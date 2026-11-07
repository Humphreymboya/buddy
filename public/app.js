'use strict';

/* =========================================================================
   BUDDY — HUD front-end
   Voice in (Web Speech), voice out (SpeechSynthesis), live reactor orb.
   The heavy lifting happens on the local Node server, which drives the
   OpenCode "buddy" agent with full control of this PC.
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const app = $('app');
const logEl = $('log');
const actEl = $('activity');
const stateLine = $('stateLine');
const heardEl = $('heard');
const statusText = $('statusText');
const latencyEl = $('latency');
const inputEl = $('input');
const micBtn = $('micBtn');
const engineHint = $('engineHint');

const STATE = {
  idle: ['STANDBY', 'SAY “BUDDY” TO BEGIN'],
  listening: ['LISTENING', 'GO AHEAD, SIR'],
  thinking: ['PROCESSING', 'WORKING ON IT'],
  speaking: ['SPEAKING', 'RESPONDING'],
};
let mode = 'idle';
let voice = null;
let ttsActive = false;
let fullReply = '';
let idleTimer = null;
let typeChain = Promise.resolve();

/* ---------------------------------------------------------------- clock */
function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  $('date').textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
tickClock();
setInterval(tickClock, 5000);

/* ------------------------------------------------------------- UI helpers */
function setMode(m) {
  mode = m;
  app.classList.remove('idle', 'listening', 'thinking', 'speaking');
  app.classList.add(m);
  const [s, line] = STATE[m] || STATE.idle;
  statusText.textContent = s;
  stateLine.textContent = line;
  micBtn.classList.toggle('live', m === 'listening');
  if (m === 'thinking') latencyEl.textContent = '···';
}

function flashState(text) {
  stateLine.textContent = text;
}

function activity(text, hot = false) {
  const first = actEl.querySelector('.empty');
  if (first) first.remove();
  const line = document.createElement('div');
  line.className = 'line' + (hot ? ' hot' : '');
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  line.innerHTML = `<span class="t">${t}</span><span class="ico">▸</span><span class="text"></span>`;
  line.querySelector('.text').textContent = text;
  actEl.appendChild(line);
  while (actEl.children.length > 90) actEl.firstElementChild.remove();
  actEl.scrollTop = actEl.scrollHeight;
}

function addMsg(role, text = '') {
  const empty = logEl.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = '<div class="who"></div><p></p>';
  div.querySelector('.who').textContent = role === 'you' ? 'YOU' : role === 'error' ? 'FAULT' : 'BUDDY';
  div.querySelector('p').textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div.querySelector('p');
}

function typeAppend(el, text) {
  typeChain = typeChain.then(() => new Promise((resolve) => {
    let i = 0;
    const step = Math.max(1, Math.ceil(text.length / 70));
    const tick = () => {
      if (i >= text.length) return resolve();
      el.textContent += text.slice(i, i + step);
      i += step;
      logEl.scrollTop = logEl.scrollHeight;
      requestAnimationFrame(tick);
    };
    tick();
  }));
  return typeChain;
}

function setHeard(t) { heardEl.textContent = t ? `“${t}”` : ''; }

function playChime(kind = 'wake') {
  try {
    const ctx = audioCtx();
    const seq = kind === 'wake' ? [[660, 0, .1], [990, .11, .16]]
      : kind === 'send' ? [[880, 0, .07]]
      : kind === 'error' ? [[200, 0, .2]]
      : [[520, 0, .06], [420, .1, .1]];
    for (const [f, at, dur] of seq) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'error' ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(kind === 'wake' ? 0.075 : 0.04, ctx.currentTime + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + dur + 0.02);
    }
  } catch { /* audio not ready */ }
}

/* --------------------------------------------------------------- audio io */
let actx = null;
let analyser = null;
let freqData = null;
let timeData = null;
let level = 0;
let levelSmooth = 0;

function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

async function initMicMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
  } catch (e) {
    engineHint.textContent = 'MIC UNAVAILABLE · TYPE INSTEAD';
  }
}

/* ---------------------------------------------------------------- speech out */
const synth = window.speechSynthesis;
const VOICE_PREF = [
  'Google UK English Male', 'Microsoft Ryan', 'Microsoft George', 'Microsoft David',
  'Daniel', 'Microsoft Mark', 'Microsoft Guy', 'Microsoft Hazel',
];

function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices();
  if (!vs.length) return;
  for (const p of VOICE_PREF) {
    const v = vs.find((x) => x.name.toLowerCase().startsWith(p.toLowerCase()));
    if (v) { voice = v; return; }
  }
  voice = vs.find((v) => /^en[-_]GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || vs[0];
}
if (synth) {
  pickVoice();
  synth.onvoiceschanged = pickVoice;
}

function chunkText(text, max = 220) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;:]+[.!?;:]?/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let speechToken = 0;
function speak(text) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!synth || !clean) { afterSpeech(); return; }
  const token = ++speechToken;
  ttsActive = true;
  setMode('speaking');
  stopRec();
  try { synth.cancel(); } catch {}
  const chunks = chunkText(clean);
  let i = 0;
  let ended = false;
  let watchdog = null;
  const finish = () => {
    if (ended || token !== speechToken) return;
    ended = true;
    clearTimeout(watchdog);
    ttsActive = false;
    setTimeout(afterSpeech, 500);
  };
  watchdog = setTimeout(finish, Math.min(90000, 5000 + clean.length * 80));
  const next = () => {
    if (token !== speechToken) return;
    if (i >= chunks.length) return finish();
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.pitch = 0.82;
    u.volume = 1;
    u.onend = next;
    u.onerror = next;
    try { synth.speak(u); } catch { finish(); }
  };
  setTimeout(() => { if (token === speechToken) next(); }, 120);
}

function afterSpeech() {
  if (mode !== 'speaking') return;
  setMode('idle');
  maybeStartWake();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (mode === 'idle') app.classList.remove('active'); }, 30000);
}

/* ---------------------------------------------------------------- speech in */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recRunning = false;
let recMode = 'wake';
let listenDeadline = 0;
const WAKE_RE = /\b(?:hey|ok|okay)?\s*(?:buddy|jarvis)\b/i;

function createRec() {
  if (!SR) {
    engineHint.textContent = 'VOICE NEEDS CHROME OR EDGE';
    return;
  }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.maxAlternatives = 1;

  rec.onstart = () => { recRunning = true; };
  rec.onend = () => {
    recRunning = false;
    if (mode === 'idle' && !ttsActive) setTimeout(maybeStartWake, 350);
    else if (mode === 'listening' && !ttsActive) setTimeout(maybeStartCommand, 250);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      engineHint.textContent = 'MIC BLOCKED · CLICK THE MIC ICON';
    }
    /* no-speech / aborted / network are normal in a long-running loop */
  };
  rec.onresult = onResult;
}

function startRec(target) {
  if (!rec || recRunning) return;
  recMode = target;
  try { rec.start(); recRunning = true; }
  catch {
    recRunning = false;
    setTimeout(() => {
      if (mode === 'idle') maybeStartWake();
      else if (mode === 'listening') maybeStartCommand();
    }, 900);
  }
}
function stopRec() {
  if (!rec) return;
  try { rec.stop(); } catch {}
  recRunning = false;
}
function maybeStartWake() {
  if (recMode !== 'wake') recMode = 'wake';
  if (mode !== 'idle' || ttsActive || recRunning) return;
  startRec('wake');
}
function maybeStartCommand() {
  recMode = 'command';
  if (mode !== 'listening' || ttsActive || recRunning) return;
  startRec('command');
}

function onResult(e) {
  if (ttsActive) return;
  let interim = '';
  let finals = '';
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i];
    if (r.isFinal) finals += r[0].transcript;
    else interim += r[0].transcript;
  }
  const heard = (finals || interim).trim();
  if (!heard) return;

  if (mode === 'idle') {
    if (WAKE_RE.test(heard)) wake();
    return;
  }
  if (mode === 'listening') {
    if (interim) { setHeard(interim); listenDeadline = Date.now() + 12000; }
    if (finals) {
      setHeard(finals);
      const cmd = finals
        .replace(/^\s*(?:hey|ok|okay)?[\s,]*\b(?:buddy|jarvis)\b[\s,.:;!?-]*/i, '')
        .trim();
      if (cmd && !/^(buddy|jarvis)$/i.test(cmd)) sendCommand(cmd);
      else listenDeadline = Date.now() + 12000;
    }
  }
}

setInterval(() => {
  if (mode === 'listening' && listenDeadline && Date.now() > listenDeadline) sleepMode();
}, 500);

function wake() {
  if (mode !== 'idle') return;
  app.classList.add('active');
  setMode('listening');
  setHeard('');
  listenDeadline = Date.now() + 12000;
  playChime('wake');
  activity('WAKE WORD DETECTED · LISTENING', true);
  if (recMode !== 'command') maybeStartCommand();
  clearTimeout(idleTimer);
  // Raise the window if it is minimised or behind something.
  fetch('/api/summon', { method: 'POST' }).catch(() => {});
}

function sleepMode(silent = false) {
  clearTimeout(idleTimer);
  speechToken++;
  try { if (synth) synth.cancel(); } catch {}
  ttsActive = false;
  app.classList.remove('active');
  setMode('idle');
  setHeard('');
  recMode = 'wake';
  listenDeadline = 0;
  if (!silent) activity('STANDING BY');
  maybeStartWake();
}

/* --------------------------------------------------------------- chat flow */
async function sendCommand(text) {
  text = String(text || '').trim();
  if (!text) return;
  const t = text.toLowerCase().replace(/[.!?]+$/, '').trim();

  if (/^(go to sleep|stand ?by|stop listening|that'?s all|dismiss|goodbye|bye|good ?night)$/.test(t)) {
    playChime('down');
    return sleepMode();
  }
  if (/^(be quiet|silence|shut up|quiet)$/.test(t)) {
    speechToken++;
    try { synth && synth.cancel(); } catch {}
    ttsActive = false;
    setMode('idle');
    maybeStartWake();
    return;
  }
  if (mode === 'thinking') {
    activity('BUSY · IGNORED: ' + text);
    flashState('WORKING ON IT');
    return;
  }

  stopRec();
  setHeard(text);
  playChime('send');
  addMsg('you', text);
  setMode('thinking');
  app.classList.add('active');
  activity('REQUEST → AGENT');
  latencyEl.textContent = '···';
  const started = performance.now();

  const bubble = addMsg('buddy', '');
  fullReply = '';
  let gotText = false;
  let deltaCount = 0;
  let first = true;
  let failure = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('server returned ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let payload = {};
        try { payload = JSON.parse(data); } catch { continue; }

        if (ev === 'tool') {
          activity(payload.local ? `LOCAL · ${payload.label}` : payload.label);
        } else if (ev === 'status') {
          activity('AGENT ENGAGED');
        } else if (ev === 'delta' && payload.text) {
          if (gotText) fullReply += '\n\n';
          fullReply += payload.text;
          gotText = true;
          const prefix = deltaCount++ > 0 ? '\n\n' : '';
          if (first) { first = false; latencyEl.textContent = ((performance.now() - started) / 1000).toFixed(1) + 's'; }
          typeAppend(bubble, prefix + payload.text);
        } else if (ev === 'error') {
          failure = payload.message || 'unknown fault';
          activity('FAULT · ' + failure, true);
        } else if (ev === 'done') {
          if (!gotText && payload.text) {
            fullReply = payload.text;
            gotText = true;
            typeAppend(bubble, payload.text);
          }
          if (payload.ms) latencyEl.textContent = (payload.ms / 1000).toFixed(1) + 's';
        }
      }
    }
  } catch (err) {
    failure = err && err.message ? err.message : String(err);
    activity('CONNECTION FAULT · ' + failure, true);
  }

  if (!gotText) {
    const msg = failure
      ? 'I could not complete that, sir. ' + failure
      : 'I did not get a response from my engine.';
    fullReply = msg;
    bubble.textContent = msg;
    bubble.parentElement.classList.add('error');
  }

  setMode('speaking');
  speak(fullReply.replace(/\n+/g, ' '));
}

/* --------------------------------------------------------------- orb canvas */
const bg = $('bg');
const bgx = bg.getContext('2d');
const orb = $('orb');
const ox = orb.getContext('2d');
let W = 0, H = 0, DPR = 1, OW = 0, OH = 0;
const particles = [];

function sizeCanvases() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  // The backdrop is mostly soft gradients: 1x is plenty and keeps integrated GPUs cool.
  bg.width = W; bg.height = H;
  bgx.setTransform(1, 0, 0, 1, 0, 0);

  const r = orb.getBoundingClientRect();
  OW = r.width; OH = r.height;
  orb.width = Math.max(1, OW * DPR);
  orb.height = Math.max(1, OH * DPR);
  ox.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function seedParticles() {
  particles.length = 0;
  for (let i = 0; i < 46; i++) {
    particles.push({
      x: Math.random(), y: Math.random(),
      r: Math.random() * 1.6 + 0.3,
      v: Math.random() * 0.00006 + 0.00002,
      a: Math.random() * 0.35 + 0.08,
    });
  }
}

function palette() {
  if (mode === 'thinking') return { r: 255, g: 191, b: 94 };
  if (mode === 'listening' || mode === 'speaking') return { r: 110, g: 248, b: 255 };
  return { r: 77, g: 243, b: 255 };
}

function drawBg(t) {
  const g = bgx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#02070b');
  g.addColorStop(0.5, '#04121a');
  g.addColorStop(1, '#020609');
  bgx.fillStyle = g;
  bgx.fillRect(0, 0, W, H);

  // soft center glow
  const cx = W / 2, cy = H * 0.48;
  const rg = bgx.createRadialGradient(cx, cy, 20, cx, cy, Math.max(W, H) * 0.55);
  rg.addColorStop(0, 'rgba(30,120,150,.18)');
  rg.addColorStop(0.45, 'rgba(10,50,70,.08)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  bgx.fillStyle = rg;
  bgx.fillRect(0, 0, W, H);

  // grid
  const step = 46;
  bgx.strokeStyle = 'rgba(90,200,225,.055)';
  bgx.lineWidth = 1;
  bgx.beginPath();
  for (let x = (t * 0.004) % step; x < W; x += step) { bgx.moveTo(x, 0); bgx.lineTo(x, H); }
  for (let y = (t * 0.004) % step; y < H; y += step) { bgx.moveTo(0, y); bgx.lineTo(W, y); }
  bgx.stroke();

  // particles
  const p = palette();
  for (const pt of particles) {
    pt.y -= pt.v * 16;
    if (pt.y < -0.02) { pt.y = 1.02; pt.x = Math.random(); }
    bgx.beginPath();
    bgx.fillStyle = `rgba(${p.r},${p.g},${p.b},${pt.a * 0.5})`;
    bgx.arc(pt.x * W, pt.y * H, pt.r, 0, Math.PI * 2);
    bgx.fill();
  }

  // scan sweep
  const sy = (t * 0.035) % (H + 200) - 100;
  const sg = bgx.createLinearGradient(0, sy - 60, 0, sy + 60);
  sg.addColorStop(0, 'rgba(77,243,255,0)');
  sg.addColorStop(0.5, 'rgba(77,243,255,.035)');
  sg.addColorStop(1, 'rgba(77,243,255,0)');
  bgx.fillStyle = sg;
  bgx.fillRect(0, sy - 60, W, 120);
}

function drawOrb(t) {
  ox.clearRect(0, 0, OW, OH);
  if (analyser) {
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i += 4) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    level = Math.min(1, Math.sqrt(sum / (timeData.length / 4)) * 4.2);
  }
  levelSmooth += (level - levelSmooth) * 0.14;

  const cx = OW / 2, cy = OH / 2;
  const R = Math.min(OW, OH) * 0.29;
  const p = palette();
  const c = (a) => `rgba(${p.r},${p.g},${p.b},${a})`;
  const breath = 0.5 + 0.5 * Math.sin(t * 0.0016);
  const speed = mode === 'thinking' ? 3.4 : mode === 'listening' ? 1.5 : mode === 'speaking' ? 1.15 : 0.42;

  // outer glow
  const glow = ox.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.9);
  glow.addColorStop(0, c(0.10 + levelSmooth * 0.12));
  glow.addColorStop(0.55, c(0.03));
  glow.addColorStop(1, c(0));
  ox.fillStyle = glow;
  ox.beginPath(); ox.arc(cx, cy, R * 1.9, 0, Math.PI * 2); ox.fill();

  // tick ring
  const tr = R * 1.46;
  const ticks = 120;
  ox.save();
  ox.translate(cx, cy);
  ox.rotate(t * 0.00012 * speed);
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const major = i % 5 === 0;
    const len = major ? 9 : 4;
    const alpha = major ? 0.34 : 0.14;
    ox.strokeStyle = c(alpha);
    ox.lineWidth = major ? 1.2 : 0.8;
    ox.beginPath();
    ox.moveTo(Math.cos(a) * tr, Math.sin(a) * tr);
    ox.lineTo(Math.cos(a) * (tr + len), Math.sin(a) * (tr + len));
    ox.stroke();
  }
  ox.restore();

  // rotating arc segments
  const arcs = [
    { r: R * 1.3, from: 0.15, span: 1.25, sp: 1.0, w: 2.2, a: 0.65 },
    { r: R * 1.3, from: 3.5, span: 0.55, sp: 1.0, w: 2.2, a: 0.35 },
    { r: R * 1.17, from: 1.2, span: 0.9, sp: -1.7, w: 1.2, a: 0.4 },
    { r: R * 1.56, from: 4.4, span: 0.5, sp: 0.7, w: 1, a: 0.3 },
  ];
  for (const a of arcs) {
    ox.save();
    ox.translate(cx, cy);
    ox.rotate(t * 0.001 * a.sp * speed + a.from);
    ox.strokeStyle = c(a.a);
    ox.lineWidth = a.w;
    ox.lineCap = 'round';
    ox.beginPath();
    ox.arc(0, 0, a.r, 0, a.span);
    ox.stroke();
    ox.restore();
  }

  // audio ring
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    const n = 128;
    const inner = R * (1.03 + levelSmooth * 0.02);
    ox.beginPath();
    for (let i = 0; i <= n; i++) {
      const bi = Math.floor((i / n) * (freqData.length * 0.55));
      const v = freqData[bi] / 255;
      const rr = inner + v * R * 0.24;
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr;
      if (i === 0) ox.moveTo(x, y); else ox.lineTo(x, y);
    }
    ox.closePath();
    ox.strokeStyle = c(mode === 'idle' ? 0.28 : 0.6);
    ox.lineWidth = 1.2;
    ox.shadowColor = c(0.5);
    ox.shadowBlur = 12;
    ox.stroke();
    ox.shadowBlur = 0;
  }

  // main ring
  ox.beginPath();
  ox.arc(cx, cy, R, 0, Math.PI * 2);
  ox.strokeStyle = c(0.55);
  ox.lineWidth = 2;
  ox.shadowColor = c(0.8);
  ox.shadowBlur = 18 + levelSmooth * 24;
  ox.stroke();
  ox.shadowBlur = 0;

  // inner ring
  ox.beginPath();
  ox.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
  ox.strokeStyle = c(0.18);
  ox.lineWidth = 1;
  ox.stroke();

  // core
  const coreR = R * (0.5 + levelSmooth * 0.10 + breath * 0.025);
  const cg = ox.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  cg.addColorStop(0, 'rgba(240,255,255,.95)');
  cg.addColorStop(0.25, c(0.9));
  cg.addColorStop(0.62, c(0.28));
  cg.addColorStop(1, c(0));
  ox.fillStyle = cg;
  ox.beginPath(); ox.arc(cx, cy, coreR, 0, Math.PI * 2); ox.fill();

  ox.beginPath();
  ox.arc(cx, cy, coreR * 0.4, 0, Math.PI * 2);
  ox.strokeStyle = 'rgba(255,255,255,.55)';
  ox.lineWidth = 1;
  ox.stroke();

  // cross hairs
  ox.strokeStyle = c(0.16);
  ox.lineWidth = 1;
  ox.beginPath();
  ox.moveTo(cx - R * 1.6, cy); ox.lineTo(cx - R * 1.08, cy);
  ox.moveTo(cx + R * 1.08, cy); ox.lineTo(cx + R * 1.6, cy);
  ox.moveTo(cx, cy - R * 1.6); ox.lineTo(cx, cy - R * 1.08);
  ox.moveTo(cx, cy + R * 1.08); ox.lineTo(cx, cy + R * 1.6);
  ox.stroke();

  // orbiting nodes
  for (let i = 0; i < 3; i++) {
    const a = t * 0.00035 * speed * (i % 2 ? -1 : 1) + (i * Math.PI * 2) / 3;
    const rr = R * 1.34;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    ox.beginPath();
    ox.fillStyle = c(0.85);
    ox.shadowColor = c(0.9);
    ox.shadowBlur = 10;
    ox.arc(x, y, 2.2, 0, Math.PI * 2);
    ox.fill();
    ox.shadowBlur = 0;
  }
}

let frameNo = 0;
function frame(t) {
  frameNo++;
  if (frameNo % 2 === 0) drawBg(t);   // backdrop at ~30fps, orb at full rate
  drawOrb(t);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ boot */
function boot() {
  sizeCanvases();
  seedParticles();
  requestAnimationFrame(frame);
  setMode('idle');

  setTimeout(() => {
    const b = $('boot');
    $('bootSub').textContent = 'CORE ONLINE';
    b.classList.add('gone');
  }, 900);
  setTimeout(() => { $('boot').remove(); }, 1800);

  initMicMeter().then(() => {
    if (SR) {
      createRec();
      setTimeout(maybeStartWake, 1200);
      activity('VOICE INTERFACE ONLINE');
    } else {
      activity('VOICE UNSUPPORTED · USE TEXT', true);
      flashState('VOICE NEEDS CHROME OR EDGE · TYPE BELOW');
    }
    loadHistory();
  });
}

async function loadHistory() {
  try {
    const r = await fetch('/api/history?limit=8');
    const { messages } = await r.json();
    if (!messages || !messages.length) return;
    logEl.innerHTML = '';
    for (const m of messages) {
      if (!m.text) continue;
      addMsg(m.role === 'user' ? 'you' : 'buddy', m.text);
    }
    app.classList.add('active');
    activity('SESSION RESTORED');
  } catch { /* server not ready yet */ }
}

/* ------------------------------------------------------------------ input */
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = inputEl.value.trim();
    if (!v) return;
    inputEl.value = '';
    sendCommand(v);
  }
});
$('sendBtn').addEventListener('click', () => {
  const v = inputEl.value.trim();
  if (!v) return;
  inputEl.value = '';
  sendCommand(v);
});
micBtn.addEventListener('click', () => {
  audioCtx();
  if (mode === 'thinking') return;
  if (mode === 'idle') wake();
  else if (mode === 'listening') { listenDeadline = Date.now() + 100; }
  else if (mode === 'speaking') { try { synth.cancel(); } catch {} ttsActive = false; sleepMode(); }
});

$('clearBtn').addEventListener('click', async () => {
  try { await fetch('/api/reset', { method: 'POST' }); } catch {}
  logEl.innerHTML = '<div class="empty">No transmissions yet.</div>';
  actEl.innerHTML = '<div class="empty">Idle.</div>';
  latencyEl.textContent = '—';
  sleepMode(true);
  activity('NEW SESSION');
});

// Push to talk: hold Space when not typing.
let spaceDown = false;
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.activeElement === inputEl) return;
  e.preventDefault();
  if (spaceDown) return;
  spaceDown = true;
  audioCtx();
  if (mode === 'idle') wake();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  spaceDown = false;
  if (mode === 'listening') {
    stopRec();                              // finalise whatever was captured
    listenDeadline = Date.now() + 2500;     // then fall back to standby
  }
});

window.addEventListener('resize', sizeCanvases);
window.addEventListener('pointerdown', () => audioCtx(), { once: true });

/* heartbeat */
setInterval(async () => {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    engineHint.textContent = s.busy ? 'LOCAL ENGINE · WORKING' : 'LOCAL ENGINE · READY';
  } catch {
    engineHint.textContent = 'ENGINE OFFLINE';
  }
}, 10000);

boot();
