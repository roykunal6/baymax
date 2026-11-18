// Natural-language time parsing. Pure functions: no DOM, safe to unit test in Node.

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, fifty: 50, sixty: 60,
  ninety: 90, couple: 2, few: 3,
};

const UNIT_SECONDS = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const PART_OF_DAY = { morning: 9, noon: 12, afternoon: 15, evening: 18, tonight: 20, night: 20 };

export function toNumber(word) {
  if (word == null) return NaN;
  const w = String(word).toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(w)) return parseFloat(w);
  if (w in WORD_NUMBERS) return WORD_NUMBERS[w];
  return NaN;
}

const NUM = '(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety|couple(?: of)?|few)';
const UNIT = '(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';

/** Parse a duration like "5 minutes", "an hour and a half", "half an hour". Returns seconds or null. */
export function parseDuration(text) {
  const t = text.toLowerCase();
  if (/\bhalf (an|a) hour\b/.test(t)) return 1800;
  const re = new RegExp(`\\b${NUM}\\s*${UNIT}\\b`, 'g');
  let total = 0;
  let found = false;
  let m;
  while ((m = re.exec(t))) {
    const n = toNumber(m[1].replace(/ of$/, ''));
    const unit = UNIT_SECONDS[m[2]];
    if (!isNaN(n) && unit) { total += n * unit; found = true; }
  }
  if (found && /\band a half\b/.test(t)) {
    const unitMatch = t.match(new RegExp(`${UNIT}\\s+and a half`));
    if (unitMatch) total += UNIT_SECONDS[unitMatch[1]] / 2;
  }
  return found ? Math.round(total) : null;
}

/** Parse "9", "9am", "9:30 pm", "21:15", "noon", "midnight" → {h, m} or null. */
export function parseClock(str) {
  const s = str.toLowerCase().replace(/\./g, '').trim();
  if (s === 'noon' || s === 'midday') return { h: 12, m: 0 };
  if (s === 'midnight') return { h: 0, m: 0 };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].replace(' ', '') : null;
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, m: min, explicit: !!ap || h > 12 || !!m[2] };
}

const CLOCK = '(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)?|noon|midnight|midday)';

function setClock(date, clock) {
  const d = new Date(date);
  d.setHours(clock.h, clock.m, 0, 0);
  return d;
}

/**
 * Find a time expression in `text`.
 * Returns { date: Date, match: string, rest: string } or null.
 * `rest` is the text with the time phrase removed and whitespace tidied.
 */
export function parseTime(text, now = new Date()) {
  const lower = text.toLowerCase();
  const strip = (match) => tidy(text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length));

  // 1. Relative: "in 10 minutes", "in an hour and a half", "after 2 hours"
  const rel = lower.match(new RegExp(`\\b(?:in|after)\\s+((?:half (?:an|a) hour)|(?:${NUM}\\s*${UNIT}(?:\\s+and a half)?(?:\\s+(?:and\\s+)?${NUM}\\s*${UNIT})?))\\b`));
  if (rel) {
    const secs = parseDuration(rel[1]);
    if (secs) return { date: new Date(now.getTime() + secs * 1000), match: rel[0], rest: strip(rel) };
  }

  // 2. Day anchor + optional clock: "tomorrow at 9am", "on friday at 5", "next monday", "today at 3pm", "tomorrow morning"
  const dayRe = new RegExp(
    `\\b(today|tonight|tomorrow|day after tomorrow|(?:on\\s+|next\\s+|this\\s+)?(?:${DAYS.join('|')}))` +
    `(?:\\s+(morning|afternoon|evening|night))?` +
    `(?:\\s+(?:at|by|@)\\s*${CLOCK})?\\b`
  );
  const altRe = new RegExp(`\\b(?:at|by|@)\\s*${CLOCK}\\s+(today|tonight|tomorrow|(?:on\\s+|next\\s+)?(?:${DAYS.join('|')}))\\b`);
  let dm = lower.match(dayRe);
  let dayWord, partWord, clockStr, matchObj;
  const am = lower.match(altRe);
  if (am && (!dm || am.index <= dm.index)) {
    clockStr = am[1]; dayWord = am[2]; matchObj = am;
  } else if (dm) {
    dayWord = dm[1]; partWord = dm[2]; clockStr = dm[3]; matchObj = dm;
  }
  if (matchObj) {
    let base = new Date(now);
    base.setSeconds(0, 0);
    const word = dayWord.replace(/^(on|this)\s+/, '');
    if (word === 'tomorrow') base.setDate(base.getDate() + 1);
    else if (word === 'day after tomorrow') base.setDate(base.getDate() + 2);
    else if (word !== 'today' && word !== 'tonight') {
      // "friday" and "next friday" both mean the coming friday (common spoken usage).
      const target = DAYS.indexOf(word.replace(/^next\s+/, ''));
      let diff = (target - base.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      base.setDate(base.getDate() + diff);
    }
    let clock = clockStr ? parseClock(clockStr) : null;
    if (clock && !clock.explicit && clock.h < 12) {
      // "at 5" with no am/pm: prefer afternoon for 1–7, or evening context
      if (partWord && partWord !== 'morning') clock.h += 12;
      else if (word === 'tonight') clock.h += 12;
      else if (!partWord && clock.h >= 1 && clock.h <= 7) clock.h += 12;
    }
    if (!clock) {
      const ph = PART_OF_DAY[partWord] ?? (word === 'tonight' ? 20 : 9);
      clock = { h: ph, m: 0 };
    }
    let date = setClock(base, clock);
    if ((word === 'today' || word === 'tonight') && date <= now && !clockStr) {
      date = new Date(now.getTime() + 60 * 60 * 1000); // "later today" fallback
    }
    return { date, match: matchObj[0], rest: strip(matchObj) };
  }

  // 3. Bare clock: "at 5:30 pm", "at noon", "by 6"
  const cm = lower.match(new RegExp(`\\b(?:at|by|@)\\s*${CLOCK}(?:\\s+(morning|afternoon|evening|tonight))?(?=\\s|$|[,.!?])`));
  if (cm) {
    const clock = parseClock(cm[1]);
    if (clock) {
      if (cm[2] && cm[2] !== 'morning' && clock.h < 12) clock.h += 12;
      let date = setClock(now, clock);
      if (!clock.explicit && date <= now && clock.h < 12) {
        // ambiguous "at 5" when it's already past 5am → assume 5pm today
        const pm = setClock(now, { h: clock.h + 12, m: clock.m });
        if (pm > now) date = pm;
      }
      if (date <= now) date.setDate(date.getDate() + 1);
      return { date, match: cm[0], rest: strip(cm) };
    }
  }

  // 4. Part of day alone: "this evening", "tonight"
  const pm = lower.match(/\b(?:this\s+)?(morning|afternoon|evening|tonight)\b/);
  if (pm) {
    let date = setClock(now, { h: PART_OF_DAY[pm[1]], m: 0 });
    if (date <= now) date.setDate(date.getDate() + 1);
    return { date, match: pm[0], rest: strip(pm) };
  }

  return null;
}

export function tidy(s) {
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
}

/** Human-friendly description: "today 5:30 PM", "tomorrow 9:00 AM", "Fri 12 Dec 9:00 AM". */
export function formatDue(date, now = new Date()) {
  if (!date) return '';
  const d = new Date(date);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function formatDuration(secs) {
  const parts = [];
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
  if (s && !h) parts.push(`${s} second${s > 1 ? 's' : ''}`);
  return parts.join(' ') || '0 seconds';
}
