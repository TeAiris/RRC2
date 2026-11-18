// Drum circle room: the default view of Rhythms Re‿Connected.
//
// A round hall with the globe at its centre and the ensemble in a circle around it.
//   HOME    the globe with rhythm names; pick a rhythm from the cards or the globe
//   TRAVEL  the camera dives into the globe and hands over to the Cesium journey
//   CIRCLE  on arrival the camera pulls back to the drum circle for that rhythm
//   FOCUS   sit at one instrument; the rhythm to follow is drawn on and around it
//
// The room listens to the app (journey, rhythm data, scheduled steps) and sends strokes and
// commands back through the app's existing bridges. It owns no sound and no rhythm data.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { paintDjembe, preset as FLOW_PRESET, strokeToZone } from './djembe-visual.js';

const params = new URLSearchParams(location.search);
// Standalone demo page (no app around it): no classic layout, no map handover.
const DEMO = !!window.RRC_ROOM_DEMO;
// Storage can be unavailable (private modes, sandboxed frames).
const store = {
  get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch {} }
};
const PAD_ONLY = params.get('padRemote') === '1'
  || (params.has('mobile') && !['0', 'false', 'off', 'no'].includes(String(params.get('mobile')).toLowerCase()));
const BASE = new URL('./assets/', import.meta.url).href;

// Same colours as the notation (notation-styles.css).
const ACCENT = { tone: '#fcd116', slap: '#ce1126', bass: '#19a463', mute: '#ff8c00', bell: '#ce1126' };
const CHAR = { slap: 'X', bass: 'B', mute: 'M', bell: 'X' };
const DEFAULT_BEATS = ['#ce1126', '#fcd116', '#009460', '#fcd116'];
const MODEL_FOR = { djembe: 'Djembe', djembe_solo: 'DjembeLead', kenkeni: 'Kenkeni', sangban: 'Sangban', doundoun: 'Doundoun', shekere: 'Shekere' };
const BELL_OF = { kenkeni_bell: 'kenkeni', sangban_bell: 'sangban', doundoun_bell: 'doundoun' };
const DUNUN = { Kenkeni: { D: 0.25, L: 0.40, zc: 0.70 }, Sangban: { D: 0.31, L: 0.50, zc: 0.68 }, Doundoun: { D: 0.39, L: 0.62, zc: 0.66 } };
// Forged kenken bells, sized per drum: height, mouth width (m). Shape follows hand-folded iron bells.
const BELL_SIZE = { Kenkeni: { H: 0.13, W: 0.094 }, Sangban: { H: 0.155, W: 0.11 }, Doundoun: { H: 0.18, W: 0.125 } };
// Hit feedback: how strong a stroke shows, how long it holds at full strength, how long it fades (ms).
const FEEDBACK_DEFAULTS = Object.freeze({
  idle: 0.12,
  djembe: { intensity: 0.6, hold: 140, fade: 280 },
  dunun: { intensity: 0.6, hold: 140, fade: 320 },
  bell: { intensity: 0.6, hold: 120, fade: 360 }
});
const FEEDBACK_KEY = 'rrcRoomFeedback';
function loadFeedback() {
  const d = JSON.parse(JSON.stringify(FEEDBACK_DEFAULTS));
  try {
    const saved = JSON.parse(store.get(FEEDBACK_KEY) || '{}');
    if (Number.isFinite(saved.idle)) d.idle = clamp(saved.idle, 0, 0.6);
    for (const k of ['djembe', 'dunun', 'bell']) for (const f of ['intensity', 'hold', 'fade']) if (Number.isFinite(saved[k]?.[f])) d[k][f] = saved[k][f];
  } catch {}
  return d;
}
// Strength of a hit `age` ms after it landed: full for `hold`, then a linear fade.
function reaction(age, f) {
  if (!Number.isFinite(age) || age < 0) return 0;
  if (age < f.hold) return f.intensity;
  return f.intensity * Math.max(0, 1 - (age - f.hold) / Math.max(1, f.fade));
}
const reactionSpan = (f) => f.hold + f.fade + 40;
const DJEMBE_HEAD_Y = 0.652;
const DJEMBE_R = 0.186;
const CIRCLE_R = 2.45;
const GLOBE_R = 0.62;
const HALL_R = 6.2;
const CLOTHS = [1, 2, 3, 4, 5, 2, 4, 1, 5, 3, 4, 5];      // one cloth per hanging, neighbours differ
// Rope and ring colours: the call drum is orange, the other djembes take turns.
const CALL_WRAP = '#e8711c';
const DJEMBE_WRAPS = ['#b3241c', '#1f7a3d', '#d9a01a', '#2f4fa8', '#7a2f86', '#f2efe6'];
const VIEWS = ['player', 'top', 'side'];
const VIEW_NAMES = { player: 'Player', top: 'Top', side: 'Side' };
// Windows and tools of the full app, in the order the menu lists them (ids of the old top bar buttons).
const MENU_WINDOWS = [['notation-toggle', 'Notation'], ['stage-toggle', 'Stage'], ['trigger-pad-toggle', 'Pads'], ['circular-toggle', 'Circular'],
  ['media-toggle', 'Media'], ['history-toggle', 'Context'], ['info-toggle', 'Title'], ['rhythm-toggle', 'Rhythm list'], ['map-toggle', 'Map'],
  ['nav-toggle', 'Nav'], ['qr-toggle', 'QR'], ['session-toggle', 'Session'], ['auth-toggle', 'User'], ['debug-toggle', 'Settings']];
const MENU_TOOLS = [['mute-all-audio-btn', 'Mute all'], ['tidy-toggle', 'Tidy windows'], ['views-toggle', 'Saved views'], ['window-select-toggle', 'Select windows'],
  ['serve-local-toggle', 'Serve'], ['saveStateBtn', 'Save state'], ['exportSettingsBtn', 'Export settings'], ['importSettingsBtn', 'Import settings'], ['resetSettingsBtn', 'Reset settings']];

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function strokeOf(value) {
  const m = /^(tone|slap|bass|mute)(Tone|Slap|Bass|Mute)?(Flam|Roll)$/.exec(String(value || ''));
  return m ? { grace: m[1], main: m[2] ? m[2].toLowerCase() : m[1], kind: m[3].toLowerCase() } : null;
}
// Small grace stroke drawn up and to the left of the main note (flam), doubled for a roll.
function drawGrace(g, x, y, r, value) {
  const st = strokeOf(value);
  if (!st) return;
  const gr = r * 0.42;
  const marks = st.kind === 'roll' ? 2 : 1;
  for (let k = 0; k < marks; k++) {
    const gx = x - r * 0.95 - k * gr * 1.1, gy = y - r * 0.85;
    g.fillStyle = st.grace === 'tone' ? 'rgba(252, 209, 22, 0.25)' : 'rgba(20,20,20,0.9)';
    g.strokeStyle = ACCENT[st.grace]; g.lineWidth = Math.max(1.5, r * 0.12);
    g.beginPath(); g.arc(gx, gy, gr, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}

function soundOf(value, isBell) {
  const st = strokeOf(value);
  if (st && !isBell) return st.main;
  const raw = String(value || '').toLowerCase();
  if (!raw || raw === 'silence' || raw === 'rest' || raw === 'null' || raw === 'clear') return null;
  if (isBell) return 'bell';
  if (raw.includes('bass')) return 'bass';
  if (raw.includes('slap')) return 'slap';
  if (raw.includes('mute') || raw.includes('muff') || raw.includes('closed')) return 'mute';
  return 'tone';
}

// One history text per rhythm: the merged text where there is one; otherwise the short
// description and the longer context joined, without repeating a text the other already holds.
function historyOf(r) {
  if (!r) return '';
  if (r.historicalContext) return String(r.historicalContext).trim();
  try {
    const fb = Object.values(FALLBACK_rhythmData || {}).find((x) => x && x.name === r.name && x.culturalContext === r.culturalContext);
    if (fb?.historicalContext) return fb.historicalContext;
  } catch {}
  const d = String(r.description || '').trim(), c = String(r.culturalContext || '').trim();
  if (!d) return c;
  if (!c || c.includes(d)) return c || d;
  if (d.includes(c)) return d;
  return `${d} ${c}`;
}

function appRhythms() { try { return allRhythms || {}; } catch { return {}; } }
function beatColors() {
  try { if (Array.isArray(latestNotationBeatColors) && latestNotationBeatColors.length) return latestNotationBeatColors; } catch {}
  return DEFAULT_BEATS;
}
function sessionInfo() { try { return sessionState || {}; } catch { return {}; } }

class Room {
  constructor() {
    this.enabled = params.get('room') !== '0';
    this.state = 'HOME';
    this.seats = [];
    this.focus = null;
    this.rhythm = null;
    this.signature = '';
    this.journey = null;
    this.rhythmKey = '';
    this.playing = false;
    this.stepQueue = [];
    this.clock = { step: -1, epoch: 0, dur: 150, durs: [] };
    this.tween = null;
    this.orbit = { az: 0, pol: 1.32, r: 4.7, target: new THREE.Vector3(0, 1.25, 0), auto: true };
    this.pointer = { down: false, moved: 0, x: 0, y: 0 };
    this.touches = new Map();
    this.djembeView = store.get('rrcRoomDjembeView') === 'line' ? 'line' : 'ring';
    this.focusView = 'player';
    this.feedback = loadFeedback();
    // This device's own solo / mute by instrument id, kept across rhythm loads (sessions reload the rhythm).
    try { this.mixPref = JSON.parse(store.get('rrcRoomMixPref') || '{}') || {}; } catch { this.mixPref = {}; }
    // Phones in a session solo the instrument they sit at, until the person uses S / M / ✕ themselves.
    this.autoSolo = PAD_ONLY;
    this.autoSoloIds = [];
    this.focusZoom = 1;
    this.callState = null;
    this.bootAt = performance.now();
    this.mapOnline = !DEMO;
    if (!DEMO) fetch('https://assets.ion.cesium.com/', { mode: 'no-cors', cache: 'no-store' }).catch(() => { this.mapOnline = false; });
    this.tmp = new THREE.Vector3();
    this.buildDom();
    this.buildScene();
    this.bind();
    this.setEnabled(this.enabled, { initial: true });
    this.load();
  }

  // ================================================================ DOM
  buildDom() {
    const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; };
    const btn = (label, title, fn, cls = '') => { const b = el('button', `room-btn ${cls}`.trim(), label); b.type = 'button'; b.title = title; b.addEventListener('click', fn); return b; };
    this.view = el('div'); this.view.id = 'room-view';
    this.labels = el('div'); this.labels.id = 'room-labels';
    this.hud = el('div'); this.hud.id = 'room-hud';

    this.title = el('div', 'room-title');
    this.titleName = el('div', 'room-title-name');
    this.titlePlace = el('div', 'room-title-place');
    this.title.append(this.titleName, this.titlePlace);
    this.hint = el('div', 'room-hint');

    this.bar = el('nav', 'room-bar');
    this.btnMenu = btn('☰', 'All views', () => this.toggleSheet('menu'), 'room-btn-icon');
    this.btnRhythms = btn('Rhythms', 'Choose a rhythm', () => this.toggleSheet('picker'));
    this.btnGlobe = btn('Globe', 'Back to the globe', () => this.go('HOME'));
    this.btnMap = btn('Map', 'Explore the world map: geography and place names', () => this.toggleMap());
    this.btnCircle = btn('Circle', 'The drum circle', () => this.go('CIRCLE'));
    this.btnPrev = btn('◀', 'Previous instrument', () => this.stepFocus(-1), 'room-btn-icon');
    this.seatName = el('div', 'room-seat');
    this.btnNext = btn('▶', 'Next instrument', () => this.stepFocus(1), 'room-btn-icon');
    this.btnPlay = btn('Play', 'Play or stop', () => this.togglePlay(), 'room-btn-play');
    this.btnCall = btn('Call In', 'Call In when stopped, Call when playing', () => this.call('call'), 'room-btn-call');
    this.btnCallOut = btn('Call Out', 'Play the call next measure, then stop', () => this.call('callOut'), 'room-btn-call');
    this.btnNotation = btn('Notation', 'Notation table', () => document.getElementById('notation-toggle')?.click());
    this.btnAbout = btn('About', 'Name, place and history', () => this.toggleSheet('about'));
    this.btnSession = btn('Session', 'Play together', () => this.toggleSheet('session'));
    this.btnFeedback = btn('⚙', 'Room settings: follower timing and hit feedback', () => this.toggleSheet('feedback'), 'room-btn-icon');
    this.bar.append(this.btnMenu, this.btnRhythms, this.btnMap, this.btnGlobe, this.btnCircle, this.btnPrev, this.seatName, this.btnNext,
      this.btnPlay, this.btnCall, this.btnCallOut, this.btnNotation, this.btnAbout, this.btnSession, this.btnFeedback);
    this.btnCallOut.hidden = true;
    this.btnMet = btn('Met', 'Metronome (the shekere keeps the beat)', () => this.setMet(!this.met));
    this.tempoBox = el('div', 'room-tempo');
    const tDown = btn('−', 'Slower', () => this.nudgeTempo(-2), 'room-btn-icon');
    this.tempoInput = el('input', 'room-tempo-input');
    Object.assign(this.tempoInput, { type: 'number', min: 40, max: 240, step: 1, inputMode: 'numeric', title: 'Tempo (BPM)' });
    this.tempoInput.addEventListener('change', () => this.setTempo(parseInt(this.tempoInput.value, 10)));
    this.tempoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.tempoInput.blur(); e.stopPropagation(); });
    const tUp = btn('+', 'Faster', () => this.nudgeTempo(2), 'room-btn-icon');
    const tLabel = el('span', 'room-tempo-label', 'BPM');
    this.tempoBox.append(tDown, this.tempoInput, tLabel, tUp);
    this.btnCallOut.after(this.btnMet, this.tempoBox);

    // Seated: how the part is shown and where the camera sits.
    this.tools = el('div', 'room-tools');
    const seg = (items, onPick) => {
      const g = el('div', 'room-seg');
      for (const [v, label] of items) { const b = btn(label, label, () => onPick(v)); b.dataset.v = v; g.append(b); }
      return g;
    };
    this.segNotation = seg([['ring', 'Ring'], ['line', 'Line']], (v) => { this.djembeView = v; store.set('rrcRoomDjembeView', v); this.applyState(); this.refocus(); });
    this.segView = seg(VIEWS.map((v) => [v, VIEW_NAMES[v]]), (v) => { this.focusView = v; this.focusZoom = 1; this.refocus(); });
    const zoom = el('div', 'room-seg');
    zoom.append(btn('−', 'Zoom out', () => this.zoomFocus(1.15), 'room-btn-icon'), btn('+', 'Zoom in', () => this.zoomFocus(1 / 1.15), 'room-btn-icon'));
    // Solo and mute for the instrument you are sitting at (a dunun seat covers drum and bell).
    this.segMix = el('div', 'room-seg');
    this.btnSolo = btn('S', 'Solo this instrument', () => this.toggleMix('soloed'), 'room-btn-icon room-btn-solo');
    this.btnMute = btn('M', 'Mute this instrument', () => this.toggleMix('muted'), 'room-btn-icon room-btn-mute');
    this.btnClearMix = btn('✕', 'Unmute and unsolo every instrument', () => this.clearMix(), 'room-btn-icon room-btn-clearmix');
    this.segMix.append(this.btnSolo, this.btnMute, this.btnClearMix);
    const zoomRow = el('div', 'room-tools-row');
    zoomRow.append(this.segMix, zoom);
    this.tools.append(this.segNotation, this.segView, zoomRow);
    if (PAD_ONLY) this.bar.append(this.segNotation);          // phones: Ring / Line sits in the top bar
    this.lineCanvas = el('canvas', 'room-line');

    if (DEMO) this.btnNotation.hidden = true;               // the notation window is part of the full app
    this.sheets = {};
    for (const name of ['menu', 'picker', 'about', 'session', 'feedback']) {
      const s = el('section', `room-sheet room-sheet-${name}`);
      s.hidden = true;
      this.sheets[name] = s;
      this.hud.append(s);
    }
    this.loading = el('div', 'room-loading', 'Loading the room');
    // Session countdown: the same shared start on the leader and every follower.
    this.countdown = el('div', 'room-countdown');
    this.countdown.innerHTML = '<div class="room-countdown-label"></div><div class="room-countdown-num"></div>';
    this.countdown.hidden = true;
    this.hud.append(this.countdown);
    // Top middle: what the rhythm is for. Seated tools stay top right.
    this.meaning = el('div', 'room-meaning');
    this.meaningText = el('p', 'room-meaning-text');
    this.meaning.append(el('div', 'room-meaning-label', 'Historical Context'), this.meaningText);
    this.right = el('div', 'room-right');
    this.right.append(this.tools);
    this.hud.append(this.title, this.meaning, this.lineCanvas, this.hint, this.right, this.bar, this.loading);
    const anchor = document.getElementById('cesiumContainer');
    anchor.insertAdjacentElement('afterend', this.view);
    this.view.insertAdjacentElement('afterend', this.labels);
    document.body.append(this.hud);

    // A way back into the room from the classic layout.
    const top = document.getElementById('top-panel-toggles');
    if (top) {
      this.toggleBtn = document.createElement('button');
      this.toggleBtn.id = 'room-toggle';
      this.toggleBtn.textContent = '🥁 Room';
      this.toggleBtn.title = 'Drum circle room';
      this.toggleBtn.addEventListener('click', () => this.setEnabled(true));
      top.insertBefore(this.toggleBtn, top.children[1] || null);
    }
  }

  toggleSheet(name, force) {
    const open = force !== undefined ? force : this.sheets[name].hidden;
    for (const [k, s] of Object.entries(this.sheets)) s.hidden = !(open && k === name);
    for (const [k, b] of [['menu', this.btnMenu], ['picker', this.btnRhythms], ['about', this.btnAbout], ['session', this.btnSession], ['feedback', this.btnFeedback]]) {
      b.classList.toggle('on', open && k === name);
    }
    if (!open) return;
    if (name === 'menu') this.renderMenu();
    if (name === 'picker') this.renderPicker();
    if (name === 'about') this.renderAbout();
    if (name === 'session') {
      this.sessionMsg = '';
      this.renderSession();
      const before = JSON.stringify(window._rrcListSessions?.() || []);
      Promise.resolve(window._rrcRefreshSessionDirectory?.({ silent: true })).then(() => {
        const s = this.sheets.session, typed = [...s.querySelectorAll('.room-code-input')].some((i) => i.value);
        if (!s.hidden && !sessionInfo().active && !typed && JSON.stringify(window._rrcListSessions?.() || []) !== before) this.renderSession();
      }).catch(() => {});
    }
    if (name === 'feedback') this.renderFeedback();
  }

  closeSheets() { this.toggleSheet('menu', false); }

  // ---------- menu: every view from the old top bar
  renderMenu() {
    const s = this.sheets.menu;
    s.innerHTML = '<h3>Windows</h3><div class="room-menu-list" data-g="w"></div><h3>Tools</h3><div class="room-menu-list" data-g="t"></div><div class="room-menu-foot"></div>';
    const fill = (list, box) => {
      for (const [id, label] of list) {
        const src = document.getElementById(id);
        if (!DEMO && (!src || src.hidden)) continue;
        const item = document.createElement('button');
        item.type = 'button';
        const open = !!src && src.classList.contains('active');
        item.className = 'room-menu-item' + (open ? ' on' : '');
        item.innerHTML = `<span class="room-menu-dot"></span><span>${esc(label)}</span>`;
        item.addEventListener('click', () => {
          if (src) { src.click(); this.closeSheets(); return; }
          this.flashHint(`${label} opens in the full app`);
        });
        box.append(item);
      }
    };
    fill(MENU_WINDOWS, s.querySelector('[data-g="w"]'));
    fill(MENU_TOOLS, s.querySelector('[data-g="t"]'));
    if (DEMO) return;
    const classic = document.createElement('button');
    classic.type = 'button'; classic.className = 'room-menu-item room-menu-wide';
    classic.textContent = 'Classic layout (globe and windows)';
    classic.addEventListener('click', () => { this.closeSheets(); this.setEnabled(false); });
    s.querySelector('.room-menu-foot').append(classic);
  }

  flashHint(text) {
    this.hint.textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.applyState(), 2200);
  }

  // ---------- per-device timing trim (Session sheet): shifts this device's notes later or earlier
  timingOffset() { const v = Number(store.get('rrcTimingOffsetMs')); return Number.isFinite(v) ? Math.max(-50, Math.min(50, v)) : 0; }
  sendTimingOffset() { try { window._notationBridge?.postMain?.({ type: 'setTimingOffsetMs', value: this.timingOffset() }); } catch {} }
  appendTimingControl(sheet) {
    const v = this.timingOffset();
    const box = document.createElement('div');
    box.className = 'room-timing';
    box.innerHTML = `<label class="room-fb-row room-timing-row"><span class="room-fb-name">Timing</span>
      <input type="range" min="-50" max="50" step="1" value="${v}" aria-label="Timing adjust for this device">
      <output>${v > 0 ? '+' : ''}${v} ms</output></label>
      <div class="room-timing-note">This device only. If it sounds early, move right (later); if late, move left.</div>`;
    const input = box.querySelector('input'), out = box.querySelector('output');
    input.addEventListener('input', () => {
      const n = Number(input.value);
      out.textContent = `${n > 0 ? '+' : ''}${n} ms`;
      store.set('rrcTimingOffsetMs', String(n));
      this.sendTimingOffset();
    });
    for (const t of ['pointerdown', 'touchstart']) box.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    sheet.append(box);
  }

  // ---------- hit feedback calibration
  renderFeedback() {
    const s = this.sheets.feedback, fb = this.feedback;
    const groups = [['djembe', 'Djembe', 'Rings on the skin'], ['dunun', 'Dunun', 'The struck head'], ['bell', 'Bell', 'Kenken on top of the dunun']];
    const fields = [['intensity', 'Strength', 0, 100, 1, (v) => `${v}%`, 100], ['hold', 'Hold', 0, 800, 10, (v) => `${v} ms`, 1], ['fade', 'Fade', 40, 1500, 10, (v) => `${v} ms`, 1]];
    const slider = (key, val, min, max, step, fmt) => `<label class="room-fb-row"><span class="room-fb-name">${key}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></label>`;
    s.innerHTML = `<button type="button" class="room-sheet-close" aria-label="Close">×</button>
      <h2>Room settings</h2>
      <div class="room-fb-group">
        <h3>Nudge follower</h3>
        <p class="room-fb-note">Adjust playback on this device when following a session. If you hear it lag behind the leader, tap Earlier.</p>
        <button type="button" class="room-btn" data-shift="-5">Earlier 5 ms</button>
        <output class="room-timing-offset" aria-live="polite"></output>
        <button type="button" class="room-btn" data-shift="5">Later 5 ms</button>
        <button type="button" class="room-btn" data-shift="0">Reset timing</button>
      </div>
      <h3>Hit feedback</h3>
      <p class="room-fb-lead">Hold keeps a stroke at full strength so you can see it landed, then it fades. Test each part while you tune it.</p>
      <div class="room-fb-grid">${groups.map(([k, label, note]) => `
        <div class="room-fb-group" data-k="${k}">
          <div class="room-fb-head"><h3>${label}</h3><button type="button" class="room-btn room-fb-test" data-test="${k}">Test</button></div>
          <div class="room-fb-note">${note}</div>
          ${fields.map(([f, name, min, max, step, fmt, mul]) => `<div data-f="${f}" data-mul="${mul}">${slider(name, Math.round(fb[k][f] * mul), min, max, step, fmt)}</div>`).join('')}
        </div>`).join('')}
      </div>
      <div class="room-fb-foot">
        <div data-f="idle" data-mul="100" class="room-fb-idle">${slider('Resting visibility', Math.round(fb.idle * 100), 0, 60, 1, (v) => `${v}%`)}</div>
        <button type="button" class="room-btn room-fb-reset">Reset</button>
      </div>`;
    const timing = window._rrcFollowerTiming;
    const displayOffset = () => {
      const ms = timing.offset;
      s.querySelector('.room-timing-offset').textContent = ms ? `${Math.abs(ms)} ms ${ms < 0 ? 'early' : 'late'}` : '0 ms';
    };
    displayOffset();
    s.querySelectorAll('[data-shift]').forEach(button => button.addEventListener('click', () => {
      const delta = Number(button.dataset.shift);
      timing.set(delta ? timing.offset + delta : 0);
      displayOffset();
    }));
    const save = () => { store.set(FEEDBACK_KEY, JSON.stringify(fb)); for (const seat of this.seats) { if (seat.skin) seat.skin.dirty = true; if (seat.drumSkin) seat.drumSkin.dirty = true; } };
    s.querySelectorAll('[data-f]').forEach((box) => {
      const input = box.querySelector('input'), out = box.querySelector('output');
      const k = box.closest('.room-fb-group')?.dataset.k, f = box.dataset.f, mul = Number(box.dataset.mul);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = f === 'hold' || f === 'fade' ? `${v} ms` : `${v}%`;
        if (k) fb[k][f] = v / mul; else fb.idle = v / mul;
        save();
      });
    });
    s.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => this.testFeedback(b.dataset.test)));
    s.querySelector('.room-fb-reset').addEventListener('click', () => { store.set(FEEDBACK_KEY, '{}'); this.feedback = loadFeedback(); this.renderFeedback(); for (const seat of this.seats) { if (seat.skin) seat.skin.dirty = true; if (seat.drumSkin) seat.drumSkin.dirty = true; } });
    s.querySelector('.room-sheet-close').addEventListener('click', () => this.closeSheets());
  }

  // One representative stroke on the focused (or first) instrument of that kind.
  testFeedback(kind) {
    const pick = (ok) => (this.focus && ok(this.focus) ? this.focus : this.seats.find(ok));
    this.testN = (this.testN || 0) + 1;
    if (kind === 'djembe') {
      const seat = pick((s) => s.kind === 'djembe');
      if (seat) this.animateHit(seat, ['bass', 'tone', 'slap'][this.testN % 3], false, this.testN);
    } else if (kind === 'dunun') {
      const seat = pick((s) => s.kind === 'dunun');
      if (seat) this.animateHit(seat, this.testN % 2 ? 'tone' : 'mute', false, this.testN);
    } else {
      const seat = pick((s) => s.kind === 'dunun' && s.bellRig);
      if (seat) this.animateHit(seat, 'bell', true, this.testN);
    }
    if (!this.seats.length) this.flashHint('Pick a rhythm to see the instruments');
  }

  // ---------- rhythm picker
  renderPicker() {
    const s = this.sheets.picker;
    const list = appRhythms();
    const keys = Object.keys(list).filter((k) => list[k] && list[k].name);
    // Case-insensitive: "guinea" and "Guinea" are one chip.
    const titleCase = (t) => t.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
    const countryOf = (r) => titleCase(String(r.country || String(r.fullLocation || r.location || '').split(',').slice(-2, -1)[0] || '').trim());
    const countries = [...new Set(keys.map((k) => countryOf(list[k])).filter(Boolean))].sort();
    if (!this.pickerFilter) this.pickerFilter = { q: '', country: '' };
    s.innerHTML = `
      <div class="room-picker-head">
        <input type="search" class="room-search" placeholder="Search" value="${esc(this.pickerFilter.q)}" aria-label="Search rhythms">
        <div class="room-chips">${['', ...countries].map((c) => `<button type="button" class="room-chip${c === this.pickerFilter.country ? ' on' : ''}" data-c="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('')}</div>
      </div>
      <div class="room-cards"></div>`;
    const cards = s.querySelector('.room-cards');
    const draw = () => {
      const q = this.pickerFilter.q.trim().toLowerCase();
      const shown = keys.filter((k) => {
        const r = list[k];
        if (this.pickerFilter.country && countryOf(r) !== this.pickerFilter.country) return false;
        return !q || `${r.name} ${r.fullLocation || r.location || ''} ${r.community || ''}`.toLowerCase().includes(q);
      }).sort((a, b) => list[a].name.localeCompare(list[b].name));
      cards.innerHTML = shown.length ? shown.map((k) => {
        const r = list[k];
        return `<button type="button" class="room-card${k === this.rhythmKey ? ' on' : ''}" data-k="${esc(k)}" style="--c:${esc(r.colorHex || '#fcd116')}">
          <span class="room-card-name">${esc(r.name)}</span>
          <span class="room-card-place">${esc(r.fullLocation || r.location || '')}</span></button>`;
      }).join('') : '<div class="room-empty">No rhythms match.</div>';
    };
    draw();
    s.querySelector('.room-search').addEventListener('input', (e) => { this.pickerFilter.q = e.target.value; draw(); });
    s.querySelector('.room-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.room-chip'); if (!c) return;
      this.pickerFilter.country = c.dataset.c;
      s.querySelectorAll('.room-chip').forEach((x) => x.classList.toggle('on', x === c));
      draw();
    });
    cards.addEventListener('click', (e) => {
      const c = e.target.closest('.room-card'); if (!c) return;
      this.selectRhythm(c.dataset.k);
    });
  }

  selectRhythm(key) {
    this.userActive = true;
    this.closeSheets();
    const st = sessionInfo();
    if (st.active && st.role === 'follower' && !st.freeMode && key !== this.rhythmKey) {
      this.flashHint('The session leader picks the rhythm');
      return;
    }
    if (key === this.rhythmKey && this.state !== 'HOME') return;
    try { handleRhythmOrJourneySelection(key); } catch (err) { console.warn('[room] select failed', err); }
  }

  // ---------- consolidated name + history view
  renderAbout() {
    const s = this.sheets.about;
    const r = appRhythms()[this.rhythmKey];
    if (!r) { s.innerHTML = '<div class="room-empty">Choose a rhythm first.</div>'; return; }
    const songs = Array.isArray(r.songTexts) ? r.songTexts.filter((x) => x && (x.text || x.lyrics)) : [];
    const tags = Array.isArray(r.tags) ? r.tags.map((t) => (typeof t === 'string' ? t : t?.tag)).filter(Boolean) : [];
    s.innerHTML = `
      <button type="button" class="room-sheet-close" aria-label="Close">×</button>
      <h2 style="color:${esc(r.colorHex || '#fcd116')}">${esc(r.name)}</h2>
      <div class="room-about-place">${esc([r.fullLocation || r.location, r.community].filter(Boolean).join(' · '))}</div>
      ${historyOf(r) ? `<h3>Historical Context</h3><p>${esc(historyOf(r))}</p>` : ''}
      ${songs.length ? `<h3>Song</h3>${songs.map((x) => `<div class="room-song"><div class="room-song-lang">${esc([x.language, x.role].filter(Boolean).join(' · '))}</div><div class="room-song-text">${esc(x.text || x.lyrics)}</div></div>`).join('')}` : ''}
      ${tags.length ? `<div class="room-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="room-about-actions"><button type="button" class="room-btn" data-open="media-toggle">Media</button></div>`;
    s.querySelector('.room-sheet-close').addEventListener('click', () => this.closeSheets());
    s.querySelector('[data-open]')?.addEventListener('click', () => { document.getElementById('media-toggle')?.click(); this.closeSheets(); });
  }

  // ---------- sessions: start, join by code, share by QR
  async renderSession() {
    const s = this.sheets.session;
    const st = sessionInfo();
    const qr = (url) => esc(url);
    const status = (document.getElementById('session-status')?.textContent || '').trim();
    const close = '<button type="button" class="room-sheet-close" aria-label="Close">×</button>';
    if (st.active && st.sessionId) {
      const id = st.sessionId;
      let joinUrl = '';
      try { joinUrl = await window._rrcBuildSessionJoinUrl?.(id) || ''; } catch {}
      if (!joinUrl || joinUrl.endsWith('#')) { const u = new URL(location.href); u.search = `?session=${id}`; u.hash = ''; joinUrl = u.toString(); }
      let padUrl = '';
      try { padUrl = await window._rrcBuildPhonePadUrl?.(this.focus?.inst?.id || '', id); } catch {}
      // A localhost link can't be opened on a phone: leave the pad QR out, and offer to set the network address.
      const loopback = (u) => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(u).hostname); } catch { return true; } };
      if (padUrl && loopback(padUrl)) padUrl = '';
      const needsLan = loopback(joinUrl) && typeof window._rrcAskLanHost === 'function';
      if (!this.sheets.session.hidden && !sessionInfo().active) return;   // left while the link was being built
      const members = Array.isArray(st.members) ? st.members.length : 0;
      s.innerHTML = `${close}
        <h3>Session</h3>
        <div class="room-session-code">${esc(id)}</div>
        <div class="room-session-meta">${members ? `${members} connected · ` : ''}${esc(st.role === 'leader' ? 'You lead' : 'Following the leader')}</div>
        <div class="room-qrs">
          <figure><div class="room-qr" data-url="${qr(joinUrl)}" role="img" aria-label="QR code to join session ${esc(id)}"></div><figcaption>Join on a computer or tablet</figcaption></figure>
          ${padUrl ? `<figure><div class="room-qr" data-url="${qr(padUrl)}" role="img" aria-label="QR code for phone pads"></div><figcaption>Join on a phone, with pads${this.focus?.inst ? ` (${esc(this.focus.inst.name)})` : ''}</figcaption></figure>` : ''}
        </div>
        ${needsLan ? '<p class="room-session-note">These links point to localhost, so other devices can\'t open them. Set this computer\'s network address to fix that.</p>' : ''}
        <div class="room-session-actions">
          ${needsLan ? '<button type="button" class="room-btn" data-act="lan">Set network address</button>' : ''}
          <button type="button" class="room-btn" data-act="copy">Copy link</button>
          <button type="button" class="room-btn room-btn-danger" data-act="leave">Leave</button>
        </div>
        <div class="room-session-status">${esc(status)}</div>
        <div class="room-session-health" title="Ping: round trip to the leader. Late notes: notes this device played late. Longest pause: the longest gap between scheduler ticks (notes stay on time while it is under the look-ahead)."></div>`;
      drawQrCodes(s);
      // Live sync health, so a problem on a real phone shows up as numbers.
      const health = s.querySelector('.room-session-health');
      const showHealth = () => {
        if (s.hidden || !health.isConnected) { clearInterval(this.healthTimer); return; }
        const info = sessionInfo();
        let stats = null, ahead = 0;
        try {
          const w = document.getElementById('notation-iframe')?.contentWindow;
          stats = w?.__rrcTransportStats || null;
          ahead = Math.round(w?.eval?.('typeof transportLookaheadMs === "function" ? transportLookaheadMs() : 0') || 0);
        } catch {}
        const parts = [];
        if (info.role !== 'leader' && Number(info.leaderClockRttMs) > 0) parts.push(`ping ${Math.round(info.leaderClockRttMs)} ms`);
        if (stats) {
          parts.push(`late notes ${stats.late}${stats.worstLateMs ? ` (worst ${stats.worstLateMs} ms)` : ''}`);
          parts.push(`longest pause ${stats.maxTickGapMs} ms${ahead ? ` of ${ahead}` : ''}`);
          if (stats.skipped) parts.push(`skipped ${stats.skipped}`);
        }
        const lines = parts.length ? [`This device · ${parts.join(' · ')}`] : [];
        // Leader: every follower's own report (sent every 5 s while playing).
        if (info.role === 'leader' && info.syncReports) {
          for (const r of Object.values(info.syncReports)) {
            const age = Math.round((Date.now() - r.at) / 1000);
            if (age > 60) continue;
            const late = r.stats ? ` · late ${r.stats.late}${r.stats.worstLateMs ? ` (${r.stats.worstLateMs} ms)` : ''} · pause ${r.stats.maxTickGapMs} ms` : '';
            lines.push(`${r.name} (${r.device} ${r.browser}) · off by ${r.driftAvg} ms avg, ${r.driftMax} max · ping ${r.rtt} ms${late}${age > 8 ? ` · ${age}s ago` : ''}`);
          }
        }
        health.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
      };
      clearInterval(this.healthTimer);
      showHealth();
      this.healthTimer = setInterval(showHealth, 1000);
      s.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(joinUrl); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed'; }
      });
      s.querySelector('[data-act="lan"]')?.addEventListener('click', async () => { try { await window._rrcAskLanHost(); } catch {} this.renderSession(); });
      s.querySelector('[data-act="leave"]').addEventListener('click', () => { document.getElementById('session-leave-btn')?.click(); this.waitForSession(false); });
    } else {
      const signedIn = !!st.userId;
      const open = (window._rrcListSessions?.() || []).slice(0, 6);
      s.innerHTML = `${close}
        <h3>Start a session</h3>
        <p class="room-session-note">Name it, start it, and you lead. Others join with the name, the link or the QR code.</p>
        <div class="room-session-row">
          <input class="room-code-input room-name-input" maxlength="40" placeholder="Name (optional)" aria-label="Session name" autocapitalize="none" spellcheck="false">
          <button type="button" class="room-btn room-btn-play" data-act="start">Start</button>
        </div>
        <h3>Join a session</h3>
        ${open.length ? `<div class="room-session-list">${open.map((o) => `<button type="button" class="room-menu-item" data-join="${esc(o.id)}"><span class="room-menu-dot"></span><span>${esc(o.id)}</span><span class="room-session-who">${o.mine ? 'yours' : esc(o.leaderName)}${o.members ? ` · ${o.members}` : ''}</span></button>`).join('')}</div>` : ''}
        <div class="room-session-row">
          <input class="room-code-input" maxlength="40" placeholder="Session name" aria-label="Session to join" autocapitalize="none" spellcheck="false">
          <button type="button" class="room-btn" data-act="join">Join</button>
        </div>
        ${signedIn ? '' : '<p class="room-session-note">No account needed: you join as a guest. <button type="button" class="room-link-btn" data-act="signin">Sign in</button> to use your own name.</p>'}
        <div class="room-session-status">${esc(this.sessionMsg || status)}</div>`;
      const clean = (v) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 40);
      const [nameIn, code] = s.querySelectorAll('.room-code-input');
      for (const input of [nameIn, code]) input.addEventListener('input', () => { input.value = clean(input.value); });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') s.querySelector('[data-act="start"]').click(); e.stopPropagation(); });
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') s.querySelector('[data-act="join"]').click(); e.stopPropagation(); });
      const say = (msg) => { this.sessionMsg = msg; const el = s.querySelector('.room-session-status'); if (el) el.textContent = msg; };
      const why = (r) => ({
        taken: `"${r.id}" already has a leader${r.leaderName ? ` (${r.leaderName})` : ''}. Join it, or pick another name.`,
        playing: 'Stop playback first, then try again.',
        signin: 'Could not sign in. Sign in, or turn on guest sign-in in Supabase.',
        empty: 'Type the session name to join.',
        active: 'You are already in a session.'
      }[r.reason] || 'That did not work. Try again.');
      const run = async (btn, action, verb) => {
        btn.disabled = true; say(`${verb}…`);
        let r = { ok: false };
        try { r = await action(); } catch (err) { console.warn('[room] session', err); }
        btn.disabled = false;
        if (r?.ok) { this.sessionMsg = ''; this.waitForSession(true); } else say(why(r || {}));
      };
      s.querySelector('[data-act="start"]').addEventListener('click', (e) => run(e.currentTarget, () => window._rrcStartSession?.(nameIn.value) ?? { ok: false }, 'Starting'));
      s.querySelector('[data-act="join"]').addEventListener('click', (e) => run(e.currentTarget, () => window._rrcJoinSession?.(code.value) ?? { ok: false }, 'Joining'));
      s.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => run(b, () => window._rrcJoinSession?.(b.dataset.join) ?? { ok: false }, 'Joining')));
      s.querySelector('[data-act="signin"]')?.addEventListener('click', () => { document.getElementById('auth-toggle')?.click(); this.closeSheets(); });
    }
    s.querySelector('.room-sheet-close').addEventListener('click', () => this.closeSheets());
    this.appendTimingControl(s);
  }

  waitForSession(active) {
    clearInterval(this.sessionPoll);
    let n = 0;
    this.sessionPoll = setInterval(() => {
      n += 1;
      const done = !!sessionInfo().active === active;
      if (done || n > 20) { clearInterval(this.sessionPoll); this.updateSessionButton(); }
      if (!this.sheets.session.hidden && (done || n % 4 === 0)) this.renderSession();
    }, 500);
  }

  updateSessionButton() {
    const st = sessionInfo();
    this.btnSession.textContent = st.active && st.sessionId ? st.sessionId : 'Session';
    this.btnSession.classList.toggle('live', !!st.active);
  }

  // ================================================================ scene
  buildScene() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, PAD_ONLY ? 1.25 : 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.7;
    this.view.append(r.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#080504');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
    this.raycaster = new THREE.Raycaster();
    this.hemi = new THREE.HemisphereLight('#ffe2bd', '#3a2414', 0.7);
    this.lamp = new THREE.PointLight('#ffd9a6', 22, 14, 1.6);
    this.lamp.position.set(0, 3.15, 0);
    this.key = new THREE.SpotLight('#fff1d6', 0, 6, 0.6, 0.6, 1.2);
    this.scene.add(this.hemi, this.lamp, this.key, this.key.target);
    this.ensemble = new THREE.Group();
    this.scene.add(this.ensemble);
    this.buildGlobe();
    this.resize();
  }

  buildGlobe() {
    const g = this.globe = new THREE.Group();
    g.position.set(0, 1.3, 0);
    const tex = new THREE.TextureLoader().load(BASE + 'earth.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 64, 48),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.4 }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.16, 48, 32), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      uniforms: { c: { value: new THREE.Color('#fcd116') } },
      vertexShader: 'varying vec3 n; varying vec3 v; void main(){ n = normalize(normalMatrix * normal); vec4 p = modelViewMatrix * vec4(position,1.0); v = normalize(-p.xyz); gl_Position = projectionMatrix * p; }',
      fragmentShader: 'uniform vec3 c; varying vec3 n; varying vec3 v; void main(){ float f = pow(clamp(dot(-n, v), 0.0, 1.0), 2.6); gl_FragColor = vec4(c * f * 0.8, f); }'
    }));
    this.markers = new THREE.Group();
    this.earth.add(this.markers);
    g.add(this.earth, glow);
    this.scene.add(g);
    this.globePose = { y: 1.3, s: 1 };
    this.upgradeEarthTexture();
  }

  // The small texture paints first; a sharper NASA Blue Marble (public domain, oceans lightened) replaces it
  // once loaded: 8K on computers that support it, 4K on tablets. Phones keep the small one.
  upgradeEarthTexture() {
    if (PAD_ONLY) return;
    const touch = (navigator.maxTouchPoints || 0) > 1 || window.matchMedia?.('(pointer: coarse)').matches;
    const max = this.renderer?.capabilities?.maxTextureSize || 4096;
    const file = !touch && max >= 8192 ? 'earth-8k.jpg' : 'earth-4k.jpg';
    new THREE.TextureLoader().load(BASE + file, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() || 8;
      const m = this.earth.material, old = m.map;
      m.map = tex; m.emissiveMap = tex; m.needsUpdate = true;
      old?.dispose();
      this.earthDetail = true;                                 // allows the closer zoom (zoomOrbit)
    }, undefined, () => {});
  }

  // Distance from the camera to the globe's surface, in room metres.
  globeSurfaceDistance() {
    const c = this.globe.getWorldPosition(this.tmp);
    return Math.max(0, this.camera.position.distanceTo(c) - GLOBE_R * this.globe.scale.x);
  }

  latLngToVec(lat, lng, r = GLOBE_R) {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lng + 180);
    return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }

  // Markers as in the original globe: a soft coloured dome with the rhythm name above it.
  refreshMarkers() {
    const list = appRhythms();
    // Runs every frame: only rebuild when the rhythm list itself changed.
    const count = Object.keys(list).length;
    if (list === this.markerList && count === this.markerCount) return;
    this.markerList = list; this.markerCount = count;
    const keys = Object.keys(list).filter((k) => Number.isFinite(list[k]?.lat) && Number.isFinite(list[k]?.lng));
    const sig = keys.join('|');
    if (sig === this.markerSig) return;
    this.markerSig = sig;
    this.markers.clear();
    this.labels.innerHTML = '';
    this.markerGeo = this.markerGeo || new THREE.SphereGeometry(0.016, 12, 8);
    for (const key of keys) {
      const rh = list[key];
      const color = rh.colorHex || '#fcd116';
      // The large library collection: smaller dots, and no floating name unless selected (keeps the globe readable and fast).
      const minor = rh.collection === 'djembeloops';
      const dome = new THREE.Mesh(this.markerGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: minor ? 0.4 : 0.55, depthWrite: false }));
      if (minor) dome.scale.setScalar(0.55);
      dome.position.copy(this.latLngToVec(rh.lat, rh.lng, GLOBE_R * 1.004));
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'room-globe-label';
      label.textContent = rh.name;
      label.style.color = color;
      label.addEventListener('click', () => this.selectRhythm(key));
      this.labels.append(label);
      dome.userData = { rhythmKey: key, name: rh.name, label, minor, baseScale: minor ? 0.55 : 1 };
      this.markers.add(dome);
    }
    this.highlightMarker(this.rhythmKey);
    if (!this.sheets.picker.hidden) this.renderPicker();
  }

  async load() {
    const loader = new GLTFLoader();
    // The demo page can only host text files, so there the models ship as base64 inside JSON.
    const get = (name) => (DEMO
      ? fetch(`${BASE}${name}.glb.json`).then((r) => r.json()).then((j) => {
        const bin = Uint8Array.from(atob(j.glb_base64), (c) => c.charCodeAt(0));
        return new Promise((res, rej) => loader.parse(bin.buffer, BASE, res, rej));
      })
      : new Promise((res, rej) => loader.load(`${BASE}${name}.glb`, res, undefined, rej)));
    try {
      const [room, kit, lm] = await Promise.all([
        get('DrumCircleRoom'), get('EnsembleKit'),
        new THREE.TextureLoader().loadAsync(BASE + 'lm_DC.jpg').catch(() => null)
      ]);
      if (lm) { lm.flipY = false; lm.channel = 1; lm.colorSpace = THREE.SRGBColorSpace; }
      room.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (lm && o.geometry.attributes.uv1) { m.lightMap = lm; m.lightMapIntensity = 7; }
          m.envMapIntensity = 0;
        }
      });
      this.scene.add(room.scene);
      this.addHangings();
      this.kit = {};
      const kids = kit.scene.children[0]?.children?.length ? kit.scene.children[0].children : kit.scene.children;
      for (const child of kids) this.kit[child.name] = child;
      this.ready = true;
      this.loading.remove();
      this.view.classList.add('ready');
      this.syncEnsemble(true);
      this.applyState(true);
      // Lift the load cover once the room has drawn and finished its 0.7 s fade-in (the map sits underneath).
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => document.documentElement.classList.remove('rrc-booting'), 750)));
    } catch (err) {
      document.documentElement.classList.remove('rrc-booting');
      console.error('[room] could not load', err);
      this.loading.textContent = 'The room could not load. Showing the globe instead.';
      setTimeout(() => this.setEnabled(false), 1800);
    }
  }

  // One cloth per hanging, laid over the baked hanging so each shows a single whole pattern.
  addHangings() {
    const loader = new THREE.TextureLoader();
    const tex = {};
    for (const i of new Set(CLOTHS)) {
      const t = loader.load(`${BASE}cloth_${i}.jpg`);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      tex[i] = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.18 });
    }
    const geo = new THREE.PlaneGeometry(2.06, 1.96);
    const rp = HALL_R * Math.cos(THREE.MathUtils.degToRad(15)) - 0.068;
    for (let k = 0; k < 12; k++) {
      // Blender (Z up) RZ(30k+15) about the hall centre; glTF swaps to Y up with Z = -Y_blender.
      const a = THREE.MathUtils.degToRad(30 * k + 15);
      const m = new THREE.Mesh(geo, tex[CLOTHS[k]]);
      m.position.set(rp * Math.cos(a), 1.95, -rp * Math.sin(a));
      m.lookAt(0, 1.95, 0);
      this.scene.add(m);
    }
  }

  // ================================================================ ensemble
  syncEnsemble(force = false) {
    if (!this.ready) return;
    const data = window._latestNotationRhythmData || null;
    const instruments = Array.isArray(data?.instruments) && data.instruments.length ? data.instruments.slice() : [
      { id: 'djembe1', name: 'Djembe 1', type: 'djembe' }, { id: 'djembe2', name: 'Djembe 2', type: 'djembe' },
      { id: 'kenkeni1', name: 'Kenkeni', type: 'kenkeni' }, { id: 'sangban1', name: 'Sangban', type: 'sangban' }, { id: 'doundoun1', name: 'Doundoun', type: 'doundoun' }
    ];
    if (!instruments.some((i) => String(i.type || '').toLowerCase() === 'shekere')) {
      instruments.push({ id: 'shekere1', name: 'Shekere', type: 'shekere', pattern: [] });
    }
    this.rhythm = data;
    this.sendTimingOffset();                                    // the player may have reloaded: re-apply the trim
    this.padFocusPending = PAD_ONLY && this.padFocusPending !== false;
    const rk = String(data?.rhythmName || data?.name || '');
    if (rk !== this.mixRhythm) {                               // a new rhythm: ask the player for its solo / mute
      this.mixRhythm = rk; this.mix = {};
      try { window._notationBridge?.postMain?.({ type: 'requestInstrumentMix' }); } catch {}
    }
    const sig = instruments.map((i) => `${i.id}:${i.type}`).join('|');
    if (sig !== this.signature || force) { this.signature = sig; this.layout(instruments); } else this.bindParts(instruments);
    for (const seat of this.seats) { seat.notationDirty = true; this.drawLabel(seat); }
    // Phones opened from a pad link sit straight at that instrument (pi = its id).
    if (this.padFocusPending && this.seats.length) {
      this.padFocusPending = false;
      this.go('FOCUS', { seat: this.padSeat(), seconds: 0.1 });
    }
  }

  padSeat() {
    const pi = params.get('pi') || '';
    return this.seats.find((s) => s.id === pi || s.inst?.id === pi || s.bell?.id === pi) || this.seats[0];
  }

  layout(instruments) {
    const focusId = this.focus?.id || null;
    for (const s of this.seats) this.ensemble.remove(s.group);
    this.seats = [];
    const byFamily = new Map();
    const order = [];
    for (const inst of instruments) {
      const type = String(inst.type || '').toLowerCase();
      if (BELL_OF[type]) continue;
      const model = inst.isCall ? 'DjembeLead' : MODEL_FOR[type];
      if (!model || !this.kit[model]) continue;
      const seat = { id: inst.id, model, family: type };
      if (DUNUN[model]) byFamily.set(type, seat);
      order.push(seat);
    }
    for (const inst of instruments) {
      const fam = BELL_OF[String(inst.type || '').toLowerCase()];
      if (!fam || byFamily.has(fam)) continue;
      const seat = { id: `${inst.id}:drum`, model: MODEL_FOR[fam], family: fam };
      byFamily.set(fam, seat); order.push(seat);
    }
    const rank = (s) => ({ Djembe: 0, DjembeLead: 1, Shekere: 2, Kenkeni: 3, Sangban: 4, Doundoun: 5 }[s.model] ?? 6);
    order.sort((a, b) => rank(a) - rank(b));
    const n = order.length;
    let dj = 0;
    for (const seat of order) if (seat.model === 'Djembe') seat.wrap = DJEMBE_WRAPS[dj++ % DJEMBE_WRAPS.length]; else if (seat.model === 'DjembeLead') seat.wrap = CALL_WRAP;
    order.forEach((seat, i) => {
      const deg = n === 1 ? 180 : 62 + 236 * (i / (n - 1));
      seat.theta = THREE.MathUtils.degToRad(deg);
      seat.out = new THREE.Vector3(Math.sin(seat.theta), 0, Math.cos(seat.theta));
      seat.pos = seat.out.clone().multiplyScalar(CIRCLE_R);
      this.buildSeat(seat);
      this.seats.push(seat);
    });
    this.bindParts(instruments);
    this.focus = this.seats.find((s) => s.id === focusId) || null;
    if (this.state === 'FOCUS' && !this.focus) this.go('CIRCLE');
  }

  bindParts(instruments) {
    instruments = instruments.map((i) => (this.mix?.[i.id] ? { ...i, ...this.mix[i.id] } : i));   // solo / mute set from the room
    for (const seat of this.seats) { seat.inst = null; seat.bell = null; }
    for (const inst of instruments) {
      const type = String(inst.type || '').toLowerCase();
      const fam = BELL_OF[type];
      const seat = fam ? this.seats.find((s) => s.family === fam) : this.seats.find((s) => s.id === inst.id);
      if (!seat) continue;
      if (fam) seat.bell = inst; else seat.inst = inst;
    }
    this.syncMixButtons();
  }

  buildSeat(seat) {
    const g = seat.group = new THREE.Group();
    g.position.copy(seat.pos);
    g.rotation.y = seat.theta;                               // player side (+Z) faces away from the centre
    const body = seat.body = this.kit[seat.model].clone(true);
    body.position.set(0, 0, 0);
    g.add(body);
    seat.kind = seat.model.startsWith('Djembe') ? 'djembe' : DUNUN[seat.model] ? 'dunun' : 'shekere';
    seat.parts = {};
    const scale = body.scale.x || 1;
    body.traverse((o) => {
      if (/_Gourd$/.test(o.name) && !seat.parts.gourd) { seat.parts.gourd = o; o.userData.rest = o.rotation.clone(); }
      if (/_(Stick|BellBeater)$/.test(o.name)) { o.visible = false; return; }  // resting sticks are for the VR rig; nothing holds them here
      if (!o.isMesh) return;
      if (/_Head(_A)?$/.test(o.name)) { o.material = o.material.clone(); seat.parts.head = o; }
      if (/_Bell$/.test(o.name)) { o.visible = false; return; }      // replaced by the forged bell built below
      if (seat.wrap && /^Djembe/.test(o.name)) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const out = mats.map((m) => {
          const name = String(m?.name || '');
          if (!/^wrap|^rope$|^rope\./.test(name)) return m;
          const c = m.clone(); c.color = new THREE.Color(seat.wrap);
          if (/^rope/.test(name)) c.color.lerp(new THREE.Color('#ffffff'), 0.12);
          return c;
        });
        o.material = Array.isArray(o.material) ? out : out[0];
      }
    });
    if (seat.kind === 'djembe') {
      seat.headR = DJEMBE_R * scale;
      seat.headPos = new THREE.Vector3(0, DJEMBE_HEAD_Y * scale + 0.003, 0);
      seat.headNormal = new THREE.Vector3(0, 1, 0);
      seat.height = 0.62 * scale;
    } else if (seat.kind === 'dunun') {
      const d = DUNUN[seat.model];
      seat.headR = d.D / 2;
      seat.headPos = new THREE.Vector3(d.L / 2 + 0.008, d.zc, 0);
      seat.headNormal = new THREE.Vector3(1, 0, 0);
      seat.top = d.zc + d.D / 2;
      seat.height = seat.top + 0.08;
      seat.len = d.L;
    } else {
      seat.headR = 0.13;
      seat.headPos = new THREE.Vector3(0, 0.64, 0);
      seat.headNormal = new THREE.Vector3(0, 1, 0);
      seat.height = 0.9;
    }
    const isDunun = seat.kind === 'dunun';
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(isDunun ? 0.5 : 0.3, 32),
      new THREE.MeshBasicMaterial({ map: softDisc(), transparent: true, depthWrite: false, opacity: 0.55, color: '#000' }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    seat.ring = new THREE.Mesh(new THREE.RingGeometry(isDunun ? 0.56 : 0.36, isDunun ? 0.59 : 0.385, 64),
      new THREE.MeshBasicMaterial({ color: '#fcd116', transparent: true, opacity: 0, depthWrite: false }));
    seat.ring.rotation.x = -Math.PI / 2; seat.ring.position.y = 0.022;
    seat.pick = new THREE.Mesh(new THREE.CylinderGeometry(isDunun ? 0.42 : 0.26, isDunun ? 0.42 : 0.24, seat.height + 0.15, 12),
      new THREE.MeshBasicMaterial({ visible: false }));
    seat.pick.position.y = (seat.height + 0.15) / 2;
    seat.pick.userData.seat = seat;
    seat.label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
    seat.label.position.set(0, seat.height + 0.34, 0);
    seat.label.scale.set(0.8, 0.2, 1);
    seat.label.renderOrder = 5;
    g.add(shadow, seat.ring, seat.pick, seat.label);
    if (seat.kind === 'djembe') {
      const stool = this.kit.Stool?.clone(true);
      if (stool) { stool.position.set(0, 0, 0.52); g.add(stool); }
      this.buildDjembeVisuals(seat);
    }
    if (seat.kind === 'dunun') { this.buildDununVisuals(seat); this.buildBell(seat); }
    seat.fx = { flash: 0, color: new THREE.Color('#fff'), shake: 0, bellAt: -Infinity };
    this.ensemble.add(g);
  }

  // Djembe: the Flow State visual on the skin, and the circular notation around the rim (focus view).
  buildDjembeVisuals(seat) {
    const canvasTex = (size) => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      return { c, t };
    };
    const holder = new THREE.Group();
    holder.position.copy(seat.headPos);
    holder.rotation.x = -Math.PI / 2;                          // canvas bottom faces the player
    seat.group.add(holder);
    const skin = canvasTex(PAD_ONLY ? 256 : 512);
    seat.skin = { canvas: skin.c, tex: skin.t, zone: null, step: -1, at: -Infinity, dirty: true };
    seat.skinMesh = new THREE.Mesh(new THREE.CircleGeometry(seat.headR * 1.0, 64),
      new THREE.MeshBasicMaterial({ map: skin.t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    seat.skinMesh.renderOrder = 2;
    holder.add(seat.skinMesh);
    const dial = canvasTex(1024);
    seat.dial = { canvas: dial.c, tex: dial.t };
    seat.dialInner = seat.headR + 0.03;
    seat.dialOuter = seat.headR + 0.23;
    seat.dialMesh = new THREE.Mesh(new THREE.RingGeometry(seat.dialInner, seat.dialOuter, 128),
      new THREE.MeshBasicMaterial({ map: dial.t, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }));
    seat.dialMesh.position.z = -0.01;
    seat.dialMesh.visible = false;
    holder.add(seat.dialMesh);
    // The sweep is its own mesh, turned every frame; the ring canvas is only redrawn when the step changes.
    const sweepMat = (opacity) => new THREE.MeshBasicMaterial({ color: '#fcd116', transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    seat.sweep = new THREE.Group();
    seat.sweepWedge = new THREE.Mesh(new THREE.RingGeometry(seat.dialInner, seat.dialOuter, 16, 1, 0, Math.PI / 14), sweepMat(0.22));
    seat.sweepLine = new THREE.Mesh(new THREE.RingGeometry(seat.dialInner, seat.dialOuter, 1, 1, -0.008, 0.016), sweepMat(1));
    seat.sweep.add(seat.sweepWedge, seat.sweepLine);
    seat.sweep.position.z = -0.009;
    seat.sweep.visible = false;
    holder.add(seat.sweep);
  }

  // Dunun: a decal on the struck head. Open fills the head; a muted stroke lights only the edge band.
  buildDununVisuals(seat) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    seat.drumSkin = { canvas: c, tex, sound: null, at: -Infinity, dirty: true };
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(seat.headR * 0.97, 48),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    mesh.position.copy(seat.headPos).add(new THREE.Vector3(0.004, 0, 0));
    mesh.rotation.y = Math.PI / 2;                             // face +X, out of the struck head
    mesh.renderOrder = 2;
    seat.group.add(mesh);
  }

  paintDrumSkin(seat, now) {
    const sk = seat.drumSkin, f = this.feedback.dunun;
    const age = now - sk.at;
    const active = age < reactionSpan(f);
    if (!sk.dirty && !active && !sk.wasActive) return;
    sk.wasActive = active; sk.dirty = false;
    const g = sk.canvas.getContext('2d'), S = sk.canvas.width, cx = S / 2, R = S / 2 - 6;
    const strength = active ? reaction(age, f) : 0, idle = this.feedback.idle;
    const muted = sk.sound === 'mute', col = muted ? ACCENT.mute : ACCENT.tone;
    g.clearRect(0, 0, S, S);
    g.globalAlpha = Math.min(1, idle);                         // resting head
    g.fillStyle = ACCENT.tone;
    g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2); g.fill();
    if (strength > 0) {
      g.globalAlpha = Math.min(1, idle + strength);
      g.fillStyle = col;
      g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2);
      if (muted) g.arc(cx, cx, R * 0.58, 0, Math.PI * 2, true);
      g.fill('evenodd');
    }
    g.globalAlpha = 1;                                         // rim stays solid, like the djembe borders
    g.lineWidth = 7; g.strokeStyle = strength > 0 ? col : ACCENT.tone;
    g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2); g.stroke();
    if (muted && strength > 0) { g.lineWidth = 4; g.beginPath(); g.arc(cx, cx, R * 0.58, 0, Math.PI * 2); g.stroke(); }
    sk.tex.needsUpdate = true;
  }

  // Kenken bell: folded, hammered iron with a strap handle. It lies flat on top of the shell in the middle,
  // across the drum: open end away from the player, handle toward them, tied through the handle.
  buildBell(seat) {
    const { H, W } = BELL_SIZE[seat.model] || BELL_SIZE.Sangban;
    const geo = bellGeometry(H, W);
    const tex = ironTexture();
    const outer = new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.6, color: '#9a928a', metalness: 0.3, roughness: 0.6, emissive: '#ffc35a', emissiveIntensity: 0 });
    const inner = new THREE.MeshStandardMaterial({ color: '#141210', metalness: 0.2, roughness: 0.9, side: THREE.BackSide });
    const Dm = W * 0.46 / 2 * 1.1;                             // half thickness at the belly
    const rig = new THREE.Group();                             // bell frame: +Y handle, +Z the upper face
    const r0 = W * 0.17, span = H + r0 * 2;                    // mouth to the top of the handle
    const tip = 0.1;                                           // mouth tipped down toward the curve of the shell
    rig.position.set(0, seat.top + 0.02 + Dm * 0.9 - Math.sin(tip) * span / 2, -span / 2); // mouth end (bell origin); middle rests on the saddle
    rig.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(   // handle (+Y) toward the player, face up
      new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)));
    rig.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -tip));
    const r = W * 0.17, cy = H + r * 0.88 - 0.002;             // handle loop, around the X axis
    const swing = new THREE.Group();                           // pivots on the cord through the handle
    swing.position.set(0, cy, 0);
    const body = new THREE.Group(); body.position.set(0, -cy, 0);
    body.add(new THREE.Mesh(geo, outer), new THREE.Mesh(geo, inner));
    const loop = [];
    loop.push(new THREE.Vector3(0, H - 0.006, 0.004));
    for (let i = 0; i <= 16; i++) {
      const th = -Math.PI / 2 + 0.5 + (Math.PI * 2 - 1) * (i / 16);
      loop.push(new THREE.Vector3(0, cy + r * Math.sin(th), r * Math.cos(th)));
    }
    loop.push(new THREE.Vector3(0, H - 0.006, -0.004));
    const strapR = 0.0032;
    const strap = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop), 48, strapR, 8, false), outer);
    strap.scale.x = (W * 0.15) / strapR;                       // flat strap, as wide as a finger
    body.add(strap);
    swing.add(body);
    // Cord: through the handle, both ends down to the lacing on the shell.
    const cordPts = [[-0.038, cy + 0.01, -Dm - 0.04], [-0.022, cy + 0.004, -0.01], [0, cy, 0], [0.022, cy + 0.004, -0.01], [0.038, cy + 0.01, -Dm - 0.04]]
      .map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const cord = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cordPts), 40, 0.0028, 6, false),
      new THREE.MeshStandardMaterial({ color: '#16120f', roughness: 0.95 }));
    const pick = new THREE.Mesh(new THREE.BoxGeometry(W * 1.6, H * 1.45, W * 1.3), new THREE.MeshBasicMaterial({ visible: false }));
    pick.position.y = H * 0.6;
    rig.add(swing, cord, pick);                                // the cord holds still; the bell lifts on it
    seat.group.add(rig);
    seat.bellRig = { rig, swing, outer, pick };
  }

  paintSkin(seat, now) {
    const sk = seat.skin, f = this.feedback.djembe;
    const ms = now - sk.at;
    const active = ms < reactionSpan(f);
    if (!sk.dirty && !active && !sk.wasActive) return;
    sk.wasActive = active; sk.dirty = false;
    const age = Math.max(0, ms - f.hold) / 1000;              // the Flow State pulse starts fading once the hold ends
    const g = sk.canvas.getContext('2d');
    const k = sk.canvas.width / 320;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, sk.canvas.width, sk.canvas.height);
    // The visual draws its playing surface inside radius 145 of a 320 square; stretch it to the skin.
    const s = (k * 320) / 290;
    g.setTransform(s, 0, 0, s, -15 * s, -15 * s);
    const focused = this.state === 'FOCUS' && seat === this.focus;
    paintDjembe(g, { ...FLOW_PRESET, showLabels: focused, idleOpacity: this.feedback.idle, sensitivity: f.intensity, decay: Math.max(0.01, f.fade / 1000) }, { zone: active ? sk.zone : null, step: sk.step, age: active ? age : Infinity });
    sk.tex.needsUpdate = true;
  }

  // The original circular notation, wrapped around the rim: beat ticks and numbers on the outer
  // edge, notes on the track in the notation's own symbols, and a sweep that follows the beat.
  paintDial(seat, pos) {
    const c = seat.dial.canvas, g = c.getContext('2d');
    const { sub, total } = this.steps();
    const S = c.width, cx = S / 2, cy = S / 2;
    const rOut = S / 2 - 2, rIn = rOut * (seat.dialInner / seat.dialOuter);
    const band = rOut - rIn;
    const track = rIn + band * 0.3;
    const colors = beatColors();
    const pattern = Array.isArray(seat.inst?.pattern) ? seat.inst.pattern : [];
    const step = pos >= 0 ? Math.floor(pos) % total : -1;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(38, 38, 38, 0.68)';
    g.beginPath(); g.arc(cx, cy, rOut, 0, Math.PI * 2); g.arc(cx, cy, rIn, 0, Math.PI * 2, true); g.fill();
    for (let i = 0; i < total; i++) {
      const beat = Math.floor(i / sub), down = i % sub === 0;
      const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
      const col = colors[beat % colors.length];
      g.strokeStyle = col; g.lineWidth = down ? 6 : 3;
      const t0 = rOut - band * (down ? 0.27 : 0.29), t1 = rOut - band * (down ? 0.39 : 0.35);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * t0, cy + Math.sin(a) * t0); g.lineTo(cx + Math.cos(a) * t1, cy + Math.sin(a) * t1); g.stroke();
      if (down) {
        const nr = rOut - band * 0.13;
        g.fillStyle = col; g.font = `bold ${Math.round(band * 0.17)}px Orbitron, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(beat + 1), cx + Math.cos(a) * nr, cy + Math.sin(a) * nr);
      }
    }
    const rr = Math.min(band * 0.14, (Math.PI * track / total) * 0.8);
    for (let i = 0; i < total; i++) {
      const sound = soundOf(pattern[i], false);
      if (!sound) continue;
      const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
      const x = cx + Math.cos(a) * track, y = cy + Math.sin(a) * track;
      const now = i === step;
      const r = rr + (now ? rr * 0.35 : 0);
      if (sound === 'tone') {
        g.strokeStyle = ACCENT.tone; g.fillStyle = `rgba(252, 209, 22, ${now ? 0.4 : 0.15})`; g.lineWidth = now ? 6 : 4.5;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        const col = ACCENT[sound];
        g.fillStyle = 'rgba(20, 20, 20, 0.86)'; g.strokeStyle = col; g.lineWidth = now ? 5 : 4;
        if (now) { g.shadowBlur = 18; g.shadowColor = col; }
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.shadowBlur = 0;
        g.fillStyle = col; g.font = `bold ${Math.round(r * 1.15)}px Arial, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(CHAR[sound], x, y + 1);
      }
      drawGrace(g, x, y, r, pattern[i]);
    }
    seat.dial.tex.needsUpdate = true;
  }

  // Line view: the part as a row of steps (bell row over drum row for dunun), shown above the seat.
  paintLine(seat, pos) {
    const c = this.lineCanvas, g = c.getContext('2d');
    const { sub, total } = this.steps();
    const rows = [];
    if (seat.kind === 'shekere') {
      const { sub: sb, total: tt } = this.steps();
      const beats = Array.from({ length: tt }, (_, i) => (i % sb === 0 ? (i === 0 ? 'slap' : 'tone') : 'silence'));
      rows.push({ inst: { pattern: beats }, bell: false, label: 'Met' });
    }
    if (seat.bell) rows.push({ inst: seat.bell, bell: true, label: 'Bell' });
    if (seat.inst && seat.kind !== 'shekere') rows.push({ inst: seat.inst, bell: false, label: seat.kind === 'dunun' ? 'Drum' : '' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = c.clientWidth || 600, rowPx = 46, headPx = 30;
    const cssH = headPx + Math.max(1, rows.length) * rowPx + 10;
    if (c.height !== Math.round(cssH * dpr) || c.width !== Math.round(cssW * dpr)) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); c.style.height = `${cssH}px`; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW, H = cssH;
    const colors = beatColors();
    const step = pos >= 0 ? Math.floor(pos) % total : -1;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(14, 9, 6, 0.82)'; roundRect(g, 1, 1, W - 2, H - 2, 12); g.fill();
    const labelW = rows.some((r) => r.label) ? 48 : 10;
    const padX = labelW, padR = 10;
    const cw = (W - padX - padR) / total;
    for (let b = 0; b * sub < total; b++) {
      const x0 = padX + b * sub * cw;
      g.fillStyle = colors[b % colors.length];
      g.font = `bold 13px Orbitron, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(String(b + 1), x0 + 3, 6);
      g.fillRect(x0 + 2, headPx - 7, sub * cw - 4, 3);
    }
    if (step >= 0) { g.fillStyle = 'rgba(255,255,255,0.13)'; g.fillRect(padX + step * cw, headPx - 2, cw, H - headPx - 4); }
    rows.forEach((row, ri) => {
      const pattern = Array.isArray(row.inst.pattern) ? row.inst.pattern : [];
      const y = headPx + ri * rowPx + rowPx / 2;
      if (row.label) {
        g.fillStyle = 'rgba(255, 246, 220, 0.7)'; g.font = '600 11px Orbitron, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(row.label.toUpperCase(), 8, y);
      }
      const rad = Math.min(cw * 0.4, rowPx * 0.34);
      for (let i = 0; i < total; i++) {
        const x = padX + (i + 0.5) * cw;
        const sound = soundOf(pattern[i], row.bell);
        const now = i === step;
        if (!sound) { g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(x - rad * 0.35, y - 1, rad * 0.7, 2); continue; }
        const r = rad * (now ? 1.2 : 1);
        if (sound === 'tone') {
          g.strokeStyle = ACCENT.tone; g.fillStyle = `rgba(252, 209, 22, ${now ? 0.4 : 0.15})`; g.lineWidth = 2.5;
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        } else {
          const col = ACCENT[sound];
          g.fillStyle = 'rgba(20,20,20,0.9)'; g.strokeStyle = col; g.lineWidth = 2.5;
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
          g.fillStyle = col; g.font = `bold ${Math.round(r * 1.1)}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(CHAR[sound], x, y + 1);
        }
        if (!row.bell) drawGrace(g, x, y, r, pattern[i]);
      }
    });
    if (!rows.length || rows.every((r) => !(r.inst.pattern || []).some((v) => soundOf(v, r.bell)))) {
      g.fillStyle = 'rgba(255, 246, 220, 0.6)'; g.font = '600 12px Orbitron, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('No part written for this instrument', W / 2, headPx + rowPx / 2);
    }
  }

  drawLabel(seat) {
    const name = seat.inst?.name || seat.bell?.name || seat.model;
    if (seat.labelText === name) return;
    seat.labelText = name;
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.font = 'bold 44px Orbitron, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.strokeText(name, 256, 64, 490);
    g.fillStyle = '#fcd116'; g.fillText(name, 256, 64, 490);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    seat.label.material.map?.dispose();
    seat.label.material.map = tex; seat.label.material.needsUpdate = true;
  }

  steps() {
    const d = this.rhythm;
    const beats = Math.max(1, parseInt(d?.beats, 10) || 4);
    const sub = Math.max(1, parseInt(d?.subdivisions, 10) || 4);
    return { beats, sub, total: beats * sub, tempo: clamp(parseInt(d?.tempo, 10) || 100, 40, 240) };
  }

  // ================================================================ camera
  poseFor(state, seat = this.focus) {
    const narrow = this.camera.aspect < 1;
    if (state === 'HOME') {
      const o = { az: this.orbit.az, pol: narrow ? 1.42 : 1.36, r: narrow ? 3.6 : 3.5 };
      const t = new THREE.Vector3(0, narrow ? 1.05 : 1.3, 0);
      return { pos: sph(t, o), target: t, fov: narrow ? 62 : 46, orbit: o };
    }
    if (state === 'CIRCLE') {
      // Stay under the roof beams (3.7 m) on tall, narrow screens.
      const o = { az: 0, pol: narrow ? 1.0 : 0.98, r: narrow ? 4.6 : 5.3 };
      const t = new THREE.Vector3(0, 0.55, narrow ? -0.6 : -0.35);
      return { pos: sph(t, o), target: t, fov: narrow ? 80 : 56, orbit: o };
    }
    if (state === 'DIVE') {
      const dir = this.camera.position.clone().sub(this.globe.position).setY(0).normalize();
      const t = this.globe.position.clone();
      return { pos: t.clone().addScaledVector(dir, GLOBE_R + 0.45).setY(t.y + 0.1), target: t, fov: 40 };
    }
    const base = seat.pos.clone(), out = seat.out;
    const side = new THREE.Vector3(out.z, 0, -out.x);
    const up = new THREE.Vector3(0, 1, 0);
    const v = this.focusView;
    let pos, target, fov;
    if (seat.kind === 'djembe') {
      const head = base.clone().add(new THREE.Vector3(0, seat.headPos.y, 0));
      target = head.clone().addScaledVector(out, -0.02);
      if (v === 'top') { pos = head.clone().addScaledVector(out, 0.06).addScaledVector(up, 1.05); fov = narrow ? 66 : 48; }
      else if (v === 'side') { pos = head.clone().addScaledVector(out, 0.8).addScaledVector(side, 0.35).addScaledVector(up, 0.32); target = head.clone().addScaledVector(up, -0.12); fov = narrow ? 64 : 46; }
      else { pos = head.clone().addScaledVector(out, 0.36).addScaledVector(up, 0.82); fov = narrow ? 64 : 46; }
    } else if (seat.kind === 'dunun') {
      const mid = base.clone().add(new THREE.Vector3(0, seat.top + 0.06, 0));
      target = mid.clone().addScaledVector(side, 0.04);
      if (v === 'top') { pos = mid.clone().addScaledVector(out, 0.2).addScaledVector(up, 1.15); fov = narrow ? 68 : 54; }
      else if (v === 'side') { const head = base.clone().add(new THREE.Vector3(0, seat.headPos.y, 0)); target = head.clone().addScaledVector(side, seat.len / 2); pos = head.clone().addScaledVector(side, 1.05).addScaledVector(out, 0.35).addScaledVector(up, 0.25); fov = narrow ? 64 : 48; }
      else { pos = mid.clone().addScaledVector(out, 0.9).addScaledVector(side, 0.12).addScaledVector(up, 0.6); fov = narrow ? 68 : 54; }
    } else {
      const mid = base.clone().add(new THREE.Vector3(0, 0.8, 0));
      target = mid;
      if (v === 'top') { pos = mid.clone().addScaledVector(out, 0.15).addScaledVector(up, 1.0); fov = narrow ? 64 : 50; }
      else if (v === 'side') { pos = mid.clone().addScaledVector(out, 0.5).addScaledVector(side, 0.65).addScaledVector(up, 0.1); fov = narrow ? 64 : 50; }
      else { pos = mid.clone().addScaledVector(out, 0.8).addScaledVector(up, 0.45); fov = narrow ? 64 : 50; }
    }
    const pose = this.fitFocus(seat, { pos, target, fov });
    pose.pos = pose.target.clone().add(pose.pos.clone().sub(pose.target).multiplyScalar(this.focusZoom));
    return pose;
  }

  // The line view sits under whichever is lower: the title or the meaning card.
  placeLine() {
    const below = (el) => { const r = el.getBoundingClientRect(); return !el.hidden && r.height && getComputedStyle(el).display !== 'none' ? r.bottom : 0; };
    const top = Math.max(below(this.meaning), this.title.classList.contains('show') ? below(this.title) : 0, 60);
    this.lineCanvas.style.top = `${Math.round(top + 8)}px`;
  }

  // Free screen band between the top HUD (title or line view) and the bottom bar, in pixels.
  safeBand() {
    const H = window.innerHeight;
    let top = 70, bottom = 96;
    if (this.title.classList.contains('show')) top = this.title.getBoundingClientRect().bottom + 8;
    if (!this.meaning.hidden && getComputedStyle(this.meaning).display !== 'none') top = Math.max(top, this.meaning.getBoundingClientRect().bottom + 8);
    const bar = this.bar.getBoundingClientRect();
    if (bar.height) bottom = H - bar.top + 34;               // bar plus the hint line above it
    const lineOn = this.state === 'FOCUS' && this.focus && (this.focus.kind !== 'djembe' || this.djembeView === 'line');
    if (lineOn) {
      const r = this.lineCanvas.getBoundingClientRect();
      top = Math.max(top, (r.height ? r.bottom : 200) + 8);
    }
    return { top: Math.min(top, H * 0.45), bottom: Math.min(bottom, H * 0.4) };
  }

  // Back the camera off until the ring (or the instrument) fits inside the free band.
  fitFocus(seat, pose) {
    const band = this.safeBand();
    const H = window.innerHeight;
    const availY = 2 * (H - band.top - band.bottom) / H * 0.94, availX = 2 * 0.9;
    const pts = [];
    const ring = seat.kind === 'djembe' && this.djembeView === 'ring' ? seat.dialOuter : seat.kind === 'djembe' ? seat.headR * 1.15 : 0;
    if (ring) {
      const c = seat.pos.clone().add(new THREE.Vector3(0, seat.headPos.y, 0));
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push(c.clone().add(new THREE.Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring))); }
    } else {
      const half = seat.kind === 'dunun' ? seat.len / 2 + 0.05 : 0.2;
      const side = new THREE.Vector3(seat.out.z, 0, -seat.out.x);
      for (const sx of [-half, half]) for (const y of [0.35, seat.height]) pts.push(seat.pos.clone().addScaledVector(side, sx).add(new THREE.Vector3(0, y, 0)));
    }
    const cam = this.fitCam || (this.fitCam = new THREE.PerspectiveCamera(50, 1, 0.01, 100));
    cam.aspect = this.camera.aspect; cam.fov = pose.fov; cam.updateProjectionMatrix();
    let pos = pose.pos.clone();
    for (let i = 0; i < 4; i++) {
      cam.position.copy(pos); cam.lookAt(pose.target); cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { const v = p.clone().project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const need = Math.max((y1 - y0) / availY, (x1 - x0) / availX);
      if (need <= 1.01) break;
      pos = pose.target.clone().add(pos.clone().sub(pose.target).multiplyScalar(need * 1.02));
    }
    return { pos, target: pose.target, fov: pose.fov };
  }

  refocus(seconds = 0.6) {
    if (this.state !== 'FOCUS' || !this.focus) { this.syncTools(); return; }
    this.flyTo(this.poseFor('FOCUS'), seconds);
    this.syncTools();
  }

  zoomFocus(k) {
    this.focusZoom = clamp(this.focusZoom * k, 0.55, 1.8);
    this.refocus(0.35);
  }

  syncTools() {
    const focus = this.state === 'FOCUS' && this.focus;
    this.tools.hidden = !focus;
    this.segNotation.hidden = !(focus && this.focus.kind === 'djembe');
    for (const b of this.segNotation.children) b.classList.toggle('on', b.dataset.v === this.djembeView);
    for (const b of this.segView.children) b.classList.toggle('on', b.dataset.v === this.focusView);
    this.syncMixButtons();
    const line = !!focus && (this.focus.kind !== 'djembe' || this.djembeView === 'line');
    this.lineCanvas.hidden = !line;
    if (focus) for (const seat of this.seats) seat.notationDirty = true;
  }

  flyTo(pose, seconds = 1.4, done) {
    this.tween = {
      t: 0, dur: seconds, done,
      p0: this.camera.position.clone(), p1: pose.pos.clone(),
      q0: this.lookTarget ? this.lookTarget.clone() : pose.target.clone(), q1: pose.target.clone(),
      f0: this.camera.fov, f1: pose.fov
    };
  }

  go(state, opts = {}) {
    if (state === 'FOCUS') {
      const seat = opts.seat || this.focus || this.seats[0];
      if (!seat) return;
      if (this.state !== 'FOCUS') this.focusZoom = 1;
      this.focus = seat;
    } else if (state !== 'DIVE') {
      this.focus = null;
    }
    if (state !== 'DIVE') this.closeSheets();
    this.state = state;
    if (!this.ready) { this.applyState(); return; }
    const pose = this.poseFor(state);
    this.orbit.auto = state === 'HOME';
    this.flyTo(pose, opts.seconds ?? (state === 'FOCUS' ? 1.2 : 1.6), () => {
      if (pose.orbit) { Object.assign(this.orbit, pose.orbit); this.orbit.target.copy(pose.target); }
      opts.done?.();
    });
    this.globePose = state === 'HOME' || state === 'DIVE' ? { y: 1.3, s: 1 } : { y: 3.05, s: 0.34 };
    for (const seat of this.seats) if (seat.skin) seat.skin.dirty = true;
    this.applyState();
  }

  applyState(snap = false) {
    const s = this.state;
    document.body.dataset.roomState = s;
    const hasRhythm = !!this.rhythmKey;
    this.btnGlobe.hidden = s === 'HOME' || s === 'DIVE';
    this.btnCircle.hidden = !(s === 'FOCUS' || (s === 'HOME' && hasRhythm));
    const focus = s === 'FOCUS' && this.focus;
    this.btnPrev.hidden = this.btnNext.hidden = this.seatName.hidden = !focus;
    if (focus) this.seatName.textContent = this.focus.inst?.name || this.focus.bell?.name || this.focus.model;
    this.btnAbout.disabled = !hasRhythm;
    this.title.classList.toggle('show', hasRhythm && (s === 'CIRCLE' || s === 'FOCUS'));
    const r = appRhythms()[this.rhythmKey] || {};
    const meaning = historyOf(r) || String(this.journey?.description || '').trim();
    this.meaningText.textContent = meaning;
    this.meaning.hidden = !(meaning && hasRhythm && (s === 'CIRCLE' || s === 'FOCUS'));
    this.placeLine();
    this.hint.textContent = s === 'HOME' ? 'Choose a rhythm from Rhythms or tap a name on the globe'
      : s === 'CIRCLE' ? 'Tap an instrument to sit at it'
        : focus && this.focus.kind === 'djembe' ? 'Play on the skin: centre bass, middle tone, edge slap'
          : focus && this.focus.kind === 'dunun' ? 'Head: open. Shell: muted. Bell on top'
            : focus ? (this.met ? 'The shekere keeps the beat (Met is on)' : 'The shekere is the metronome: turn on Met') : '';
    this.syncTools();
    if (snap && this.ready) {
      const pose = this.poseFor(s === 'FOCUS' && !this.focus ? 'CIRCLE' : s);
      this.camera.position.copy(pose.pos); this.lookTarget = pose.target.clone(); this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix(); this.camera.lookAt(this.lookTarget);
      if (pose.orbit) { Object.assign(this.orbit, pose.orbit); this.orbit.target.copy(pose.target); }
    }
    this.syncSeatToPads();
  }

  stepFocus(dir) {
    if (!this.seats.length) return;
    const i = this.seats.indexOf(this.focus);
    this.go('FOCUS', { seat: this.seats[(i + dir + this.seats.length) % this.seats.length], seconds: 0.9 });
  }

  // The pad window that plays: on phones the one docked over the room, otherwise Pad 1.
  activePad() {
    return (PAD_ONLY && document.querySelector('.trigger-pad-window.remote-active')) || document.getElementById('trigger-pad-1');
  }

  // Sitting at an instrument points the pad (and the phone pad QR) at it.
  syncSeatToPads() {
    if (this.state !== 'FOCUS' || !this.focus?.inst) return;
    const select = this.activePad()?.querySelector('select.trigger-pad-instrument-select:not(.trigger-pad-rhythm-select)');
    if (!select || select.value === this.focus.inst.id) return;
    if (![...select.options].some((o) => o.value === this.focus.inst.id)) return;
    select.value = this.focus.inst.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ================================================================ app wiring
  bind() {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('rrc:notation-rhythm-state', () => this.syncEnsemble());
    window.addEventListener('message', (e) => {
      if (e.data?.type !== 'notationInstrumentMix') return;
      if (e.source !== document.getElementById('notation-iframe')?.contentWindow) return;   // only the notation player
      this.onInstrumentMix(e.data);
    });
    window.addEventListener('rrc:notation-step-scheduled', (e) => {
      const d = e.detail || {};
      if (!Number.isFinite(d.stepEpoch)) return;
      const q = this.stepQueue;
      while (q.length && q[q.length - 1].stepEpoch >= d.stepEpoch - 1) q.pop();
      q.push(d);
      if (q.length > 64) q.splice(0, q.length - 64);
      this.setPlaying(true);
    });
    window.addEventListener('rrc:notation-playback-state', (e) => {
      if (!e.detail?.playing) { this.stepQueue.length = 0; this.setPlaying(false); }
    });
    window.addEventListener('rrc:journey', (e) => this.onJourney(e.detail || {}));
    window.addEventListener('rrc:notation-metronome', (e) => { this.met = !!e.detail?.enabled; this.syncMetTempo(); });
    window.addEventListener('rrc:notation-rhythm-state', () => { this.tempo = this.steps().tempo; this.syncMetTempo(); });
    window.addEventListener('rrc:notation-call-state', (e) => { this.callState = e.detail || null; this.syncCallButtons(); });
    document.addEventListener('visibilitychange', () => { this.lastFrame = 0; });
    const markActive = () => { this.userActive = true; };
    window.addEventListener('pointerdown', markActive, { capture: true, passive: true });
    window.addEventListener('keydown', markActive, { capture: true, passive: true });
    setInterval(() => this.updateSessionButton(), 2000);

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    dom.addEventListener('pointerup', (e) => this.onPointerUp(e));
    dom.addEventListener('pointercancel', () => { this.pointer.down = false; });
    dom.addEventListener('wheel', (e) => {
      if (this.tween) return;
      e.preventDefault();
      const k = Math.exp(clamp(e.deltaY, -60, 60) * 0.0025);
      if (this.state === 'FOCUS') { this.zoomFocus(k); return; }
      this.zoomOrbit(k);
    }, { passive: false });
    // Two-finger pinch zooms the globe and the circle.
    dom.addEventListener('pointerdown', (e) => { this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.pinch = null; }, { capture: true });
    dom.addEventListener('pointermove', (e) => {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size !== 2 || this.state === 'FOCUS' || this.tween) return;
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch) this.zoomOrbit(this.pinch / Math.max(1, d));
      this.pinch = d; this.pointer.moved += 20;
    }, { capture: true });
    const lift = (e) => { this.touches.delete(e.pointerId); if (this.touches.size < 2) this.pinch = null; };
    dom.addEventListener('pointerup', lift, { capture: true });
    dom.addEventListener('pointercancel', lift, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'Escape') { if (this.mapMode) this.toggleMap(false); else if (!Object.values(this.sheets).every((s) => s.hidden)) this.closeSheets(); else if (this.state === 'FOCUS') this.go('CIRCLE'); }
      else if (this.state === 'FOCUS' && e.key === 'ArrowLeft') this.stepFocus(-1);
      else if (this.state === 'FOCUS' && e.key === 'ArrowRight') this.stepFocus(1);
    });
  }

  // ---------- solo / mute, per seat; the notation player owns the real state
  seatParts(seat) { return [seat?.inst, seat?.bell].filter(Boolean); }

  // The player reports solo / mute for every instrument; that is the truth the room shows.
  onInstrumentMix(d) {
    if (!Array.isArray(d?.mix)) return;
    this.mix = {};
    for (const m of d.mix) if (m && m.id != null) this.mix[m.id] = { muted: !!m.muted, soloed: !!m.soloed };
    for (const seat of this.seats) for (const p of this.seatParts(seat)) if (this.mix[p.id]) Object.assign(p, this.mix[p.id]);
    this.syncMixButtons();
    if (this.autoSolo) return;                                 // the automatic phone solo decides for now
    // A rhythm load resets the player's solo / mute: put this device's own choices back. Only after a reset
    // (nothing soloed or muted), so changes made in the notation window are left alone.
    const reset = Object.values(this.mix).every((m) => !m.muted && !m.soloed);
    if (!reset) return;
    const want = { muted: { true: [], false: [] }, soloed: { true: [], false: [] } };
    for (const id of Object.keys(this.mix)) {
      const pref = this.mixPref[id] || {};
      for (const key of ['muted', 'soloed']) {
        const desired = !!pref[key];
        if (this.mix[id][key] !== desired) want[key][desired].push(id);
      }
    }
    const bridge = window._notationBridge;
    for (const key of ['muted', 'soloed']) for (const val of [true, false]) {
      if (want[key][val].length) try { bridge?.postMain?.({ type: 'setInstrumentMix', ids: want[key][val], [key]: val }); } catch {}
    }
  }

  toggleMix(key) {
    const parts = this.seatParts(this.focus);
    if (!parts.length) return;
    this.autoSolo = false; this.autoSoloIds = [];
    const on = !parts.every((p) => p[key] === true);
    this.mix = this.mix || {};
    for (const p of parts) {
      p[key] = on; this.mix[p.id] = { ...this.mix[p.id], [key]: on };
      this.mixPref[p.id] = { ...this.mixPref[p.id], [key]: on };
      if (!this.mixPref[p.id].muted && !this.mixPref[p.id].soloed) delete this.mixPref[p.id];
    }
    store.set('rrcRoomMixPref', JSON.stringify(this.mixPref));
    const bridge = window._notationBridge;
    try { bridge?.ensureLoaded?.(); bridge?.postMain?.({ type: 'setInstrumentMix', ids: parts.map((p) => p.id), [key]: on }); } catch {}
    this.syncMixButtons();
    const name = this.focus.inst?.name || this.focus.bell?.name || this.focus.model;
    this.flashHint(`${name}: ${key === 'soloed' ? (on ? 'solo on' : 'solo off') : (on ? 'muted' : 'unmuted')}`);
  }

  clearMix() {
    this.autoSolo = false; this.autoSoloIds = [];
    this.mixPref = {}; store.set('rrcRoomMixPref', '{}');
    const ids = Object.keys(this.mix || {}).filter((id) => this.mix[id].muted || this.mix[id].soloed);
    for (const seat of this.seats) for (const p of this.seatParts(seat)) { p.muted = false; p.soloed = false; if (!ids.includes(p.id)) ids.push(p.id); }
    for (const id of Object.keys(this.mix || {})) this.mix[id] = { muted: false, soloed: false };
    const bridge = window._notationBridge;
    try { bridge?.ensureLoaded?.(); bridge?.postMain?.({ type: 'setInstrumentMix', ids, muted: false, soloed: false }); } catch {}
    this.syncMixButtons();
    this.flashHint('Every instrument unmuted, no solo');
  }

  syncMixButtons() {
    if (!this.btnSolo) return;
    // Phones: the room's tools are hidden, so S / M / ✕ sit in the docked pad's header, next to Play.
    if (PAD_ONLY) {
      const actions = this.activePad()?.querySelector('.trigger-pad-header-actions');
      if (actions && this.segMix.parentElement !== actions) {
        this.segMix.classList.add('room-pad-mix');
        actions.prepend(this.segMix);
        // The pad header handles presses itself (dragging, its own buttons); keep ours from reaching it,
        // or a cancelled touch press never turns into a click.
        if (!this.segMix.dataset.guarded) {
          this.segMix.dataset.guarded = '1';
          for (const type of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend']) {
            this.segMix.addEventListener(type, (e) => e.stopPropagation());
          }
        }
      }
    }
    const any = this.seats.some((s) => this.seatParts(s).some((p) => p.muted === true || p.soloed === true));
    this.btnClearMix.disabled = !any;
    this.btnClearMix.classList.toggle('on', any);
    const parts = this.seatParts(this.focus);
    this.btnSolo.classList.toggle('on', parts.length > 0 && parts.every((p) => p.soloed === true));
    this.btnMute.classList.toggle('on', parts.length > 0 && parts.every((p) => p.muted === true));
    this.btnSolo.disabled = this.btnMute.disabled = !parts.length;
  }

  setMet(on) {
    this.met = !!on;
    const bridge = window._notationBridge;
    try { bridge?.ensureLoaded?.(); bridge?.postMain?.({ type: 'setMetronomeEnabled', enabled: this.met }); } catch {}
    this.syncMetTempo();
    if (this.state === 'FOCUS') this.applyState();
  }

  nudgeTempo(d) { this.setTempo((this.tempo || this.steps().tempo) + d); }

  setTempo(bpm) {
    if (!Number.isFinite(bpm)) { this.syncMetTempo(); return; }
    this.tempo = clamp(Math.round(bpm), 40, 240);
    try { window._notationBridge?.postMain?.({ type: 'setTempo', tempo: this.tempo }); } catch {}
    if (this.rhythm) this.rhythm.tempo = this.tempo;
    this.syncMetTempo();
  }

  syncMetTempo() {
    this.btnMet.classList.toggle('on', !!this.met);
    const t = this.tempo || this.steps().tempo;
    if (document.activeElement !== this.tempoInput) this.tempoInput.value = String(t);
  }

  zoomOrbit(k) {
    this.orbit.auto = false;
    // With the sharp texture the globe can be approached closely: steps shrink near the surface and the
    // orbit centres on the globe, so it can be turned to any country.
    const close = this.state === 'HOME' && this.earthDetail;
    const nearest = this.state === 'HOME' ? GLOBE_R + (close ? 0.08 : 0.3) : 3.4;
    if (close) {
      const surface = Math.max(0.02, this.orbit.r - GLOBE_R);
      this.orbit.r = clamp(GLOBE_R + surface * k, nearest, 5.7);
      if (this.orbit.r < 2) this.orbit.target.y = lerp(this.orbit.target.y, this.globe.position.y, 0.35);
    } else {
      this.orbit.r = clamp(this.orbit.r * k, nearest, 5.7);
    }
    this.orbit.pol = clamp(this.orbit.pol, ...this.polRange());
  }

  // Up and down range for the orbit: wide near the globe, kept off the floor and under the roof.
  polRange() {
    if (this.state !== 'HOME') return [0.62, 1.48];
    const r = this.orbit.r, cy = this.orbit.target.y;
    const lo = Math.acos(clamp((3.3 - cy) / r, -1, 1));
    const hi = Math.acos(clamp((0.25 - cy) / r, -1, 1));
    return [Math.max(0.12, lo), Math.min(Math.PI - 0.12, hi)];
  }

  setPlaying(on) {
    if (this.playing === on) return;
    this.playing = on;
    this.btnPlay.textContent = on ? 'Stop' : 'Play';
    this.btnPlay.classList.toggle('on', on);
    if (!on) this.clock.step = -1;
    this.syncCallButtons();
  }

  // Call In while stopped; Call and Call Out while playing (labels follow the notation when it reports them).
  syncCallButtons() {
    const cs = this.callState;
    const playing = cs ? !!cs.playing || this.playing : this.playing;
    this.btnCall.textContent = cs?.callLabel || (playing ? 'Call' : 'Call In');
    this.btnCall.classList.toggle('on', !!(cs && (cs.callPending || cs.callActive || cs.callInActive)));
    this.btnCallOut.hidden = !(cs ? cs.showCallOut ?? playing : playing);
    this.btnCallOut.classList.toggle('on', !!cs?.callOutActive);
    this.btnCall.disabled = !this.rhythmKey && !DEMO;
  }

  call(kind) {
    try { window._notationBridge?.ensureLoaded?.(); window._notationBridge?.warmupMainAudio?.(); } catch {}
    if (typeof window._rrcCall === 'function') window._rrcCall(kind);
  }

  togglePlay() {
    const bridge = window._notationBridge;
    if (!bridge) return;
    try { bridge.ensureLoaded?.(); bridge.warmupMainAudio?.(); } catch {}
    // In a session the app decides: the leader's Play runs the countdown for everyone, a follower is blocked.
    const how = window._rrcTogglePlay?.();
    if (how === 'blocked') { this.flashHint('The session leader starts and stops playback'); return; }
    if (how === 'session') return;
    bridge.postMain?.({ type: this.playing ? 'stopPlayback' : 'startPlayback' });
  }

  onJourney(d) {
    if (!this.enabled) return;
    if (this.mapMode && d.phase === 'start') this.toggleMap(false);
    if (PAD_ONLY) {                                            // phones stay seated: no travel, no circle view
      if (d.phase === 'start') { this.journey = d; this.rhythmKey = d.key || ''; }
      if (this.state !== 'FOCUS' && this.focus === null && this.seats.length) this.go('FOCUS', { seat: this.padSeat(), seconds: 0.1 });
      return;
    }
    if (d.phase === 'start') {
      this.journey = d;
      this.rhythmKey = d.key || '';
      this.titleName.textContent = d.name || '';
      this.titleName.style.color = d.color || '#fcd116';
      this.titlePlace.textContent = d.location || '';
      this.highlightMarker(d.key);
      // The journey the app runs on load restores the last rhythm; in the room we stay at the globe.
      if (!this.userActive) { this.bootJourney = true; return; }
      if (!d.travel || !this.ready) { this.arrive(); return; }
      if (!this.mapOnline) {
        this.state = 'DIVE'; this.closeSheets(); this.orbit.auto = false;
        if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
          const v = this.latLngToVec(d.lat, d.lng, 1);
          const camAz = Math.atan2(this.camera.position.x - this.globe.position.x, this.camera.position.z - this.globe.position.z);
          this.earthTarget = camAz - Math.atan2(v.x, v.z);
        }
        this.flyTo(this.poseFor('DIVE'), 1.4);
        this.applyState();
        clearTimeout(this.arriveTimer);
        this.arriveTimer = setTimeout(() => this.arrive(), 2600);
        return;
      }
      if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
        const v = this.latLngToVec(d.lat, d.lng, 1);
        const camAz = Math.atan2(this.camera.position.x - this.globe.position.x, this.camera.position.z - this.globe.position.z);
        this.earthTarget = camAz - Math.atan2(v.x, v.z);
      }
      this.state = 'DIVE';
      this.closeSheets();
      this.globePose = { y: 1.3, s: 1 };
      this.orbit.auto = false;
      this.flyTo(this.poseFor('DIVE'), 1.0);
      this.applyState();
      this.setHandover(true, 450);
      clearTimeout(this.arriveTimer);
      this.arriveTimer = setTimeout(() => this.arrive(), 14000);
    } else if (d.phase === 'arrive') {
      if (!this.mapOnline && this.state === 'DIVE') return;   // the room's own dive finishes the trip
      this.journey = d;
      this.rhythmKey = d.key || this.rhythmKey;
      if (this.bootJourney) { this.bootJourney = false; this.applyState(); return; }
      this.arrive();
    }
  }

  arrive() {
    clearTimeout(this.arriveTimer);
    this.setHandover(false, 0);
    this.syncEnsemble();
    this.go('CIRCLE', { seconds: 2.1 });
  }

  setHandover(on, delayMs) {
    clearTimeout(this.handoverTimer);
    const apply = () => {
      this.view.classList.toggle('handover', on);
      this.hud.classList.toggle('handover', on);
      this.labels.classList.toggle('handover', on);
      this.setCesiumActive(on || !this.enabled);
    };
    if (on) this.setCesiumActive(true);
    if (delayMs) this.handoverTimer = setTimeout(apply, delayMs); else apply();
  }

  // The Cesium world map, full screen behind the bottom bar. The room stops drawing while it is open,
  // and the map stops drawing when it is closed.
  toggleMap(force) {
    const on = force === undefined ? !this.mapMode : !!force;
    if (on === !!this.mapMode) return;
    this.mapMode = on;
    document.documentElement.classList.toggle('rrc-room-map', on);
    this.btnMap.classList.toggle('on', on);
    this.btnMap.textContent = on ? 'Room' : 'Map';
    this.btnMap.title = on ? 'Back to the room' : 'Explore the world map: geography and place names';
    this.setCesiumActive(on || !this.enabled);
    if (!on) { this.applyState(); return; }
    this.closeSheets();
    try { if (typeof applyMapWindowMode === 'function') applyMapWindowMode(false, { persist: false }); } catch {}
    try {
      if (typeof viewer !== 'undefined' && viewer && typeof Cesium !== 'undefined') {
        viewer.resize?.();
        const r = appRhythms()[this.rhythmKey];
        const lat = Number.isFinite(r?.lat) ? r.lat : 10.5, lng = Number.isFinite(r?.lng) ? r.lng : -9.5;
        viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lng, lat, r ? 1800000 : 4500000), duration: 1.6 });
      }
    } catch (err) { console.warn('[room] map', err); }
    this.hint.textContent = 'Drag to move, scroll or pinch to zoom. The layers button (top right) switches map styles.';
  }

  setCesiumActive(on) {
    try { if (typeof viewer !== 'undefined' && viewer) viewer.useDefaultRenderLoop = !!on; } catch {}
  }

  highlightMarker(key) {
    for (const m of this.markers.children) {
      const on = m.userData.rhythmKey === key;
      m.userData.selected = on;
      m.material.opacity = on ? 0.9 : 0.55;
      m.userData.label?.classList.toggle('on', on);
    }
  }

  setEnabled(on, { initial = false } = {}) {
    if (PAD_ONLY) on = true;                                   // phones: the room, with the pads docked over it
    this.enabled = on;
    document.documentElement.classList.toggle('rrc-room', on);
    this.setCesiumActive(!on);
    // The window manager refits windows when the top bar appears or disappears.
    setTimeout(() => { try { window._reflowFloatingWindows?.(); } catch {} }, 50);
    if (on) {
      this.lastFrame = 0;
      if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
      try { window._notationBridge?.ensureLoaded?.(); } catch {}
      if (initial) this.clearOverlays();
    }
  }

  // Start with a clear room. Windows stay one tap away in the menu.
  clearOverlays() {
    document.querySelectorAll('[data-floating-window="true"]').forEach((p) => {
      if (p.id === 'cesiumContainer') return;
      p.classList.add('hidden', 'panel-hidden'); p.classList.remove('active');
    });
    window._syncTopPanelToggleStates?.();
    window._syncNotationWindowVisibilityFromDom?.();
  }

  // ================================================================ pointer
  ray(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  pickSeat(e) {
    const hits = this.ray(e).intersectObjects(this.seats.map((s) => s.pick), false);
    return hits[0]?.object.userData.seat || null;
  }

  onPointerDown(e) {
    if (!this.ready || this.tween) return;
    this.closeSheets();
    this.pointer = { down: true, moved: 0, x: e.clientX, y: e.clientY };
    if (this.state === 'FOCUS' && this.focus) {
      if (this.playOn(this.focus, e)) { this.pointer.down = false; e.preventDefault(); }
      return;
    }
    this.orbit.auto = false;
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch {}
  }

  onPointerMove(e) {
    if (!this.ready) return;
    const p = this.pointer;
    if (p.down && this.state !== 'FOCUS' && !this.tween) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.moved += Math.abs(dx) + Math.abs(dy); p.x = e.clientX; p.y = e.clientY;
      if (this.touches.size > 1) return;
      const k = this.state === 'HOME'
        ? (this.earthDetail ? clamp((this.orbit.r - GLOBE_R) / 3, 0.03, 1) : clamp(this.orbit.r / 3.5, 0.15, 1))
        : 1;
      this.orbit.az -= dx * 0.005 * k;
      this.orbit.pol = clamp(this.orbit.pol - dy * 0.004 * k, ...this.polRange());
      return;
    }
    if (e.pointerType === 'mouse' && !p.down) {
      const seat = this.state === 'CIRCLE' ? this.pickSeat(e) : null;
      this.hover = seat;
      this.renderer.domElement.style.cursor = seat || this.state === 'FOCUS' ? 'pointer' : 'grab';
    }
  }

  onPointerUp(e) {
    const p = this.pointer;
    if (!p.down) return;
    p.down = false;
    if (p.moved > 8 || this.tween) return;
    if (this.state === 'HOME') {
      if (this.rhythmKey && this.ray(e).intersectObject(this.earth, false).length) this.go('CIRCLE');
      return;
    }
    const seat = this.pickSeat(e);
    if (seat) this.go('FOCUS', { seat });
  }

  // A stroke played on the focused instrument. Returns true when something was hit.
  playOn(seat, e) {
    const ray = this.ray(e).ray;
    const toLocal = (v) => seat.group.worldToLocal(v.clone());
    const o = toLocal(ray.origin);
    const d = toLocal(ray.origin.clone().add(ray.direction)).sub(o).normalize();
    const hitPlane = (point, normal) => {
      const denom = d.dot(normal);
      if (Math.abs(denom) < 1e-4) return null;
      const t = point.clone().sub(o).dot(normal) / denom;
      return t > 0 ? o.clone().addScaledVector(d, t) : null;
    };
    const other = () => { const s = this.pickSeat(e); if (s && s !== seat) { this.go('FOCUS', { seat: s, seconds: 0.9 }); return true; } return false; };
    if (seat.kind === 'djembe') {
      const p = hitPlane(seat.headPos, seat.headNormal);
      if (!p) return other();
      const r = Math.hypot(p.x - seat.headPos.x, p.z - seat.headPos.z) / seat.headR;
      if (r > 1.12) return other();
      const z = FLOW_PRESET.zoneSizes;
      const sound = e.shiftKey ? 'mute' : r < z.bass / 100 ? 'bass' : r < (z.bass + z.open) / 100 ? 'tone' : 'slap';
      this.sendHit(seat, seat.inst, sound, p.x >= seat.headPos.x ? 1 : 0);
      return true;
    }
    if (seat.kind === 'dunun') {
      if (seat.bell && seat.bellRig && this.ray(e).intersectObject(seat.bellRig.pick, false).length) { this.sendHit(seat, seat.bell, 'slap', 1, true); return true; }
      const head = hitPlane(seat.headPos, seat.headNormal);
      const onHead = head && Math.hypot(head.y - seat.headPos.y, head.z - seat.headPos.z) < seat.headR * 1.1;
      const shell = hitPlane(new THREE.Vector3(0, seat.top - 0.02, 0), new THREE.Vector3(0, 1, 0));
      const onShell = shell && Math.abs(shell.x) < seat.len / 2 && Math.abs(shell.z) < seat.headR;
      if (onHead && seat.inst) { this.sendHit(seat, seat.inst, e.shiftKey ? 'mute' : 'tone', 0); return true; }
      if (onShell && seat.inst) { this.sendHit(seat, seat.inst, 'mute', 0); return true; }
      return other();
    }
    if (this.pickSeat(e) === seat && seat.inst) { this.sendHit(seat, seat.inst, 'tone', 0); return true; }
    return other();
  }

  sendHit(seat, inst, sound, lane, isBell = false) {
    if (!inst) return;
    this.liveStep = (this.liveStep || 0) + 1;
    this.animateHit(seat, isBell ? 'bell' : soundOf(sound, false), isBell, this.liveStep);
    try { window._rrcSendTriggerHit?.({ instrumentId: inst.id, instrumentType: inst.type, sound, velocity: 0.92, triggerLane: lane, reverbMix: 0.1 }); }
    catch (err) { console.warn('[room] hit failed', err); }
  }

  animateHit(seat, sound, isBell, step) {
    if (!sound) return;
    const fx = seat.fx;
    if (isBell) { fx.bellAt = performance.now(); return; }
    if (seat.kind === 'djembe') {
      seat.skin.zone = strokeToZone(sound === 'tone' ? 'open' : sound, 'djembe');
      seat.skin.step = step; seat.skin.at = performance.now();
      return;
    }
    if (seat.kind === 'dunun') {
      seat.drumSkin.sound = sound === 'mute' ? 'mute' : 'tone'; seat.drumSkin.at = performance.now();
      return;
    }
    if (seat.kind === 'shekere') fx.shake = 1;
    fx.flash = 1; fx.muted = sound === 'mute'; fx.color.set(ACCENT[sound] || '#fff');
  }

  // ================================================================ frame
  resize() {
    this.placeLine?.();
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Phones: the pads cover the bottom of the screen, so centre the view in the space above them.
    const pad = PAD_ONLY ? this.activePad() : null;
    const inset = pad && pad.offsetParent ? Math.min(h * 0.6, pad.getBoundingClientRect().height) : 0;
    if (inset > 0) this.camera.setViewOffset(w, h, 0, inset / 2, w, h); else this.camera.clearViewOffset();
    if (pad && !this.padObserved) { this.padObserved = true; new ResizeObserver(() => this.resize()).observe(pad); }
    this.camera.updateProjectionMatrix();
    if (this.ready && !this.tween) this.applyState(true);
  }

  frame(t) {
    this.raf = this.enabled ? requestAnimationFrame((n) => this.frame(n)) : 0;
    if (!this.enabled || document.hidden || this.mapMode) return;
    // Phones draw at 30 fps: the GPU and main thread are shared with the audio scheduler and the pads.
    if (PAD_ONLY && this.lastFrame && t - this.lastFrame < 30) return;
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = t;
    if (!this.ready) return;
    if (this.view.classList.contains('handover') && !this.tween) return;
    this.refreshMarkers();
    this.advanceClock();
    this.updateCamera(dt);
    this.updateGlobe(dt, t);
    this.updateSeats(dt, t);
    this.updateCountdown();
    this.updateAutoSolo();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  advanceClock() {
    const now = Date.now();
    const q = this.stepQueue;
    while (q.length && q[0].stepEpoch <= now + 8) {
      const s = q.shift();
      const c = this.clock;
      c.step = s.step; c.epoch = s.stepEpoch; c.dur = s.stepDurationMs > 0 ? s.stepDurationMs : c.dur;
      c.durs[s.step] = c.dur;
      c.abs = (c.abs || 0) + 1;
      if (Number.isFinite(s.tempo) && s.tempo > 0 && s.tempo !== this.tempo) { this.tempo = Math.round(s.tempo); this.syncMetTempo(); }
      this.onStep(s.step, c.abs, s);
    }
  }

  onStep(step, abs, info = {}) {
    const { sub } = this.steps();
    if (typeof info.metronome === 'boolean' && info.metronome !== this.met) { this.met = info.metronome; this.syncMetTempo(); }
    const silent = new Set(Array.isArray(info.silentIds) ? info.silentIds : []);
    const soloActive = this.seats.some((s) => this.seatParts(s).some((p) => p.soloed === true));
    for (const seat of this.seats) {
      if (seat.kind === 'shekere') {
        if (this.met && step % sub === 0) this.animateHit(seat, step === 0 ? 'slap' : 'tone', false, step);
        continue;
      }
      for (const [inst, isBell] of [[seat.inst, false], [seat.bell, true]]) {
        if (!inst || silent.has(inst.id)) continue;
        if (inst.isCall) {                                       // only the call djembe, only while it calls
          const value = 'callSound' in info ? info.callSound : info.callActive && Array.isArray(inst.pattern) ? inst.pattern[step % inst.pattern.length] : null;
          const sound = soundOf(value, false);
          if (sound) this.animateHit(seat, sound, false, step);
          continue;
        }
        if (inst.muted || (soloActive && inst.soloed !== true) || !Array.isArray(inst.pattern)) continue;
        const sound = soundOf(inst.pattern[step % inst.pattern.length], isBell);
        if (sound) this.animateHit(seat, sound, isBell, step);
      }
    }
    void abs;
  }

  cyclePosition() {
    const c = this.clock;
    if (!this.playing || c.step < 0) return -1;
    return c.step + clamp((Date.now() - c.epoch) / Math.max(20, c.dur), 0, 0.999);
  }

  updateCamera(dt) {
    const cam = this.camera;
    const W = window.innerWidth, H = window.innerHeight;
    let shift = 0;
    if (this.state === 'FOCUS') { const b = this.safeBand(); shift = (b.bottom - b.top) / 2; }
    this.viewShift = lerp(this.viewShift || 0, shift, 1 - Math.pow(0.002, dt));
    if (Math.abs(this.viewShift) > 0.5) cam.setViewOffset(W, H, 0, this.viewShift, W, H);
    else if (cam.view?.enabled) cam.clearViewOffset();
    if (this.tween) {
      const w = this.tween;
      if (!w.start) w.start = performance.now();
      w.t = Math.min(1, (performance.now() - w.start) / 1000 / w.dur);
      const k = ease(w.t);
      cam.position.lerpVectors(w.p0, w.p1, k);
      cam.position.y += Math.sin(Math.PI * k) * 0.22 * Math.min(1, w.p0.distanceTo(w.p1) / 3);
      this.lookTarget = w.q0.clone().lerp(w.q1, k);
      cam.fov = lerp(w.f0, w.f1, k); cam.updateProjectionMatrix();
      cam.lookAt(this.lookTarget);
      if (w.t >= 1) { this.tween = null; w.done?.(); }
      return;
    }
    if (this.state === 'HOME' || this.state === 'CIRCLE') {
      if (this.orbit.auto) this.orbit.az += dt * 0.05;
      cam.position.copy(sph(this.orbit.target, this.orbit));
      this.lookTarget = this.orbit.target.clone();
      cam.lookAt(this.lookTarget);
    }
  }

  updateGlobe(dt, t) {
    const g = this.globe, p = this.globePose;
    const k = 1 - Math.pow(0.02, dt);
    g.position.y = lerp(g.position.y, p.y, k);
    g.scale.setScalar(lerp(g.scale.x, p.s, k));
    if (this.state === 'HOME' && !this.tween && !this.orbit.auto) {
      // Left alone where the user turned it.
    } else if (this.state === 'HOME' && !this.tween) {
      const v = this.latLngToVec(10, -6, 1);                  // West Africa
      const camAz = Math.atan2(this.camera.position.x - g.position.x, this.camera.position.z - g.position.z);
      this.earthTarget = camAz - Math.atan2(v.x, v.z) + Math.sin(t / 9000) * 0.35;
      let d = this.earthTarget - this.earth.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.earth.rotation.y += d * (1 - Math.pow(0.15, dt));
    } else if (this.earthTarget !== undefined && this.state === 'DIVE') {
      let d = this.earthTarget - this.earth.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.earth.rotation.y += d * (1 - Math.pow(0.001, dt));
    } else {
      this.earth.rotation.y += dt * (this.state === 'HOME' ? 0.06 : 0.04);
    }
    const pulse = 1 + 0.35 * Math.sin(t / 300);
    // Zoomed in close, markers shrink so neighbouring rhythms stay apart.
    const near = this.earthDetail && this.state === 'HOME' ? clamp(this.globeSurfaceDistance() / 1.6, 0.03, 1) : 1;
    for (const m of this.markers.children) m.scale.setScalar((m.userData.selected ? 1.8 * pulse : (m.userData.baseScale || 1)) * near);
    const target = this.state === 'HOME' || this.state === 'DIVE' ? 0.5 : this.state === 'FOCUS' ? 0.78 : 0.72;
    this.renderer.toneMappingExposure = lerp(this.renderer.toneMappingExposure, target, k * 0.6);
    this.key.intensity = lerp(this.key.intensity, this.state === 'FOCUS' ? 16 : 0, k);
    if (this.focus) {
      const f = this.focus;
      const aimY = f.kind === 'djembe' ? f.headPos.y : f.kind === 'dunun' ? f.top : 0.75;
      const aim = f.pos.clone().setY(aimY);
      const from = f.pos.clone().add(new THREE.Vector3(0, 3.0, 0)).addScaledVector(f.out, 0.7);
      const snap = this.key.intensity < 0.5 || this.keySeat !== f && !this.keySeat;
      const kk = snap ? 1 : 1 - Math.pow(0.0005, dt);
      this.key.position.lerp(from, kk);
      this.key.target.position.lerp(aim, kk);
      this.keySeat = f;
    } else this.keySeat = null;
    this.key.target.updateMatrixWorld();
  }

  // Rhythm names on the globe, as on the original map; overlapping names give way to nearer ones.
  placeLabels() {
    const show = this.state === 'HOME' && !this.tween;
    this.labels.classList.toggle('show', show);
    if (!show) return;
    const w = window.innerWidth, h = window.innerHeight;
    const camDir = this.camera.position.clone().sub(this.globe.position).normalize();
    const placed = [];
    const zoomedIn = !!this.earthDetail && this.globeSurfaceDistance() < 0.5;   // close up, library names show too
    const items = this.markers.children.map((m) => {
      const p = m.getWorldPosition(new THREE.Vector3());
      const facing = p.clone().sub(this.globe.position).normalize().dot(camDir);
      return { m, p, facing };
    }).sort((a, b) => (b.m.userData.selected - a.m.userData.selected) || (b.facing - a.facing));
    for (const { m, p, facing } of items) {
      const label = m.userData.label;
      if (m.userData.minor && !m.userData.selected && !zoomedIn) {
        if (label.style.opacity !== '0') { label.style.opacity = '0'; label.style.pointerEvents = 'none'; }
        continue;
      }
      const v = p.clone().project(this.camera);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      const lw = label.textContent.length * 9 + 12, lh = 22;
      const box = { x0: x - lw / 2, x1: x + lw / 2, y0: y - 30, y1: y - 30 + lh };
      const clash = placed.some((b) => !(box.x1 < b.x0 || b.x1 < box.x0 || box.y1 < b.y0 || b.y1 < box.y0));
      const visible = facing > 0.25 && (!clash || m.userData.selected);
      label.style.opacity = visible ? String(clamp((facing - 0.25) * 4, 0, 1)) : '0';
      label.style.pointerEvents = visible ? 'auto' : 'none';
      if (visible) { placed.push(box); label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -130%)`; }
    }
  }

  // Phones: while in a session, keep exactly the seated instrument soloed (checked once a second).
  updateAutoSolo() {
    if (!PAD_ONLY || !this.autoSolo) return;
    const now = performance.now();
    if (now - (this.autoSoloCheckedAt || 0) < 1000) return;
    this.autoSoloCheckedAt = now;
    const st = sessionInfo();
    const bridge = window._notationBridge;
    const send = (ids, soloed) => { if (ids.length) try { bridge?.postMain?.({ type: 'setInstrumentMix', ids, soloed }); } catch {} };
    if (!st.active || this.state !== 'FOCUS' || !this.focus) {
      if (!st.active && this.autoSoloIds.length) { send(this.autoSoloIds, false); this.autoSoloIds = []; }
      return;
    }
    const want = this.seatParts(this.focus).map((p) => p.id);
    const key = want.join(',');
    if (key === this.autoSoloIds.join(',') && this.seatParts(this.focus).every((p) => p.soloed === true)) return;
    const stale = this.autoSoloIds.filter((id) => !want.includes(id));
    send(stale, false);
    send(want, true);
    this.autoSoloIds = want;
    for (const seat of this.seats) for (const p of this.seatParts(seat)) p.soloed = want.includes(p.id);
    this.syncMixButtons();
  }

  updateCountdown() {
    const st = sessionInfo();
    const left = st.active ? (Number(st.pendingStartAt) || 0) - Date.now() : 0;
    const show = left > 0 && left < 10000;
    if (this.countdown.hidden === show) this.countdown.hidden = !show;
    if (!show) { this.countdownShown = 0; return; }
    const n = Math.max(1, Math.ceil(left / 1000));
    if (n === this.countdownShown) return;
    this.countdownShown = n;
    const callIn = st.pendingStartAction === 'call_in';
    this.countdown.firstChild.textContent = `${st.role === 'leader' ? 'Starting' : 'Leader starting'}${callIn ? ' the call' : ''}`;
    const num = this.countdown.lastChild;
    num.textContent = String(n);
    num.classList.remove('tick'); void num.offsetWidth; num.classList.add('tick');
  }

  updateSeats(dt) {
    const pos = this.cyclePosition();
    const now = performance.now();
    const stepNow = pos >= 0 ? Math.floor(pos) : -1;
    for (const seat of this.seats) {
      const fx = seat.fx;
      const focused = this.state === 'FOCUS' && seat === this.focus;
      const hovered = this.hover === seat && this.state === 'CIRCLE';
      fx.flash = Math.max(0, fx.flash - dt * (fx.muted ? 11 : 3.2)); fx.shake = Math.max(0, fx.shake - dt * 5);
      if (seat.kind === 'dunun') this.paintDrumSkin(seat, now);
      if (seat.kind === 'shekere' && seat.parts.head) {
        seat.parts.head.material.emissive.copy(fx.color);
        seat.parts.head.material.emissiveIntensity = fx.flash * fx.flash * (fx.muted ? 0.35 : 0.75);
      }
      if (seat.bellRig) {                                       // warm glow held, then faded; a small rock on the cord
        const fb = this.feedback.bell, age = now - fx.bellAt, k = reaction(age, fb);
        seat.bellRig.outer.emissiveIntensity = k * 0.55;
        const ring = age >= 0 && age < reactionSpan(fb) ? Math.max(0, 1 - age / reactionSpan(fb)) : 0;
        // a small rock on the cord
        seat.bellRig.swing.rotation.x = ring > 0 ? Math.sin(age / 1000 * 26) * 0.05 * ring * Math.min(1, fb.intensity * 1.6) : 0;
      }
      if (seat.parts.gourd) {
        const g = seat.parts.gourd;
        g.rotation.copy(g.userData.rest); g.rotation.z += Math.sin(fx.shake * 24) * 0.18 * fx.shake;
      }
      seat.ring.material.opacity = lerp(seat.ring.material.opacity, focused ? 0.75 : hovered ? 0.55 : 0, 0.2);
      seat.label.material.opacity = lerp(seat.label.material.opacity, this.state === 'CIRCLE' ? 1 : 0, 0.15);
      seat.label.visible = this.state === 'CIRCLE';

      if (seat.kind === 'djembe') {
        this.paintSkin(seat, now);
        const m = seat.dialMesh.material;
        m.opacity = lerp(m.opacity, focused && this.djembeView === 'ring' ? 1 : 0, 0.14);
        seat.dialMesh.visible = m.opacity > 0.02;
        const dialStep = pos >= 0 ? Math.floor(pos) : -1;
        if (seat.dialMesh.visible && (seat.notationDirty || seat.dialStep !== dialStep)) {
          this.paintDial(seat, pos); seat.notationDirty = false; seat.dialStep = dialStep;
          if (dialStep >= 0) {                                   // sweep takes the colour of the current beat
            const { sub } = this.steps(), colors = beatColors();
            const col = colors[Math.floor(dialStep / sub) % colors.length];
            seat.sweepWedge.material.color.set(col); seat.sweepLine.material.color.set(col);
          }
        }
        seat.sweep.visible = seat.dialMesh.visible && pos >= 0;
        if (seat.sweep.visible) {
          const { total } = this.steps();
          seat.sweep.rotation.z = -(-Math.PI / 2 + (pos / total) * Math.PI * 2);
          seat.sweepWedge.material.opacity = 0.22 * m.opacity; seat.sweepLine.material.opacity = m.opacity;
        }
      }
      if (focused && !this.lineCanvas.hidden && (seat.notationDirty || seat.lineStep !== stepNow)) {
        this.paintLine(seat, pos); seat.notationDirty = false; seat.lineStep = stepNow;
      }
    }
  }
}

// ---------------------------------------------------------------- helpers
let qrLib = null;
function drawQrCodes(root) {
  qrLib ||= new Promise((res, rej) => {
    if (window.QRCode) { res(window.QRCode); return; }
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    sc.onload = () => res(window.QRCode); sc.onerror = rej;
    document.head.append(sc);
  });
  qrLib.then((QR) => {
    root.querySelectorAll('.room-qr[data-url]').forEach((box) => {
      box.innerHTML = '';
      new QR(box, { text: box.dataset.url, width: 360, height: 360, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QR.CorrectLevel.L });
    });
  }).catch(() => root.querySelectorAll('.room-qr').forEach((b) => { b.textContent = 'QR unavailable'; }));
}

function sph(target, o) {
  return new THREE.Vector3(target.x + o.r * Math.sin(o.pol) * Math.sin(o.az), target.y + o.r * Math.cos(o.pol), target.z + o.r * Math.sin(o.pol) * Math.cos(o.az));
}
function isOpen(el) { return !!el && !el.classList.contains('hidden') && !el.classList.contains('panel-hidden'); }
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || '').trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
let softDiscTex = null;
function softDisc() {
  if (softDiscTex) return softDiscTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.6, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  softDiscTex = new THREE.CanvasTexture(c);
  return softDiscTex;
}

{
  if (PAD_ONLY) document.documentElement.classList.add('rrc-room-pads');
  const start = () => {
    try { window.rrcRoom = new Room(); }
    finally { document.documentElement.classList.remove('rrc-room-boot'); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

// Folded iron bell, mouth at y = 0, closed shoulder at y = H. Faces along ±Z, the folded seam on the +X side
// is left slightly open, the way hand-folded kenken are.
function bellGeometry(H, W) {
  const D = W * 0.46, NA = 44, NY = 22, slit = 0.34, sh = 0.83;
  const pos = [], uv = [], idx = [];
  const jitter = (i, j) => { const n = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; return (n - Math.floor(n)) - 0.5; };
  for (let j = 0; j <= NY; j++) {
    const t = j / NY, y = t * H, ts = Math.min(t, sh) / sh;
    let w = lerp(W, W * 0.66, ts) / 2;
    let d = lerp(D, D * 0.62, ts) / 2 * (1 + 0.1 * Math.sin(Math.PI * ts));   // hammered belly
    if (t > sh) {                                                           // plates pressed together over a round shoulder
      const u = (t - sh) / (1 - sh);
      w *= Math.sqrt(Math.max(0, 1 - 0.5 * u * u));
      d *= Math.cos(u * Math.PI / 2);
    }
    if (t < 0.06) { const l = 1 - t / 0.06; w *= 1 + 0.025 * l; d *= 1 + 0.06 * l; }   // slight lip at the mouth
    for (let i = 0; i <= NA; i++) {
      const a = slit / 2 + (Math.PI * 2 - slit) * (i / NA);
      const sa = Math.sin(a), n = 1 + 0.018 * jitter(i, j) * (t < sh ? 1 : 0);
      pos.push(w * Math.cos(a) * n, y, d * Math.sign(sa) * Math.pow(Math.abs(sa), 1.15) * n);
      uv.push(i / NA, t);
    }
  }
  const row = NA + 1;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NA; i++) {
    const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Dark forged iron: hammer marks, pale wear and rust freckles, a darker band near the mouth.
let ironTex = null;
function ironTexture() {
  if (ironTex) return ironTex;
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const base = g.createLinearGradient(0, S, 0, 0);
  base.addColorStop(0, '#4e3d31'); base.addColorStop(0.1, '#3a332e'); base.addColorStop(0.2, '#6a625a'); base.addColorStop(1, '#6f675e');
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  for (let k = 0; k < 140; k++) {                               // hammer facets
    const x = rnd() * S, y = rnd() * S, r = 6 + rnd() * 14;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() > 0.5;
    gr.addColorStop(0, light ? 'rgba(150,140,128,0.28)' : 'rgba(30,26,22,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r * 1.4, r, rnd() * Math.PI, 0, Math.PI * 2); g.fill();
  }
  for (let k = 0; k < 520; k++) {                               // freckles: rust and worn spots
    const x = rnd() * S, y = rnd() * S, r = 0.6 + rnd() * 1.8, p = rnd();
    g.fillStyle = p < 0.55 ? `rgba(122,84,48,${0.35 + rnd() * 0.4})` : p < 0.8 ? `rgba(160,150,135,${0.2 + rnd() * 0.3})` : `rgba(14,12,10,${0.4 + rnd() * 0.3})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  ironTex = new THREE.CanvasTexture(c);
  ironTex.colorSpace = THREE.SRGBColorSpace;
  ironTex.wrapS = ironTex.wrapT = THREE.RepeatWrapping;
  return ironTex;
}
