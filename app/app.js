/* DataSaisie — saisie, import, traitement, analyse et visualisation de données.
 * Application 100 % navigateur : les données restent sur le poste (localStorage). */
'use strict';

/* ======================================================================
 * État
 * ==================================================================== */
const STORAGE_KEY = 'datasaisie.v1';
const PAGE_SIZE = 50;
const TYPE_LABEL = { text: 'Texte', number: 'Nombre', date: 'Date' };

let state = { name: 'Sans titre', columns: [], rows: [], log: [] };
let undoStack = [];
let redoStack = [];
const view = { page: 0, sortCol: null, sortDir: 1, search: '', selected: new Set() };
let chart = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Sauvegarde impossible', e); }
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = Object.assign({ log: [] }, JSON.parse(raw));
  } catch (e) { /* stockage indisponible */ }
}

/** Enregistre un instantané pour pouvoir annuler, applique fn, puis rafraîchit. */
function mutate(label, fn) {
  const snapshot = JSON.stringify(state);
  const result = fn();
  if (result === false) return false;
  undoStack.push(snapshot);
  if (undoStack.length > 30) undoStack.shift();
  redoStack = [];
  if (label) state.log.push({ t: new Date().toLocaleString('fr-FR'), label });
  save();
  refreshAll();
  return true;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state));
  state = JSON.parse(undoStack.pop());
  save(); refreshAll();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state));
  state = JSON.parse(redoStack.pop());
  save(); refreshAll();
}

/* ======================================================================
 * Utilitaires valeurs / types
 * ==================================================================== */
const isEmpty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && Number.isNaN(v));

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Conversion stricte : "12", "-3.5", "3,5", "1e3". */
function strictNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^[-+]?(\d+([.,]\d+)?|[.,]\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  return parseFloat(s.replace(',', '.'));
}

/** Conversion tolérante : "$320,800", "1 234,56 €", "45%", "(12)". */
function looseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  const strict = strictNum(s);
  if (strict !== null) return strict;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s  €$£¥%]|MAD|DH|EUR|USD/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Normalise une date en "AAAA-MM-JJ". order = 'dmy' | 'mdy' pour les formats ambigus. */
function toIsoDate(v, order = 'dmy') {
  if (isEmpty(v)) return null;
  if (typeof v === 'number') {
    // numéro de série Excel
    if (v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    let d, mo;
    if (a > 12) { d = a; mo = b; } else if (b > 12) { d = b; mo = a; } else if (order === 'mdy') { mo = a; d = b; } else { d = a; mo = b; }
    return valid(y, mo, d);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = new Date(t); return valid(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  return null;
  function valid(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
}

/** Convertit une valeur brute selon le type de colonne. */
function coerce(v, type) {
  if (isEmpty(v)) return '';
  if (type === 'number') { const n = looseNum(v); return n === null ? String(v) : n; }
  if (type === 'date') return toIsoDate(v) || String(v);
  return typeof v === 'string' ? v : String(v);
}

/** Devine le type d'une colonne à partir de ses valeurs. */
function inferType(values) {
  const vals = values.filter((v) => !isEmpty(v));
  if (!vals.length) return 'text';
  const nums = vals.filter((v) => strictNum(v) !== null).length;
  if (nums / vals.length >= 0.95) return 'number';
  const dates = vals.filter((v) => typeof v === 'string' && /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/.test(v.trim())).length;
  if (dates / vals.length >= 0.95) return 'date';
  return 'text';
}

const colType = (name) => (state.columns.find((c) => c.name === name) || {}).type || 'text';
const numericCols = () => state.columns.filter((c) => c.type === 'number').map((c) => c.name);
const colValues = (name, rows = state.rows) => rows.map((r) => r[name]);
const numValues = (name, rows = state.rows) => rows.map((r) => looseNum(r[name])).filter((n) => n !== null);

function compareValues(a, b) {
  const ea = isEmpty(a), eb = isEmpty(b);
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = strictNum(a), nb = strictNum(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b), 'fr', { numeric: true, sensitivity: 'base' });
}

function fmt(v, digits = 4) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });
  }
  return isEmpty(v) ? '' : String(v);
}

/* ======================================================================
 * Statistiques
 * ==================================================================== */
const S = {
  sum: (a) => a.reduce((s, x) => s + x, 0),
  mean: (a) => (a.length ? S.sum(a) / a.length : NaN),
  min: (a) => (a.length ? a.reduce((m, x) => (x < m ? x : m), Infinity) : NaN),
  max: (a) => (a.length ? a.reduce((m, x) => (x > m ? x : m), -Infinity) : NaN),
  quantile(a, q) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  },
  median: (a) => S.quantile(a, 0.5),
  std(a) {
    if (a.length < 2) return NaN;
    const m = S.mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  },
  count: (a) => a.length,
  mode(a) {
    const f = new Map();
    a.forEach((x) => f.set(x, (f.get(x) || 0) + 1));
    let best, bc = 0;
    f.forEach((c, k) => { if (c > bc) { bc = c; best = k; } });
    return best;
  },
  pearson(x, y) {
    const n = x.length;
    if (n < 3) return NaN;
    const mx = S.mean(x), my = S.mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy);
  },
};
const AGG_LABEL = { count: 'Nombre', sum: 'Somme', mean: 'Moyenne', median: 'Médiane', min: 'Min', max: 'Max', std: 'Écart-type' };

function aggregate(rows, groupCol, valueCol, agg) {
  const groups = new Map();
  rows.forEach((r) => {
    const k = isEmpty(r[groupCol]) ? '(vide)' : String(r[groupCol]);
    if (!groups.has(k)) groups.set(k, []);
    const v = valueCol ? looseNum(r[valueCol]) : 1;
    if (agg === 'count') groups.get(k).push(1);
    else if (v !== null) groups.get(k).push(v);
  });
  return Array.from(groups, ([k, vals]) => ({ key: k, value: S[agg](vals), n: vals.length }));
}

/* ======================================================================
 * Import
 * ==================================================================== */
function parseCSV(text, delimiter) {
  text = text.replace(/^﻿/, '');
  if (!delimiter) {
    const first = text.split(/\r?\n/).slice(0, 5).join('\n');
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    delimiter = counts[0][1] > 1 ? counts[0][0] : ',';
  }
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const data = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!data.length) return [];
  const headers = uniqueHeaders(data[0]);
  return data.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])));
}

function uniqueHeaders(hs) {
  const seen = new Map();
  return hs.map((h, i) => {
    let name = String(h ?? '').trim() || `Colonne ${i + 1}`;
    if (seen.has(name)) { const n = seen.get(name) + 1; seen.set(name, n); name = `${name}_${n}`; }
    else seen.set(name, 1);
    return name;
  });
}

/** Aplatit un objet imbriqué : {a:{b:1}} → {"a.b":1}. */
function flatten(obj, prefix = '', out = {}) {
  Object.entries(obj || {}).forEach(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  });
  return out;
}

/** Accepte un tableau JSON, {data:[…]}, GeoJSON, un objet seul, ou des objets séparés par des virgules / lignes (NDJSON). */
function parseJSONLoose(text) {
  let data;
  const t = text.replace(/^﻿/, '').trim();
  try { data = JSON.parse(t); }
  catch (e) {
    const cleaned = t.replace(/,\s*$/, '').replace(/,\s*([\]}])/g, '$1');
    try { data = JSON.parse(cleaned.startsWith('[') ? cleaned : `[${cleaned}]`); }
    catch (e2) {
      try { data = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l.trim().replace(/,$/, ''))); }
      catch (e3) { throw new Error('JSON invalide : ' + e.message); }
    }
  }
  if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    return data.features.map((f) => {
      const row = flatten(f.properties || {});
      if (f.geometry) {
        row['geometrie.type'] = f.geometry.type;
        if (f.geometry.type === 'Point') { row.longitude = f.geometry.coordinates[0]; row.latitude = f.geometry.coordinates[1]; }
      }
      return row;
    });
  }
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const arr = Object.values(data).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
    data = arr || [data];
  }
  if (!Array.isArray(data)) throw new Error('Format JSON non reconnu');
  return data.map((r) => (r && typeof r === 'object' ? flatten(r) : { valeur: r }));
}

function parseWorkbook(buffer) {
  if (typeof XLSX === 'undefined') throw new Error('Bibliothèque Excel non chargée');
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  return rows.map((r) => {
    const o = {};
    Object.entries(r).forEach(([k, v]) => {
      o[k] = v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : v;
    });
    return o;
  });
}

/** Charge des enregistrements bruts dans le jeu de données. */
function loadRecords(records, mode, label) {
  if (!records.length) throw new Error('Aucune ligne trouvée');
  const keys = [];
  records.forEach((r) => Object.keys(r).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  mutate(label, () => {
    const existing = mode === 'append' ? state.columns.slice() : [];
    keys.forEach((k) => {
      if (!existing.find((c) => c.name === k)) existing.push({ name: k, type: inferType(records.map((r) => r[k])) });
    });
    const newRows = records.map((r) => {
      const o = {};
      existing.forEach((c) => { o[c.name] = coerce(r[c.name], c.type); });
      return o;
    });
    if (mode === 'append') {
      state.rows.forEach((r) => existing.forEach((c) => { if (!(c.name in r)) r[c.name] = ''; }));
      state.rows = state.rows.concat(newRows);
    } else {
      state.rows = newRows;
    }
    state.columns = existing;
  });
  view.page = 0; view.selected.clear();
}

async function importFile(file) {
  const mode = document.querySelector('input[name=importMode]:checked').value;
  const ext = file.name.split('.').pop().toLowerCase();
  let records;
  if (['xlsx', 'xls', 'ods'].includes(ext)) records = parseWorkbook(await file.arrayBuffer());
  else {
    const text = await file.text();
    if (['json', 'geojson'].includes(ext)) records = parseJSONLoose(text);
    else if (ext === 'tsv') records = parseCSV(text, '\t');
    else records = /^\s*[[{]/.test(text) ? parseJSONLoose(text) : parseCSV(text);
  }
  if (mode === 'replace') state.name = file.name.replace(/\.[^.]+$/, '');
  loadRecords(records, mode, `Import de « ${file.name} » (${records.length} lignes, ${mode === 'append' ? 'ajout' : 'remplacement'})`);
  return records.length;
}

/* ======================================================================
 * Export
 * ==================================================================== */
function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toCSV(columns, rows, sep = ';') {
  const q = (v) => {
    let s = typeof v === 'number' ? String(v).replace('.', sep === ';' ? ',' : '.') : String(v ?? '');
    return /["\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map(q).join(sep), ...rows.map((r) => columns.map((c) => q(r[c])).join(sep))].join('\r\n');
}
function exportData(kind) {
  const cols = state.columns.map((c) => c.name);
  const base = (state.name || 'donnees').replace(/[^\w\-]+/g, '_');
  if (kind === 'csv') download(`${base}.csv`, toCSV(cols, state.rows), 'text/csv;charset=utf-8');
  else if (kind === 'json') download(`${base}.json`, JSON.stringify(state.rows, null, 2), 'application/json');
  else if (kind === 'xlsx') {
    if (typeof XLSX === 'undefined') return alert('Bibliothèque Excel non chargée.');
    const ws = XLSX.utils.json_to_sheet(state.rows, { header: cols });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Données');
    XLSX.writeFile(wb, `${base}.xlsx`);
  }
}

/* ======================================================================
 * Rendu : en-tête, colonnes, saisie
 * ==================================================================== */
function refreshAll() {
  $('#datasetName').value = state.name;
  $('#datasetStats').textContent = `${state.rows.length} ligne(s) · ${state.columns.length} colonne(s)`;
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  renderColumns();
  renderEntryForm();
  renderLastEntries();
  renderTable();
  fillColumnSelects();
  renderLog();
  const active = document.querySelector('.panel.active');
  if (active && active.id === 'tab-analyse') renderAnalysis();
}

function renderColumns() {
  $('#columnsList').innerHTML = state.columns.map((c, i) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${TYPE_LABEL[c.type]}</td>
      <td class="row">
        <button data-colact="up" data-i="${i}" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-colact="down" data-i="${i}" title="Descendre" ${i === state.columns.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-colact="edit" data-i="${i}" title="Renommer / changer le type">✎</button>
        <button data-colact="del" data-i="${i}" class="danger" title="Supprimer">✕</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="3" class="muted">Aucune colonne. Ajoutez-en une ou importez un fichier.</td></tr>';
}

function renderEntryForm() {
  const box = $('#entryFields');
  const prev = {};
  box.querySelectorAll('[data-field]').forEach((el) => { prev[el.dataset.field] = el.value; });
  box.innerHTML = state.columns.map((c, i) => {
    const type = c.type === 'number' ? 'number" step="any' : c.type === 'date' ? 'date' : 'text';
    const id = `fld_${i}`;
    const list = c.type === 'text' ? `list="dl_${i}"` : '';
    const opts = c.type === 'text'
      ? `<datalist id="dl_${i}">${[...new Set(colValues(c.name).filter((v) => !isEmpty(v)))].slice(0, 200).map((v) => `<option value="${escapeHtml(v)}">`).join('')}</datalist>`
      : '';
    return `<label for="${id}">${escapeHtml(c.name)}</label>
            <input id="${id}" data-field="${escapeHtml(c.name)}" type="${type}" ${list} value="${escapeHtml(prev[c.name] || '')}">${opts}`;
  }).join('') || '<p class="muted">Définissez d\'abord des colonnes.</p>';
}

function renderLastEntries() {
  const rows = state.rows.slice(-5).reverse();
  $('#lastEntries').innerHTML = rows.length ? simpleTable(state.columns.map((c) => c.name), rows.map((r) => state.columns.map((c) => r[c.name]))) : '';
}

function simpleTable(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((v) => `<td class="${typeof v === 'number' ? 'num' : ''}">${escapeHtml(fmt(v))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

/* ======================================================================
 * Rendu : tableau de données éditable
 * ==================================================================== */
function visibleRowIndexes() {
  let idx = state.rows.map((_, i) => i);
  const q = view.search.trim().toLowerCase();
  if (q) idx = idx.filter((i) => state.columns.some((c) => String(state.rows[i][c.name] ?? '').toLowerCase().includes(q)));
  if (view.sortCol && state.columns.find((c) => c.name === view.sortCol)) {
    const col = view.sortCol;
    idx.sort((a, b) => compareValues(state.rows[a][col], state.rows[b][col]) * view.sortDir);
  }
  return idx;
}

function renderTable() {
  const box = $('#dataTable');
  if (!state.columns.length) { box.innerHTML = '<p class="muted" style="padding:1rem">Aucune donnée. Importez un fichier ou utilisez l\'onglet Saisie.</p>'; $('#pager').innerHTML = ''; return; }
  const idx = visibleRowIndexes();
  const pages = Math.max(1, Math.ceil(idx.length / PAGE_SIZE));
  if (view.page >= pages) view.page = pages - 1;
  const slice = idx.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
  const allChecked = slice.length && slice.every((i) => view.selected.has(i));
  box.innerHTML = `<table>
    <thead><tr>
      <th><input type="checkbox" id="selAll" ${allChecked ? 'checked' : ''}></th><th>#</th>
      ${state.columns.map((c) => `<th class="sortable" data-sort="${escapeHtml(c.name)}">${escapeHtml(c.name)}<span class="type">${TYPE_LABEL[c.type]}</span>${view.sortCol === c.name ? (view.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
    </tr></thead>
    <tbody>${slice.map((i) => {
      const r = state.rows[i];
      return `<tr data-row="${i}"><td><input type="checkbox" data-sel="${i}" ${view.selected.has(i) ? 'checked' : ''}></td><td class="rownum">${i + 1}</td>${
        state.columns.map((c, ci) => {
          const v = r[c.name];
          const cls = [typeof v === 'number' ? 'num' : '', isEmpty(v) ? 'empty' : ''].join(' ');
          return `<td class="${cls}" data-c="${ci}">${escapeHtml(fmt(v, 10))}</td>`;
        }).join('')}</tr>`;
    }).join('')}</tbody></table>`;

  const pager = $('#pager');
  pager.innerHTML = `<button data-page="prev" ${view.page === 0 ? 'disabled' : ''}>‹</button>
    <span>Page ${view.page + 1} / ${pages} — ${idx.length} ligne(s)${view.search ? ' trouvée(s)' : ''}</span>
    <button data-page="next" ${view.page >= pages - 1 ? 'disabled' : ''}>›</button>`;
}

function startEdit(td) {
  if (td.classList.contains('editing')) return;
  const ri = +td.parentElement.dataset.row, col = state.columns[+td.dataset.c];
  const raw = state.rows[ri][col.name];
  td.classList.add('editing');
  td.contentEditable = 'true';
  td.textContent = isEmpty(raw) ? '' : String(raw);
  td.focus();
  document.getSelection().selectAllChildren(td);
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    td.contentEditable = 'false';
    td.classList.remove('editing');
    const nv = coerce(td.textContent.trim(), col.type);
    if (commit && nv !== raw && !(isEmpty(nv) && isEmpty(raw))) {
      mutate(`Modification ligne ${ri + 1}, « ${col.name} »`, () => { state.rows[ri][col.name] = nv; });
    } else renderTable();
  };
  td.onblur = () => finish(true);
  td.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
}

/* ======================================================================
 * Listes déroulantes de colonnes
 * ==================================================================== */
function fillColumnSelects() {
  $$('select[data-col]').forEach((sel) => {
    const prev = sel.value;
    const cols = sel.hasAttribute('data-numeric') ? numericCols() : state.columns.map((c) => c.name);
    let html = '';
    if (sel.hasAttribute('data-allow-all')) html += '<option value="">(toutes les colonnes)</option>';
    if (sel.hasAttribute('data-allow-none')) html += '<option value="">(aucune – compter)</option>';
    html += cols.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  });
  const box = $('#chartY');
  const checked = new Set($$('#chartY input:checked').map((i) => i.value));
  const nums = numericCols();
  box.innerHTML = nums.map((c, i) => `<label class="inline"><input type="checkbox" value="${escapeHtml(c)}" ${checked.has(c) || (!checked.size && i === 0) ? 'checked' : ''}>${escapeHtml(c)}</label>`).join('')
    || '<span class="muted">Aucune colonne numérique</span>';
}

function renderLog() {
  $('#opLog').innerHTML = state.log.slice(-100).map((l) => `<li><span class="muted">${escapeHtml(l.t)}</span> — ${escapeHtml(l.label)}</li>`).join('') || '<li class="muted">Aucune opération</li>';
}

/* ======================================================================
 * Traitements
 * ==================================================================== */
function msg(el, text, ok = true) {
  const p = typeof el === 'string' ? $(el) : el;
  p.textContent = text;
  p.className = 'msg ' + (ok ? 'ok' : 'err');
}
const targetCols = (sel) => (sel ? [sel] : state.columns.map((c) => c.name));

const ops = {
  convert() {
    const col = $('#convCol').value, type = $('#convType').value, order = $('#convDateFmt').value;
    if (!col) return msg('#procMsg', 'Choisissez une colonne', false);
    let fails = 0;
    mutate(`Conversion de « ${col} » en ${TYPE_LABEL[type]}`, () => {
      state.columns.find((c) => c.name === col).type = type;
      state.rows.forEach((r) => {
        const v = r[col];
        if (isEmpty(v)) { r[col] = ''; return; }
        let nv;
        if (type === 'number') nv = looseNum(v);
        else if (type === 'date') nv = toIsoDate(v, order);
        else nv = String(v);
        if (nv === null) { fails++; nv = String(v); }
        r[col] = nv;
      });
    });
    msg('#procMsg', `Colonne « ${col} » convertie.${fails ? ` ${fails} valeur(s) non convertible(s) laissée(s) telle(s) quelle(s).` : ''}`, !fails);
  },

  missing() {
    const col = $('#naCol').value, method = $('#naMethod').value, val = $('#naValue').value;
    const cols = targetCols(col);
    let count = 0;
    mutate(`Valeurs manquantes (${col || 'toutes'}) : ${$('#naMethod').selectedOptions[0].text}`, () => {
      if (method === 'drop') {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !cols.some((c) => isEmpty(r[c])));
        count = before - state.rows.length;
        return;
      }
      cols.forEach((c) => {
        const t = colType(c);
        let fill;
        if (method === 'value') fill = coerce(val, t);
        else if (method === 'mean') fill = S.mean(numValues(c));
        else if (method === 'median') fill = S.median(numValues(c));
        else if (method === 'mode') fill = S.mode(colValues(c).filter((v) => !isEmpty(v)));
        if ((method === 'mean' || method === 'median') && (t !== 'number' || Number.isNaN(fill))) return;
        let last = '';
        state.rows.forEach((r) => {
          if (isEmpty(r[c])) {
            const f = method === 'ffill' ? last : fill;
            if (!isEmpty(f)) { r[c] = f; count++; }
          } else last = r[c];
        });
      });
    });
    msg('#procMsg', method === 'drop' ? `${count} ligne(s) supprimée(s).` : `${count} valeur(s) complétée(s).`);
  },

  dedupe() {
    const col = $('#dupCol').value;
    const cols = targetCols(col);
    let removed = 0;
    mutate(`Suppression des doublons (${col || 'toutes colonnes'})`, () => {
      const seen = new Set();
      const before = state.rows.length;
      state.rows = state.rows.filter((r) => {
        const k = JSON.stringify(cols.map((c) => r[c]));
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      removed = before - state.rows.length;
    });
    msg('#procMsg', `${removed} doublon(s) supprimé(s).`);
  },

  filter() {
    const col = $('#filtCol').value, op = $('#filtOp').value, raw = $('#filtValue').value;
    if (!col) return msg('#procMsg', 'Choisissez une colonne', false);
    const t = colType(col);
    const target = t === 'number' ? looseNum(raw) : raw;
    const test = (v) => {
      switch (op) {
        case 'empty': return isEmpty(v);
        case 'notempty': return !isEmpty(v);
        case 'contains': return String(v ?? '').toLowerCase().includes(raw.toLowerCase());
        case 'notcontains': return !String(v ?? '').toLowerCase().includes(raw.toLowerCase());
        default: {
          if (isEmpty(v)) return op === 'ne';
          const cmp = t === 'number' ? (looseNum(v) ?? NaN) - target : compareValues(v, target);
          return { eq: cmp === 0, ne: cmp !== 0, gt: cmp > 0, ge: cmp >= 0, lt: cmp < 0, le: cmp <= 0 }[op];
        }
      }
    };
    let removed = 0;
    mutate(`Filtre : ${col} ${$('#filtOp').selectedOptions[0].text} ${raw}`, () => {
      const before = state.rows.length;
      state.rows = state.rows.filter((r) => test(r[col]));
      removed = before - state.rows.length;
    });
    msg('#procMsg', `${state.rows.length} ligne(s) conservée(s), ${removed} retirée(s). (Annuler pour revenir en arrière.)`);
  },

  replace() {
    const col = $('#repCol').value, find = $('#repFind').value, rep = $('#repWith').value, exact = $('#repExact').checked;
    if (!find) return msg('#procMsg', 'Indiquez le texte à rechercher', false);
    let n = 0;
    mutate(`Remplacer « ${find} » par « ${rep} » (${col || 'toutes'})`, () => {
      targetCols(col).forEach((c) => {
        const t = colType(c);
        state.rows.forEach((r) => {
          const s = String(r[c] ?? '');
          if (exact ? s === find : s.includes(find)) {
            r[c] = coerce(exact ? rep : s.split(find).join(rep), t); n++;
          }
        });
      });
    });
    msg('#procMsg', `${n} cellule(s) modifiée(s).`);
  },

  text() {
    const col = $('#txtCol').value, op = $('#txtOp').value;
    const f = {
      trim: (s) => s.replace(/\s+/g, ' ').trim(),
      upper: (s) => s.toLocaleUpperCase('fr-FR'),
      lower: (s) => s.toLocaleLowerCase('fr-FR'),
      title: (s) => s.toLocaleLowerCase('fr-FR').replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('fr-FR')),
      accents: (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    }[op];
    let n = 0;
    mutate(`Texte : ${$('#txtOp').selectedOptions[0].text} (${col || 'toutes'})`, () => {
      targetCols(col).filter((c) => colType(c) === 'text').forEach((c) => {
        state.rows.forEach((r) => { if (typeof r[c] === 'string') { const nv = f(r[c]); if (nv !== r[c]) { r[c] = nv; n++; } } });
      });
    });
    msg('#procMsg', `${n} cellule(s) modifiée(s).`);
  },

  calc() {
    const name = $('#calcName').value.trim(), expr = $('#calcExpr').value.trim();
    if (!name || !expr) return msg('#procMsg', 'Nom et expression requis', false);
    let fn;
    try { fn = compileExpression(expr); } catch (e) { return msg('#procMsg', e.message, false); }
    let errors = 0;
    const values = state.rows.map((r) => {
      try {
        const v = fn(r);
        if (typeof v === 'number' && !Number.isFinite(v)) { errors++; return ''; }
        return v ?? '';
      } catch (e) { errors++; return ''; }
    });
    const type = inferType(values.map((v) => (typeof v === 'number' ? String(v) : v)));
    mutate(`Colonne calculée « ${name} » = ${expr}`, () => {
      if (!state.columns.find((c) => c.name === name)) state.columns.push({ name, type });
      else state.columns.find((c) => c.name === name).type = type;
      state.rows.forEach((r, i) => { r[name] = coerce(values[i], type); });
    });
    msg('#procMsg', `Colonne « ${name} » créée.${errors ? ` ${errors} ligne(s) sans résultat (division par zéro, valeur manquante…).` : ''}`, !errors);
  },

  sort() {
    const col = $('#sortCol').value, dir = $('#sortDir').value === 'asc' ? 1 : -1;
    if (!col) return;
    mutate(`Tri par « ${col} » (${dir > 0 ? 'croissant' : 'décroissant'})`, () => {
      state.rows.sort((a, b) => compareValues(a[col], b[col]) * dir);
    });
    view.sortCol = null;
    msg('#procMsg', 'Données triées.');
  },

  bin() {
    const col = $('#binCol').value, n = Math.max(2, Math.min(50, +$('#binN').value || 5));
    if (!col) return msg('#procMsg', 'Aucune colonne numérique', false);
    const vals = numValues(col);
    const lo = S.min(vals), hi = S.max(vals), w = (hi - lo) / n || 1;
    const name = `${col} (classes)`;
    mutate(`Discrétisation de « ${col} » en ${n} classes`, () => {
      if (!state.columns.find((c) => c.name === name)) state.columns.push({ name, type: 'text' });
      state.rows.forEach((r) => {
        const v = looseNum(r[col]);
        if (v === null) { r[name] = ''; return; }
        const k = Math.min(n - 1, Math.floor((v - lo) / w));
        const a = lo + k * w, b = a + w;
        r[name] = `${String(k + 1).padStart(2, '0')}. [${fmt(a, 2)} ; ${fmt(b, 2)}${k === n - 1 ? ']' : '['}`;
      });
    });
    msg('#procMsg', `Colonne « ${name} » créée.`);
  },
};

/** Compile une expression utilisateur de manière contrôlée ([col] + fonctions autorisées). */
function compileExpression(expr) {
  const refs = [];
  let body = expr.replace(/\[([^\]]+)\]/g, (m, name) => {
    if (!state.columns.find((c) => c.name === name)) throw new Error(`Colonne inconnue : ${name}`);
    refs.push(name);
    return `__v(${JSON.stringify(name)})`;
  });
  // On n'autorise que les identifiants de fonctions connus, nombres, chaînes, opérateurs.
  const allowed = new Set(['round', 'abs', 'sqrt', 'min', 'max', 'pow', 'log', 'exp', 'floor', 'ceil', 'concat', 'upper', 'lower', 'year', 'month', 'day', 'si', 'len', '__v', 'true', 'false']);
  const stripped = body.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const ids = stripped.match(/[A-Za-z_$][\w$]*/g) || [];
  const bad = ids.find((id) => !allowed.has(id) && !/^e\d*$/i.test(id));
  if (bad) throw new Error(`Élément non autorisé dans l'expression : « ${bad} »`);
  if (/[;{}=`\\]|=>/.test(stripped.replace(/[<>!=]=|==/g, ''))) throw new Error('Caractère non autorisé dans l\'expression');
  const lib = {
    round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
    abs: Math.abs, sqrt: Math.sqrt, min: Math.min, max: Math.max, pow: Math.pow, log: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    concat: (...a) => a.map((x) => x ?? '').join(''),
    upper: (s) => String(s ?? '').toUpperCase(), lower: (s) => String(s ?? '').toLowerCase(), len: (s) => String(s ?? '').length,
    year: (d) => +String(toIsoDate(d) || '').slice(0, 4) || '', month: (d) => +String(toIsoDate(d) || '').slice(5, 7) || '', day: (d) => +String(toIsoDate(d) || '').slice(8, 10) || '',
    si: (c, a, b) => (c ? a : b),
  };
  // eslint-disable-next-line no-new-func
  const f = new Function(...Object.keys(lib), '__v', `"use strict"; return (${body});`);
  return (row) => f(...Object.values(lib), (name) => {
    const v = row[name];
    if (colType(name) === 'number') { const n = looseNum(v); if (n === null) throw new Error('vide'); return n; }
    return v;
  });
}

/* ======================================================================
 * Analyse
 * ==================================================================== */
function renderAnalysis() {
  if (!state.columns.length) {
    $('#statsTable').innerHTML = '<p class="muted" style="padding:1rem">Aucune donnée.</p>';
    $('#corrResult').innerHTML = '';
    return;
  }
  const headers = ['Colonne', 'Type', 'Renseignées', 'Manquantes', 'Distinctes', 'Min', 'Q1', 'Médiane', 'Moyenne', 'Q3', 'Max', 'Écart-type', 'Somme', 'Plus fréquente'];
  const rows = state.columns.map((c) => {
    const all = colValues(c.name), filled = all.filter((v) => !isEmpty(v));
    const distinct = new Set(filled.map(String)).size;
    const mode = S.mode(filled.map(String));
    if (c.type === 'number') {
      const a = numValues(c.name);
      return [c.name, TYPE_LABEL[c.type], filled.length, all.length - filled.length, distinct, S.min(a), S.quantile(a, 0.25), S.median(a), S.mean(a), S.quantile(a, 0.75), S.max(a), S.std(a), S.sum(a), mode];
    }
    const sorted = filled.map(String).sort((x, y) => compareValues(x, y));
    return [c.name, TYPE_LABEL[c.type], filled.length, all.length - filled.length, distinct, sorted[0] ?? '', '', '', '', '', sorted[sorted.length - 1] ?? '', '', '', mode ?? ''];
  });
  $('#statsTable').innerHTML = simpleTable(headers, rows);
  renderCorrelation();
}

function renderCorrelation() {
  const cols = numericCols();
  if (cols.length < 2) { $('#corrResult').innerHTML = '<p class="muted" style="padding:1rem">Il faut au moins deux colonnes numériques.</p>'; return; }
  const cell = (r) => {
    if (Number.isNaN(r)) return '<td class="num">—</td>';
    const a = Math.min(1, Math.abs(r)) * 0.6;
    const color = r >= 0 ? `rgba(37,99,235,${a})` : `rgba(220,38,38,${a})`;
    return `<td class="num" style="background:${color}">${r.toFixed(2)}</td>`;
  };
  const body = cols.map((a) => {
    const tds = cols.map((b) => {
      const pairs = state.rows.map((r) => [looseNum(r[a]), looseNum(r[b])]).filter(([x, y]) => x !== null && y !== null);
      return cell(S.pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])));
    }).join('');
    return `<tr><th>${escapeHtml(a)}</th>${tds}</tr>`;
  }).join('');
  $('#corrResult').innerHTML = `<table><thead><tr><th></th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
    <p class="muted small" style="padding:0 .6rem">Bleu : corrélation positive · Rouge : corrélation négative. Proche de ±1 = lien linéaire fort.</p>`;
}

let lastGroup = null;
function runGroup() {
  const g = $('#grpCol').value, v = $('#grpVal').value, agg = v ? $('#grpAgg').value : 'count';
  if (!g) return;
  const res = aggregate(state.rows, g, v, agg).sort((a, b) => compareValues(a.key, b.key));
  lastGroup = { g, v, agg };
  const total = S.sum(res.map((r) => r.n));
  const headers = [g, v ? `${AGG_LABEL[agg]} de ${v}` : 'Nombre', 'Effectif', '%'];
  $('#grpResult').innerHTML = simpleTable(headers, res.map((r) => [r.key, r.value, r.n, total ? (100 * r.n) / total : 0]));
}

function runFreq() {
  const c = $('#freqCol').value;
  if (!c) return;
  const res = aggregate(state.rows, c, null, 'count').sort((a, b) => b.value - a.value);
  const total = state.rows.length;
  let cum = 0;
  $('#freqResult').innerHTML = simpleTable([c, 'Effectif', 'Fréquence %', 'Cumul %'],
    res.map((r) => { cum += r.value; return [r.key, r.value, (100 * r.value) / total, (100 * cum) / total]; }));
}

/* ======================================================================
 * Visualisation
 * ==================================================================== */
const PALETTE = ['#2563eb', '#e8590c', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#f08c00', '#5c7cfa', '#a61e4d', '#37b24d'];

function drawChart() {
  const type = $('#chartType').value, x = $('#chartX').value, agg = $('#chartAgg').value;
  const sort = $('#chartSort').value, limit = +$('#chartLimit').value || 0;
  const ys = $$('#chartY input:checked').map((i) => i.value);
  if (typeof Chart === 'undefined') return msg('#chartMsg', 'Bibliothèque de graphiques non chargée.', false);
  if (!state.rows.length) return msg('#chartMsg', 'Aucune donnée à représenter.', false);
  const color = getComputedStyle(document.body).color;
  Chart.defaults.color = color;
  Chart.defaults.locale = 'fr-FR';
  let config;

  if (type === 'hist') {
    const col = ys[0] || (colType(x) === 'number' ? x : null);
    if (!col) return msg('#chartMsg', 'Choisissez une série Y numérique (ou un X numérique) pour l\'histogramme.', false);
    const vals = numValues(col);
    const bins = Math.max(5, Math.min(40, Math.ceil(Math.sqrt(vals.length))));
    const lo = S.min(vals), hi = S.max(vals), w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    vals.forEach((v) => { counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++; });
    config = {
      type: 'bar',
      data: { labels: counts.map((_, i) => `${fmt(lo + i * w, 2)} – ${fmt(lo + (i + 1) * w, 2)}`), datasets: [{ label: `Distribution de ${col}`, data: counts, backgroundColor: PALETTE[0], barPercentage: 1, categoryPercentage: 1 }] },
      options: { scales: { y: { title: { display: true, text: 'Effectif' } } } },
    };
  } else if (type === 'scatter') {
    if (!ys.length) return msg('#chartMsg', 'Choisissez au moins une série Y.', false);
    const xNum = colType(x) === 'number', xDate = colType(x) === 'date';
    config = {
      type: 'scatter',
      data: {
        datasets: ys.map((y, i) => ({
          label: `${y} selon ${x}`,
          backgroundColor: PALETTE[i % PALETTE.length],
          data: state.rows.map((r) => ({ x: xNum ? looseNum(r[x]) : xDate ? Date.parse(r[x]) : null, y: looseNum(r[y]) })).filter((p) => p.x !== null && !Number.isNaN(p.x) && p.y !== null),
        })),
      },
      options: { scales: { x: { title: { display: true, text: x }, ticks: xDate ? { callback: (v) => new Date(v).toLocaleDateString('fr-FR') } : {} } } },
    };
    if (!xNum && !xDate) return msg('#chartMsg', 'Le nuage de points nécessite un axe X numérique ou date.', false);
  } else {
    const pie = type === 'pie' || type === 'doughnut';
    if (!ys.length && agg !== 'count') return msg('#chartMsg', 'Choisissez au moins une série Y, ou l\'agrégation « Nombre ».', false);
    const series = ys.length ? ys : [null];
    let labels, datasets;
    if (agg === 'none') {
      let rows = state.rows.map((r) => r);
      if (sort === 'x') rows = [...rows].sort((a, b) => compareValues(a[x], b[x]));
      if (sort === 'yasc' || sort === 'ydesc') rows = [...rows].sort((a, b) => compareValues(looseNum(a[series[0]]), looseNum(b[series[0]])) * (sort === 'yasc' ? 1 : -1));
      if (limit) rows = rows.slice(0, limit);
      labels = rows.map((r) => fmt(r[x]));
      datasets = series.map((y) => ({ label: y, data: rows.map((r) => looseNum(r[y])) }));
    } else {
      const groups = series.map((y) => new Map(aggregate(state.rows, x, y, agg).map((g) => [g.key, g.value])));
      let keys = [...groups[0].keys()];
      if (sort === 'x') keys.sort(compareValues);
      if (sort === 'yasc' || sort === 'ydesc') keys.sort((a, b) => (groups[0].get(a) - groups[0].get(b)) * (sort === 'yasc' ? 1 : -1));
      if (limit) keys = keys.slice(0, limit);
      labels = keys;
      datasets = series.map((y, i) => ({ label: y ? `${AGG_LABEL[agg]} de ${y}` : 'Nombre', data: keys.map((k) => groups[i].get(k) ?? null) }));
    }
    datasets.forEach((d, i) => {
      if (pie) { d.backgroundColor = labels.map((_, j) => PALETTE[j % PALETTE.length]); }
      else { d.backgroundColor = PALETTE[i % PALETTE.length]; d.borderColor = PALETTE[i % PALETTE.length]; }
      if (type === 'line') { d.tension = 0.2; d.pointRadius = labels.length > 100 ? 0 : 3; d.fill = false; }
    });
    config = {
      type: type === 'barh' ? 'bar' : type,
      data: { labels, datasets: pie ? datasets.slice(0, 1) : datasets },
      options: type === 'barh' ? { indexAxis: 'y' } : {},
    };
    if (pie && datasets.length > 1) msg('#chartMsg', 'Graphique en secteurs : seule la première série est affichée.', true);
  }
  config.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } } }, config.options);
  if (chart) chart.destroy();
  chart = new Chart($('#chartCanvas'), config);
  if (!$('#chartMsg').textContent.startsWith('Graphique en secteurs')) msg('#chartMsg', '');
}

/* ======================================================================
 * Données d'exemple
 * ==================================================================== */
function sampleData() {
  const villes = ['Béni Mellal', 'Casablanca', 'Rabat', 'Marrakech', 'Fès', 'Agadir'];
  const produits = ['Olives', 'Agrumes', 'Céréales', 'Lait', 'Miel'];
  const rows = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 120; i++) {
    const d = new Date(2025, 0, 1 + Math.floor(rnd() * 365));
    const q = Math.round(5 + rnd() * 95);
    const p = Math.round((10 + rnd() * 40) * 100) / 100;
    rows.push({
      Date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      Ville: villes[Math.floor(rnd() * villes.length)],
      Produit: produits[Math.floor(rnd() * produits.length)],
      Quantité: rnd() < 0.04 ? '' : String(q),
      'Prix unitaire': String(p),
    });
  }
  return rows;
}

/* ======================================================================
 * Événements
 * ==================================================================== */
function bind() {
  // Onglets
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === b));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'analyse') renderAnalysis();
    if (b.dataset.tab === 'visualisation' && !chart && state.rows.length) drawChart();
  }));

  $('#datasetName').addEventListener('change', (e) => { state.name = e.target.value || 'Sans titre'; save(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  document.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });

  // Colonnes
  $('#addColumnForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#newColName').value.trim(), type = $('#newColType').value;
    if (!name) return;
    if (state.columns.find((c) => c.name === name)) return alert('Cette colonne existe déjà.');
    mutate(`Ajout de la colonne « ${name} » (${TYPE_LABEL[type]})`, () => {
      state.columns.push({ name, type });
      state.rows.forEach((r) => { r[name] = ''; });
    });
    $('#newColName').value = '';
    $('#newColName').focus();
  });
  $('#columnsList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-colact]');
    if (!b) return;
    const i = +b.dataset.i, c = state.columns[i];
    if (b.dataset.colact === 'del') {
      if (!confirm(`Supprimer la colonne « ${c.name} » et ses données ?`)) return;
      mutate(`Suppression de la colonne « ${c.name} »`, () => {
        state.columns.splice(i, 1);
        state.rows.forEach((r) => { delete r[c.name]; });
      });
    } else if (b.dataset.colact === 'up' || b.dataset.colact === 'down') {
      const j = b.dataset.colact === 'up' ? i - 1 : i + 1;
      mutate(null, () => { [state.columns[i], state.columns[j]] = [state.columns[j], state.columns[i]]; });
    } else if (b.dataset.colact === 'edit') {
      const dlg = $('#colDialog');
      $('#colDialogName').value = c.name;
      $('#colDialogType').value = c.type;
      dlg.returnValue = '';
      dlg.showModal();
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') return;
        const nn = $('#colDialogName').value.trim(), nt = $('#colDialogType').value;
        if (!nn) return;
        if (nn !== c.name && state.columns.find((x) => x.name === nn)) return alert('Ce nom est déjà utilisé.');
        mutate(`Colonne « ${c.name} » → « ${nn} » (${TYPE_LABEL[nt]})`, () => {
          if (nn !== c.name) state.rows.forEach((r) => { r[nn] = r[c.name]; delete r[c.name]; });
          if (nt !== c.type) state.rows.forEach((r) => { r[nn] = coerce(r[nn], nt); });
          c.name = nn; c.type = nt;
        });
      };
    }
  });

  // Saisie
  $('#entryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.columns.length) return msg('#entryMsg', 'Ajoutez d\'abord des colonnes.', false);
    const row = {};
    state.columns.forEach((c) => {
      const el = $(`#entryFields [data-field="${CSS.escape(c.name)}"]`);
      row[c.name] = coerce(el ? el.value : '', c.type);
    });
    if (state.columns.every((c) => isEmpty(row[c.name]))) return msg('#entryMsg', 'La ligne est vide.', false);
    mutate(`Saisie d'une ligne`, () => { state.rows.push(row); });
    $('#entryFields').querySelectorAll('[data-field]').forEach((el) => { el.value = ''; });
    const first = $('#entryFields [data-field]');
    if (first) first.focus();
    msg('#entryMsg', `Ligne n° ${state.rows.length} enregistrée.`);
  });

  // Import
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await importFile(f); msg('#importMsg', `${n} ligne(s) importée(s) depuis « ${f.name} ».`); }
    catch (err) { msg('#importMsg', `Erreur : ${err.message}`, false); }
    e.target.value = '';
  });
  $('#pasteBtn').addEventListener('click', () => $('#pasteArea').classList.toggle('hidden'));
  $('#pasteImportBtn').addEventListener('click', () => {
    const text = $('#pasteText').value;
    const mode = document.querySelector('input[name=importMode]:checked').value;
    try {
      const recs = /^\s*[[{]/.test(text) ? parseJSONLoose(text) : parseCSV(text);
      loadRecords(recs, mode, `Import de texte collé (${recs.length} lignes)`);
      msg('#importMsg', `${recs.length} ligne(s) importée(s).`);
      $('#pasteText').value = '';
      $('#pasteArea').classList.add('hidden');
    } catch (err) { msg('#importMsg', `Erreur : ${err.message}`, false); }
  });
  $('#sampleBtn').addEventListener('click', () => {
    if (state.rows.length && !confirm('Remplacer les données actuelles par l\'exemple ?')) return;
    state.name = 'Ventes (exemple)';
    loadRecords(sampleData(), 'replace', 'Chargement des données d\'exemple');
    msg('#importMsg', 'Données d\'exemple chargées (120 lignes).');
  });

  // Tableau
  $('#searchInput').addEventListener('input', (e) => { view.search = e.target.value; view.page = 0; renderTable(); });
  $('#dataTable').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const c = th.dataset.sort;
      if (view.sortCol === c) { if (view.sortDir === 1) view.sortDir = -1; else { view.sortCol = null; view.sortDir = 1; } }
      else { view.sortCol = c; view.sortDir = 1; }
      renderTable();
      return;
    }
    if (e.target.id === 'selAll') {
      const boxes = $$('#dataTable input[data-sel]');
      boxes.forEach((b) => { const i = +b.dataset.sel; if (e.target.checked) view.selected.add(i); else view.selected.delete(i); b.checked = e.target.checked; });
      return;
    }
    if (e.target.dataset.sel !== undefined) {
      const i = +e.target.dataset.sel;
      if (e.target.checked) view.selected.add(i); else view.selected.delete(i);
    }
  });
  $('#dataTable').addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-c]');
    if (td) startEdit(td);
  });
  $('#pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b) return;
    view.page += b.dataset.page === 'next' ? 1 : -1;
    renderTable();
  });
  $('#addRowBtn').addEventListener('click', () => {
    if (!state.columns.length) return alert('Ajoutez d\'abord des colonnes (onglet Saisie).');
    mutate('Ajout d\'une ligne vide', () => { state.rows.push(Object.fromEntries(state.columns.map((c) => [c.name, '']))); });
    view.search = ''; $('#searchInput').value = ''; view.sortCol = null;
    view.page = Math.floor((state.rows.length - 1) / PAGE_SIZE);
    renderTable();
  });
  $('#deleteSelectedBtn').addEventListener('click', () => {
    const n = view.selected.size;
    if (!n) return alert('Cochez les lignes à supprimer.');
    if (!confirm(`Supprimer ${n} ligne(s) ?`)) return;
    mutate(`Suppression de ${n} ligne(s)`, () => { state.rows = state.rows.filter((_, i) => !view.selected.has(i)); });
    view.selected.clear();
    renderTable();
  });
  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('Effacer toutes les données et colonnes ? (annulable avec « Annuler »)')) return;
    mutate('Effacement complet', () => { state.rows = []; state.columns = []; state.name = 'Sans titre'; });
    view.selected.clear();
  });
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportData(b.dataset.export)));

  // Traitements
  $('#convBtn').addEventListener('click', ops.convert);
  $('#naBtn').addEventListener('click', ops.missing);
  $('#dupBtn').addEventListener('click', ops.dedupe);
  $('#filtBtn').addEventListener('click', ops.filter);
  $('#repBtn').addEventListener('click', ops.replace);
  $('#txtBtn').addEventListener('click', ops.text);
  $('#calcBtn').addEventListener('click', ops.calc);
  $('#sortBtn').addEventListener('click', ops.sort);
  $('#binBtn').addEventListener('click', ops.bin);

  // Analyse
  $('#grpBtn').addEventListener('click', runGroup);
  $('#freqBtn').addEventListener('click', runFreq);
  $('#grpToChart').addEventListener('click', () => {
    runGroup();
    if (!lastGroup) return;
    $('#chartX').value = lastGroup.g;
    $('#chartAgg').value = lastGroup.v ? lastGroup.agg : 'count';
    if (!['sum', 'mean', 'count', 'min', 'max'].includes($('#chartAgg').value)) $('#chartAgg').value = 'mean';
    $$('#chartY input').forEach((i) => { i.checked = i.value === lastGroup.v; });
    $('#chartType').value = 'bar';
    document.querySelector('.tab[data-tab=visualisation]').click();
    drawChart();
  });

  // Visualisation
  $('#chartBtn').addEventListener('click', drawChart);
  $('#chartPng').addEventListener('click', () => {
    if (!chart) return;
    const a = document.createElement('a');
    a.href = chart.toBase64Image('image/png', 1);
    a.download = `${(state.name || 'graphique').replace(/[^\w\-]+/g, '_')}.png`;
    a.click();
  });
}

load();
bind();
refreshAll();
