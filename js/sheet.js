// A bottom-sheet form built from a field list. Used for spends, dues, invoices, cards and habits.

import { parseAmount } from './finance.js';

const dialog = () => document.getElementById('sheet');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let current = null;

function fieldHtml(f, value) {
  const id = `sf-${f.key}`;
  const v = value ?? f.default ?? '';
  const req = f.required ? 'required' : '';
  const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '';
  if (f.type === 'check') return `<label class="check"><input type="checkbox" id="${id}" name="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    return `<label for="${id}">${esc(f.label)}<select id="${id}" name="${f.key}" ${req}>${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  }
  if (f.type === 'textarea') return `<label for="${id}">${esc(f.label)}<textarea id="${id}" name="${f.key}" rows="2" ${req} ${ph}>${esc(v)}</textarea></label>`;
  const type = f.type === 'date' ? 'date' : f.type === 'month' ? 'month' : f.type === 'day' || f.type === 'number' ? 'number' : 'text';
  const extra = f.type === 'amount' ? 'inputmode="decimal"' : f.type === 'day' ? 'inputmode="numeric" min="1" max="31"' : f.type === 'number' ? 'inputmode="decimal" min="0" step="any"' : '';
  return `<label for="${id}">${esc(f.label)}<input id="${id}" name="${f.key}" type="${type}" value="${esc(v)}" ${extra} ${req} ${ph} autocomplete="off"></label>`;
}

/**
 * @param {{title: string, fields: Array, values?: object, onSave: (v: object) => (string|void), onDelete?: () => void}} opts
 * onSave may return an error message to keep the sheet open.
 */
export function openSheet(opts) {
  const d = dialog();
  current = opts;
  d.querySelector('#sheet-title').textContent = opts.title;
  const values = opts.values || {};
  // Group consecutive fields marked `half` into two-column rows.
  let html = '';
  for (let i = 0; i < opts.fields.length; i++) {
    const f = opts.fields[i];
    if (f.half && opts.fields[i + 1]?.half) {
      html += `<div class="form-row">${fieldHtml(f, values[f.key])}${fieldHtml(opts.fields[i + 1], values[opts.fields[i + 1].key])}</div>`;
      i++;
    } else html += fieldHtml(f, values[f.key]);
  }
  d.querySelector('#sheet-fields').innerHTML = html;
  const del = d.querySelector('#sheet-delete');
  del.hidden = !opts.onDelete;
  del.textContent = 'Delete';
  del.dataset.armed = '';
  d.showModal();
  const first = d.querySelector('#sheet-fields input, #sheet-fields select');
  if (first && !values[opts.fields[0]?.key] && matchMedia('(pointer: fine)').matches) first.focus();
}

function collect() {
  const d = dialog();
  const out = {};
  for (const f of current.fields) {
    const el = d.querySelector(`[name="${f.key}"]`);
    if (!el) continue;
    if (f.type === 'check') out[f.key] = el.checked;
    else if (f.type === 'amount') out[f.key] = parseAmount(el.value);
    else if (f.type === 'day' || f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
    else out[f.key] = el.value.trim();
  }
  return out;
}

export function initSheet() {
  const d = dialog();
  const form = d.querySelector('#sheet-form');
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save' || !current) return;
    const v = collect();
    for (const f of current.fields) {
      if (f.type === 'amount' && (f.required !== false) && !(v[f.key] > 0)) {
        e.preventDefault();
        const el = d.querySelector(`[name="${f.key}"]`);
        el.setCustomValidity('Enter an amount, e.g. 450 or 2.5k');
        el.reportValidity();
        el.addEventListener('input', () => el.setCustomValidity(''), { once: true });
        return;
      }
      if (f.type === 'day' && v[f.key] != null && (v[f.key] < 1 || v[f.key] > 31)) { e.preventDefault(); return; }
    }
    const err = current.onSave(v);
    if (typeof err === 'string') { e.preventDefault(); alertInSheet(err); }
  });
  d.querySelector('#sheet-delete').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Tap again to delete';
      setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Delete'; }, 3500);
      return;
    }
    current?.onDelete?.();
    d.close();
  });
  // Tap on the dimmed backdrop closes the sheet.
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

function alertInSheet(msg) {
  const box = dialog().querySelector('#sheet-fields');
  let p = box.querySelector('.sheet-error');
  if (!p) { p = document.createElement('p'); p.className = 'alert bad sheet-error'; box.prepend(p); }
  p.textContent = msg;
}
