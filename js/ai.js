// AI fallback for commands the offline parser doesn't understand.
// - Inside claude.ai: asks Claude through the page's built-in `sample` capability (no server needed).
// - On your own website: posts to api/assistant.php, which holds the API key server-side.
// Both return { reply, actions[] } in the same shape the offline parser produces.

import { state } from './store.js';

const ACTION_TYPES = [
  'add_task', 'remind', 'timer', 'add_note', 'list_tasks', 'list_notes', 'complete_task',
  'delete_task', 'open', 'search', 'email', 'briefing', 'run_routine', 'time', 'date',
];

let sampler = null;
const inClaude = typeof window !== 'undefined' && typeof window.claude?.use === 'function';
const ready = inClaude ? window.claude.use('sample').then((s) => { sampler = s; }).catch(() => {}) : Promise.resolve();

/** True when AI can be used without the user configuring a server (inside claude.ai). */
export function builtInAI() { return !!sampler; }
export { ready as aiReady };

function context(text) {
  return {
    now: new Date().toString(),
    tasks: state.tasks.filter((t) => !t.done && !t.isTimer).slice(0, 30).map((t) => ({ title: t.title, due: t.due })),
    routines: state.routines.map((r) => r.name),
    history: state.history.slice(-6).map(({ role, text: t }) => ({ role, text: t })),
    text,
  };
}

function clean(data) {
  const actions = (Array.isArray(data?.actions) ? data.actions : []).slice(0, 10).filter((a) =>
    a && ACTION_TYPES.includes(a.type) && (a.type !== 'open' || /^https:\/\//i.test(String(a.url || ''))));
  return { reply: typeof data?.reply === 'string' ? data.reply : '', actions };
}

const PROMPT = `You are Baymax, the brain of a voice-controlled personal assistant app. The user spoke a command that the app's
simple built-in parser did not understand. Turn it into actions the app can run, and a short spoken reply.

Action types and fields:
- add_task {title, due?}   due = ISO 8601 datetime with the user's UTC offset, or omitted
- remind {title, due}      always include due; pick a sensible time if the user was vague
- timer {seconds}
- add_note {text}
- list_tasks {filter: "open"|"today"|"overdue"}
- list_notes {}
- complete_task {query} / delete_task {query}   query = words identifying an existing task
- open {url}               full https URL
- search {query}
- email {to, subject, body}
- briefing {}
- run_routine {name}       must exactly match one of the user's routine names
- time {} / date {}

Rules: the reply is spoken aloud, one or two short friendly sentences, no markdown. Don't repeat what an
action will already say. If nothing fits, return no actions and answer briefly in the reply. Never invent
email addresses or URLs the user did not give, except well-known public websites.

Reply with only JSON like {"reply": "...", "actions": [{"type": "remind", "title": "ring the bank", "due": "2026-11-18T12:30:00+05:30"}]}`;

export async function askAI(text) {
  await ready;
  if (sampler) {
    const c = context(text);
    try {
      const data = await sampler.json(
        `${PROMPT}\n\nUser's local date/time: ${c.now}\nOpen tasks: ${JSON.stringify(c.tasks)}\n` +
        `Routine names: ${JSON.stringify(c.routines)}\nRecent conversation: ${JSON.stringify(c.history)}\n\nCommand: ${text}`,
        { modelTier: 'quick', cache: false },
      );
      return clean(data);
    } catch (e) {
      const why = { not_granted: 'permission was declined', rate_limited: 'too many requests just now' }[e?.code];
      throw new Error(why || e?.message || 'no answer');
    }
  }

  const { aiUrl, aiPin } = state.settings;
  const c = context(text);
  const res = await fetch(aiUrl || 'api/assistant.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Assistant-Pin': aiPin || '' },
    body: JSON.stringify(c),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `AI service error ${res.status}`);
  return clean(data);
}
