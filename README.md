# Baymax
Kunal Roy's Personal Assistant: a voice-driven app for tasks, reminders, notes and routines.

A personal assistant you talk to. It runs in the browser, can be installed on your phone,
and needs no account. See [PLAN.md](PLAN.md) for the design and roadmap.

## What it does
- **Voice in, voice out:** tap the mic (or press Ctrl/⌘ + K) and speak. Replies are read aloud.
- **Tasks & reminders:** “add task send FCL quote tomorrow at 11”, “remind me to call the bank in 30 minutes”.
- **Timers, notes, email drafts, web:** “set a timer for 5 minutes”, “note: …”, “email ravi@x.com about invoice saying …”, “open gmail”.
- **Daily briefing:** “what’s my day?”
- **Routines (automation):** chain actions (speak, add task, reminder, timer, open site, compose email,
  call a Zapier/Make/n8n webhook, wait…) and trigger them by a voice phrase, a daily time, or a tap.
  Three starter routines are included. Edit them in the **Routines** tab.
- **AI mode (optional):** anything the built-in parser doesn’t understand goes to Claude, which turns it
  into the same actions. Example: “nudge me before lunch to ring the bank”.

Say **“help”** in the app for the full list.

## Run it
It is static HTML/JS, so any web server works. Voice input needs **HTTPS or localhost**.

```bash
php -S localhost:8000        # then open http://localhost:8000
```

On your live site, upload these files to a folder (e.g. `baymax/`) and open `https://your-domain/baymax/`.
On a phone, use the browser menu → **Add to Home Screen** to install it as an app.

**Browser support:** voice input works in Chrome, Edge and Safari. Firefox can type commands and
hear replies, but has no speech recognition.

## Use it on your phone
**Quickest:** the app is also published as a private claude.ai page. Open the link in your phone's
browser while signed in to claude.ai. Voice input works in Chrome on Android; on iPhone you type
commands. Inside claude.ai, AI mode works without any server setup.
Rebuild that page with `node tools/build-artifact.mjs <out.html>`.

**Full app (installable, voice on iPhone too, notifications):** upload these files to any HTTPS
website you own, open it in Safari (iPhone) or Chrome (Android), then Share → **Add to Home Screen**
(iPhone) or menu → **Install app** (Android).

## Enable AI mode (optional)
1. `cd api && composer install`
2. `cp config.sample.php config.php` and set `anthropic_api_key` and a `pin`.
   (`config.php` is git-ignored. Or set `ANTHROPIC_API_KEY` as a server environment variable.)
3. In the app: **Settings → AI mode**, tick it and enter the same PIN.

The key stays on your server. The endpoint checks the PIN, rate-limits per IP, and only lets
through known, safe action types (it can’t trigger webhooks or open non-https links).

## Tests
```bash
npm test          # parser + time-parsing unit tests (Node 18+)
```

## Good to know
- Data lives in this browser’s storage only. Use **Settings → Export** to back up or move devices.
- Reminders and timed routines fire while the app is open (it can be in a background tab).
  Allow notifications so you see them. Reminders when the app is fully closed need a server-side
  push service (listed in PLAN.md phase 3).
- Deep links: `index.html?q=what%27s%20my%20day` runs a command on open. Handy for phone shortcuts.

## Hosting
- **GitHub Pages (free, public repos):** Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`.
- **Netlify (free):** import this repo; `netlify.toml` configures it.
- **MilesWeb / cPanel:** Git Version Control → clone this repo → Deploy HEAD Commit. `.cpanel.yml` publishes to `public_html/baymax`.
- **Upload zip:** `tools/package.sh baymax.zip` builds an upload-ready zip including the AI libraries.

AI mode with your own API key needs PHP (MilesWeb / cPanel). On static hosts everything else works,
and the claude.ai version has AI built in.
