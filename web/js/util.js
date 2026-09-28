// Small helpers shared by every panel.

/** h('div.cls#id', {attrs/on*}, ...children) */
export function h(tag, props, ...kids) {
  const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    }
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const uid = (p = 'id') => `${p}_${Math.random().toString(16).slice(2, 10)}`;

export function hexToRgb(hex) {
  let s = (hex || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function colorOf(c, palette) {
  if (typeof c === 'string' && /^p\d$/.test(c)) return palette[+c[1] % palette.length] || '#ffffff';
  if (c === 'white') return '#ffffff';
  if (c === 'black') return '#000000';
  return c || '#ffffff';
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    pending = args;
    const now = performance.now();
    if (now - last >= ms) { last = now; fn(...pending); pending = null; }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); if (pending) fn(...pending); pending = null; }, ms - (now - last));
  };
}
export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, err = false) {
  const el = h('div.toast', { class: err ? 'err' : '' }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
}

// tiny event bus
const subs = {};
export const on = (ev, fn) => ((subs[ev] ||= []).push(fn), fn);
export const emit = (ev, ...a) => (subs[ev] || []).forEach((f) => f(...a));

export const DIV_LABEL = { 1: '1 beat', 2: '1/2', 3: '1/3 trip', 4: '1/4', 6: '1/6 trip', 8: '1/8', 12: '1/12 trip', 16: '1/16', 32: '1/32' };
export const RATE_OPTS = [[0.25, '1/4 beat'], [0.5, '1/2 beat'], [1, '1 beat'], [1.3333, '4/3 (trip)'], [2, '2 beats'], [4, '1 bar'], [8, '2 bars'], [16, '4 bars'], [32, '8 bars']];

export function field(label, control, cls = '') {
  return h('label.field', { class: cls }, h('span', label), control);
}
export function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange(e.target.value, e) },
    options.map(([v, l]) => h('option', { value: String(v) }, l)));
  s.value = String(value);
  if (s.selectedIndex < 0 && options.length) {
    // value not in list (e.g. custom rate) - add it so nothing silently changes
    s.append(h('option', { value: String(value) }, String(value)));
    s.value = String(value);
  }
  return s;
}
export function num(value, onchange, attrs = {}) {
  return h('input', { type: 'number', value, ...attrs, onchange: (e) => onchange(parseFloat(e.target.value)) });
}

export function showTab(name) {
  $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try { localStorage.setItem('ls.tab', name); } catch {}
  emit('tab', name);
}
