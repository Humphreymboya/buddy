'use strict';
/**
 * BUDDY - local voice assistant server
 * Bridges the JARVIS HUD (public/) to the OpenCode agent CLI for real machine control.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const intents = require('./intents');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
const PORT = Number(process.env.BUDDY_PORT || 7777);
const HOST = '127.0.0.1';
const TIME_LIMIT_MS = 6 * 60 * 1000;

for (const d of [DATA, LOGS]) fs.mkdirSync(d, { recursive: true });

const LOG_FILE = path.join(LOGS, 'server.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts
    .map((p) => (typeof p === 'string' ? p : (p && p.stack) || JSON.stringify(p)))
    .join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

const SESSION_FILE = path.join(DATA, 'session.json');
const HISTORY_FILE = path.join(DATA, 'history.jsonl');
const AUDIT_FILE = path.join(DATA, 'audit.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function resolveOpencode() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'opencode', 'bin', 'opencode.exe'),
    'C:\\Program Files\\opencode\\opencode.exe',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'opencode';
}
const OPENCODE_BIN = resolveOpencode();

let sessionID = null;
try {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  if (s && typeof s.id === 'string' && s.id.startsWith('ses')) sessionID = s.id;
} catch { /* first run */ }

function saveSession(id) {
  if (!id || !id.startsWith('ses') || id === sessionID) return;
  sessionID = id;
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ id, updated: new Date().toISOString() }, null, 2));
}

function appendHistory(role, text, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), role, text, ...extra });
  fs.appendFileSync(HISTORY_FILE, line + '\n');
}

function audit(entry) {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

let busy = false;

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function shortLabel(tool, input) {
  if (!input) return tool;
  const val = input.command || input.filePath || input.path || input.pattern || input.query || input.description || input.url;
  if (!val) return tool;
  const s = String(val).replace(/\s+/g, ' ').trim();
  return `${tool}: ${s.length > 78 ? s.slice(0, 75) + '...' : s}`;
}

async function handleChat(req, res, body) {
  const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
  if (!text) return json(res, 400, { error: 'empty text' });
  if (text.length > 4000) return json(res, 400, { error: 'too long' });

  const send = sseStart(res);
  const started = Date.now();
  appendHistory('user', text);
  audit({ kind: 'request', text });

  // ---- fast local intents (instant, no model round-trip) ----
  let intent = null;
  try { intent = await intents.handle(text); } catch (e) { log('intent error', e && e.message); }

  if (intent) {
    if (intent.reset) {
      sessionID = null;
      try { fs.rmSync(SESSION_FILE, { force: true }); } catch {}
    }
    if (intent.action) send('tool', { label: intent.action, local: true });
    send('delta', { text: intent.reply });
    appendHistory('buddy', intent.reply, { intent: intent.action || 'local' });
    audit({ kind: 'intent', text, action: intent.action || 'local', reply: intent.reply });
    send('done', { text: intent.reply, ms: Date.now() - started, local: true });
    return res.end();
  }

  if (busy) {
    const msg = 'One moment, sir. I am still working on the previous request.';
    send('delta', { text: msg });
    send('done', { text: msg, ms: Date.now() - started, local: true });
    return res.end();
  }
  busy = true;

  const args = ['run', text, '--format', 'json', '--auto', '--agent', 'buddy'];
  if (sessionID) args.push('--session', sessionID);

  send('status', { phase: 'thinking', session: sessionID });

  let child;
  try {
    child = spawn(OPENCODE_BIN, args, {
      cwd: process.env.USERPROFILE || ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } catch (e) {
    busy = false;
    send('error', { message: 'Could not start the assistant engine: ' + e.message });
    return res.end();
  }

  let stdout = '';
  let stderr = '';
  let collected = '';
  const seenParts = new Set();
  const tools = [];
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    busy = false;
  };

  const timer = setTimeout(() => {
    if (finished) return;
    try { child.kill(); } catch {}
    send('error', { message: 'That took too long, so I stopped. Try asking in a smaller step.' });
    send('done', { text: 'That took too long, so I stopped.', ms: Date.now() - started });
    audit({ kind: 'timeout', text });
    cleanup();
    res.end();
  }, TIME_LIMIT_MS);

  req.on('close', () => {
    if (!finished) {
      try { child.kill(); } catch {}
      clearTimeout(timer);
      cleanup();
      audit({ kind: 'aborted', text });
    }
  });

  const handleLine = (line) => {
    const raw = line.trim();
    if (!raw) return;
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    if (ev.sessionID) saveSession(ev.sessionID);

    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') {
      const id = ev.part.id || ev.part.partID || Math.random().toString();
      if (seenParts.has(id)) return;
      seenParts.add(id);
      const t = ev.part.text.trim();
      if (!t) return;
      collected += (collected ? '\n\n' : '') + t;
      send('delta', { text: t });
    } else if (ev.type === 'tool_use' && ev.part) {
      const label = shortLabel(ev.part.tool || 'tool', ev.part.state && ev.part.state.input);
      tools.push(label);
      send('tool', { label });
    } else if (ev.type === 'error') {
      const msg = (ev.error && (ev.error.message || ev.error.name)) || 'unknown error';
      send('error', { message: msg });
    }
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    let idx;
    while ((idx = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, idx);
      stdout = stdout.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString(); });

  child.on('error', (e) => {
    clearTimeout(timer);
    send('error', { message: 'Assistant engine error: ' + e.message });
    send('done', { text: 'I could not reach my engine, sir.', ms: Date.now() - started });
    cleanup();
    res.end();
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (finished) return;
    if (stdout.trim()) handleLine(stdout);
    const finalText = collected.trim();
    if (!finalText && code !== 0) {
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      send('error', { message: detail || `engine exited with code ${code}` });
    }
    if (finalText) {
      appendHistory('buddy', finalText, { tools });
      audit({ kind: 'reply', text, reply: finalText, tools, ms: Date.now() - started, exit: code });
    }
    send('done', { text: finalText, ms: Date.now() - started, tools, exit: code });
    cleanup();
    res.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, {
        ok: true,
        agent: 'buddy',
        session: sessionID,
        busy,
        engine: OPENCODE_BIN,
        pid: process.pid,
      });
    }
    if (req.method === 'GET' && p === '/api/history') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 40), 200);
      let lines = [];
      try {
        lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
      } catch {}
      return json(res, 200, { messages: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
    }
    if (req.method === 'POST' && p === '/api/chat') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      return handleChat(req, res, body);
    }
    if (req.method === 'POST' && p === '/api/reset') {
      sessionID = null;
      try { fs.rmSync(SESSION_FILE, { force: true }); } catch {}
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/summon') {
      const script = path.join(ROOT, 'focus-buddy.ps1');
      try {
        const child = spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { windowsHide: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => log('summon out:', String(d).trim()));
        child.stderr.on('data', (d) => log('summon err:', String(d).trim()));
        child.on('error', (e) => log('summon spawn error:', e.message));
        child.on('exit', (code, signal) => log('summon child exit:', String(code), String(signal)));
        child.unref();
      } catch (e) {
        log('summon threw:', e && e.message);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/shutdown') {
      json(res, 200, { ok: true });
      return setTimeout(() => process.exit(0), 150);
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(405); res.end('method not allowed');
  } catch (err) {
    log('request error', err && err.message);
    if (!res.headersSent) json(res, 500, { error: String(err && err.message || err) });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`engine: ${OPENCODE_BIN}`);
  log(`session: ${sessionID || '(new)'}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

