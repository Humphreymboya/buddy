# BUDDY

A JARVIS-style voice assistant that lives on this PC.

Say **"Buddy"** and the HUD wakes up, listens to what you say, **actually does it** on the
machine (open apps, move files, run scripts, write code, browse, change settings), and talks
back. It is not a chatbot in a browser tab — the requests are executed by a dedicated
OpenCode agent with full shell access to this computer.

```
  "Buddy, what's my battery?"
  "Buddy, open Chrome and search for cheap flights to Tokyo."
  "Buddy, tidy up my Downloads folder into subfolders by file type."
  "Buddy, screenshot this and save it to my Pictures folder."
  "Buddy, make a Python script that renames every photo by date, then run it."
```

---

## Quick start

### From GitHub

```powershell
git clone https://github.com/Humphreymboya/buddy.git
cd buddy
.\install.ps1
```

Everything resolves relative to the folder you clone into, so it does not have to live at
`%USERPROFILE%\Buddy`. Once `install.ps1` has run, the Desktop shortcut and the startup entry
point at wherever the clone is, and the app can be updated with `git pull` like any other repo.

### Already on disk

```powershell
cd $env:USERPROFILE\Buddy
.\install.ps1
```

That creates a **Buddy** shortcut on the Desktop, adds it to startup, and launches it.
After that just say **"Buddy"** (or press `Ctrl+Alt+B` to summon the window).

If you only want to launch it now: `.\start-buddy.ps1`
To shut everything down: `.\stop-buddy.ps1`

---

## How it works

```
 microphone ──► Chrome Web Speech ──► HUD (public/)
                                        │  POST /api/chat
                                        ▼
                                  server.js (Node, port 7777)
                                   │              │
                        local intents       OpenCode CLI
                        (instant)           agent "buddy"
                                   │              │
                                   └──────► your PC: shell, files, apps, web
```

* **The HUD** (`public/`) is a canvas reactor with live waveform, conversation log and
  activity feed. It runs as a Chrome/Edge app window (`--app`), so it looks like a native app.
* **The server** (`server.js`) is zero-dependency Node. It streams the agent's work to the HUD.
* **Local intents** (`intents.js`) answer ~20 common commands in milliseconds — time, date,
  open app, open site, search, volume, media keys, screenshot, lock, minimize, battery,
  sleep, shutdown with confirmation.
* **Everything else** goes to the `buddy` agent (`~/.config/opencode/agent/buddy.md`),
  which has full access to this machine and streams back short, speakable answers.

Conversation context is kept in an OpenCode session (`data/session.json`), so follow-ups
work: *"open my documents folder" → "now zip everything in there"*.

---

## Voice & keys

| Action | How |
| --- | --- |
| Wake it | say **"Buddy"** or **"Hey Buddy"** (also answers to "Jarvis") |
| Talk | just speak after the chime |
| Push to talk | hold `Space` (when not typing) |
| Summon / focus window | `Ctrl+Alt+B` |
| Type instead | use the input bar |
| Go back to standby | "go to sleep", "stand by", "that's all" |
| Stop it talking | "be quiet" |
| New conversation | "new session", or the `RESET` button |

It stops listening while it speaks, so it does not answer itself.

---

## Safety

* The agent is instructed to **ask before destructive actions** (mass deletes, uninstalls,
  shutdown/restart, network changes). Shutdown and empty-recycle-bin are two-step here:
  say it once, then say **"confirm"**.
* Hard **deny rules** in the agent profile block catastrophic commands (disk formatting,
  `diskpart`, boot config edits, Windows-folder deletion, Defender tampering).
* Every request, tool call and reply is logged to `data/audit.log`.
* The server only binds to `127.0.0.1` — nothing on your network can reach it.
* Speech recognition uses Chrome/Edge's online recognizer (Google). If you would rather not
  send audio to a cloud recognizer, use the text box or push-to-talk only.

---

## Files

```
Buddy/
├─ server.js              HTTP + SSE bridge, session/audit/history
├─ intents.js             instant local commands
├─ start-buddy.ps1        starts server + hotkey watcher + HUD
├─ stop-buddy.ps1         stops everything
├─ install.ps1            shortcuts + autostart + agent profile
├─ hotkey.ps1             global Ctrl+Alt+B
├─ focus-buddy.ps1        brings the HUD to front
├─ start-buddy.vbs        silent launcher
├─ package.json           npm start / stop / install-app / serve
├─ agent/buddy.md         the agent's persona, rules and deny-list
├─ public/                HUD (index.html, styles.css, app.js)
├─ data/                  session.json, history.jsonl, audit.log  (git-ignored)
└─ logs/                  server output                          (git-ignored)
```

`data/`, `logs/` and `chrome-profile/` are deliberately **not** in the repo — they hold your
conversations, session id, audit trail and browser profile. Fresh clones create them on first run.

---

## Requirements

* Windows 10/11
* Node.js 18+
* Chrome or Edge (for voice in/out and the app window)
* OpenCode CLI signed in to a model (`opencode auth login`) — this is the brain
* A microphone

---

## Troubleshooting

**It doesn't hear "Buddy".** Speak clearly, check the mic icon is not greyed out, and make
sure no other app is holding the microphone. Click the mic button once to grant permission.
Chrome's recognizer occasionally drops out; the HUD restarts it automatically.

**It hears itself.** Keep speakers at a moderate level; the app already mutes the mic while
speaking and restarts it 0.5 s afterwards.

**"Engine offline".** Run `.\start-buddy.ps1`, then check `logs\server.log` and `logs\server.err.log`.

**Voice is robotic / wrong accent.** It prefers a British male voice (Google UK English Male,
then Microsoft Ryan/George/David). Install additional Windows voices under
*Settings → Time & Language → Speech* for more choice.

**Nothing happens when I ask for something.** Check `data/audit.log` — every request and tool
call is recorded there. If the agent needed a permission it could not get, the fault appears
in the HUD activity feed.

**Start over clean.** Delete `data\session.json` (or say "new session").
