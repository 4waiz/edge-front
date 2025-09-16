// api/chat.js — Vercel Edge Function proxy to Groq
export const runtime = 'edge';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Use POST', { status: 405 });
  }

  const { messages = [] } = await req.json().catch(()=>({messages:[]}));

  const sys = {
    role: 'system',
    content:
      "You are EDGE AI. Be helpful, direct, and professional. " +
      "Keep every answer under 100 words unless explicitly asked for more."
  };

  const body = {
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    temperature: 0.6,
    max_tokens: 300,
    top_p: 0.95,
    messages: [sys, ...messages]
  };

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text();
    return new Response(JSON.stringify({ error: text }), {
      status: r.status, headers: { 'content-type': 'application/json' }
    });
  }

  const data = await r.json();
  const reply = data?.choices?.[0]?.message?.content || '';
  return new Response(JSON.stringify({ reply }), {
    headers: { 'content-type': 'application/json' }
  });
}
