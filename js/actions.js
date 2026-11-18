// Executes action objects produced by the parser, a routine, or the AI endpoint.
// Each executor returns { reply, items?, link? } and the UI decides how to show/speak it.

import { state, addTask, updateTask, removeTask, findTask, addNote, save, logActivity } from './store.js';
import { formatDue, formatDuration } from './timeparse.js';
import { HELP_TEXT } from './parser.js';

export const ACTION_TYPES = {
  speak: { label: 'Say something', fields: [{ key: 'text', label: 'Text', type: 'text' }] },
  briefing: { label: 'Daily briefing', fields: [] },
  add_task: { label: 'Add task', fields: [{ key: 'title', label: 'Task', type: 'text' }, { key: 'dueIn', label: 'Due in (minutes, optional)', type: 'minutes' }] },
  remind: { label: 'Set reminder', fields: [{ key: 'title', label: 'Reminder', type: 'text' }, { key: 'dueIn', label: 'In (minutes)', type: 'minutes' }] },
  timer: { label: 'Start timer', fields: [{ key: 'seconds', label: 'Minutes', type: 'minutes-as-seconds' }] },
  list_tasks: { label: 'Read my tasks', fields: [{ key: 'filter', label: 'Which', type: 'select', options: ['open', 'today', 'overdue'] }] },
  add_note: { label: 'Save a note', fields: [{ key: 'text', label: 'Note', type: 'text' }] },
  open: { label: 'Open website / app', fields: [{ key: 'url', label: 'URL', type: 'url' }] },
  search: { label: 'Web search', fields: [{ key: 'query', label: 'Search for', type: 'text' }] },
  email: { label: 'Compose email', fields: [{ key: 'to', label: 'To', type: 'text' }, { key: 'subject', label: 'Subject', type: 'text' }, { key: 'body', label: 'Message', type: 'textarea' }] },
  webhook: { label: 'Call webhook (Zapier / Make / n8n)', fields: [{ key: 'url', label: 'Webhook URL', type: 'url' }, { key: 'method', label: 'Method', type: 'select', options: ['POST', 'GET'] }, { key: 'body', label: 'JSON body (optional)', type: 'textarea' }] },
  wait: { label: 'Wait', fields: [{ key: 'seconds', label: 'Seconds', type: 'number' }] },
};

export function describeAction(a) {
  switch (a.type) {
    case 'speak': return `Say “${a.text || ''}”`;
    case 'briefing': return 'Give my daily briefing';
    case 'add_task': return `Add task “${a.title || ''}”${a.dueIn ? ` due in ${formatDuration(a.dueIn)}` : ''}`;
    case 'remind': return `Remind me “${a.title || ''}” in ${formatDuration(a.dueIn || 0)}`;
    case 'timer': return `Start timer: ${formatDuration(a.seconds || 0)}`;
    case 'list_tasks': return `Read my ${a.filter || 'open'} tasks`;
    case 'add_note': return `Save note “${a.text || ''}”`;
    case 'open': return `Open ${a.url || ''}`;
    case 'search': return `Search the web for “${a.query || ''}”`;
    case 'email': return `Compose email to ${a.to || '…'}`;
    case 'webhook': return `${a.method || 'POST'} webhook ${shortUrl(a.url)}`;
    case 'wait': return `Wait ${a.seconds || 0}s`;
    default: return a.type;
  }
}

function shortUrl(u = '') { try { return new URL(u).host; } catch { return u; } }

function resolveDue(a) {
  if (a.due) return a.due;
  if (a.dueIn) return new Date(Date.now() + Number(a.dueIn) * 1000).toISOString();
  return null;
}

function openUrl(url, label) {
  let opened = null;
  if (url.startsWith('mailto:') || url.startsWith('tel:')) {
    window.location.href = url;
    opened = true;
  } else {
    opened = window.open(url, '_blank', 'noopener');
  }
  return { link: { url, label }, blocked: !opened };
}

const greetingWord = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

function taskFilter(filter) {
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const open = state.tasks.filter((t) => !t.done && !t.isTimer);
  if (filter === 'today') return open.filter((t) => t.due && new Date(t.due) <= endOfDay);
  if (filter === 'overdue') return open.filter((t) => t.due && new Date(t.due) < now);
  return open;
}

function sortByDue(list) {
  return [...list].sort((a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity));
}

export async function execute(action, ctx = {}) {
  const a = action || {};
  switch (a.type) {
    case 'greet': {
      const name = state.settings.name ? `, ${state.settings.name}` : '';
      return { reply: `${greetingWord()}${name}! I am Baymax, your personal assistant. What can I do for you?` };
    }
    case 'thanks': return { reply: 'Anytime!' };
    case 'help': return { reply: 'Here are some things you can say:', items: HELP_TEXT, speakText: 'Here are some things you can say. I have listed them on screen.' };
    case 'stop': return { reply: 'Okay.', silent: true };
    case 'time': return { reply: `It’s ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` };
    case 'date': return { reply: `Today is ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.` };

    case 'speak': return { reply: a.text || '' };

    case 'briefing': {
      const now = new Date();
      const today = sortByDue(taskFilter('today'));
      const overdue = taskFilter('overdue');
      const open = taskFilter('open');
      const name = state.settings.name ? `, ${state.settings.name}` : '';
      let reply = `${greetingWord()}${name}. It’s ${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. `;
      if (!open.length) reply += 'Your task list is clear.';
      else {
        reply += `You have ${today.length} task${today.length === 1 ? '' : 's'} due today`;
        if (overdue.length) reply += `, ${overdue.length} overdue`;
        reply += ` and ${open.length} open in total.`;
        if (today[0]) reply += ` Next up: ${today[0].title}${today[0].due ? ` at ${new Date(today[0].due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`;
      }
      return { reply, items: today.map((t) => `${t.title} · ${formatDue(t.due)}`) };
    }

    case 'add_task': {
      if (!a.title) return { reply: 'What should the task be called?' };
      const t = addTask({ title: a.title, due: resolveDue(a) });
      logActivity(`Task added: ${t.title}`);
      return { reply: `Added “${t.title}”${t.due ? `, due ${formatDue(t.due)}` : ''}.` };
    }

    case 'remind': {
      const due = resolveDue(a);
      if (!due) return { reply: `When should I remind you${a.title ? ` to ${a.title}` : ''}? Try “remind me to ${a.title || '…'} in 30 minutes”.` };
      const t = addTask({ title: a.title || 'Reminder', due });
      logActivity(`Reminder set: ${t.title}`);
      ctx.ensureNotifications?.();
      return { reply: `Okay, I’ll remind you to ${t.title} ${formatDue(t.due)}.` };
    }

    case 'timer': {
      const secs = Number(a.seconds) || 60;
      const label = `${formatDuration(secs)} timer`;
      addTask({ title: label, due: new Date(Date.now() + secs * 1000).toISOString(), isTimer: true });
      ctx.ensureNotifications?.();
      return { reply: `Timer set for ${formatDuration(secs)}.` };
    }

    case 'list_tasks': {
      const list = sortByDue(taskFilter(a.filter || 'open'));
      const label = a.filter === 'today' ? 'today' : a.filter === 'overdue' ? 'overdue' : 'open';
      if (!list.length) return { reply: `You have no ${label} tasks. 🎉` };
      const spoken = list.slice(0, 5).map((t) => t.title).join(', ');
      return {
        reply: `You have ${list.length} ${label} task${list.length === 1 ? '' : 's'}:`,
        items: list.map((t) => `${t.title}${t.due ? ` · ${formatDue(t.due)}` : ''}`),
        speakText: `You have ${list.length} ${label} task${list.length === 1 ? '' : 's'}: ${spoken}${list.length > 5 ? ', and more' : ''}.`,
      };
    }

    case 'complete_task': {
      const t = findTask(a.query || '');
      if (!t) return { reply: `I couldn’t find an open task matching “${a.query}”.` };
      updateTask(t.id, { done: true, doneAt: new Date().toISOString() });
      logActivity(`Task completed: ${t.title}`);
      return { reply: `Nice! Marked “${t.title}” as done.` };
    }

    case 'delete_task': {
      const t = findTask(a.query || '', { includeDone: true });
      if (!t) return { reply: `I couldn’t find a task matching “${a.query}”.` };
      removeTask(t.id);
      return { reply: `Deleted “${t.title}”.` };
    }

    case 'clear_completed': {
      const n = state.tasks.filter((t) => t.done).length;
      state.tasks = state.tasks.filter((t) => !t.done);
      save();
      return { reply: n ? `Cleared ${n} completed task${n === 1 ? '' : 's'}.` : 'There were no completed tasks to clear.' };
    }

    case 'add_note': {
      if (!a.text) return { reply: 'What should the note say?' };
      addNote(a.text);
      logActivity('Note saved');
      return { reply: 'Saved to your notes.' };
    }

    case 'list_notes': {
      if (!state.notes.length) return { reply: 'You don’t have any notes yet.' };
      const recent = state.notes.slice(0, 5);
      return {
        reply: `Your ${recent.length === state.notes.length ? '' : 'latest '}notes:`,
        items: recent.map((n) => n.text),
        speakText: `Your latest notes: ${recent.map((n) => n.text).join('. ')}.`,
      };
    }

    case 'open': {
      if (!a.url) return { reply: 'Which site should I open?' };
      const r = openUrl(a.url, `Open ${shortUrl(a.url)}`);
      return { reply: r.blocked ? `Tap to open ${shortUrl(a.url)}.` : `Opening ${shortUrl(a.url)}.`, link: r.link };
    }

    case 'search': {
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(a.query || '');
      const r = openUrl(url, `Search “${a.query}”`);
      return { reply: r.blocked ? `Tap to search for ${a.query}.` : `Searching for ${a.query}.`, link: r.link };
    }

    case 'email': {
      const qs = new URLSearchParams();
      if (a.subject) qs.set('subject', a.subject);
      if (a.body) qs.set('body', a.body);
      const url = `mailto:${encodeURIComponent(a.to || '').replace(/%40/g, '@')}?${qs.toString().replace(/\+/g, '%20')}`;
      const r = openUrl(url, `Email ${a.to || ''}`);
      logActivity(`Email drafted to ${a.to}`);
      return { reply: `Drafting an email to ${a.to}${a.subject ? ` about ${a.subject}` : ''}. Review and hit send in your mail app.`, link: r.link };
    }

    case 'webhook': {
      if (!a.url) return { reply: 'This webhook step has no URL.' };
      const method = (a.method || 'POST').toUpperCase();
      let body;
      if (method !== 'GET') {
        body = a.body && String(a.body).trim() ? a.body : JSON.stringify({ source: 'voice-assistant', at: new Date().toISOString() });
      }
      try {
        const res = await fetch(a.url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body });
        logActivity(`Webhook ${shortUrl(a.url)} → ${res.status}`);
        return { reply: res.ok ? `Webhook sent to ${shortUrl(a.url)}.` : `Webhook returned ${res.status}.` };
      } catch {
        // Many automation hooks don't send CORS headers. Fire-and-forget still delivers the request.
        try {
          await fetch(a.url, { method, mode: 'no-cors', body, headers: body ? { 'Content-Type': 'text/plain' } : undefined });
          logActivity(`Webhook ${shortUrl(a.url)} sent (no-cors)`);
          return { reply: `Webhook sent to ${shortUrl(a.url)}.` };
        } catch (err) {
          return { reply: `Couldn’t reach ${shortUrl(a.url)}: ${err.message}` };
        }
      }
    }

    case 'wait': {
      await new Promise((r) => setTimeout(r, Math.min(Number(a.seconds) || 0, 600) * 1000));
      return { reply: '', silent: true };
    }

    case 'run_routine': {
      const r = state.routines.find((x) => x.id === a.id || x.name.toLowerCase() === String(a.name || '').toLowerCase());
      if (!r) return { reply: `I couldn’t find a routine called ${a.name}.` };
      await ctx.runRoutine?.(r);
      return { reply: '', silent: true };
    }

    default:
      return { reply: 'Sorry, I didn’t catch that. Say “help” to see what I can do.' };
  }
}
