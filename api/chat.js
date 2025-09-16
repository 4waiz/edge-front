// api/chat.js
// Frontend logic + Vercel edge function call (Groq).
// Voice turn-taking with permission prompt + barge-in + backoffs.

const API_BASE = ''; // same origin
const $ = (s)=>document.querySelector(s);
const log = $("#log");
const input = $("#input");
const sendBtn = $("#send");
const toggleVoiceBtn = $("#toggleVoice");
const speakSwitch = $("#speakSwitch");
const rateEl = $("#rate");
const stateBadge = $("#stateBadge");
const errBar = $("#err");

// ---- Chat state -------------------------------------------------------------
const history = [];
let inFlight = false;
let lastSendAt = 0;
const MIN_SEND_SPACING_MS = 1100;

const STATE = {
  IDLE:'Idle', LISTEN:'Listening', THINK:'Thinking…', SPEAK:'Speaking…',
  WAIT:'Waiting…', INTERRUPTED:'Interrupted → Listening', NEEDS_PERMISSION:'Mic blocked'
};
let state = STATE.IDLE;
let interrupted = false;

// ---- UI helpers -------------------------------------------------------------
function showError(msg=''){
  errBar.textContent = msg;
  errBar.style.display = msg ? 'block' : 'none';
}
function badge(cls, text){
  stateBadge.className = `badge ${cls||''}`; stateBadge.textContent = text;
}
function setState(s){
  state = s;
  if (s === STATE.LISTEN) badge('ok', 'Listening');
  else if (s === STATE.THINK) badge('', 'Thinking…');
  else if (s === STATE.SPEAK) badge('speaking', 'Speaking…');
  else if (s === STATE.WAIT) badge('', 'Waiting…');
  else if (s === STATE.INTERRUPTED) badge('interrupt', 'Interrupted → Listening');
  else if (s === STATE.NEEDS_PERMISSION) badge('interrupt', 'Mic blocked');
  else badge('', 'Idle');
}
function push(role, text){
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

// ---- Word limiter -----------------------------------------------------------
function limitWords(s, n = 100) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length > n ? words.slice(0, n).join(" ") + "…" : s;
}

// ---- Network ---------------------------------------------------------------
async function postJSON(url, payload){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function sendText(text){
  if (!text) return;
  const now = Date.now();
  if (inFlight || (now - lastSendAt) < MIN_SEND_SPACING_MS) return;
  inFlight = true; lastSendAt = now;

  history.push({role:'user', content:text});
  push('user', text);
  setState(STATE.THINK);

  try{
    const res = await postJSON('/api/chat', {messages: history});
    const raw = res.reply || '[no reply]';
    const reply = limitWords(raw, 100);
    history.push({role:'assistant', content: reply});
    push('assistant', reply);

    if (speakSwitch.checked) await speak(reply);

    // wait a moment before re-opening mic
    if (!interrupted && voice.enabled){
      setState(STATE.WAIT);
      await wait(500);
      if (!speechSynthesis.speaking) voice._resumeListening();
    }
  }catch(e){
    console.error(e);
    push('assistant', `[error]`);
  }finally{
    inFlight = false;
    if (state === STATE.THINK) setState(STATE.IDLE);
  }
}

// ---- Buttons / keyboard -----------------------------------------------------
sendBtn.onclick = ()=> {
  const text = input.value.trim();
  input.value = '';
  sendText(text);
};
input.addEventListener('keydown', (ev)=>{
  if (ev.key === 'Enter' && !ev.shiftKey){
    ev.preventDefault();
    sendBtn.click();
  }
});
document.addEventListener('keydown', (ev)=>{
  if (ev.key.toLowerCase() === 'm') toggleVoiceBtn.click();
});

// ---- Speech synthesis (prefer Microsoft Emily) ------------------------------
let selectedVoice = null;
function pickVoice(){
  const voices = speechSynthesis.getVoices() || [];
  selectedVoice = voices.find(v => /emily/i.test(v.name) && /microsoft/i.test(v.name)) ||
                  voices.find(v => /neural/i.test(v.name) && /microsoft/i.test(v.name)) ||
                  voices.find(v => /english/i.test(v.lang)) || voices[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();

function speak(text){
  return new Promise((resolve)=>{
    if (!text) return resolve();
    try{
      interrupted = false;
      const u = new SpeechSynthesisUtterance(text);
      if (selectedVoice) u.voice = selectedVoice;
      u.rate = parseFloat(rateEl.value || '1.0');
      u.onstart = ()=> setState(STATE.SPEAK);
      u.onend = ()=> { if(!interrupted) setState(STATE.IDLE); resolve(); };
      u.onerror = ()=> { if(!interrupted) setState(STATE.IDLE); resolve(); };
      speechSynthesis.speak(u);
    }catch{ resolve(); }
  });
}
function cancelTTS(){
  if (speechSynthesis.speaking){
    interrupted = true;
    speechSynthesis.cancel();
    setState(STATE.INTERRUPTED);
  }
}

// ---- Permission helper ------------------------------------------------------
async function ensureMicPermission(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    stream.getTracks().forEach(t=>t.stop()); // we only needed to prompt; SR will access mic internally
    showError('');
    return true;
  }catch(err){
    console.warn('getUserMedia error', err);
    showError('Microphone permission is blocked. Click the mic/camera icon in the address bar and allow access, then press Start Voice again.');
    setState(STATE.NEEDS_PERMISSION);
    return false;
  }
}

// ---- Voice (SpeechRecognition + VAD for barge-in) --------------------------
const voice = {
  enabled:false, rec:null, ctx:null, analyser:null, data:null, raf:0,
  lastFinal:'',

  async start(){
    if (this.enabled) return;

    // API support check
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR){
      showError('This browser does not support SpeechRecognition. Use Chrome/Edge on desktop/Android.');
      setState(STATE.NEEDS_PERMISSION);
      return;
    }

    // Make sure user granted mic before starting the recognizer
    const ok = await ensureMicPermission();
    if (!ok) return;

    this.enabled = true;
    showError('');
    toggleVoiceBtn.textContent = 'Voice On';

    // Create recognizer
    this.rec = new SR();
    this.rec.lang = 'en-US';
    this.rec.interimResults = false;
    this.rec.continuous = false;

    this.rec.onstart = ()=> setState(STATE.LISTEN);

    this.rec.onresult = async (e)=>{
      const text = (e.results[0][0].transcript || '').trim();
      if (!text || text === this.lastFinal) return;
      this.lastFinal = text;
      setState(STATE.THINK);
      await wait(350); // tiny safety spacing
      sendText(text);
    };

    this.rec.onerror = (e)=>{
      console.warn('SR error', e?.error || e);
      if (e?.error === 'not-allowed'){
        showError('Microphone access denied. Allow mic in the address bar and press Start Voice again.');
        setState(STATE.NEEDS_PERMISSION);
        this.stop();
        return;
      }
      // soften common transient errors
      if (this.enabled) setTimeout(()=>this._resumeListening(), 400);
    };

    this.rec.onend = ()=>{
      // We'll reopen when allowed by state machine
    };

    // Kick once
    this._resumeListening();

    // VAD for barge-in while TTS is speaking
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      await this.ctx.resume();
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      const tick = ()=>{
        if (!this.enabled) return;
        this.analyser.getByteTimeDomainData(this.data);
        let sum = 0; for (let i=0;i<this.data.length;i++){ const v=(this.data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum/this.data.length);
        if (speechSynthesis.speaking && rms > 0.06){
          cancelTTS();
          setTimeout(()=> this._resumeListening(), 600);
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }catch(err){
      console.warn('VAD stream error', err);
    }
  },

  _resumeListening(){
    if (!this.enabled || !this.rec) return;
    try{
      this.rec.abort?.(); // ensure clean state
    }catch{}
    try{
      this.rec.start();
    }catch(e){
      // start can throw if called too fast; try again
      setTimeout(()=>{ try{ this.rec.start(); }catch{} }, 250);
    }
  },

  stop(){
    this.enabled = false;
    try{ this.rec && this.rec.stop(); }catch{}
    if (this.ctx){ try{ this.ctx.close(); }catch{} this.ctx = null; }
    if (this.raf) cancelAnimationFrame(this.raf);
    setState(STATE.IDLE);
    toggleVoiceBtn.textContent = 'Start Voice';
  }
};

toggleVoiceBtn.onclick = ()=> voice.enabled ? voice.stop() : voice.start();

// ---- Helpers ----------------------------------------------------------------
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
input.addEventListener('focus', cancelTTS);

// ---- Greeting ---------------------------------------------------------------
push('assistant', 'Voice is optional. Press “Start Voice” and allow the microphone, or type a message.');
