# Baymax: Plan

## Goal
A personal assistant you **talk to**. It understands spoken commands, manages tasks,
reminders and notes, and runs **automations** (routines) that chain several actions
together, triggered by a phrase or a time of day.

## Guiding principles
- **Works with zero setup.** Voice, tasks, reminders and routines run fully in the browser.
  Nothing leaves your device unless you turn on AI mode.
- **Installable.** A PWA you can "Add to Home Screen" on your phone or desktop.
- **Smart when you want it.** Optional AI mode sends unrecognised commands to Claude
  (through a small PHP endpoint on your own server, so the API key never reaches the browser).
- **Fits this repo.** Plain HTML/CSS/JS + PHP, the same stack the TeamGlobal site already uses.
  No build step.

## Architecture
```
baymax/
├── index.html              App shell (tabs: Assistant · Tasks · Routines · Notes · Settings)
├── manifest.webmanifest    PWA manifest
├── sw.js                   Service worker (offline cache)
├── icon.svg
├── css/app.css
├── js/
│   ├── app.js              UI + wiring
│   ├── voice.js            Speech-to-text (Web Speech API) + text-to-speech
│   ├── parser.js           Offline natural-language command parser  (unit tested)
│   ├── timeparse.js        "in 10 minutes", "tomorrow at 9am", "at 5:30 pm"  (unit tested)
│   ├── store.js            localStorage persistence, export/import
│   ├── actions.js          Executes parsed intents (add task, remind, open, email…)
│   ├── routines.js         Automation engine: triggers -> ordered action list
│   ├── scheduler.js        1-second tick: due reminders + timed routines -> notifications
│   └── ai.js               Optional call to api/assistant.php
├── api/
│   ├── assistant.php       Claude-backed intent parser (structured JSON output)
│   ├── composer.json       anthropic-ai/sdk
│   └── config.sample.php   Copy to config.php (git-ignored) for API key + access PIN
└── tests/                  node --test for parser + time parsing
```

## Phase 1: Core (built now)
1. **Voice in / voice out:** mic button (tap to talk), live transcript, typed fallback, spoken replies (toggle).
2. **Command parser** (offline), understands:
   - `add task buy milk` · `remind me to call Ravi in 20 minutes` · `remind me tomorrow at 9am to send invoice`
   - `what are my tasks` · `complete task buy milk` · `delete task …` · `clear completed tasks`
   - `note: shipment ref 4471 arrives Friday` · `read my notes`
   - `set a timer for 5 minutes`
   - `open gmail` / `open youtube.com` · `search for container rates Mumbai`
   - `email ravi@example.com about invoice saying please send by Friday` (opens your mail app pre-filled)
   - `what time is it` · `what's the date` · `help`
   - `run morning routine` / any custom routine phrase
3. **Tasks & reminders:** list with due times, overdue highlight, browser notifications + chime.
4. **Notes:** quick voice notes, searchable.
5. **Routines (automation):**
   - Triggers: *voice phrase*, *daily at HH:MM* (with weekday selection), *manual button*.
   - Actions: speak text, add task, add reminder, open URL, show tasks, compose email, call a webhook
     (Zapier / Make / n8n / IFTTT → connect anything), wait N seconds.
   - Starter templates: Morning briefing, End-of-day wrap-up, Start work.
6. **Settings:** voice on/off, voice choice, language, AI mode + PIN, export/import backup, wipe data.

## Phase 2: AI mode (built now, optional)
- When the offline parser can't understand a command, it goes to `api/assistant.php`.
- Claude returns a strict JSON list of actions in the same format as the offline parser,
  so the same executor runs it. Handles fuzzy phrasing ("nudge me before lunch to ring the bank").
- Protected by a PIN, the key lives in `config.php` on the server only.

## Phase 3: Ideas / improvements (suggested next)
| Idea | Value |
|------|-------|
| Google Calendar / Gmail sync (OAuth) | "What's on today?", real email send, not just compose |
| Trello / Zoho integration | Push tasks to boards; read freight enquiries from Zoho Mail |
| Freight shortcuts | "New FCL quote for Mumbai to Jebel Ali, 2×40HC" pre-fills the existing quote forms |
| Wake word ("Hey Assistant") | Hands-free; needs an on-device model (e.g. Porcupine) |
| Push notifications via server | Reminders fire even when the app is closed |
| Location triggers | "When I reach office, show today's tasks" |
| Multi-device sync | Small PHP + SQLite backend, login |
| Daily digest email | Server cron emails tomorrow's tasks every evening |

## Security notes
- No secrets in the browser or in git. `config.php` is git-ignored.
- Webhook routines only call URLs you entered yourself.
- **Existing issue:** `Emailer.php` in the repo root has an SMTP password committed in plain text.
  It should be rotated and moved to a config file outside git.

## Testing
- `npm test` covers the parser and time parsing.
- `php -l` on the PHP endpoint.
- Headless Chromium smoke test of the UI (typed command → task created → routine runs).
