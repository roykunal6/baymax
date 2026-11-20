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
};

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = rows[r].map((c) => String(c ?? '').trim());
    const find = (re) => cells.findIndex((c) => re.test(c));
    const cols = Object.fromEntries(Object.entries(COL).map(([k, re]) => [k, find(re)]));
    if (cols.symbol >= 0 && cols.qty >= 0 && (cols.avg >= 0 || cols.value >= 0)) return { row: r, ...cols };
  }
  return null;
}

/** Rows from a Zerodha holdings file → [{id, symbol, isin, type, qty, avg, price, invested, value, pnl}] */
export function parseHoldings(rows) {
  const h = findHeader(rows);
  if (!h) return [];
  const out = [];
  for (const r of rows.slice(h.row + 1)) {
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
    const type = /^INF/i.test(isin) || /\b(fund|plan|growth|direct|idcw|scheme)\b/i.test(symbol) ? 'mf' : 'equity';
    const round = (x) => Math.round(x * 100) / 100;
    out.push({ id: `zh-${(isin || symbol).replace(/[^\w-]/g, '')}`, symbol, isin, type, qty, avg: round(avg), price: round(price), invested: round(invested), value: round(value), pnl: round(pnl) });
  }
  return out;
}

/**
 * Merge newly uploaded holdings into the current list. A file replaces the holdings of the types
 * it contains (an equity file replaces stocks, a fund file replaces funds), so stocks you sold disappear.
 */
export function mergeHoldings(current, uploaded) {
  const types = new Set(uploaded.map((h) => h.type));
  return [...(current || []).filter((h) => !types.has(h.type)), ...uploaded];
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
