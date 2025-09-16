// api/chat.js
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  const apiKey =
    process.env.GROQ_API_KEY ||
    process.env.GROQ_KEY ||
    process.env.GROQ_TOKEN; // any of these works

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          'Missing GROQ_API_KEY. Set it in Vercel → Project → Settings → Environment Variables.',
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Accept messages from the client; keep the most recent 10 for brevity.
  const userMsgs = Array.isArray(body.messages) ? body.messages : [];
  const clipped = userMsgs.slice(-10);

  const systemMsg = {
    role: 'system',
    content:
      "You are EDGE AI. Be friendly and concise. Keep each reply under 100 words unless the user explicitly asks for details. Prefer simple, clear sentences. If the user speaks while you're replying, it's okay to finish the current sentence and then stop.",
  };

  const payload = {
    model: body.model || process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    messages: [systemMsg, ...clipped],
    temperature: 0.35,
    top_p: 0.9,
    max_tokens: 300,
  };

  try {
    const data = await callGroqWithRetry(payload, apiKey);
    const reply = data?.choices?.[0]?.message?.content ?? '';
    return new Response(JSON.stringify({ reply }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const status = err?.status || 500;
    return new Response(
      JSON.stringify({
        error: `Groq ${status}`,
        detail: String(err?.detail || err?.message || err),
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }
}

/** Simple exponential backoff w/ jitter for 429/5xx */
async function callGroqWithRetry(payload, apiKey, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.ok) return res.json();

  const txt = await res.text();
  const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);

  if (retriable && attempt < 3) {
    // 0.8s, 1.6s (+ jitter up to 200ms)
    const waitMs = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
    await sleep(waitMs);
    return callGroqWithRetry(payload, apiKey, attempt + 1);
  }

  const error = new Error('Groq error');
  error.status = res.status;
  error.detail = txt;
  throw error;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
