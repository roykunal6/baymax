// Zerodha holdings: reads the holdings file from Console (Excel) or Kite (CSV), for stocks and
// mutual funds, and summarises the portfolio. Pure functions, unit-tested in tests/zerodha.test.mjs.

const num = (v) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[₹,\s%]/g, ''));
  return isNaN(n) ? NaN : n;
};

const COL = {
  symbol: /^(symbol|instrument|tradingsymbol|trading symbol|scheme( name)?|fund( name)?|name|stock)$/i,
  isin: /^isin$/i,
  qty: /^(quantity available|qty\.?|quantity|units|available qty|net qty)$/i,
  avg: /^(average price|avg\.? ?(cost|price)|average cost|buy avg\.?|avg)$/i,
  price: /^(previous closing price|ltp|last price|closing price|current price|nav|last traded price|cmp)$/i,
  value: /^(cur(rent|\.)? ?val(ue)?\.?|present value|market value)$/i,
  pnl: /^(unrealized p&l|unrealised p&l|p&l|pnl|net p&l)$/i,
  sector: /^sector$/i,
  itype: /^instrument type$/i,
};

/** Column positions if this row is a holdings header, else null. */
function headerOf(row) {
  const cells = (row || []).map((c) => String(c ?? '').trim());
  const find = (re) => cells.findIndex((c) => re.test(c));
  const cols = Object.fromEntries(Object.entries(COL).map(([k, re]) => [k, find(re)]));
  return cols.symbol >= 0 && cols.qty >= 0 && (cols.avg >= 0 || cols.value >= 0) ? cols : null;
}

/**
 * Rows from a Zerodha holdings file → [{id, symbol, isin, type, qty, avg, price, invested, value, pnl}].
 * Console's Excel has several sheets (Equity, Mutual Funds, Combined) with different column orders,
 * so every header row found starts a new layout; holdings repeated on the Combined sheet are skipped.
 */
export function parseHoldings(rows, { owner = '' } = {}) {
  const out = [];
  const seen = new Set();
  let h = null;
  owner = owner || clientIdOf(rows);
  for (const r of rows) {
    const head = headerOf(r);
    if (head) { h = head; continue; }
    if (!h || !Array.isArray(r)) continue;
    const symbol = String(r[h.symbol] ?? '').trim();
    const qty = num(r[h.qty]);
    if (!symbol || !(qty > 0) || /^total/i.test(symbol)) continue;
    const isin = h.isin >= 0 ? String(r[h.isin] ?? '').trim() : '';
    const avg = h.avg >= 0 ? num(r[h.avg]) : NaN;
    let price = h.price >= 0 ? num(r[h.price]) : NaN;
    let value = h.value >= 0 ? num(r[h.value]) : NaN;
    if (isNaN(value) && !isNaN(price)) value = qty * price;
    if (isNaN(price) && !isNaN(value)) price = value / qty;
    const invested = !isNaN(avg) ? qty * avg : NaN;
    const pnl = h.pnl >= 0 && !isNaN(num(r[h.pnl])) ? num(r[h.pnl]) : value - invested;
    // Console says which it is: stocks and ETFs have a Sector, mutual funds an Instrument Type.
    const cell = (i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    const sector = cell(h.sector), itype = cell(h.itype);
    const type = sector && sector !== '-' ? 'equity'
      : itype && itype !== '-' ? 'mf'
      : /^INF/i.test(isin) && !/bees\b|etf\b/i.test(symbol) || /\b(fund|plan|growth|direct|idcw|scheme)\b/i.test(symbol) ? 'mf' : 'equity';
    const round = (x) => Math.round(x * 100) / 100;
    const id = `zh-${owner ? `${owner}-` : ''}${(isin || symbol).replace(/[^\w-]/g, '')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ...(owner ? { owner } : {}), symbol, isin, type, qty, avg: round(avg), price: round(price), invested: round(invested), value: round(value), pnl: round(pnl) });
  }
  return out;
}

/**
 * Merge newly uploaded holdings into the current list. A file replaces the holdings of the types
 * it contains (an equity file replaces stocks, a fund file replaces funds), so stocks you sold disappear.
 */
export function mergeHoldings(current, uploaded) {
  const owners = new Set(uploaded.map((h) => h.owner).filter(Boolean));
  if (owners.size) {
    // Per account: an upload replaces everything held in the accounts it covers (and older
    // uploads that had no account on them).
    return [...(current || []).filter((h) => h.owner && !owners.has(h.owner)), ...uploaded];
  }
  const types = new Set(uploaded.map((h) => h.type));
  return [...(current || []).filter((h) => !types.has(h.type)), ...uploaded];
}

/** The Zerodha client ID in a Console file ("Client ID | GU1234"), or ''. */
export function clientIdOf(rows) {
  for (const r of (rows || []).slice(0, 15)) {
    const cells = (r || []).map((c) => String(c ?? '').trim());
    const i = cells.findIndex((c) => /^client id$/i.test(c));
    if (i >= 0 && /^[A-Z]{2,3}\d{3,5}$/i.test(cells[i + 1] || '')) return cells[i + 1].toUpperCase();
  }
  return '';
}

/** Client ID from a file name like "holdings-GU1234.xlsx", or ''. */
export const clientIdFromName = (name) => (String(name || '').match(/\b([A-Z]{2,3}\d{3,5})\b/i)?.[1] || '').toUpperCase();

/** Totals per account: [{owner, value, invested, pnl, count}] */
export function byOwner(holdings) {
  const m = new Map();
  for (const h of holdings || []) {
    const k = h.owner || '';
    const o = m.get(k) || { owner: k, value: 0, invested: 0, pnl: 0, count: 0 };
    o.value += Number(h.value) || 0; o.invested += Number(h.invested) || 0; o.pnl += Number(h.pnl) || 0; o.count++;
    m.set(k, o);
  }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

export function portfolioSummary(holdings) {
  const sum = (list, k) => list.reduce((a, h) => a + (Number(h[k]) || 0), 0);
  const eq = holdings.filter((h) => h.type === 'equity');
  const mf = holdings.filter((h) => h.type === 'mf');
  const invested = sum(holdings, 'invested');
  const value = sum(holdings, 'value');
  return {
    invested, value, pnl: value - invested, pnlPct: invested ? ((value - invested) / invested) * 100 : 0,
    equity: { value: sum(eq, 'value'), invested: sum(eq, 'invested'), count: eq.length },
    mf: { value: sum(mf, 'value'), invested: sum(mf, 'invested'), count: mf.length },
  };
}

/** Is the weekly upload due? (Sunday from 10 AM onward, or more than 7 days since the last one.) */
export function uploadDue(lastUpload, now = new Date()) {
  if (!lastUpload) return true;
  const days = (now - new Date(lastUpload)) / 86400000;
  if (days >= 7) return true;
  return now.getDay() === 0 && now.getHours() >= 10 && days >= 1;
}
