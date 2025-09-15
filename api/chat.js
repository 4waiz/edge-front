// /api/chat.js
export const config = { runtime: 'edge' };

const API_BASE = 'https://api-inference.huggingface.co';
const MODEL = process.env.HF_MODEL || 'google/gemma-2-2b-it';
const SYS =
  process.env.SYSTEM_PROMPT || 'You are EDGE AI, a concise helpful assistant.';
const AUTH = `Bearer ${process.env.HF_TOKEN}`;

// tiny helper: retry when model is loading (503/529)
async function hfFetch(url, init, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, init);
    if (r.status === 503 || r.status === 529) {
      // model is loading or too many requests — wait and retry
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
      continue;
    }
    return r;
  }
  // final attempt
  return fetch(url, init);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { messages = [] } = await req.json();
    const finalMessages = [{ role: 'system', content: SYS }, ...messages.slice(-12)];

    // v1 chat first
    let r = await hfFetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: AUTH,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: finalMessages,
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (r.ok) {
      const data = await r.json();
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      return json({ reply, mode: 'v1' });
    }

    // if v1 failed, try legacy /models
    const chatml =
      finalMessages
        .map((m) =>
          m.role === 'system'
            ? `<|system|>\n${m.content}</s>\n`
            : `<|${m.role === 'assistant' ? 'assistant' : 'user'}|>\n${m.content}</s>\n`
        )
        .join('') + '<|assistant|>\n';

    r = await hfFetch(`${API_BASE}/models/${MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: AUTH,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        inputs: chatml,
        parameters: { max_new_tokens: 256, return_full_text: false },
        options: { wait_for_model: true },
      }),
    });

    if (r.ok) {
      // legacy text-generation returns a list
      const data2 = await r.json();
      const reply = (data2?.[0]?.generated_text || '').trim();
      return json({ reply, mode: 'legacy' });
    }

    // surface HF error text to the frontend for easier debugging
    const detailText = await r.text();
    return json(
      { error: `HF error ${r.status}`, detail: detailText.slice(0, 800) },
      502
    );
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
