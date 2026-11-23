// Reads Indian bank / credit card alert emails ("Rs.450.00 spent on your HDFC Bank Credit Card
// ending 1234 at SWIGGY on 20-11-2026") and returns a transaction, or null if it isn't one.
// Pure: used by the server ingest function and unit-tested in tests/bankparse.test.mjs.

const BANKS = [
  [/hdfc/i, 'HDFC Bank'], [/icici/i, 'ICICI Bank'], [/axis/i, 'Axis Bank'], [/\bsbi\b|sbicard|onlinesbi/i, 'SBI'],
  [/kotak/i, 'Kotak'], [/yes ?bank/i, 'Yes Bank'], [/indusind/i, 'IndusInd'], [/idfc/i, 'IDFC FIRST'],
  [/americanexpress|amex/i, 'Amex'], [/\bau ?bank|aubank/i, 'AU Bank'], [/federal/i, 'Federal Bank'],
  [/standard ?chartered|sc\.com/i, 'Standard Chartered'], [/hsbc/i, 'HSBC'], [/rbl/i, 'RBL Bank'],
  [/bank ?of ?baroda|bobcard/i, 'Bank of Baroda'], [/onecard/i, 'OneCard'], [/bandhan/i, 'Bandhan Bank'], [/paytm/i, 'Paytm'], [/citi/i, 'Citi'],
];

const NOT_A_TRANSACTION = /\b(otp|one[- ]time password|verification code|statement (is|has been) (generated|ready)|e-?statement|offer|cashback offer|pre-?approved|apply now|credit limit (increase|enhance)|reward points? (balance|summary)|password|login alert|new device|kyc|emi conversion|payment reminder|due date reminder|minimum amount due|is due on|will be debited|will be auto-?debited|scheduled|mandate (registered|created)|request(ed)? (to pay|money)|has requested)\b/i;

const DEBIT = /\b(debited|spent|thank you for using|for using|withdrawn|deducted|paid|purchase|sent|used for|charged|transaction of|txn of|transferred to|autopay|auto-?debit|dr\.?)\b/i;
const CREDIT = /\b(credited|received|deposited|refund(ed)?|reversed|reversal|cashback (of|credited)|cr\.?)\b/i;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function cleanText(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function toISO(y, m, d) {
  const yy = y < 100 ? 2000 + y : y;
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return `${yy}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** First date in text: 20-11-2026, 20/11/26, 20-Nov-26, 20 Nov 2026, Nov 20, 2026, 2026-11-20. */
export function findDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return toISO(+m[1], +m[2] - 1, +m[3]);
  m = text.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/);
  if (m) return toISO(+m[3], +m[2] - 1, +m[1]);
  m = text.match(/\b(\d{1,2})[-\s]?([A-Za-z]{3})[a-z]*[-\s,]+(\d{2,4})\b/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return toISO(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = text.match(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return toISO(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

const AMOUNT = /(?:₹|\bINR|\bRs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i;

function findMerchant(text) {
  const tries = [
    /\bUPI\/(?:P2[MA]|DR|CR)?\/?\d*\/?([A-Za-z][\w&.' \-]{1,30}?)(?=\/|\s|[.,;\n]|$)/i,
    /\bVPA\s+([\w.\-]+@[\w.\-]+)(?:\s*\(([^)]+)\))?/i,
    /\bto\s+([\w.\-]+@[a-z]+)\b/i,
    /\b(?:at|@)\s+([A-Za-z0-9][\w&.'*\/\- ]{1,40}?)(?=\s+(?:on|dated|via|using|thru|through|ref|for|txn|at)\b|[.,;\n]|$)/i,
    /\b(?:to|towards|for)\s+([A-Z][\w&.'\- ]{1,40}?)(?=\s+(?:on|dated|via|using|ref|upi|from)\b|[.,;\n]|$)/,
    /\bInfo[:\s]+([\w&.'*\/\- ]{2,40}?)(?=[.,;\n]|$)/i,
  ];
  for (const re of tries) {
    const m = text.match(re);
    if (m) {
      const name = (m[2] || m[1]).trim().replace(/\s{2,}/g, ' ');
      if (!/^(your|the|a|an|account|card|a\/c|rs|inr|bank)$/i.test(name)) return name;
    }
  }
  return '';
}

/**
 * @param {{from?: string, subject?: string, body?: string, date?: string|number, id?: string}} msg
 * @returns {null | {id, amount, type: 'debit'|'credit', merchant, last4, channel, bank, date, text}}
 */
/**
 * Only your own accounts: spec "axis:9361,icici:0879,hdfc:7004" (bank word : last 4 digits).
 * An alert matches when its last 4 digits are on the list (and the bank agrees), or, when the email
 * doesn't show the digits, when it's from a bank on the list. Empty spec = keep everything.
 */
export function isTrackedAccount(t, spec) {
  const list = String(spec || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    .map((x) => { const [bank, last4] = x.includes(':') ? x.split(':') : ['', x]; return { bank, last4: last4.replace(/\D/g, '').slice(-4) }; });
  if (!list.length) return true;
  const bank = String(t.bank || '').toLowerCase();
  const bankOk = (b) => !b || bank.includes(b);
  if (t.last4) return list.some((a) => a.last4 === t.last4 && bankOk(a.bank));
  return list.some((a) => a.bank && bank.includes(a.bank));
}

export function parseAlert(msg) {
  const subject = cleanText(msg.subject);
  const body = cleanText(msg.body);
  const text = `${subject}\n${body}`.slice(0, 4000);
  if (NOT_A_TRANSACTION.test(text) && !/\b(debited|credited|spent)\b/i.test(subject)) return null;

  const amt = text.match(AMOUNT);
  if (!amt) return null;
  const amount = parseFloat(amt[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;

  // Decide debit vs credit from the sentence that holds the amount.
  const sentence = (text.split(/(?<=[.!?])\s+|\n/).find((l) => AMOUNT.test(l)) || text);
  const d = sentence.search(DEBIT), c = sentence.search(CREDIT);
  let type = null;
  if (d >= 0 && (c < 0 || d < c)) type = 'debit';
  else if (c >= 0) type = 'credit';
  else if (DEBIT.test(text) && !CREDIT.test(text)) type = 'debit';
  else if (CREDIT.test(text) && !DEBIT.test(text)) type = 'credit';
  if (!type) return null;
  if (NOT_A_TRANSACTION.test(sentence)) return null;

  const last4M = text.match(/(?:card|a\/c|acct|account|ac)\b[^\d\n]{0,25}?(?:x{1,}|\*{1,}|ending(?: with| in)?|no\.?|number)?\s*[x*]*(\d{4})\b/i);
  const channel = /\bupi\b|vpa/i.test(text) ? 'upi' : /credit card/i.test(text) ? 'credit card' : /debit card/i.test(text) ? 'debit card'
    : /\bcard\b/i.test(text) ? 'card' : /neft|imps|rtgs|net ?banking/i.test(text) ? 'bank transfer' : /atm/i.test(text) ? 'atm' : 'bank';
  const bank = (BANKS.find(([re]) => re.test(`${msg.from || ''} ${subject}`)) || BANKS.find(([re]) => re.test(text)) || [null, ''])[1];
  const ref = text.match(/\b(?:ref(?:erence)?\.?\s*(?:no\.?|number)?|UPI Ref\.?|RRN|txn id)(?:\s+is)?[:\s#]*([A-Z0-9]*\d[A-Z0-9]{5,})/i);
  let date = findDate(sentence) || findDate(text);
  if (!date && msg.date) { const t = new Date(msg.date); if (!isNaN(t)) date = t.toISOString().slice(0, 10); }

  return {
    id: String(msg.id || ''),
    amount, type, channel, bank,
    merchant: findMerchant(sentence) || findMerchant(text),
    last4: last4M ? last4M[1] : '',
    ref: ref ? ref[1] : '',
    date: date || new Date().toISOString().slice(0, 10),
    text: sentence.slice(0, 280),
  };
}
