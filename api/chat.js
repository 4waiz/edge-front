export const config = { runtime: 'edge' };

/* =========================
   AUDIO UNLOCK (unchanged)
   ========================= */
let audioCtx;
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {}
}

/* =========================
   TTS (female-preferred) (unchanged)
   ========================= */
let isSpeaking = false;
const PREFERRED_VOICES = [
  'Google UK English Female',
  'Microsoft Emily Online (Natural)',
  'Microsoft Aria Online (Natural)',
  'Samantha', 'Victoria',
  'Zira',
];

function pickFemaleVoice() {
  const voices = speechSynthesis.getVoices() || [];
  for (const want of PREFERRED_VOICES) {
    const v = voices.find(x => x.name && x.name.includes(want));
    if (v) return v;
  }
  return voices.find(v => /en/i.test(v.lang) && /female/i.test(v.name || '')) || voices[0];
}

export function speak(text, rate = 1.0) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  stopSTT(); // half-duplex
  unlockAudio();

  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;

  const setV = () => { const v = pickFemaleVoice(); if (v) u.voice = v; };

  if (speechSynthesis.getVoices().length === 0) {
    speechSynthesis.onvoiceschanged = () => setV();
  } else setV();

  isSpeaking = true;
  u.onend = () => { isSpeaking = false; if (voiceOn) startSTT(800); };
  u.onerror = () => { isSpeaking = false; if (voiceOn) startSTT(800); };

  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* =========================
   STT (unchanged)
   ========================= */
let rec, recActive = false, voiceOn = false;
let partial = '';

function newRecognizer() {
  const SR = typeof window !== 'undefined' && (window.webkitSpeechRecognition || window.SpeechRecognition);
  if (!SR) return null;
  const r = new SR();
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;

  r.onresult = (e) => {
    let finalChunk = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalChunk += res[0].transcript;
      else partial = res[0].transcript;
    }
    if (finalChunk.trim()) {
      handleUserSpeech(finalChunk.trim());
      partial = '';
    }
  };

  r.onend = () => {
    recActive = false;
    if (voiceOn && !isSpeaking) startSTT(250);
  };

  r.onerror = (ev) => {
    recActive = false;
    if (ev.error !== 'aborted') setTimeout(() => voiceOn && startSTT(800), 1000);
  };

  return r;
}

export function startSTT(delay = 0) {
  if (!voiceOn) voiceOn = true;
  if (!rec) rec = newRecognizer();
  if (!rec || recActive || isSpeaking) return;
  setTimeout(() => {
    try {
      rec.start();
      recActive = true;
    } catch (e) {
      recActive = false;
      setTimeout(() => voiceOn && startSTT(500), 600);
    }
  }, delay);
}

export function stopSTT() {
  if (rec && recActive) {
    try { rec.stop(); } catch {}
    recActive = false;
  }
}

export function toggleVoice(on) {
  voiceOn = on;
  if (on) { unlockAudio(); startSTT(150); }
  else    { stopSTT(); if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }
}

// called when we got a final transcript
async function handleUserSpeech(text) {
  if (typeof window === 'undefined') return;

  if (window.__lastUtterance === text) return;
  window.__lastUtterance = text;

  push('user', text);
  history.push({ role: 'user', content: text });

  try {
    const res = await postJSON('/api/chat', { messages: history });
    const raw = res.reply || '[no reply]';
    const reply = limitWords(raw, 100);
    history.push({ role: 'assistant', content: reply });
    push('assistant', reply);
    speak(reply);
  } catch (e) {
    push('assistant', '[error]');
  }
}

export function limitWords(s, n = 100) {
  const words = String(s || '').trim().split(/\s+/);
  return words.length > n ? words.slice(0, n).join(' ') + '…' : s;
}

/* =========================
   SIMPLE UI INTEGRATION (NEW)
   ========================= */
function byId(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
function qp(name) {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

// Attach once in browser only
if (typeof window !== 'undefined') {
  // 1) Unlock audio on first interaction (needed on iOS)
  const firstTap = () => { unlockAudio(); window.removeEventListener('pointerdown', firstTap, { passive: true }); };
  window.addEventListener('pointerdown', firstTap, { passive: true });

  // 2) Wire up the Speak button if present
  window.addEventListener('DOMContentLoaded', () => {
    const btn = byId('speakBtn');
    const input = byId('text');

    if (btn) {
      btn.addEventListener('click', () => {
        const phrase = (input && input.value) || 'Hello from EDGE!';
        speak(phrase);
      });
    }

    // 3) Optional: ?say=Hello — will auto-fill and speak on first tap
    const say = qp('say');
    if (say && input) input.value = say;

    // Expose for quick console tests on the iPad:
    window.edgeTTS = { speak, toggleVoice, startSTT, stopSTT, unlockAudio };
  });

  // 4) Ensure voices are populated on Safari/iOS before first speak
  if ('speechSynthesis' in window) {
    const prewarm = () => { speechSynthesis.getVoices(); };
    window.addEventListener('load', prewarm, { once: true });
    speechSynthesis.onvoiceschanged = () => {}; // triggers voice list population in some browsers
  }
}

/* =========================
   Vercel Edge API (unchanged)
   ========================= */
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
    { role: 'system', content: 'You are EDGE AI. Be concise. Keep answers under 70 words unless explicitly asked for more. Use simple English. Act friendly. You are meant to greet people.' },
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