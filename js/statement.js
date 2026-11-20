// Bank / credit card statement import: CSV, Excel (.xls/.xlsx) and PDF.
// Pure parsing (rows → transactions) is unit-tested; file reading uses SheetJS / pdf.js, loaded
// from cdnjs only when a statement is imported.

import { findDate } from './bankparse.js';
import { hash } from './sync.js';

// ---------------------------------------------------------------- CSV
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

// ---------------------------------------------------------------- tables → transactions
const num = (v) => {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹,\s]|INR|Rs\.?/gi, '');
  const neg = /^\(.*\)$/.test(s) || /-$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, '').replace(/-$/, ''));
  return isNaN(n) ? NaN : neg ? -n : n;
};

function excelDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return findDate(String(v || ''));
}

const H = {
  date: /^(txn |transaction |value |posting |tran )?date|^date$/i,
  desc: /narration|description|particulars|details|remarks|transaction details|merchant/i,
  debit: /withdrawal|debit|dr\.?\s*amount|amount\s*\(?dr|paid out|^dr$/i,
  credit: /deposit|credit|cr\.?\s*amount|amount\s*\(?cr|paid in|^cr$/i,
  amount: /^(transaction )?amount( \(inr\)| \(rs\.?\))?$|^amt$|^amount\b/i,
  drcr: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|debit\/credit|dr\/cr)$/i,
  balance: /balance/i,
};

/** Find the header row and column positions in a table (array of arrays). */
export function findColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = rows[r].map((c) => String(c || '').trim());
    const idx = (re, not) => cells.findIndex((c, i) => re.test(c) && (!not || !not.test(c)) && c.length < 40 && i >= 0);
    const date = idx(H.date);
    if (date < 0) continue;
    const cols = {
      row: r, date,
      desc: idx(H.desc),
      debit: idx(H.debit, H.balance),
      credit: idx(H.credit, /balance|card/i),
      amount: idx(H.amount),
      drcr: idx(H.drcr),
      balance: idx(H.balance),
    };
    if (cols.debit >= 0 || cols.credit >= 0 || cols.amount >= 0) return cols;
  }
  return null;
}

/** Rows (with a header) → [{date, description, amount, type}] */
export function tableToTransactions(rows) {
  const c = findColumns(rows);
  if (!c) return [];
  const out = [];
  // One signed "Amount" column: negatives are money out, positives money in. All positive = a list of spends.
  const signed = c.amount >= 0 && c.drcr < 0 && rows.slice(c.row + 1).some((r) => num(r[c.amount]) < 0);
  for (const r of rows.slice(c.row + 1)) {
    const date = excelDate(r[c.date]);
    if (!date) continue;
    const description = String(r[c.desc] ?? '').replace(/\s+/g, ' ').trim();
    let debit = c.debit >= 0 ? num(r[c.debit]) : NaN;
    let credit = c.credit >= 0 ? num(r[c.credit]) : NaN;
    if (isNaN(debit) && isNaN(credit) && c.amount >= 0) {
      const a = num(r[c.amount]);
      if (isNaN(a)) continue;
      const flag = c.drcr >= 0 ? String(r[c.drcr]) : String(r[c.amount]);
      if (/cr/i.test(flag)) credit = Math.abs(a);
      else if (/dr/i.test(flag) || a < 0) debit = Math.abs(a);
      else if (signed) credit = a;
      else debit = a;
    }
    if (debit > 0) out.push({ date, description, amount: Math.round(debit * 100) / 100, type: 'debit' });
    else if (credit > 0) out.push({ date, description, amount: Math.round(credit * 100) / 100, type: 'credit' });
  }
  return out;
}

/**
 * Text lines from a PDF → transactions. Each line starts with a date and ends with amounts.
 * With a running balance column, debit vs credit comes from how the balance moved; otherwise
 * from Dr/Cr markers (credit card statements).
 */
export function linesToTransactions(lines) {
  const out = [];
  let prevBalance = null;
  const AMT = /(?:₹\s?)?\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d{2})\)?(?:\s?(?:Dr|Cr|DR|CR))?/g;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const dm = line.match(/^(\d{1,2}[-\/. ](?:\d{1,2}|[A-Za-z]{3,9})[-\/. ,]+\d{2,4})\b/);
    if (!dm) {
      const ob = line.match(/opening balance[^\d-]*(-?[\d,]+\.\d{2})/i);
      if (ob) prevBalance = num(ob[1]);
      continue;
    }
    const date = findDate(dm[1]);
    if (!date) continue;
    const amounts = [...line.slice(dm[0].length).matchAll(AMT)].map((m) => m[0]);
    if (!amounts.length) continue;
    const firstAmtAt = line.indexOf(amounts[0], dm[0].length);
    let description = line.slice(dm[0].length, firstAmtAt).replace(/^\s*\d{1,2}[-\/. ](?:\d{1,2}|[A-Za-z]{3,9})[-\/. ,]+\d{2,4}\s*/, '').trim();
    const vals = amounts.map((a) => ({ n: Math.abs(num(a.replace(/\s?(Dr|Cr|DR|CR)$/, ''))), cr: /cr$/i.test(a), dr: /dr$/i.test(a) }));
    let amount, type;
    if (vals.length >= 2 && !vals[0].cr && !vals[0].dr) {
      const balance = num(amounts[amounts.length - 1].replace(/\s?(Dr|Cr|DR|CR)$/i, ''));
      amount = vals[vals.length - 2].n;
      if (prevBalance !== null && !isNaN(balance)) type = balance < prevBalance ? 'debit' : 'credit';
      else type = /\b(cr|credit|deposit|salary|refund|neft cr|imps cr|by transfer)\b/i.test(description) ? 'credit' : 'debit';
      prevBalance = balance;
    } else {
      amount = vals[0].n;
      type = vals[0].cr || /\b(payment received|refund|reversal|cashback|credit)\b/i.test(description) ? 'credit' : 'debit';
    }
    if (amount > 0) out.push({ date, description: description || 'Transaction', amount, type });
  }
  return out;
}

/** Statement rows → the transaction shape used by bank alerts, ready for planBankItems(). */
export function toBankTransactions(rows, { last4 = '', channel = 'bank' } = {}) {
  return rows.map((r) => {
    const d = r.description;
    const upi = /\bupi\b|@[a-z]+/i.test(d);
    const merchant = (d.match(/UPI[\/-](?:P2[MA][\/-])?(?:\d+[\/-])?([A-Za-z][\w&. '-]{1,30}?)(?:[\/-]|$)/i)?.[1] ||
      d.replace(/^(POS|ECOM|UPI|NEFT|IMPS|ACH|NACH|BIL|ONL|MB|IB|ATM|TPT)[\s\/:-]*/i, '').split(/[\/|]/)[0]).trim().slice(0, 40);
    return {
      id: `st-${hash(`${r.date}|${r.amount}|${r.type}|${d}`)}`,
      amount: r.amount, type: r.type, date: r.date,
      channel: channel === 'credit card' ? 'credit card' : upi ? 'upi' : /\batm\b|\bnwd\b|cash withdrawal/i.test(d) ? 'atm' : channel,
      bank: '', merchant, last4, ref: '', text: d,
    };
  });
}

// ---------------------------------------------------------------- reading files (browser)
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res(window[globalName]);
    s.onerror = () => rej(new Error('Couldn’t load the file reader. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

/** Read any supported statement file into transactions [{date, description, amount, type}]. */
export async function readStatementFile(file, { password } = {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || file.type === 'text/csv') return tableToTransactions(parseCSV(await file.text()));
  if (/\.(xlsx?|xlsm)$/.test(name)) {
    const XLSX = await loadScript(XLSX_URL, 'XLSX');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    let all = [];
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      all = all.concat(tableToTransactions(rows));
    }
    return all;
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await loadScript(PDFJS_URL, 'pdfjsLib');
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), password: password || undefined }).promise;
    } catch (e) {
      if (e?.name === 'PasswordException') throw new Error(password ? 'That PDF password isn’t right.' : 'This PDF is password-protected. Enter its password (often your date of birth or customer ID).');
      throw e;
    }
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const byY = new Map();
      for (const it of content.items) {
        const y = Math.round(it.transform[5] / 2) * 2;
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y).push({ x: it.transform[4], s: it.str });
      }
      [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, parts]) => lines.push(parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ')));
    }
    const tx = linesToTransactions(lines);
    if (!tx.length) throw new Error('Couldn’t find transactions in this PDF. Try the Excel or CSV download from your bank instead.');
    return tx;
  }
  throw new Error('Use a CSV, Excel or PDF statement.');
}
