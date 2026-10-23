'use strict';
// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (cmd, args) => {
  const t = window.__TAURI__;
  return t ? t.core.invoke(cmd, args) : Promise.reject('Tauri runtime not available');
};

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'innerHTML') e.innerHTML = v;
    else if (k !== 'value' && v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  if ('value' in props) e.value = props.value; // after children so <select> options exist
  return e;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = String(msg);
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2200);
}

// Two-click confirmation; window.confirm is unreliable inside webviews.
function armed(label, fn, cls = 'btn danger') {
  const b = el('button', { class: cls }, label);
  let timer;
  b.onclick = () => {
    if (b.classList.contains('armed')) return fn();
    b.classList.add('armed');
    b.textContent = 'Click again to confirm';
    timer = setTimeout(() => { b.classList.remove('armed'); b.textContent = label; }, 3000);
  };
  b.onblur = () => { clearTimeout(timer); b.classList.remove('armed'); b.textContent = label; };
  return b;
}

const ICONS = {"key": "<rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"3\"/><path d=\"M9 12h6\"/>", "combo": "<rect x=\"3\" y=\"6\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"13\" y=\"6\" width=\"8\" height=\"12\" rx=\"2\"/>", "mouse": "<rect x=\"6\" y=\"3\" width=\"12\" height=\"18\" rx=\"6\"/><path d=\"M12 3v7\"/>", "system": "<path d=\"M4 10v4h4l5 4V6L8 10z\"/><path d=\"M16 9a4 4 0 010 6\"/>", "macro": "<path d=\"M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01\"/>", "launch": "<path d=\"M7 17L17 7M9 7h8v8\"/>", "layer": "<path d=\"M12 3l9 5-9 5-9-5z\"/><path d=\"M3 13l9 5 9-5\"/>", "script": "<path d=\"M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12\"/>", "app": "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"4\"/><path d=\"M9 9h6v6H9z\"/>"};
ICONS.sound = ICONS.system;
ICONS.clip = ICONS.macro;
const ico = (n) => el('span', { class: 'ico', innerHTML: '<svg class="i" viewBox="0 0 24 24">' + ICONS[n] + '</svg>' });

// ---------- HID tables ----------
const KEYS = []; // { hid, label, ev (KeyboardEvent.code) }
const addKey = (hid, label, ev) => KEYS.push({ hid, label, ev });
[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].forEach((c, i) => addKey(4 + i, c, 'Key' + c));
[...'1234567890'].forEach((c, i) => addKey(0x1e + i, c, 'Digit' + c));
[[0x28, 'Enter', 'Enter'], [0x29, 'Esc', 'Escape'], [0x2a, 'Backspace', 'Backspace'], [0x2b, 'Tab', 'Tab'],
  [0x2c, 'Space', 'Space'], [0x2d, '-', 'Minus'], [0x2e, '=', 'Equal'], [0x2f, '[', 'BracketLeft'],
  [0x30, ']', 'BracketRight'], [0x31, '\\', 'Backslash'], [0x33, ';', 'Semicolon'], [0x34, "'", 'Quote'],
  [0x35, '`', 'Backquote'], [0x36, ',', 'Comma'], [0x37, '.', 'Period'], [0x38, '/', 'Slash'],
  [0x39, 'Caps Lock', 'CapsLock']].forEach((a) => addKey(...a));
for (let i = 1; i <= 12; i++) addKey(0x39 + i, 'F' + i, 'F' + i);
[[0x46, 'PrtSc', 'PrintScreen'], [0x47, 'Scroll Lock', 'ScrollLock'], [0x48, 'Pause', 'Pause'],
  [0x49, 'Insert', 'Insert'], [0x4a, 'Home', 'Home'], [0x4b, 'Page Up', 'PageUp'], [0x4c, 'Delete', 'Delete'],
  [0x4d, 'End', 'End'], [0x4e, 'Page Down', 'PageDown'], [0x4f, 'Right', 'ArrowRight'], [0x50, 'Left', 'ArrowLeft'],
  [0x51, 'Down', 'ArrowDown'], [0x52, 'Up', 'ArrowUp'], [0x53, 'Num Lock', 'NumLock'],
  [0x54, 'Num /', 'NumpadDivide'], [0x55, 'Num *', 'NumpadMultiply'], [0x56, 'Num -', 'NumpadSubtract'],
  [0x57, 'Num +', 'NumpadAdd'], [0x58, 'Num Enter', 'NumpadEnter']].forEach((a) => addKey(...a));
for (let i = 1; i <= 9; i++) addKey(0x58 + i, 'Num ' + i, 'Numpad' + i);
addKey(0x62, 'Num 0', 'Numpad0'); addKey(0x63, 'Num .', 'NumpadDecimal');
addKey(0x64, 'ISO \\', 'IntlBackslash'); addKey(0x65, 'Menu', 'ContextMenu');
for (let i = 13; i <= 24; i++) addKey(0x68 + i - 13, 'F' + i, 'F' + i);
const BY_HID = new Map(KEYS.map((k) => [k.hid, k]));
const BY_EV = new Map(KEYS.map((k) => [k.ev, k]));

const MODS = [['Ctrl', 1], ['Shift', 2], ['Alt', 4], ['Win', 8], ['R Ctrl', 0x10], ['R Shift', 0x20], ['R Alt', 0x40], ['R Win', 0x80]];
const MODBIT = { ControlLeft: 1, ShiftLeft: 2, AltLeft: 4, MetaLeft: 8, ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80 };

// consumer usage = (class << 8) | code, as in the original app's table
const SYSTEM = [
  ['Media', [['Play / Pause', 0xcd], ['Stop', 0xb7], ['Previous track', 0xb6], ['Next track', 0xb5], ['Media player', 0x183]]],
  ['Volume', [['Mute', 0xe2], ['Volume up', 0xe9], ['Volume down', 0xea], ['Bass up', 0x152], ['Bass down', 0x153], ['Treble up', 0x154], ['Treble down', 0x155]]],
  ['Display', [['Brightness up', 0x6f], ['Brightness down', 0x70]]],
  ['Apps', [['Calculator', 0x192], ['My Computer', 0x194], ['E-mail', 0x18a]]],
  ['Browser', [['Home', 0x223], ['Back', 0x224], ['Forward', 0x225], ['Refresh', 0x227]]],
];
const SYSTEM_NAME = new Map(SYSTEM.flatMap(([, items]) => items.map(([n, u]) => [u, n])));
const MOUSE = [['Left click', { buttons: 1, wheel: 0 }], ['Middle click', { buttons: 4, wheel: 0 }], ['Right click', { buttons: 2, wheel: 0 }],
  ['Wheel up', { buttons: 0, wheel: 1 }], ['Wheel down', { buttons: 0, wheel: -1 }]];

// printable output for the macro test preview: [plain, shifted]
const TYPED = new Map();
[...'abcdefghijklmnopqrstuvwxyz'].forEach((c, i) => TYPED.set(4 + i, [c, c.toUpperCase()]));
[...'1234567890'].forEach((c, i) => TYPED.set(0x1e + i, [c, ')!@#$%^&*('[(i + 1) % 10]]));
[[0x2c, ' ', ' '], [0x28, '\n', '\n'], [0x2b, '\t', '\t'], [0x2d, '-', '_'], [0x2e, '=', '+'], [0x2f, '[', '{'], [0x30, ']', '}'],
  [0x31, '\\', '|'], [0x33, ';', ':'], [0x34, "'", '"'], [0x35, '`', '~'], [0x36, ',', '<'], [0x37, '.', '>'], [0x38, '/', '?']]
  .forEach(([h, a, b]) => TYPED.set(h, [a, b]));

const modNames = (m) => MODS.filter(([, b]) => m & b).map(([n]) => n);
const fmtStep = (s) => [...modNames(s.mods), s.code ? (BY_HID.get(s.code)?.label ?? '0x' + s.code.toString(16)) : null].filter(Boolean).join('+');

// ---------- state ----------
const S = {
  info: null, layer: 1, sel: 1, forced: null, tab: 'keys',
  device: {}, staged: {},
  store: { macros: [], led: {}, bindings: [], sounds: [], snippets: [], layerKeys: [], home: null, activeV: 0, settings: { autoWrite: true } }, macroSel: null, layerSel: null, snipSel: null, macroDirty: false, bindSel: null,
  testing: false, testLog: '', testText: '', testStep: -1, recording: null,
};
const DEFAULT_SETTINGS = { autoWrite: true, autoLight: true, autoSend: true, typeDelay: 5, restoreClipboard: true, closeToTray: true, masterVolume: 100, accent: 'indigo' };
const kk = (layer, slot) => `${layer}:${slot}`;
const cur = (layer, slot) => S.staged[kk(layer, slot)] ?? S.device[kk(layer, slot)] ?? { type: 'keys', steps: [], interval: 0 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const selMacro = () => S.store.macros.find((m) => m.id === S.macroSel);

function slotLayout() {
  const keys = [...Array(S.info?.keys ?? 0)].map((_, i) => ({ slot: i + 1, name: 'Key ' + (i + 1) }));
  const knobs = [];
  for (let i = 0; i < (S.info?.knobs ?? 0); i++)
    [[0x12, 'turn left'], [0x11, 'press'], [0x10, 'turn right']].forEach(([o, w]) => knobs.push({ slot: o + 3 * i, name: `Knob ${i + 1} ${w}` }));
  return { keys, knobs };
}
const slotInfo = (slot) => { const l = slotLayout(); return [...l.keys, ...l.knobs].find((s) => s.slot === slot); };

function kind(a) {
  if (a.type === 'media') return 'system';
  if (a.type === 'mouse') return 'mouse';
  if (a.steps.length > 1 || a.interval > 0) return 'macro';
  return a.steps[0]?.mods ? 'combo' : 'key';
}
const KINDS = [['key', 'Keystroke'], ['combo', 'Combination'], ['mouse', 'Mouse'], ['system', 'System'], ['macro', 'Macro']];

function macroFor(a) {
  return a.type === 'keys' ? S.store.macros.find((m) => m.interval === a.interval && same(m.steps, a.steps)) : null;
}

const LAUNCH_MODS = 7; // Ctrl+Shift+Alt, plus F13..F24 for the launcher slot
const hotkeyCode = (n) => 0x68 + n - 13;
const layerKeyFor = (a) => a.type === 'keys' && a.steps.length <= 2 && a.steps[0]?.mods === LAUNCH_MODS
  ? S.store.layerKeys.find((k) => hotkeyCode(k.n) === a.steps[0].code) : null;
const bindingFor = (a) => a.type === 'keys' && a.steps.length <= 2 && a.steps[0]?.mods === LAUNCH_MODS
  ? S.store.bindings.find((l) => 0x68 + l.n - 13 === a.steps[0].code) : null;

function describe(a) {
  if (a.type === 'media') return SYSTEM_NAME.get(a.usage) ?? 'Usage 0x' + a.usage.toString(16);
  if (a.type === 'mouse') {
    const m = MOUSE.find(([, v]) => v.buttons === a.buttons && v.wheel === a.wheel);
    return [...modNames(a.mods), m ? m[0] : 'Mouse'].join('+');
  }
  if (!a.steps.length) return 'Unassigned';
  const ln = bindingFor(a);
  if (ln) return ln.name;
  const lk = layerKeyFor(a);
  if (lk) return layerKeyLabel(lk);
  if (kind(a) === 'macro') return macroFor(a)?.name ?? `${a.steps.length}-step sequence`;
  return fmtStep(a.steps[0]);
}

// ---------- device I/O ----------
async function readAll() {
  const slots = await invoke('read_slots');
  S.device = {};
  slots.forEach((s) => (S.device[kk(s.layer, s.slot)] = s.action));
  S.staged = {};
  if (!S.store.activeV) S.store.home = layerMap(1); // layer 1 is only pristine while no software layer is active
}

function layerMap(layer) {
  const m = {};
  for (let s = 1; s <= 24; s++) if (S.device[kk(layer, s)]) m[s] = S.device[kk(layer, s)];
  return m;
}

async function connect() {
  const btn = $('#connect');
  btn.disabled = true;
  try {
    S.info = await invoke('handshake');
    await readAll();
    if (S.store.activeV) await goHome(); // the app was closed while another software layer was active
    await syncHotkeys();
    saveStore();
    if (!slotInfo(S.sel)) S.sel = 1;
  } catch (e) {
    S.info = null;
    toast(e, true);
  }
  btn.disabled = false;
  render();
}

// A write is skipped for half-finished edits (e.g. a combination with no key yet); they stay staged.
const complete = (a) => a.type !== 'keys' || (a.steps.length > 0 && a.steps.every((s) => s.code || s.mods));
let writing = false, writeTimer;

function scheduleWrite() {
  clearTimeout(writeTimer);
  if (S.info && S.store.settings.autoWrite) writeTimer = setTimeout(writeStaged, 700);
}

async function writeStaged() {
  const ready = Object.entries(S.staged).filter(([, a]) => complete(a));
  if (!ready.length || writing) return;
  writing = true;
  let failed = false;
  const changes = ready.map(([k, action]) => { const [layer, slot] = k.split(':').map(Number); return { layer, slot, action }; });
  const expected = Object.fromEntries(ready);
  const btn = $('#write');
  btn.disabled = true;
  try {
    const snapshot = { ...S.staged };
    await goHome(); // edits must hit the real layer 1, not a temporary software layer
    S.staged = snapshot;
    await invoke('write_slots', { changes });
    const latest = S.staged; // may hold edits made while writing
    await readAll();
    for (const [k, a] of Object.entries(latest)) if (!(k in expected && same(expected[k], a))) S.staged[k] = a;
    await syncHotkeys();
    saveStore();
    const bad = Object.keys(expected).filter((k) => !same(expected[k], S.device[k])).length;
    bad ? toast(`${bad} slot(s) read back differently from what was written`, true) : toast(`Saved ${changes.length} change(s) to the keyboard`);
  } catch (e) {
    failed = true;
    toast(e, true);
  }
  writing = false;
  btn.disabled = false;
  render();
  if (!failed && Object.values(S.staged).some(complete)) scheduleWrite(); // a failed write waits for the next edit
}

async function saveStore() {
  try {
    await invoke('save_store', { data: JSON.stringify(S.store) });
    S.macroDirty = false;
    return true;
  } catch (e) {
    toast('Could not save: ' + e, true);
    return false;
  }
}

function stage(action) {
  const k = kk(S.layer, S.sel);
  if (same(action, S.device[k])) delete S.staged[k]; else S.staged[k] = action;
  render();
  scheduleWrite();
}

// ---------- key capture ----------
let stopCapture = null;
function capture(onDone, { withMods, onCancel }) {
  stopCapture?.();
  let held = 0;
  const down = (e) => {
    e.preventDefault();
    if (e.repeat) return;
    if (MODBIT[e.code]) { held |= MODBIT[e.code]; return; }
    const k = BY_EV.get(e.code);
    if (!k) return toast('That key cannot be assigned', true);
    end(); onDone({ mods: withMods ? held : 0, code: k.hid });
  };
  const up = (e) => { if (withMods && MODBIT[e.code] && held) { const m = held; end(); onDone({ mods: m, code: 0 }); } };
  const cancel = () => { end(); onCancel(); };
  const end = () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', cancel); stopCapture = null; };
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', cancel);
  stopCapture = end;
}

function captureButton(label, withMods, onPick) {
  const b = el('button', { class: 'btn capture' }, label);
  b.onclick = (ev) => {
    ev.stopPropagation();
    b.classList.add('live');
    b.textContent = withMods ? 'Press a combination…' : 'Press a key…';
    capture(onPick, { withMods, onCancel: render });
  };
  return b;
}

const keySelect = (value, onPick) => el('select', { value: value || '', onchange: (e) => onPick(Number(e.target.value)) },
  el('option', { value: '' }, 'Choose key…'), KEYS.map((k) => el('option', { value: k.hid }, k.label)));

const chips = (mask, list, onChange) => el('div', { class: 'chips' },
  list.map(([n, b]) => el('button', { class: 'chip' + (mask & b ? ' on' : ''), onclick: () => onChange(mask ^ b) }, n)));

// ---------- keys tab ----------
function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  $('#gridEmpty').hidden = !!S.info;
  if (!S.info) return;
  const card = (s) => {
    const a = cur(S.layer, s.slot);
    const k = kk(S.layer, s.slot);
    const kd = layerKeyFor(a) ? 'layer' : bindingFor(a) ? 'launch' : kind(a);
    return el('button', { class: 'key' + (S.sel === s.slot ? ' sel' : '') + (S.staged[k] ? ' dirty' : ''), 'data-kind': kd, onclick: () => { S.sel = s.slot; S.forced = null; render(); } },
      el('small', {}, el('span', {}, s.name), el('span', { class: 'badge' }, ico(kd), kd === 'launch' ? 'Actions' : kd === 'layer' ? 'Layer key' : KINDS.find(([id]) => id === kd)[1])),
      el('b', {}, describe(a)));
  };
  const { keys, knobs } = slotLayout();
  grid.append(...keys.map(card));
  if (knobs.length) grid.append(el('h3', {}, 'Knobs'), ...knobs.map(card));
}

function setKind(next) {
  const a = cur(S.layer, S.sel);
  const step = a.type === 'keys' ? a.steps[0] : null;
  S.forced = next;
  const make = {
    key: () => ({ type: 'keys', steps: step?.code ? [{ mods: 0, code: step.code }] : [], interval: 0 }),
    combo: () => ({ type: 'keys', steps: step ? [step] : [], interval: 0 }),
    mouse: () => ({ type: 'mouse', mods: 0, ...MOUSE[0][1] }),
    system: () => ({ type: 'media', usage: SYSTEM[0][1][0][1] }),
    macro: () => S.store.macros[0] ? { type: 'keys', steps: S.store.macros[0].steps, interval: S.store.macros[0].interval } : { type: 'keys', steps: [], interval: 0 },
  }[next]();
  stage(make);
}

function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  const info = S.info && slotInfo(S.sel);
  if (!info) { box.append(el('h2', {}, 'Assignment'), el('p', {}, 'Select a key once the keyboard is connected.')); return; }
  const a = cur(S.layer, S.sel);
  const k = S.forced ?? kind(a);
  box.append(el('h2', {}, `${info.name} · layer ${S.layer}`),
    el('div', { class: 'seg' }, KINDS.map(([id, n]) => el('button', { class: id === k ? 'on' : '', onclick: () => setKind(id) }, ico(id), n))));

  const step = a.type === 'keys' ? a.steps[0] : null;
  const field = (t, ...kids) => [el('label', { class: 'field' }, t), ...kids];
  if (k === 'key') {
    box.append(...field('Key', el('div', { class: 'row' },
      captureButton(step?.code ? fmtStep({ mods: 0, code: step.code }) : 'Click, then press a key', false, (p) => stage({ type: 'keys', steps: [{ mods: 0, code: p.code }], interval: 0 })),
      keySelect(step?.code, (code) => code && stage({ type: 'keys', steps: [{ mods: 0, code }], interval: 0 })))));
  } else if (k === 'combo') {
    const put = (s) => stage({ type: 'keys', steps: [s], interval: 0 });
    const s = step ?? { mods: 0, code: 0 };
    box.append(...field('Modifiers', chips(s.mods, MODS, (mods) => put({ ...s, mods }))),
      ...field('Key', el('div', { class: 'row' },
        captureButton(s.mods || s.code ? fmtStep(s) : 'Click, then press a combination', true, put),
        keySelect(s.code, (code) => put({ ...s, code })))),
      el('p', { class: 'hint' }, 'Modifier only (e.g. Win) is allowed; leave the key empty.'));
  } else if (k === 'mouse') {
    const m = a.type === 'mouse' ? a : { mods: 0, ...MOUSE[0][1] };
    box.append(...field('Action', el('div', { class: 'seg' }, MOUSE.map(([n, v]) => el('button', { class: v.buttons === m.buttons && v.wheel === m.wheel ? 'on' : '', onclick: () => stage({ type: 'mouse', mods: m.mods, ...v }) }, n)))),
      ...field('Hold while acting', chips(m.mods, MODS.slice(0, 4), (mods) => stage({ ...m, mods }))));
  } else if (k === 'system') {
    const u = a.type === 'media' ? a.usage : '';
    box.append(...field('Function', el('select', { value: u, onchange: (e) => stage({ type: 'media', usage: Number(e.target.value) }) },
      SYSTEM.map(([g, items]) => el('optgroup', { label: g }, items.map(([n, v]) => el('option', { value: v }, n)))))));
  } else {
    const hit = macroFor(a);
    box.append(...field('Saved macro', el('select', { value: hit?.id ?? '', onchange: (e) => { const m = S.store.macros.find((x) => x.id === e.target.value); m && stage({ type: 'keys', steps: m.steps, interval: m.interval }); } },
      el('option', { value: '' }, S.store.macros.length ? (hit ? '' : 'Choose macro…') : 'No macros saved yet'),
      S.store.macros.map((m) => el('option', { value: m.id }, m.name)))),
      ...(a.steps.length && !hit ? [el('p', { class: 'hint' }, `On the keyboard: ${a.steps.map(fmtStep).join(', ')} @ ${a.interval} ms`)] : []),
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => go('macros') }, 'Open macro editor')));
  }
  if (S.staged[kk(S.layer, S.sel)]) box.append(el('p', { class: 'note' }, 'Not written yet.'));
}

function renderBar() {
  const n = Object.keys(S.staged).length;
  $('#writebar').hidden = !n;
  const open = Object.values(S.staged).filter((x) => !complete(x)).length;
  $('#writeText').textContent = `${n} unsaved change${n > 1 ? 's' : ''}${open ? ` (${open} unfinished — pick a key to save it)` : ''}`;
}

// ---------- macros tab ----------
let macroTimer;
function markMacroDirty() {
  S.macroDirty = true;
  clearTimeout(macroTimer);
  macroTimer = setTimeout(saveStore, 500);
}

function newMacro() {
  const m = { id: 'm' + Date.now().toString(36), name: `Macro ${S.store.macros.length + 1}`, interval: 100, steps: [] };
  S.store.macros.push(m);
  S.macroSel = m.id;
  markMacroDirty();
  renderMacros();
}

function stopRecording() { S.recording?.(); S.recording = null; }

function startRecording(m) {
  let held = 0;
  const down = (e) => {
    e.preventDefault();
    if (e.repeat) return;
    if (MODBIT[e.code]) { held |= MODBIT[e.code]; return; }
    const k = BY_EV.get(e.code);
    if (!k) return;
    if (m.steps.length >= 18) { toast('A macro holds at most 18 steps', true); return stopAndRender(); }
    m.steps.push({ mods: held, code: k.hid });
    markMacroDirty();
    renderMacros();
  };
  const up = (e) => { if (MODBIT[e.code]) held &= ~MODBIT[e.code]; };
  const stopAndRender = () => { stopRecording(); renderMacros(); };
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  S.recording = () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
}

async function testMacro(m) {
  if (S.testing) { S.testing = false; return; }
  stopRecording();
  Object.assign(S, { testing: true, testLog: '', testText: '', testStep: -1 });
  renderMacros();
  let t = 0;
  for (let i = 0; i < m.steps.length && S.testing; i++) {
    const s = m.steps[i], shift = !!(s.mods & 0x22), plain = !(s.mods & ~0x22);
    const ch = plain && TYPED.get(s.code)?.[shift ? 1 : 0];
    if (ch) S.testText += ch; else if (plain && s.code === 0x2a) S.testText = S.testText.slice(0, -1);
    S.testLog += `${String(t).padStart(5)} ms  ${fmtStep(s)}\n`;
    S.testStep = i;
    renderMacros();
    if (i < m.steps.length - 1) { await sleep(Math.max(m.interval, 20)); t += m.interval; }
  }
  Object.assign(S, { testing: false, testStep: -1 });
  S.testLog += S.testLog ? `done · ${t} ms total\n` : '';
  renderMacros();
}

function renderMacros() {
  const list = $('#macroList'), ed = $('#macroEditor');
  const keepFocus = document.activeElement?.id;
  list.replaceChildren(...S.store.macros.map((m) => el('div', { class: 'mitem' + (m.id === S.macroSel ? ' on' : ''), onclick: () => { stopRecording(); S.testing = false; S.macroSel = m.id; renderMacros(); } },
    ico('macro'), m.name, el('span', {}, `${m.steps.length} steps`))));
  if (!S.store.macros.length) list.append(el('p', {}, 'No macros yet.'));
  ed.replaceChildren();
  const m = selMacro();
  if (!m) { ed.append(el('h2', {}, 'Macro'), el('p', {}, 'Create a macro to record a key sequence, test it here, then assign it to a key.')); return; }
  const touch = () => { markMacroDirty(); };
  const stepRow = (s, i) => el('div', { class: 'step' + (S.testStep === i ? ' now' : '') },
    el('span', { class: 'n' }, i + 1),
    chips(s.mods, MODS.slice(0, 4), (mods) => { s.mods = mods; touch(); renderMacros(); }),
    captureButton(s.code ? BY_HID.get(s.code).label : 'Key…', false, (p) => { s.code = p.code; touch(); renderMacros(); }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn small', disabled: i === 0, onclick: () => { m.steps.splice(i - 1, 0, m.steps.splice(i, 1)[0]); touch(); renderMacros(); } }, 'Up'),
    el('button', { class: 'btn small', disabled: i === m.steps.length - 1, onclick: () => { m.steps.splice(i + 1, 0, m.steps.splice(i, 1)[0]); touch(); renderMacros(); } }, 'Down'),
    el('button', { class: 'btn small', onclick: () => { m.steps.splice(i, 1); touch(); renderMacros(); } }, 'Remove'));
  const slotSel = el('select', { id: 'assignSlot', style: 'width:auto' }, [...slotLayout().keys, ...slotLayout().knobs].map((s) => el('option', { value: s.slot }, s.name)));
  ed.append(
    el('h2', {}, 'Macro'),
    el('label', { class: 'field' }, 'Name'),
    el('input', { type: 'text', id: 'mname', value: m.name, oninput: (e) => { m.name = e.target.value; touch(); }, onchange: renderMacros }),
    el('label', { class: 'field' }, 'Delay between steps (ms)'),
    el('div', { class: 'row' },
      el('input', { type: 'number', id: 'mint', min: 50, max: 60000, value: m.interval, oninput: (e) => { m.interval = Math.min(60000, Math.max(50, Number(e.target.value) || 50)); touch(); } }),
      el('span', { class: 'hint' }, 'One delay for the whole macro, 50–60000 ms.')),
    el('label', { class: 'field' }, `Steps (${m.steps.length}/18)`),
    ...m.steps.map(stepRow),
    el('div', { class: 'row' },
      el('button', { class: 'btn', disabled: m.steps.length >= 18, onclick: () => { m.steps.push({ mods: 0, code: 0 }); touch(); renderMacros(); } }, 'Add step'),
      el('button', { class: 'btn' + (S.recording ? ' primary' : ''), onclick: () => { if (S.recording) { stopRecording(); } else { S.testing = false; startRecording(m); } renderMacros(); } }, S.recording ? 'Stop recording' : 'Record keys'),
      el('button', { class: 'btn ghost', disabled: !m.steps.length, onclick: () => { m.steps = []; touch(); renderMacros(); } }, 'Clear')),
    el('p', { class: 'hint' }, 'Need to send a whole block of text? Add it in the Clipboard tab and bind it to a key (typed or pasted, with Enter after).'),
    el('h3', {}, 'Test'),
    el('p', { class: 'hint' }, 'Plays the sequence here with the chosen delay. It does not touch the keyboard or your system.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn', disabled: !m.steps.some((s) => s.code), onclick: () => testMacro(m) }, S.testing ? 'Stop' : 'Test macro')),
    el('pre', { class: 'log' }, S.testLog || 'Step log appears here.'),
    el('textarea', { class: 'preview', readonly: true, placeholder: 'Typed output preview' }, S.testText),
    el('h3', {}, 'Save and assign'),
    el('div', { class: 'row' },
      el('span', { class: 'hint' }, 'Changes save automatically.'),
      armed('Delete macro', async () => { stopRecording(); S.store.macros = S.store.macros.filter((x) => x !== m); S.macroSel = S.store.macros[0]?.id ?? null; await saveStore(); renderMacros(); })),
    el('div', { class: 'row' },
      slotSel,
      el('button', { class: 'btn', disabled: !S.info || !m.steps.some((s) => s.code), onclick: () => { S.sel = Number(slotSel.value); S.forced = 'macro'; stage({ type: 'keys', steps: m.steps.filter((s) => s.code || s.mods), interval: m.interval }); toast(`Staged on layer ${S.layer}; write it from the Keys tab`); } }, `Assign to layer ${S.layer}`)));
  if (keepFocus) { const f = document.getElementById(keepFocus); f?.focus(); if (f?.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length); }
}

// ---------- key actions + soundboard ----------
const shortcutOf = (l) => `Ctrl+Shift+Alt+F${l.n}`;
const selBinding = () => S.store.bindings.find((b) => b.id === S.bindSel);
const soundById = (id) => S.store.sounds.find((x) => x.id === id);
const freeHotkey = () => [...Array(12)].map((_, i) => i + 13).find((n) => ![...S.store.bindings, ...S.store.layerKeys].some((l) => l.n === n));

// Sounds are resolved here so the backend only sees file paths.
function bindingConfig(b) {
  return {
    shortcut: shortcutOf(b),
    actions: b.actions.flatMap((a) => {
      if (a.kind === 'type' || a.kind === 'paste') {
        const t = snippetById(a.snippet), cfg = S.store.settings;
        return t ? [{ when: a.when, kind: a.kind, text: t.text, send: a.send ?? cfg.autoSend, delay_ms: cfg.typeDelay, restore: cfg.restoreClipboard }] : [];
      }
      if (a.kind === 'sound') {
        const snd = soundById(a.sound);
        return snd ? [{ when: a.when, kind: 'sound', target: snd.path, volume: snd.volume, looped: !!a.looped }] : [];
      }
      return [{ when: a.when, kind: a.kind, target: a.target ?? '', args: a.args ?? '', hidden: !!a.hidden, mods: a.mods ?? 0, code: a.code ?? 0 }];
    }),
  };
}

async function syncHotkeys() {
  try {
    const maps = [1, 2, 3].map(layerMap);
    if (S.store.activeV && S.store.home) maps[0] = S.store.home;
    const led = [1, 2, 3].map((n) => (S.store.led[n] ? S.store.led[n].color << 4 | S.store.led[n].mode : null));
    const failed = await invoke('set_hotkeys', { cfg: { bindings: S.store.bindings.map(bindingConfig), layer_keys: S.store.layerKeys.map((k) => ({ shortcut: shortcutOf(k), mode: k.mode, target: k.target })), maps, led, active: S.store.activeV } });
    if (failed.length) toast(`Could not register: ${failed.join(', ')}`, true);
    S.store.sounds.forEach((s) => soundUrl(s.path).catch(() => {})); // preload for instant playback
  } catch (e) { toast(e, true); }
}
const persistBindings = async () => { await saveStore(); syncHotkeys(); };

// ----- audio engine (the webview plays; Rust sends start/stop events) -----
const audioCache = new Map(), playing = new Map(), starting = new Set();
async function soundUrl(path) {
  if (!audioCache.has(path)) {
    const buf = await invoke('read_audio', { path });
    const type = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4' }[path.split('.').pop().toLowerCase()] ?? 'audio/mpeg';
    audioCache.set(path, URL.createObjectURL(new Blob([buf instanceof ArrayBuffer ? buf : Uint8Array.from(buf)], { type })));
  }
  return audioCache.get(path);
}
function stopSound(id) {
  starting.delete(id);
  playing.get(id)?.pause();
  playing.delete(id);
}
async function playSound(path, volume, { id, looped } = {}) {
  try {
    if (id) { stopSound(id); starting.add(id); }
    const url = await soundUrl(path);
    if (id && !starting.delete(id)) return; // released while loading
    const a = new Audio(url);
    a.volume = Math.min(1, Math.max(0, ((volume ?? 100) / 100) * (S.store.settings.masterVolume / 100)));
    a.loop = !!looped;
    if (id) { playing.set(id, a); a.onended = () => { if (playing.get(id) === a) { playing.delete(id); renderIf('soundboard'); } }; }
    await a.play();
  } catch (e) { toast('Sound failed: ' + e, true); }
}
const onSound = (p) => (p.cmd === 'stop' ? stopSound(p.id) : playSound(p.path, p.volume, { id: p.id, looped: p.looped }));
const renderIf = (tab) => { if (S.tab === tab) render(); };

// ----- soundboard tab -----
async function addSounds() {
  const paths = await invoke('pick_sounds');
  for (const path of paths) {
    if (S.store.sounds.some((s) => s.path === path)) continue;
    S.store.sounds.push({ id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), path, volume: 100 });
  }
  if (paths.length) { await persistBindings(); render(); }
}

function renderSoundboard() {
  const grid = $('#sbGrid');
  grid.replaceChildren();
  $('#sbEmpty').hidden = S.store.sounds.length > 0;
  for (const snd of S.store.sounds) {
    const id = 'sb:' + snd.id, on = playing.has(id);
    const label = el('span', { class: 'hint' }, `Volume ${snd.volume}%`);
    grid.append(el('div', { class: 'snd' + (on ? ' on' : '') },
      el('button', { class: 'play', 'aria-label': on ? 'Stop' : 'Play', onclick: () => { on ? stopSound(id) : playSound(snd.path, snd.volume, { id }); render(); } }, ico('sound'), on ? 'Stop' : 'Play'),
      el('input', { type: 'text', value: snd.name, 'aria-label': 'Sound name', onchange: (e) => { snd.name = e.target.value || snd.name; persistBindings(); render(); } }),
      el('div', { class: 'hint path', title: snd.path }, snd.path),
      label,
      el('input', { type: 'range', min: 0, max: 100, value: snd.volume, oninput: (e) => { snd.volume = Number(e.target.value); label.textContent = `Volume ${snd.volume}%`; const a = playing.get(id); if (a) a.volume = (snd.volume / 100) * (S.store.settings.masterVolume / 100); }, onchange: persistBindings }),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', disabled: !S.info && false, onclick: () => newBinding(snd) }, 'Bind to a key'),
        armed('Remove', async () => { stopSound(id); S.store.sounds = S.store.sounds.filter((x) => x !== snd); await persistBindings(); render(); }, 'btn small danger'))));
  }
}

// ----- key actions tab -----
const WHEN = [['press', 'On press'], ['release', 'On release'], ['held', 'While held']];
const DO = [['sound', 'Play sound'], ['key', 'Press key'], ['type', 'Type text'], ['paste', 'Paste text'], ['app', 'Run program'], ['script', 'Run script']];
const PATH_HINT = { app: 'Path to a program', script: 'Path to a script (.ps1, .bat, .cmd, .py or any program)' };

function newBinding(sound) {
  const n = freeHotkey();
  if (!n) return toast('All 12 hotkeys (F13–F24) are in use', true);
  const b = { id: 'b' + Date.now().toString(36), name: sound ? sound.name : 'New key action', n, actions: [sound ? { when: 'press', kind: 'sound', sound: sound.id } : { when: 'press', kind: 'sound', sound: '' }] };
  S.store.bindings.push(b);
  S.bindSel = b.id;
  persistBindings();
  go('launchers');
}

function renderBindings() {
  const list = $('#launchList'), ed = $('#launchEditor');
  list.replaceChildren(...S.store.bindings.map((b) => el('div', { class: 'mitem' + (b.id === S.bindSel ? ' on' : ''), onclick: () => { S.bindSel = b.id; renderBindings(); } }, ico('launch'), b.name, el('span', {}, `${b.actions.length} action${b.actions.length === 1 ? '' : 's'}`))));
  if (!S.store.bindings.length) list.append(el('p', {}, 'No key actions yet.'));
  ed.replaceChildren();
  const b = selBinding();
  if (!b) {
    ed.append(el('h2', {}, 'Key actions'), el('p', {}, 'Give one key several jobs: play a sound while it is held, press another key when it is released, run a program, and more. The keyboard sends a rarely used hotkey and this app reacts to its press and release, so the app must be running (closing the window keeps it in the tray).'));
    return;
  }
  const save = (rerender) => { persistBindings(); if (rerender) renderBindings(); };
  const slots = [...slotLayout().keys, ...slotLayout().knobs];
  const slotSel = el('select', { id: 'launchSlot', style: 'width:auto' }, slots.map((s) => el('option', { value: s.slot }, s.name)));
  const sel = (opts, value, onchange) => el('select', { value, onchange: (e) => onchange(e.target.value), style: 'width:auto;flex:none' }, opts.map(([v, n]) => el('option', { value: v }, n)));

  const row = (a, i) => {
    const text = (key, ph) => el('input', { type: 'text', value: a[key] ?? '', placeholder: ph, oninput: (e) => { a[key] = e.target.value; }, onchange: () => save(true) });
    const browse = async () => { const p = await invoke('pick_file', { kind: a.kind }); if (p) { a.target = p; save(true); } };
    const test = async () => {
      if (a.kind === 'sound') { const s = soundById(a.sound); return s && playSound(s.path, s.volume); }
      try { await invoke('launch_now', { item: { ...a, when: 'press' } }); toast('Started'); } catch (e) { toast(e, true); }
    };
    const textCfg = () => [
      el('select', { value: a.snippet ?? '', onchange: (e) => { a.snippet = e.target.value; save(true); } },
        el('option', { value: '' }, S.store.snippets.length ? 'Choose a text block…' : 'Add text in the Clipboard tab first'),
        S.store.snippets.map((t) => el('option', { value: t.id }, t.name))),
      el('label', { class: 'hint' }, el('input', { type: 'checkbox', checked: a.send ?? S.store.settings.autoSend, onchange: (e) => { a.send = e.target.checked; save(); } }), ' Press Enter after'),
      el('button', { class: 'btn small', disabled: !a.snippet, onclick: () => { S.snipSel = a.snippet; go('clipboard'); } }, 'Edit text')];
    const cfg = {
      type: textCfg,
      paste: textCfg,
      sound: () => [
        el('select', { value: a.sound ?? '', onchange: (e) => { a.sound = e.target.value; save(true); } },
          el('option', { value: '' }, S.store.sounds.length ? 'Choose a sound…' : 'Add sounds in the Soundboard first'),
          S.store.sounds.map((s) => el('option', { value: s.id }, s.name))),
        ...(a.when === 'held' ? [el('label', { class: 'hint' }, el('input', { type: 'checkbox', checked: !!a.looped, onchange: (e) => { a.looped = e.target.checked; save(); } }), ' Loop while held')] : [])],
      key: () => [captureButton(a.code || a.mods ? fmtStep(a) : 'Click, then press a key', true, (p) => { a.mods = p.mods; a.code = p.code; save(true); }),
        ...(a.when === 'held' ? [el('span', { class: 'hint' }, 'Stays down while the key is held')] : [])],
      app: () => [text('target', PATH_HINT.app), el('button', { class: 'btn small', onclick: browse }, 'Browse…'), text('args', 'Arguments (optional)')],
      script: () => [text('target', PATH_HINT.script), el('button', { class: 'btn small', onclick: browse }, 'Browse…'), text('args', 'Arguments (optional)'),
        el('label', { class: 'hint' }, el('input', { type: 'checkbox', checked: !!a.hidden, onchange: (e) => { a.hidden = e.target.checked; save(); } }), ' No console window')],
    }[a.kind]();
    return el('div', { class: 'act' },
      el('div', { class: 'row' },
        sel(WHEN.filter(([w]) => w !== 'held' || a.kind === 'sound' || a.kind === 'key'), a.when, (v) => { a.when = v; save(true); }),
        sel(DO, a.kind, (v) => { a.kind = v; if (v !== 'sound' && v !== 'key' && a.when === 'held') a.when = 'press'; if ((v === 'type' || v === 'paste') && a.send === undefined) a.send = S.store.settings.autoSend; save(true); }),
        el('span', { class: 'spacer' }),
        ...(a.kind === 'sound' || a.kind === 'app' || a.kind === 'script' ? [el('button', { class: 'btn small', onclick: test }, 'Test')] : []),
        el('button', { class: 'btn small', 'aria-label': 'Remove action', onclick: () => { b.actions.splice(i, 1); save(true); } }, 'Remove')),
      el('div', { class: 'row' }, cfg));
  };

  ed.append(
    el('h2', {}, 'Key action'),
    el('label', { class: 'field' }, 'Name'),
    el('input', { type: 'text', id: 'bname', value: b.name, oninput: (e) => { b.name = e.target.value; }, onchange: () => save(true) }),
    el('h3', {}, 'When this key…'),
    ...b.actions.map(row),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { b.actions.push({ when: 'press', kind: 'key', mods: 0, code: 0 }); save(true); } }, 'Add action')),
    el('p', { class: 'hint' }, 'On press / on release happen once. While held starts on press and ends on release: a sound plays (optionally looping) and stops, a key stays down.'),
    el('h3', {}, 'Trigger'),
    el('p', {}, `Hotkey ${shortcutOf(b)}. Assign it to a key; it is written to the keyboard automatically.`),
    el('div', { class: 'row' },
      slotSel,
      el('button', { class: 'btn primary', disabled: !S.info, onclick: () => { S.sel = Number(slotSel.value); S.forced = 'combo'; stage({ type: 'keys', steps: [{ mods: LAUNCH_MODS, code: hotkeyCode(b.n) }], interval: 0 }); toast(`Assigned on layer ${S.layer}`); } }, `Assign to layer ${S.layer}`)),
    el('div', { class: 'row' },
      armed('Delete key action', async () => { S.store.bindings = S.store.bindings.filter((x) => x !== b); S.bindSel = S.store.bindings[0]?.id ?? null; await persistBindings(); renderBindings(); })));
}

// Old "launchers" (one action each) become bindings with the same hotkey, so existing key assignments keep working.
function migrateLaunchers() {
  const old = S.store['launchers']; // legacy key
  if (!old) return;
  for (const l of old) {
    let action;
    if (l.kind === 'sound') {
      let snd = S.store.sounds.find((s) => s.path === l.target);
      if (!snd && l.target) S.store.sounds.push(snd = { id: 's' + l.id, name: l.name, path: l.target, volume: l.volume ?? 100 });
      action = { when: 'press', kind: 'sound', sound: snd?.id ?? '' };
    } else action = { when: 'press', kind: l.kind, target: l.target, args: l.args ?? '', hidden: !!l.hidden };
    S.store.bindings.push({ id: l.id, name: l.name, n: l.n, actions: [action] });
  }
  delete S.store['launchers'];
  saveStore();
}

// ---------- layer keys tab ----------
const LAYER_MODES = [['goto', 'Go to'], ['toggle', 'Toggle'], ['cycle', 'Cycle'], ['hold', 'Hold']];
const layerKeyLabel = (k) => ({ goto: `Go to layer ${k.target}`, toggle: `Toggle layer ${k.target}`, cycle: 'Cycle layers', hold: `Hold: layer ${k.target}` })[k.mode];
const selLayerKey = () => S.store.layerKeys.find((k) => k.id === S.layerSel);

function newLayerKey() {
  const n = freeHotkey();
  if (!n) return toast('All 12 hotkeys (F13–F24) are in use', true);
  const k = { id: 'k' + Date.now().toString(36), mode: 'toggle', target: 2, n };
  S.store.layerKeys.push(k);
  S.layerSel = k.id;
  persistBindings();
  renderLayerKeys();
}

async function goHome() {
  if (!S.store.activeV) return;
  await syncHotkeys();
  await invoke('layers_goto', { to: 0 });
  S.store.activeV = 0;
  await readAll();
  await saveStore();
  await syncHotkeys();
}

function renderLayerKeys() {
  const list = $('#layerList'), ed = $('#layerEditor');
  list.replaceChildren(...S.store.layerKeys.map((k) => el('div', { class: 'mitem' + (k.id === S.layerSel ? ' on' : ''), onclick: () => { S.layerSel = k.id; renderLayerKeys(); } }, ico('layer'), layerKeyLabel(k))));
  if (!S.store.layerKeys.length) list.append(el('p', {}, 'No layer keys yet.'));
  ed.replaceChildren();
  const active = S.store.activeV + 1;
  ed.append(
    el('h2', {}, 'Software layers'),
    el('p', {}, `Active layer: ${active}. The keyboard itself only has layer 1; the app switches layers by rewriting the keys that differ, so it must be running (tray is fine). Layers 1–3 are the three layers you edit on the Keys tab.`),
    el('p', { class: 'note' }, 'Every switch writes the keyboard’s flash memory and takes about a quarter of a second. Flash wears out after many thousands of writes; the cost scales with how many keys differ between layers, and a hold is two switches. Keep layers similar, avoid very frequent switching, and prefer toggle/go-to over hold.'),
    ...(active > 1 ? [el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { try { await goHome(); toast('Back on layer 1'); } catch (e) { toast(e, true); } render(); } }, 'Return to layer 1'))] : []));
  const k = selLayerKey();
  if (!k) return;
  const slots = [...slotLayout().keys, ...slotLayout().knobs];
  const slotSel = el('select', { id: 'layerSlot', style: 'width:auto' }, slots.map((s) => el('option', { value: s.slot }, s.name)));
  const patch = (p) => { Object.assign(k, p); persistBindings(); renderLayerKeys(); };
  ed.append(
    el('h3', {}, 'Layer key'),
    el('label', { class: 'field' }, 'Behaviour'),
    el('div', { class: 'seg' }, LAYER_MODES.map(([m, n]) => el('button', { class: k.mode === m ? 'on' : '', onclick: () => patch({ mode: m }) }, n))),
    ...(k.mode === 'cycle' ? [el('p', { class: 'hint' }, 'Each press moves to the next layer: 1, 2, 3, then back to 1.')] : [
      el('label', { class: 'field' }, 'Target layer'),
      el('div', { class: 'seg' }, [1, 2, 3].map((n) => el('button', { class: k.target === n ? 'on' : '', onclick: () => patch({ target: n }) }, 'Layer ' + n))),
      el('p', { class: 'hint' }, { goto: 'Press to jump to that layer.', toggle: 'Press to jump to that layer, press again to return to layer 1.', hold: 'Hold to use that layer, release to go back.' }[k.mode])]),
    el('h3', {}, 'Trigger'),
    el('p', {}, `Hotkey ${shortcutOf(k)}. The layer key must exist on every layer to be usable, so this assigns it on layers 1, 2 and 3.`),
    el('div', { class: 'row' }, slotSel,
      el('button', { class: 'btn primary', disabled: !S.info, onclick: () => {
        const slot = Number(slotSel.value), action = { type: 'keys', steps: [{ mods: LAUNCH_MODS, code: hotkeyCode(k.n) }], interval: 0 };
        for (const layer of [1, 2, 3]) { const key = kk(layer, slot); if (same(action, S.device[key])) delete S.staged[key]; else S.staged[key] = action; }
        S.sel = slot; S.forced = 'combo';
        render();
        scheduleWrite();
        toast('Staged on all layers; write it from the Keys tab');
      } }, 'Assign to all layers')),
    el('div', { class: 'row' }, armed('Delete layer key', async () => { S.store.layerKeys = S.store.layerKeys.filter((x) => x !== k); S.layerSel = S.store.layerKeys[0]?.id ?? null; await persistBindings(); renderLayerKeys(); })));
}

// ---------- clipboard tab ----------
const snippetById = (id) => S.store.snippets.find((x) => x.id === id);
const selSnippet = () => snippetById(S.snipSel);
let snipTimer;

function newSnippet(text = '') {
  const t = { id: 't' + Date.now().toString(36), name: text ? text.split('\n')[0].slice(0, 32) : `Text ${S.store.snippets.length + 1}`, text };
  S.store.snippets.push(t);
  S.snipSel = t.id;
  saveStore();
  renderClipboard();
}

// method: 'type' sends characters one by one; 'paste' uses the clipboard and Ctrl+V (faster for long text)
function bindSnippet(t, kind) {
  const n = freeHotkey();
  if (!n) return toast('All 12 hotkeys (F13–F24) are in use', true);
  const b = { id: 'b' + Date.now().toString(36), name: t.name, n, actions: [{ when: 'press', kind, snippet: t.id, send: S.store.settings.autoSend }] };
  S.store.bindings.push(b);
  S.bindSel = b.id;
  persistBindings();
  go('launchers');
}

function renderClipboard() {
  const list = $('#clipList'), ed = $('#clipEditor');
  list.replaceChildren(...S.store.snippets.map((t) => el('div', { class: 'mitem' + (t.id === S.snipSel ? ' on' : ''), onclick: () => { S.snipSel = t.id; renderClipboard(); } }, ico('clip'), t.name, el('span', {}, `${t.text.length} chars`))));
  if (!S.store.snippets.length) list.append(el('p', {}, 'No text yet.'));
  ed.replaceChildren();
  const t = selSnippet();
  if (!t) { ed.append(el('h2', {}, 'Clipboard library'), el('p', {}, 'Keep blocks of text here (replies, addresses, code, prompts) and send them with a key: typed out, or pasted. Add one with New text.')); return; }
  const count = el('span', { class: 'hint' }, `${t.text.length} characters · ${t.text.split('\n').length} lines`);
  ed.append(
    el('h2', {}, 'Text block'),
    el('label', { class: 'field' }, 'Name'),
    el('input', { type: 'text', id: 'sname', value: t.name, oninput: (e) => { t.name = e.target.value; clearTimeout(snipTimer); snipTimer = setTimeout(() => { saveStore(); syncHotkeys(); }, 400); }, onchange: renderClipboard }),
    el('label', { class: 'field' }, 'Text'),
    el('textarea', { id: 'stext', class: 'block', spellcheck: 'false', value: t.text, oninput: (e) => { t.text = e.target.value; count.textContent = `${t.text.length} characters · ${t.text.split('\n').length} lines`; clearTimeout(snipTimer); snipTimer = setTimeout(() => { saveStore(); syncHotkeys(); }, 400); } }),
    count,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: async () => { try { await invoke('copy_text', { text: t.text }); toast('Copied to the clipboard'); } catch (e) { toast(e, true); } } }, 'Copy'),
      el('button', { class: 'btn primary', onclick: () => bindSnippet(t, 'type') }, 'Bind to a key: type it'),
      el('button', { class: 'btn primary', onclick: () => bindSnippet(t, 'paste') }, 'Bind to a key: paste it')),
    el('p', { class: 'hint' }, 'Typing sends each character (works almost everywhere, slower for long text). Pasting sets the clipboard and presses Ctrl+V (instant; your clipboard is restored afterwards unless you turn that off in Settings). Pressing Enter afterwards is a per-action toggle, on by default.'),
    el('div', { class: 'row' }, armed('Delete text block', () => { S.store.snippets = S.store.snippets.filter((x) => x !== t); S.snipSel = S.store.snippets[0]?.id ?? null; saveStore(); syncHotkeys(); renderClipboard(); })));
}

// ---------- settings tab ----------
const ACCENTS = { indigo: ['#7a8cff', '#b07cff'], teal: ['#2dd4bf', '#38bdf8'], rose: ['#fb7185', '#f472b6'], amber: ['#f59e0b', '#fb923c'], green: ['#4ade80', '#2dd4bf'] };
function applyAccent() {
  const [a, b] = ACCENTS[S.store.settings.accent] ?? ACCENTS.indigo;
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-2', b);
}

async function renderSettings() {
  const root = $('#settingsPanel'), st = S.store.settings;
  const set = (key, value, after) => { st[key] = value; saveStore(); after?.(); };
  const group = (title, ...rows) => el('div', { class: 'setgroup' }, el('h3', {}, title), ...rows);
  const row = (title, hint, control) => el('div', { class: 'setrow' }, el('div', {}, el('div', { class: 'st' }, title), hint ? el('div', { class: 'hint' }, hint) : null), control);
  const toggle = (key, after) => el('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => set(key, e.target.checked, after) });
  const autostart = el('input', { type: 'checkbox', disabled: true });
  root.replaceChildren(
    el('h2', {}, 'Settings'),
    group('General',
      row('Write key changes automatically', 'Edits are written about 0.7 s after the last change. Every write uses flash memory; turn off if you tweak a lot.', toggle('autoWrite', scheduleWrite)),
      row('Apply lighting automatically', 'Send colour and animation changes as soon as you pick them.', toggle('autoLight')),
      row('Closing the window keeps the app running', 'Hides to the system tray so key actions, sounds and layer keys keep working. Quit from the tray icon.', toggle('closeToTray', () => invoke('set_close_to_tray', { on: st.closeToTray }))),
      row('Start with Windows (hidden in the tray)', null, autostart),
      row('Accent colour', null, el('div', { class: 'swatches small' }, Object.entries(ACCENTS).map(([n, [a]]) => el('button', { class: 'sw' + (st.accent === n ? ' on' : ''), title: n, 'aria-label': n, style: `background:${a};color:${a}`, onclick: () => set('accent', n, () => { applyAccent(); renderSettings(); }) }))))),
    group('Text blocks',
      row('Press Enter after sending text', 'Default for new type/paste actions; each action has its own toggle.', toggle('autoSend')),
      row('Typing delay', 'Milliseconds between typed characters. Raise it if an app drops characters.', el('input', { type: 'number', min: 0, max: 200, value: st.typeDelay, onchange: (e) => set('typeDelay', Math.min(200, Math.max(0, Number(e.target.value) || 0)), syncHotkeys) })),
      row('Restore the clipboard after pasting', null, toggle('restoreClipboard', syncHotkeys))),
    group('Sound',
      row(`Master volume ${st.masterVolume}%`, 'Scales every sound, on top of each sound’s own volume.', el('input', { type: 'range', min: 0, max: 100, value: st.masterVolume, oninput: (e) => { st.masterVolume = Number(e.target.value); e.target.closest('.setrow').querySelector('.st').textContent = `Master volume ${st.masterVolume}%`; playing.forEach((a) => (a.volume = Math.min(1, st.masterVolume / 100))); }, onchange: () => saveStore() }))),
    group('Data',
      row('App data folder', 'Macros, sounds, text blocks, key actions and layer keys live in store.json.', el('button', { class: 'btn', onclick: () => invoke('open_data_dir').catch((e) => toast(e, true)) }, 'Open folder')),
      row('Export settings', 'Saves the whole library to a file.', el('button', { class: 'btn', onclick: async () => { try { const { home, activeV, ...data } = S.store; const p = await invoke('export_settings', { data: JSON.stringify(data, null, 2) }); if (p) toast('Exported'); } catch (e) { toast(e, true); } } }, 'Export…')),
      row('Import settings', 'Replaces the current library with a file.', el('button', { class: 'btn', onclick: async () => {
        try {
          const text = await invoke('import_settings');
          if (!text) return;
          const { home, activeV, ...data } = JSON.parse(text);
          S.store = { ...S.store, bindings: [], sounds: [], snippets: [], macros: [], layerKeys: [], led: {}, ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings }, home: S.store.home, activeV: S.store.activeV };
          await saveStore(); await syncHotkeys(); applyAccent(); invoke('set_close_to_tray', { on: S.store.settings.closeToTray });
          toast('Imported'); render();
        } catch (e) { toast('Import failed: ' + e, true); }
      } }, 'Import…')),
      row('Reset app data', 'Deletes every macro, sound, text block, key action and layer key from this app. The keyboard itself is not touched.', armed('Reset…', async () => {
        S.store = { ...S.store, macros: [], bindings: [], sounds: [], snippets: [], layerKeys: [], led: {}, settings: { ...DEFAULT_SETTINGS } };
        S.macroSel = S.bindSel = S.snipSel = S.layerSel = null;
        await saveStore(); await syncHotkeys(); applyAccent(); toast('App data reset'); render();
      }))),
    group('About', row('MiniKeyboard Configurator', `Hotkeys in use: ${S.store.bindings.length + S.store.layerKeys.length} of 12. Key and macro encodings are documented in PROTOCOL.md.`, el('span', { class: 'hint' }, 'v0.1.0'))));
  try {
    autostart.checked = await invoke('get_autostart');
    autostart.disabled = false;
    autostart.onchange = async () => { try { await invoke('set_autostart', { on: autostart.checked }); } catch (e) { toast(e, true); autostart.checked = !autostart.checked; } };
  } catch { /* leave disabled */ }
}

// ---------- lighting tab ----------
const COLORS = [['Red', '#ff3b3b'], ['Orange', '#ff9a2e'], ['Yellow', '#ffd93b'], ['Green', '#3bd16f'], ['Cyan', '#35d0e0'], ['Blue', '#3b6bff'], ['Purple', '#a05bff']];
const ANIMS = ['Off', 'Static', 'Reactive', 'Reactive alternate', 'When pressed', 'Cycle'];
const led = () => ({ color: 5, mode: 1, extra: [0, 0, 0, 0], ...S.store.led[S.layer] });

async function applyLed(layers) {
  const v = led();
  try {
    for (const layer of layers) {
      await invoke('set_led', { layer, led: v.color << 4 | v.mode, extra: v.extra });
      S.store.led[layer] = v;
    }
    await saveStore();
    await syncHotkeys();
    toast(layers.length > 1 ? 'Lighting applied to all layers' : 'Lighting applied');
  } catch (e) { toast(e, true); }
}

let ledTimer;
function autoApplyLed() {
  saveStore();
  if (!S.info || !S.store.settings.autoLight) return;
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => applyLed([S.layer]), 500);
}

function renderLighting() {
  const p = $('#lightPanel');
  const l = led();
  const set = (patch) => { S.store.led[S.layer] = { ...l, ...patch }; renderLighting(); autoApplyLed(); };
  const num = (label, val, max, onChange) => el('label', { class: 'hint' }, label + ' ', el('input', { type: 'number', min: 0, max, value: val, onchange: (e) => onChange(Math.min(max, Math.max(0, Number(e.target.value) || 0))) }));
  p.replaceChildren(
    el('h2', {}, `Lighting · layer ${S.layer}`),
    el('div', { class: 'stage' + (l.mode === 5 ? ' rainbow' : l.mode === 0 ? ' off' : ''), style: `--glow:${COLORS[l.color - 1]?.[1] ?? '#888'}` }, [0, 1, 2, 3, 4].map(() => el('div', { class: 'cap' }))),
    el('h3', {}, 'Color'),
    el('div', { class: 'swatches' + (l.mode === 0 || l.mode === 5 ? ' dim' : '') }, COLORS.map(([n, c], i) => el('button', { class: 'sw' + (l.color === i + 1 ? ' on' : ''), title: n, 'aria-label': n, style: `background:${c};color:${c}`, onclick: () => set({ color: i + 1 }) }))),
    el('h3', {}, 'Mode'),
    el('div', { class: 'modes' }, [0, 1, 2, 3, 4, 5].map((m) => el('button', { class: 'mode' + (l.mode === m ? ' on' : ''), onclick: () => set({ mode: m }) }, ANIMS[m]))),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', disabled: !S.info, onclick: () => applyLed([S.layer]) }, `Apply to layer ${S.layer}`),
      el('button', { class: 'btn', disabled: !S.info, onclick: () => applyLed([1, 2, 3]) }, 'Apply to all layers')),
    el('p', { class: 'hint' }, 'The keyboard cannot report its lighting, so this shows what this app last applied. Cycle ignores the colour and Off turns the lighting off. This keyboard has no brightness control (probed on hardware: no setting changes it).'),
    el('details', {},
      el('summary', {}, 'Advanced: probe the firmware'),
      el('p', { class: 'hint' }, 'Documented values are color 1–7 and mode 0–5. Tested on hardware: modes above 5 and the extra bytes change nothing visible.'),
      el('div', { class: 'row' }, num('Color nibble', l.color, 15, (v) => set({ color: v })), num('Mode nibble', l.mode, 15, (v) => set({ mode: v }))),
      el('div', { class: 'row' }, l.extra.map((b, i) => num('Extra ' + (i + 1), b, 255, (v) => { const extra = [...l.extra]; extra[i] = v; set({ extra }); }))),
      el('button', { class: 'btn', disabled: !S.info, onclick: () => applyLed([S.layer]) }, 'Send')));
}

// ---------- device tab ----------
async function renderDevice() {
  const i = S.info;
  const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
  $('#info').replaceChildren(...(i ? [['USB id', `${hex(i.vid)}:${hex(i.pid)}`], ['Keys', i.keys], ['Knobs', i.knobs], ['Device type', i.device_type], ['Layers', 3]] : [['Status', 'Not connected']])
    .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]));
  try {
    const l = await invoke('list_devices');
    $('#hidList').textContent = l.length ? l.map((d) => `${hex(d.vid)}:${hex(d.pid)}  usage page ${hex(d.usage_page)}  ${d.product ?? ''}`).join('\n') : 'No matching HID interfaces.';
  } catch (e) { $('#hidList').textContent = String(e); }
}

// ---------- shell ----------
function go(tab) {
  S.tab = tab;
  if (tab !== 'macros') stopRecording();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== tab));
  render();
}

function render() {
  stopCapture?.();
  $('#dot').classList.toggle('on', !!S.info);
  $('#status').textContent = S.info ? `${S.info.keys} keys${S.info.knobs ? ` · ${S.info.knobs} knobs` : ''}${S.store.activeV ? ` · layer ${S.store.activeV + 1}` : ''}` : 'Not connected';
  $('#connect').textContent = S.info ? 'Reconnect' : 'Connect';
  $('#layerNo').textContent = S.layer;
  $('#layers').replaceChildren(...[1, 2, 3].map((n) => el('button', { class: n === S.layer ? 'on' : '', onclick: () => { S.layer = n; S.forced = null; render(); } }, String(n))));
  renderBar();
  if (S.tab === 'keys') { renderGrid(); renderInspector(); }
  else if (S.tab === 'macros') renderMacros();
  else if (S.tab === 'launchers') renderBindings();
  else if (S.tab === 'soundboard') renderSoundboard();
  else if (S.tab === 'clipboard') renderClipboard();
  else if (S.tab === 'settings') renderSettings();
  else if (S.tab === 'layerkeys') renderLayerKeys();
  else if (S.tab === 'lighting') renderLighting();
  else renderDevice();
}

document.querySelectorAll('#tabs button').forEach((b) => { b.title = b.textContent; b.onclick = () => go(b.dataset.tab); });
$('#connect').onclick = connect;
$('#emptyConnect').onclick = connect;
$('#macroNew').onclick = newMacro;
$('#layerNew').onclick = newLayerKey;
$('#bindNew').onclick = () => newBinding();
$('#sbAdd').onclick = addSounds;
$('#sbStop').onclick = () => { [...playing.keys()].forEach(stopSound); render(); };
$('#clipNew').onclick = () => { go('clipboard'); newSnippet(); };
$('#clipFromClipboard').onclick = async () => { try { const t = await invoke('read_clipboard'); if (t) { go('clipboard'); newSnippet(t); } else toast('The clipboard has no text', true); } catch (e) { toast(e, true); } };
$('#reread').onclick = async () => { try { await readAll(); toast('Read from keyboard'); } catch (e) { toast(e, true); } render(); };
$('#reset').replaceWith(Object.assign(armed('Reset keyboard…', async () => { try { await invoke('clean_device_data'); toast('Keyboard reset'); await connect(); } catch (e) { toast(e, true); } }), { id: 'reset' }));
$('#write').onclick = writeStaged;
$('#discard').onclick = () => { S.staged = {}; S.forced = null; render(); };
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS' && S.tab === 'macros') { e.preventDefault(); saveStore().then((ok) => ok && (toast('Macro library saved'), renderMacros())); } });

(async () => {
  try { S.store = { macros: [], led: {}, bindings: [], sounds: [], snippets: [], layerKeys: [], home: null, activeV: 0, ...JSON.parse(await invoke('load_store')) }; } catch (e) { toast('Could not load saved macros: ' + e, true); }
  S.store.settings = { ...DEFAULT_SETTINGS, ...S.store.settings };
  applyAccent();
  invoke('set_close_to_tray', { on: S.store.settings.closeToTray }).catch(() => {});
  migrateLaunchers();
  S.snipSel = S.store.snippets[0]?.id ?? null;
  S.macroSel = S.store.macros[0]?.id ?? null;
  S.bindSel = S.store.bindings[0]?.id ?? null;
  syncHotkeys();
  const ev = window.__TAURI__?.event;
  ev?.listen('layer', (e) => { S.store.activeV = e.payload; saveStore(); render(); });
  ev?.listen('sound', (e) => onSound(e.payload));
  ev?.listen('layer-error', (e) => toast('Layer switch failed: ' + e.payload, true));
  render();
  connect();
})();
