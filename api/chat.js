// /api/chat.js — Vercel Edge Function using Groq (OpenAI-compatible)
export const config = { runtime: 'edge' };

const API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const KEY = process.env.GROQ_API_KEY;
const SYS =
  process.env.SYSTEM_PROMPT || 'You are EDGE AI, a concise helpful assistant.';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req) {
  try {
    if (req.method === 'OPTIONS') {
      // (only needed if you embed this on another domain)
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

    // Prepend our system prompt and keep last 14 from user history
    const finalMessages = [
      { role: 'system', content: SYS },
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
        temperature: 0.7,
        max_tokens: 300,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json(
        { error: `Groq ${r.status}`, detail: data?.error || data },
        502
      );
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    return json({ reply, mode: 'groq' });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
