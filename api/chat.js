export const config = { runtime: 'edge' };

// --- Config ---
const API   = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const KEY   = process.env.GROQ_API_KEY;

// Keep answers short server-side too
const SYSTEM_PROMPT = `
You are EDGE AI. Keep every answer concise, at most 100 words.
Prefer a short paragraph or up to 5 bullets. If a follow-up is needed,
ask one brief question only.
`.trim();

// --- Helpers ---
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function limitWords(s, n = 100) {
  const words = String(s || '').trim().split(/\s+/);
  return words.length > n ? words.slice(0, n).join(' ') + '…' : String(s || '');
}

// --- Handler ---
export default async function handler(req) {
  try {
    // CORS preflight (if you ever embed cross-origin)
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    if (!KEY) return json({ error: 'Missing GROQ_API_KEY' }, 500);

    const { messages = [] } = await req.json();

    // Prepend our system prompt and keep last ~14 turns
    const finalMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.slice(-14),
    ];

    const r = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: finalMessages,
        temperature: 0.6,
        max_tokens: 220, // ~100 words (with headroom)
        stream: false,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json(
        { error: `Groq ${r.status}`, detail: data?.error || data },
        502
      );
    }

    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const reply = limitWords(raw, 100); // hard cap before returning
    return json({ reply, mode: 'groq' });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
