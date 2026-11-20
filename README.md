# Baymax
Kunal Roy's Personal Assistant: a voice-driven app for tasks, reminders, notes and routines.

A personal assistant you talk to. It runs in the browser, can be installed on your phone,
and needs no account. See [PLAN.md](PLAN.md) for the design and roadmap.

## What it does
- **Home dashboard:** Day, Week and Month views of your tasks, payments, money and habits.
- **Voice in, voice out:** tap the mic and speak. Baymax replies out loud, and asks a follow-up question when a command is incomplete.
- **Money:** log spends by voice (“spent 450 on lunch with HDFC card”), track credit cards, EMIs, SIPs,
  bills and invoices (e.g. Thestral), get reminders before due dates, and warnings when you’re overspending:
  pace vs budget, outflow vs income, savings rate, EMI load, card limits, overdue bills and invoices.
- **Tasks & reminders:** “add task send FCL quote tomorrow at 11”, “remind me to call the bank in 30 minutes”.
- **Habits:** daily check-offs with streaks (“add habit meditate”, “done meditate”).
- **Routines (automation):** chain steps and trigger them by a phrase, a daily time, or a tap.
- **Notes, timers, email drafts, web search.**
- **AI mode (optional, needs PHP hosting):** free-form commands go to Claude through `api/assistant.php`.

Say **“help”** in the app for example commands.

### Money commands
| Say | What happens |
|---|---|
| “spent 2.5k on groceries with HDFC card” | Logs a spend (category guessed, card matched) |
| “how am I doing this month” | Budget pace, savings, alerts |
| “what’s due this week” / “… this month” | Upcoming and overdue payments |
| “add EMI car loan 18500 on 10th for 24 months” | Monthly EMI with end date |
| “add SIP 5000 Axis Bluechip on 7th” | Monthly SIP reminder |
| “add bill electricity 2400 due on 5th” | Monthly bill |
| “add Thestral invoice 45000 due next Friday” | Invoice to receive |
| “Thestral invoice T-12 paid” / “received 45000 from Thestral” | Marks an invoice paid |
| “paid car loan EMI” / “paid HDFC card bill” | Marks this month’s payment done |
| “set budget to 40k” / “my salary is 1.5 lakh” | Monthly numbers |

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
Regenerate the app icons from the avatar with `node tools/make-icons.mjs`.

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
