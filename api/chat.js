export const config = { runtime: 'edge' };

const API_BASE = 'https://api-inference.huggingface.co';
const MODEL = process.env.HF_MODEL || 'google/gemma-2-2b-it';
const SYS = process.env.SYSTEM_PROMPT || 'You are EDGE AI, a concise helpful assistant.';

export default async function handler(req) {
  try {
    const { messages = [] } = await req.json();

    // Build OpenAI-style messages with a system prompt
    const finalMessages = [{ role: 'system', content: SYS }, ...messages.slice(-12)];

    // Try v1 chat completions first
    let r = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, messages: finalMessages, max_tokens: 300, temperature: 0.7 })
    });

    if (r.ok) {
      const data = await r.json();
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      return new Response(JSON.stringify({ reply, mode: 'v1' }), { headers: { 'content-type': 'application/json' } });
    }

    // Fallback: legacy /models endpoint (ChatML-ish)
    const chatml = finalMessages.map(m => {
      if (m.role === 'system') return `<|system|>\n${m.content}</s>\n`;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return `<|${role}|>\n${m.content}</s>\n`;
    }).join('') + '<|assistant|>\n';

    r = await fetch(`${API_BASE}/models/${MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ inputs: chatml, parameters: { max_new_tokens: 256, return_full_text: false }, options: { wait_for_model: true } })
    });

    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: `HF error ${r.status}`, detail: txt.slice(0, 500) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    const data2 = await r.json();
    const reply = (data2?.[0]?.generated_text || '').trim();
    return new Response(JSON.stringify({ reply, mode: 'legacy' }), { headers: { 'content-type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
