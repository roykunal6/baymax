// Offline command parser. Turns a spoken/typed sentence into an action object.
// Pure: no DOM, unit-tested in tests/parser.test.mjs.
//
// Every result is an action with a `type`, the same shape that routines and the
// AI endpoint produce, so a single executor (actions.js) runs all of them.

import { parseTime, parseDuration, tidy } from './timeparse.js';

const SITES = {
  google: 'https://www.google.com', gmail: 'https://mail.google.com', youtube: 'https://www.youtube.com',
  calendar: 'https://calendar.google.com', 'google calendar': 'https://calendar.google.com',
  maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com', drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com', whatsapp: 'https://web.whatsapp.com', linkedin: 'https://www.linkedin.com',
  'zoho mail': 'https://mail.zoho.in', zoho: 'https://mail.zoho.in', trello: 'https://trello.com',
  chatgpt: 'https://chat.openai.com', claude: 'https://claude.ai', github: 'https://github.com',
  outlook: 'https://outlook.office.com', news: 'https://news.google.com', weather: 'https://www.google.com/search?q=weather',
};

const FILLER = /^(?:hey|hi|hello|ok|okay|please|baymax|bay max|assistant|could you|can you|would you|kindly)[\s,]+/i;

function clean(text) {
  let t = String(text || '').trim();
  let prev;
  do { prev = t; t = t.replace(FILLER, ''); } while (t !== prev);
  return t.replace(/[.!]+$/, '').replace(/\s+please$/i, '').trim();
}

export function normalizeUrl(target) {
  const t = target.toLowerCase().trim().replace(/^the\s+/, '').replace(/\s+(website|site|app)$/, '');
  if (SITES[t]) return SITES[t];
  if (/^https?:\/\//.test(t)) return t;
  const dotted = t.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/.test(dotted)) return 'https://' + dotted;
  return null;
}

/** Find a routine whose name or phrases match the text. */
export function matchRoutine(text, routines = []) {
  const t = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const runMatch = t.match(/^(?:run|start|do|execute|trigger|begin)\s+(?:my\s+|the\s+)?(.+?)(?:\s+routine)?$/);
  for (const r of routines) {
    const name = r.name.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const phrases = (r.phrases || []).map((p) => p.toLowerCase().replace(/[^\w\s]/g, '').trim()).filter(Boolean);
    if (phrases.includes(t)) return r;
    if (runMatch) {
      const wanted = runMatch[1].replace(/\s+routine$/, '');
      if (wanted === name || wanted === name.replace(/\s+routine$/, '')) return r;
    }
  }
  return null;
}

function stripQuotes(s) { return s.replace(/^["'“‘]+|["'”’]+$/g, '').trim(); }

/**
 * @param {string} input
 * @param {{routines?: Array, now?: Date}} ctx
 * @returns {{type: string, [k: string]: any}}
 */
export function parseCommand(input, ctx = {}) {
  const now = ctx.now || new Date();
  const text = clean(input);
  const lower = text.toLowerCase();
  if (!text) return { type: 'unknown', text: '' };

  // Routines first, so a user's own phrases win over built-ins.
  const routine = matchRoutine(text, ctx.routines);
  if (routine) return { type: 'run_routine', id: routine.id, name: routine.name };

  // Small talk / meta
  if (/^(help|what can you do|commands|show commands)\??$/.test(lower)) return { type: 'help' };
  if (/^(stop|cancel|quiet|shut up|be quiet|never ?mind)$/.test(lower)) return { type: 'stop' };
  if (/^(hello|hi|hey|good (morning|afternoon|evening))( there)?$|^(?:hey |hi |hello |ok |okay )?(?:baymax|bay max)$/.test(lower)) return { type: 'greet' };
  if (/^(thanks|thank you|thank you very much|cheers)$/.test(lower)) return { type: 'thanks' };
  if (/\bwhat(?:'s| is)? the time\b|\bwhat time is it\b|^time$/.test(lower)) return { type: 'time' };
  if (/\bwhat(?:'s| is)? (?:the |today's )?date\b|\bwhat day is (?:it|today)\b|^date$/.test(lower)) return { type: 'date' };
  if (/^(?:give me |start )?(?:my )?(?:daily )?(?:briefing|brief|summary|agenda)(?: for today)?$|^what(?:'s| is) (?:on )?my (?:day|agenda|plan)(?: today| for today)?\??$/.test(lower)) {
    return { type: 'briefing' };
  }

  // Timer: "set a timer for 5 minutes", "timer 10 minutes", "5 minute timer"
  let m = lower.match(/^(?:set\s+(?:a|an)\s+|start\s+(?:a|an)\s+)?timer\s+(?:for\s+)?(.+)$/) ||
          lower.match(/^(?:set\s+(?:a|an)\s+|start\s+(?:a|an)\s+)?(.+?)\s+timer$/);
  if (m) {
    const secs = parseDuration(m[1]);
    if (secs) return { type: 'timer', seconds: secs };
  }

  // Reminders: "remind me to X in 10 minutes", "remind me tomorrow at 9 to X", "remind me at 5 about X"
  m = text.match(/^(?:set\s+(?:a\s+)?reminder|remind\s+me|reminder|don'?t let me forget)\b\s*(.*)$/i);
  if (m) {
    const body = m[1];
    const t = parseTime(body, now);
    let title = tidy((t ? t.rest : body).replace(/^(?:to|that|about|for|of)\s+/i, '').replace(/\s+(?:to|that|about)$/i, ''));
    title = title.replace(/^(?:to|that|about|for)\s+/i, '');
    if (!t) return { type: 'remind', title: title || 'Reminder', due: null, needsTime: true };
    return { type: 'remind', title: title || 'Reminder', due: t.date.toISOString() };
  }

  // Tasks: list
  if (/^(?:what(?:'s| is| are)|show|list|read|tell me|get)\b.*\b(?:tasks?|to-?dos?|to do list|todo list)\b/.test(lower) ||
      /^(?:my\s+)?(?:tasks|to-?dos?)$/.test(lower) || /^what do i (?:have|need) to do/.test(lower)) {
    const filter = /\btoday\b/.test(lower) ? 'today' : /\b(?:overdue|late)\b/.test(lower) ? 'overdue' : 'open';
    return { type: 'list_tasks', filter };
  }

  // Tasks: clear completed
  if (/^(?:clear|remove|delete)\s+(?:all\s+)?(?:the\s+)?(?:completed|done|finished)\s+(?:tasks|items|to-?dos)$/.test(lower)) {
    return { type: 'clear_completed' };
  }

  // Tasks: complete — "mark buy milk as done", "complete task buy milk", "I finished buy milk", "done with X"
  m = lower.match(/^(?:mark|tick|check off)\s+(?:task\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/) ||
      lower.match(/^(?:complete|finish|finished|done with|i (?:have )?(?:finished|completed|done))\s+(?:the\s+)?(?:task\s+)?(.+)$/) ||
      lower.match(/^(?:check off|tick off)\s+(?:task\s+)?(.+)$/);
  if (m) return { type: 'complete_task', query: stripQuotes(m[1]) };

  // Tasks: delete
  m = lower.match(/^(?:delete|remove|cancel|drop)\s+(?:the\s+)?(?:task|to-?do|reminder)\s+(.+)$/);
  if (m) return { type: 'delete_task', query: stripQuotes(m[1]) };

  // Tasks: add — "add task X", "add X to my list", "new task X tomorrow", "I need to X", "todo X"
  m = text.match(/^(?:add|create|new|make)\s+(?:a\s+)?(?:new\s+)?(?:task|to-?do|item)\s*(?:to\s+|called\s+|:)?\s*(.+)$/i) ||
      text.match(/^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+)?(?:task\s+list|to-?do\s+list|tasks|list|to-?dos)$/i) ||
      text.match(/^(?:to-?do|task)\s*:?\s+(.+)$/i) ||
      text.match(/^i\s+(?:need|have|got)\s+to\s+(.+)$/i);
  if (m) {
    const t = parseTime(m[1], now);
    const title = stripQuotes(tidy(t ? t.rest : m[1]));
    return { type: 'add_task', title, due: t ? t.date.toISOString() : null };
  }

  // Notes
  m = text.match(/^(?:take\s+a\s+note|make\s+a\s+note|note\s+down|note\s+that|note|write\s+down|jot\s+down|remember\s+that|save\s+(?:a\s+)?note)\s*:?\s*(?:that\s+)?(.+)$/i);
  if (m) return { type: 'add_note', text: stripQuotes(m[1]) };
  if (/^(?:read|show|list|what are|open)\s+(?:me\s+)?(?:my\s+)?(?:the\s+)?notes$/.test(lower)) return { type: 'list_notes' };

  // Email: "email ravi@x.com about invoice saying please pay", "send an email to x subject y body z"
  m = text.match(/^(?:send\s+(?:an?\s+)?)?(?:e-?mail|mail)\s+(?:to\s+)?(\S+@\S+|[\w .]+?)(?:\s+(?:about|subject|with subject|regarding|re)\s+(.+?))?(?:\s+(?:saying|that says|message|body|and say|telling (?:them|him|her))\s+(.+))?$/i);
  if (m) {
    const to = m[1].trim().replace(/\s+at\s+/i, '@').replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
    return { type: 'email', to, subject: m[2] ? tidy(m[2]) : '', body: m[3] ? tidy(m[3]) : '' };
  }

  // Search
  m = lower.match(/^(?:search|google|look up|search for|search the web for|find)\s+(?:for\s+)?(.+)$/);
  if (m) return { type: 'search', query: m[1].replace(/\s+on (?:google|the web)$/, '') };

  // Open a site / app
  m = lower.match(/^(?:open|launch|go to|show me|visit|navigate to|start)\s+(.+)$/);
  if (m) {
    const url = normalizeUrl(m[1]);
    if (url) return { type: 'open', url };
  }

  // "call X" / "dial X"
  m = lower.match(/^(?:call|dial|phone)\s+(\+?[\d\s-]{6,})$/);
  if (m) return { type: 'open', url: 'tel:' + m[1].replace(/[\s-]/g, '') };

  return { type: 'unknown', text };
}

export const HELP_TEXT = [
  'Add task: “add task send FCL quote to Ravi tomorrow at 11”',
  'Reminder: “remind me to call the bank in 20 minutes”',
  'Tasks: “what are my tasks today” · “mark send quote as done”',
  'Notes: “note: container ref MSKU4471 lands Friday” · “read my notes”',
  'Timer: “set a timer for 5 minutes”',
  'Email: “email ravi@example.com about invoice saying please share by Friday”',
  'Web: “open gmail” · “search for freight rates Mumbai to Dubai”',
  'Briefing: “what’s my day” · Time: “what time is it”',
  'Routines: say a routine’s phrase, or “run morning routine”',
];
