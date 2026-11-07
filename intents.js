'use strict';
/**
 * Fast local intents. These run instantly on the PC without waking the language model.
 * Anything not matched here falls through to the OpenCode "buddy" agent, which can do
 * arbitrary work on the machine.
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || os.homedir();

function ps(script, timeout = 20000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

const APPS = {
  'chrome': 'chrome', 'google chrome': 'chrome', 'browser': 'chrome',
  'edge': 'msedge', 'microsoft edge': 'msedge',
  'notepad': 'notepad',
  'calculator': 'calc', 'calc': 'calc',
  'explorer': 'explorer', 'file explorer': 'explorer', 'files': 'explorer',
  'vscode': 'code', 'vs code': 'code', 'visual studio code': 'code', 'code': 'code',
  'spotify': 'spotify',
  'settings': 'ms-settings:', 'windows settings': 'ms-settings:',
  'cmd': 'cmd', 'command prompt': 'cmd', 'terminal': 'wt', 'windows terminal': 'wt',
  'powershell': 'powershell',
  'paint': 'mspaint', 'word': 'winword', 'excel': 'excel', 'powerpoint': 'powerpnt',
  'outlook': 'outlook', 'task manager': 'taskmgr', 'camera': 'microsoft.windows.camera:',
  'snipping tool': 'snippingtool', 'control panel': 'control',
  'store': 'ms-windows-store:', 'microsoft store': 'ms-windows-store:',
  'steam': 'steam', 'discord': 'discord', 'whatsapp': 'whatsapp', 'vlc': 'vlc',
  'obs': 'obs64', '7zip': '7zFM', 'clock': 'ms-clock:', 'calendar': 'outlookcal:',
  'photos': 'ms-photos:', 'xbox': 'xbox:',
};

const SITES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com',
  gmail: 'https://mail.google.com', github: 'https://github.com',
  chatgpt: 'https://chatgpt.com', netflix: 'https://www.netflix.com',
  reddit: 'https://www.reddit.com', twitter: 'https://x.com', x: 'https://x.com',
  facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com',
  amazon: 'https://www.amazon.com', wikipedia: 'https://www.wikipedia.org',
  maps: 'https://maps.google.com', drive: 'https://drive.google.com',
  stackoverflow: 'https://stackoverflow.com', linkedin: 'https://www.linkedin.com',
  twitch: 'https://www.twitch.tv', spotify: 'https://open.spotify.com',
  whatsapp: 'https://web.whatsapp.com', outlook: 'https://outlook.live.com',
  weather: 'https://weather.com', news: 'https://news.google.com',
};

const FOLDERS = {
  downloads: path.join(HOME, 'Downloads'),
  documents: path.join(HOME, 'Documents'),
  pictures: path.join(HOME, 'Pictures'),
  desktop: path.join(HOME, 'Desktop'),
  music: path.join(HOME, 'Music'),
  videos: path.join(HOME, 'Videos'),
  home: HOME,
};

let pending = null;

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(d = new Date()) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function clean(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').replace(/[.!?,;]+$/, '').trim();
}

function openTarget(target) {
  const safe = String(target).replace(/['"`]/g, '').trim();
  return ps(`Start-Process -FilePath '${safe.replace(/'/g, "''")}' -ErrorAction Stop`, 15000);
}
function openUrl(url) {
  return ps(`Start-Process '${url.replace(/'/g, "''")}'`, 15000);
}

async function handle(raw) {
  let text = clean(raw);
  if (!text) return null;

  // Strip a leading wake word if the recognizer kept it.
  const wake = text.match(/^(hey |ok |okay )?(buddy|jarvis)\b[,\s]*/);
  if (wake) text = text.slice(wake[0].length).trim();
  if (!text) return { reply: 'Yes sir?', action: 'wake' };

  // ---------- confirmations ----------
  if (/^(confirm\b|cancel\b|never ?mind\b|abort\b|stop$)/.test(text)) {
    if (/^(cancel|never ?mind|abort|stop$)/.test(text)) {
      const had = pending;
      pending = null;
      return { reply: had ? 'Cancelled.' : 'Nothing to cancel.', action: 'cancel' };
    }
    if (pending && /^confirm/.test(text)) {
      const job = pending; pending = null;
      if (job.type === 'shutdown') {
        await ps('shutdown /s /t 5');
        return { reply: 'Powering down in five seconds.', action: 'shutdown' };
      }
      if (job.type === 'restart') {
        await ps('shutdown /r /t 5');
        return { reply: 'Restarting in five seconds.', action: 'restart' };
      }
      if (job.type === 'emptybin') {
        const r = await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
        return { reply: 'Recycle bin emptied.', action: 'emptybin', ok: r.code === 0 };
      }
    }
    return null;
  }

  // ---------- identity / help ----------
  if (/^(hi|hello|hey|yo|good morning|good afternoon|good evening)$/.test(text)) {
    return { reply: `Hello sir. It is ${fmtTime()}. What do you need?`, action: 'greeting' };
  }
  if (/^(how are you|how's it going|how are you doing)$/.test(text)) {
    return { reply: 'Running clean, sir. All systems nominal.', action: 'status' };
  }
  if (/^(who are you|what are you|what's your name|what is your name)$/.test(text)) {
    return { reply: 'I am Buddy. Your personal assistant. I have full access to this machine.', action: 'identity' };
  }
  if (/^(what can you do|help|commands|what do you do)$/.test(text)) {
    return {
      reply: 'I can open apps and sites, search the web, take screenshots, handle files, run scripts and code, control volume and media, check the battery, lock or sleep the machine, and answer most questions. Just tell me what you want.',
      action: 'help',
    };
  }

  // ---------- time / date ----------
  if (/^(what('s| is)? the )?time( is it| now)?$/.test(text) || /^what time is it$/.test(text)) {
    return { reply: `It is ${fmtTime()}.`, action: 'time' };
  }
  if (/^(what('s| is)? (the )?(date|day)( today)?|what day is it)$/.test(text)) {
    return { reply: `Today is ${fmtDate()}.`, action: 'date' };
  }

  // ---------- battery ----------
  if (/battery|power (level|status)|how much charge/.test(text)) {
    const r = await ps(
      '$b=Get-CimInstance Win32_Battery | Select-Object -First 1;' +
      'if($b){"$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)"}else{"none"}'
    );
    if (!r.out || r.out === 'none') return { reply: 'I cannot find a battery on this machine, sir. It appears to be on mains power.', action: 'battery' };
    const [pct, st] = r.out.split('|');
    const charging = String(st) === '2' || String(st) === '6';
    return { reply: `Battery is at ${pct} percent${charging ? ' and charging' : ''}.`, action: 'battery' };
  }

  // ---------- volume / media ----------
  if (/(volume|sound) (up|higher)|^(turn it up|louder|volume up)$/.test(text)) {
    const presses = /a lot|much|max/.test(text) ? 15 : 5;
    await ps(`$w=New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]175) }`);
    return { reply: 'Volume up.', action: 'volume-up' };
  }
  if (/(volume|sound) (down|lower)|^(turn it down|quieter|volume down)$/.test(text)) {
    const presses = /a lot|much|max/.test(text) ? 15 : 5;
    await ps(`$w=New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]174) }`);
    return { reply: 'Volume down.', action: 'volume-down' };
  }
  if (/^(mute|silence)( (it|the sound|audio))?$/.test(text)) {
    await ps('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)');
    return { reply: 'Muted.', action: 'mute' };
  }
  if (/^unmute$/.test(text)) {
    await ps('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)');
    return { reply: 'Unmuted.', action: 'unmute' };
  }
  if (/^(pause|resume|play|stop)( the)?( music| media| playback| song)?$/.test(text)) {
    await ps('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]179)');
    return { reply: 'Done.', action: 'media-playpause' };
  }
  if (/^(next|skip)( track| song)?$/.test(text)) {
    await ps('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]176)');
    return { reply: 'Next track.', action: 'media-next' };
  }
  if (/^(previous|last|back)( track| song)?$/.test(text)) {
    await ps('$w=New-Object -ComObject WScript.Shell; $w.SendKeys([char]177)');
    return { reply: 'Previous track.', action: 'media-prev' };
  }

  // ---------- screen / power ----------
  if (/screenshot|screen shot|capture (the )?screen/.test(text)) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
      `$dir=Join-Path '${HOME}' 'Pictures\\Buddy'`,
      'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
      "$p=Join-Path $dir ('screen-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.png')",
      '$bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)',
      '$g.Dispose();$bmp.Dispose();$p',
    ].join(';');
    const r = await ps(script, 25000);
    if (r.code === 0 && r.out) return { reply: 'Screenshot saved to your Pictures Buddy folder.', action: 'screenshot', path: r.out };
    return { reply: 'I could not capture the screen, sir.', action: 'screenshot-failed' };
  }
  if (/^(lock)( the)?( computer| screen| pc| it| windows)?$/.test(text) || /^lock it up$/.test(text)) {
    await ps('rundll32.exe user32.dll,LockWorkStation');
    return { reply: 'Locking up.', action: 'lock' };
  }
  if (/^(minimi[sz]e)( everything| all| all windows| windows)?$/.test(text)) {
    await ps('(New-Object -ComObject Shell.Application).MinimizeAll()');
    return { reply: 'Minimised.', action: 'minimize' };
  }
  if (/^(sleep|hibernate)( the)?( computer| pc| machine| system)?$/.test(text)) {
    await ps('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    return { reply: 'Going to sleep.', action: 'sleep' };
  }
  if (/^(shut ?down|power off|turn off)( the)?( computer| pc| machine| system)?$/.test(text)) {
    pending = { type: 'shutdown' };
    return { reply: 'That will shut down the computer. Say confirm shutdown if you are sure.', action: 'shutdown-confirm' };
  }
  if (/^(restart|reboot)( the)?( computer| pc| machine| system)?$/.test(text)) {
    pending = { type: 'restart' };
    return { reply: 'That will restart the computer. Say confirm restart if you are sure.', action: 'restart-confirm' };
  }
  if (/empty (the )?(recycle|trash) bin|empty trash/.test(text)) {
    pending = { type: 'emptybin' };
    return { reply: 'That will permanently delete everything in the recycle bin. Say confirm to proceed.', action: 'emptybin-confirm' };
  }

  // ---------- web ----------
  const search = text.match(/^(?:search(?: the web)?(?: for)?|google|look up|find online)\s+(.+)$/);
  if (search) {
    const q = search[1];
    await openUrl('https://www.google.com/search?q=' + encodeURIComponent(q));
    return { reply: `Searching for ${q}.`, action: 'search' };
  }

  // ---------- open apps / sites / folders ----------
  const open = text.match(/^(?:open|launch|start|run|go to|visit|show me)\s+(?:the\s+)?(.+)$/);
  if (open) {
    let target = open[1].trim()
      .replace(/^(app|application|program|site|website)\s+/, '')
      .replace(/^(my|the)\s+/, '');

    const folder = target.match(/^(downloads|documents|pictures|desktop|music|videos|home)( folder)?$/);
    if (folder) {
      await openTarget(FOLDERS[folder[1]]);
      return { reply: `Opening ${folder[1]}.`, action: 'open-folder' };
    }

    if (APPS[target]) {
      const r = await ps(`Start-Process '${APPS[target].replace(/'/g, "''")}' -ErrorAction Stop`, 15000);
      if (r.code === 0) return { reply: `Opening ${target}.`, action: 'open-app' };
    }

    // "open youtube dot com", "open example.com", "open https://..."
    const siteText = target.replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
    if (/^https?:\/\//i.test(siteText)) {
      await openUrl(siteText);
      return { reply: 'Opening it.', action: 'open-url' };
    }
    if (/^[a-z0-9-]+(\.[a-z]{2,})+(\/.*)?$/i.test(siteText)) {
      await openUrl('https://' + siteText);
      return { reply: `Opening ${siteText}.`, action: 'open-url' };
    }
    if (SITES[target]) {
      await openUrl(SITES[target]);
      return { reply: `Opening ${target}.`, action: 'open-site' };
    }
    if (SITES[target.replace(/\s+/g, '')]) {
      await openUrl(SITES[target.replace(/\s+/g, '')]);
      return { reply: `Opening ${target}.`, action: 'open-site' };
    }

    // Last resort for a bare word: try the app, otherwise let the agent decide.
    if (/^[a-z0-9 ._-]{2,30}$/.test(target) && !/\s/.test(target)) {
      const r = await ps(`Start-Process '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`, 10000);
      if (r.code === 0) return { reply: `Opening ${target}.`, action: 'open-anything' };
    }
    return null;
  }

  if (/^(new session|start over|forget (this|our) conversation|clear (the )?conversation|reset)$/.test(text)) {
    return { reply: 'Fresh start, sir.', action: 'reset', reset: true };
  }

  return null;
}

module.exports = { handle };
