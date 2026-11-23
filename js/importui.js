// "Import a statement" dialog: read file → preview what will happen → import.

import { state, save, setPaid } from './store.js';
import { readStatementFile, toBankTransactions } from './statement.js';
import { planBankItems } from './bankfeed.js';
import { noteStatementImported } from './statements.js';
import { inr } from './finance.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initImport(toast) {
  const dlg = $('#import-dialog');
  const fileIn = $('#import-file-input');
  const nextBtn = $('#import-next');
  const err = $('#import-error');
  let plan = null;

  const showError = (m) => { err.textContent = m; err.hidden = !m; };
  const reset = () => {
    plan = null;
    $('#import-step1').hidden = false;
    $('#import-step2').hidden = true;
    $('#import-step2').innerHTML = '';
    nextBtn.textContent = 'Read statement';
    nextBtn.disabled = false;
    showError('');
  };

  fileIn.addEventListener('change', () => {
    $('#import-pass-wrap').hidden = !/\.pdf$/i.test(fileIn.files[0]?.name || '');
    showError('');
  });

  nextBtn.addEventListener('click', async () => {
    if (plan) return doImport();
    const file = fileIn.files[0];
    if (!file) { showError('Choose a statement file first.'); return; }
    nextBtn.disabled = true;
    nextBtn.textContent = 'Reading…';
    showError('');
    try {
      const rows = await readStatementFile(file, { password: $('#import-pass').value });
      if (!rows.length) throw new Error('No transactions found. If this is a PDF, try the Excel or CSV version.');
      const source = $('#import-source').value;
      const card = state.finance.cards.find((c) => c.id === source);
      const txns = toBankTransactions(rows, card ? { last4: card.last4 || '', channel: 'credit card' } : {});
      if (card && !card.last4) txns.forEach((t) => { t.bank = card.name; }); // match by name if no last 4
      plan = planBankItems(state.finance, txns, new Date(), { statement: true });
      if (card) plan.spends.forEach((x) => { x.method = card.id; });
      renderPreview(rows.length);
    } catch (e) {
      showError(e.message || 'Couldn’t read that file.');
      nextBtn.textContent = 'Read statement';
    } finally {
      nextBtn.disabled = false;
    }
  });

  function renderPreview(total) {
    const spendSum = plan.spends.reduce((a, x) => a + x.amount, 0);
    const list = (title, items) => items.length ? `<div class="group-label"><span>${title}</span><span>${items.length}</span></div>
      <ul class="rows flat">${items.slice(0, 50).map((i) => `<li class="row"><div class="grow"><div class="title">${esc(i[0])}</div><div class="meta">${esc(i[1])}</div></div><div class="amount">${i[2]}</div></li>`).join('')}</ul>
      ${items.length > 50 ? `<p class="hint">…and ${items.length - 50} more</p>` : ''}` : '';
    $('#import-step2').innerHTML = `
      <div class="alert info"><span>Found <b>${total}</b> transactions. <b>${plan.spends.length}</b> new spends (${inr(spendSum)}), <b>${plan.credits.length}</b> money in, <b>${plan.paid.length}</b> payments matched to your EMIs/SIPs/bills, <b>${plan.skipped.length}</b> skipped.</span></div>
      ${list('New spends', plan.spends.map((x) => [x.note, `${x.date} · ${x.category}`, inr(x.amount)]))}
      ${list('Money in', plan.credits.map((x) => [x.from, `${x.date} · ${x.kind}`, inr(x.amount)]))}
      ${list('Marked as paid', plan.messages.map((m) => [m, '', '']))}
      ${list('Skipped', plan.skipped.map((x) => [x.t.merchant || x.t.text, `${x.t.date} · ${x.why}`, inr(x.t.amount)]))}`;
    $('#import-step1').hidden = true;
    $('#import-step2').hidden = false;
    nextBtn.textContent = plan.spends.length || plan.credits.length || plan.paid.length ? 'Import' : 'Done';
  }

  function doImport() {
    state.finance.spends.push(...plan.spends);
    state.finance.credits = [...(state.finance.credits || []), ...plan.credits];
    for (const p of plan.paid) setPaid(p.ref, p.id, p.key, true);
    noteStatementImported(state);
    save();
    toast(`Imported ${plan.spends.length} spends${plan.paid.length ? ` · ${plan.paid.length} payments marked paid` : ''}`);
    dlg.close();
  }

  return function open() {
    reset();
    fileIn.value = '';
    $('#import-pass').value = '';
    $('#import-pass-wrap').hidden = true;
    $('#import-source').innerHTML = `<option value="bank">Bank account (savings / current)</option>` +
      state.finance.cards.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} credit card</option>`).join('');
    dlg.showModal();
  };
}
