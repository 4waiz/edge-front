export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405, headers: { 'content-type': 'application/json' } });
  }

  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing GROQ_API_KEY. Set it in Vercel → Settings → Environment Variables.' }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const userMsgs = Array.isArray(body.messages) ? body.messages : [];
  const messages = [
    { role: 'system', content: 'You are EDGE AI. Be concise. Keep answers under 70 words unless explicitly asked for more. Use simple English. Act friendly and excited. You are meant to greet people.' },
    ...userMsgs.slice(-8)
  ];

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: body.model || 'llama-3.1-8b-instant',
        messages,
        temperature: 0.3,
        max_tokens: 200
      })
    });

    const txt = await r.text();
    if (!r.ok) {
      // surface real Groq error up to the UI for easier debugging
      return new Response(JSON.stringify({ error: `Groq ${r.status}`, detail: txt }), {
        status: r.status, headers: { 'content-type': 'application/json' }
      });
    }

    const data = JSON.parse(txt);
    const reply = data?.choices?.[0]?.message?.content ?? '';
    return new Response(JSON.stringify({ reply }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error', detail: String(e) }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
}
