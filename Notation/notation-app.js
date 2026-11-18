// State
let state = {
    rhythmName: 'Kassa',
    beats: 4,
    subdivisions: 4,
    tempo: 100,
    viewMode: 'linear', // 'linear' or 'circular'
    compactMode: false,
    compactInstrumentPanelOpen: true,
    circularInstrumentIndex: 0,
    // Swing per beat position (A=1st, B=2nd, C=3rd, D=4th subdivision within each beat)
    // Values -50 to +50, internally +20 is added so 15 feels like 35
    swing: {
        factor: 100, // Overall swing intensity (in debug settings)
        A: 0,        // 1st subdivision (downbeat) - no swing
        B: 15,       // 2nd subdivision - delay
        C: 0,        // 3rd subdivision - no swing
        D: 15        // 4th subdivision - delay
    },
    currentSound: 'slap',
    cycleMode: false, // Legacy cycle mode retained only for backward compatibility
    rapidCycleEnabled: true, // Rapid repeat tap cycles articulations
    themeColor: '#fcd116', // For player color theming (yellow)
    isPlaying: false,
    playbackInterval: null,
    playbackTimeout: null,
    currentStep: 0,
    _lastPlayedStep: 0,
    _playbackRunId: 0,
    isDragging: false, // For drag-to-fill functionality
    dragMode: null, // 'write' | 'clear'
    dragWriteSound: null, // locked articulation during drag-write when needed
    lastGridClickKey: '',
    lastGridClickTime: 0,
    instruments: [
        { id: 'call1', name: 'Call', icon: '📣', type: 'djembe_solo', sampleSet: 'Solo', pattern: [], visible: false, muted: false, volume: 0, soloed: false, pan: 0, focused: false, isCall: true },
        { id: 'djembe1', name: 'Djembe 1', icon: '🥁', type: 'djembe', sampleSet: 'One', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'djembe2', name: 'Djembe 2', icon: '🥁', type: 'djembe', sampleSet: 'Two', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'djembe3', name: 'Djembe 3', icon: '🥁', type: 'djembe', sampleSet: 'Three', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'kenkeni1', name: 'Kenkeni', icon: '🪘', type: 'kenkeni', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'kenkeni_bell1', name: 'Kenkeni Bell', icon: '🔔', type: 'kenkeni_bell', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'sangban1', name: 'Sangban', icon: '🪘', type: 'sangban', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'sangban_bell1', name: 'Sangban Bell', icon: '🔔', type: 'sangban_bell', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'doundoun1', name: 'Doundoun', icon: '🪘', type: 'doundoun', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false },
        { id: 'doundoun_bell1', name: 'Doundoun Bell', icon: '🔔', type: 'doundoun_bell', sampleSet: 'default', pattern: [], visible: true, muted: false, volume: 1.0, soloed: false, pan: 0, focused: false }
    ]
};

let sessionControlRole = 'none';
let sessionControlFreeMode = false;
let touchSuppressMouseUntil = 0;
let touchPointerId = null;
let touchHoldTimer = null;
let touchHoldActive = false;
let touchHoldLastKey = '';
let touchHoldStart = null;
const TOUCH_HOLD_ERASE_MS_DEFAULT = 420;
const RAPID_CYCLE_WINDOW_MS_DEFAULT = 500;
let mouseLeftDown = false;
let mouseHoldEraseTimer = null;
let mouseHoldStart = null;
// Call In pickup: how many steps before the end of the call bar the other voices come in.
// Until it is set by hand it is a two-cell pickup.
const CALL_IN_STEP_STORAGE_KEY = 'notationCallInStepOffsetV2';
let callInStepOffset = parseInt(localStorage.getItem(CALL_IN_STEP_STORAGE_KEY), 10);
if (!Number.isFinite(callInStepOffset) || callInStepOffset < 1) callInStepOffset = null;
let callInSequenceState = null;
let callOutSequenceState = null;
let lastPostedCallStateKey = '';
let availableRhythmCatalog = [];
let selectedRhythmCatalogKey = '';
let selectedRhythmCatalogName = '';
let suppressDropdownSync = false;

const circularOnlyMode = new URLSearchParams(window.location.search).get('circularOnly') === '1';
let lastLoadRhythmRequestKey = '';
let lastLoadRhythmRequestAt = 0;
const loadRhythmInflightByName = new Map();

// Transport diagnostics (ring-buffer logger for timing/debug reports)
const transportDiag = (() => {
    const enabledDefault = String(localStorage.getItem('rrcTransportDiag') || '1').trim() !== '0';
    const verboseDefault = String(localStorage.getItem('rrcTransportDiagVerbose') || '0').trim() === '1';
    let enabled = enabledDefault;
    let verbose = verboseDefault;
    const max = 1200;
    const logs = [];
    const push = (level, event, payload = {}) => {
        if (!enabled) return;
        const entry = {
            ts: Date.now(),
            perf: Math.round(performance.now() * 1000) / 1000,
            level: String(level || 'info'),
            event: String(event || 'event'),
            payload: payload && typeof payload === 'object' ? payload : { value: payload }
        };
        logs.push(entry);
        if (logs.length > max) logs.splice(0, logs.length - max);
        if (verbose || level === 'warn' || level === 'error') {
            try { console[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')]('[TransportDiag]', event, payload); } catch {}
        }
    };
    const snapshot = () => ({
        at: new Date().toISOString(),
        enabled,
        verbose,
        location: window.location.href,
        state: {
            isPlaying: !!state?.isPlaying,
            runId: parseInt(state?._playbackRunId, 10) || 0,
            stepCounter: parseInt(state?._playbackStepCounter, 10) || 0,
            currentStep: parseInt(state?.currentStep, 10) || 0,
            tempo: parseInt(state?.tempo, 10) || 0,
            beats: parseInt(state?.beats, 10) || 0,
            subdivisions: parseInt(state?.subdivisions, 10) || 0,
            anchorEpoch: Number(state?._playbackAnchorEpoch) || 0,
            lastStepEpoch: Number(state?._lastStepEpoch) || 0
        },
        logs: logs.slice()
    });
    const api = {
        push,
        getLogs: () => logs.slice(),
        clear: () => { logs.length = 0; },
        setEnabled: (next) => {
            enabled = !!next;
            localStorage.setItem('rrcTransportDiag', enabled ? '1' : '0');
            push('info', 'diag_enabled_changed', { enabled });
        },
        setVerbose: (next) => {
            verbose = !!next;
            localStorage.setItem('rrcTransportDiagVerbose', verbose ? '1' : '0');
            push('info', 'diag_verbose_changed', { verbose });
        },
        isEnabled: () => enabled,
        isVerbose: () => verbose,
        exportReport: () => JSON.stringify(snapshot(), null, 2)
    };
    return api;
})();

window.__rrcTransportDiag = transportDiag;

// Audio samples cache - organized by instrument type and sample set
const audioSamples = {};
let audioSamplesLoaded = false;
let audioSamplesLoadPromise = null;
let audioEnginePrimed = false;
let audioPrimePromise = null;
let transportPrimeLeadMs = parseFloat(localStorage.getItem('notationPrimeLeadMs'));
transportPrimeLeadMs = Number.isFinite(transportPrimeLeadMs) ? Math.max(0, Math.min(300, transportPrimeLeadMs)) : 50;
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
let audioContext = null;
try {
    audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
} catch (err) {
    audioContext = new AudioContextCtor();
}

// ── Transport timing core ───────────────────────────────────────────────
// Steps are scheduled ahead of time on the AudioContext clock. A ticker wakes up every
// SCHED_TICK_MS and hands every step that falls inside the look-ahead window to the audio
// engine with an exact start time, so timer jitter never reaches the sound. Visual updates
// for a step are deferred until the moment that step is heard.
// The transport still runs on wall-clock epochs (anchorEpoch), so session sync is unchanged.
const SCHED_TICK_MS = 25;
// Phones and tablets get a longer look-ahead: their main thread stalls longer (rendering, touch, network),
// and a note queued on the audio clock plays on time however late the next scheduler tick is.
const SCHED_LOOKAHEAD_MS = (() => {
    try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 200 : 120; } catch { return 120; }
})();
const SCHED_LOOKAHEAD_HIDDEN_MS = 500;
const SCHED_LOOKAHEAD_MAX_MS = 600;
// Output-latency compensation shifts notes earlier by the latency the device reports. Phones and tablets
// tend to over-report it, which made them play early, so it is off there.
const SCHED_MAX_LATENCY_COMP_S = (() => {
    try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 0 : 0.25; } catch { return 0.25; }
})();
let schedWhen = null;            // audio time for sounds triggered while a step is being scheduled
let schedGeneration = 0;         // bumps whenever already-scheduled steps become invalid
let schedCallOutEnd = null; // final downbeat scheduled, waiting for its last stroke
let schedNextEpoch = null;       // epoch of the next unscheduled step under the plan that scheduled the last one
let schedStallMs = 0;
let schedLastTickPerf = 0;
let schedWallOffset = null;      // Date.now() - performance.now(), smoothed
let schedAudioOffset = null;     // audio-clock seconds minus performance seconds, smoothed
// Per-device timing trim set from the room's Session sheet: positive plays later, negative earlier.
let userTimingOffsetMs = 0;
const scheduledSources = new Set();
const transportStats = { scheduled: 0, late: 0, skipped: 0, maxTickGapMs: 0, worstLateMs: 0 };
window.__rrcTransportStats = transportStats;

// Monotonic "now" in the same epoch domain as Date.now() (which the session layer uses).
function transportEpochNow() {
    const sample = Date.now() - performance.now();
    if (schedWallOffset === null || Math.abs(sample - schedWallOffset) > 50) schedWallOffset = sample;
    else schedWallOffset += (sample - schedWallOffset) * 0.02;
    return performance.now() + schedWallOffset;
}

// Audio-clock time at which a sound must start to be HEARD at the given epoch.
function audioTimeForEpoch(epochMs) {
    const perfMs = epochMs - (schedWallOffset === null ? (Date.now() - performance.now()) : schedWallOffset);
    const plain = audioContext.currentTime - (performance.now() / 1000);
    let sample = plain;
    let comp = 0;
    if (typeof audioContext.getOutputTimestamp === 'function') {
        const ts = audioContext.getOutputTimestamp();
        if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
            comp = plain - (ts.contextTime - (ts.performanceTime / 1000));
        }
    }
    if (!(comp > 0)) comp = (audioContext.baseLatency || 0) + (audioContext.outputLatency || 0);
    sample = plain + Math.max(0, Math.min(SCHED_MAX_LATENCY_COMP_S, comp));
    // The clock pair is quantized to render blocks: smooth it, but follow real jumps.
    if (schedAudioOffset === null || Math.abs(sample - schedAudioOffset) > 0.02) schedAudioOffset = sample;
    else schedAudioOffset += (sample - schedAudioOffset) * 0.05;
    return (perfMs / 1000) + schedAudioOffset + (userTimingOffsetMs / 1000);
}

function transportLookaheadMs() {
    const base = document.hidden ? SCHED_LOOKAHEAD_HIDDEN_MS : SCHED_LOOKAHEAD_MS;
    const latencyMs = Math.min(SCHED_MAX_LATENCY_COMP_S, (audioContext.baseLatency || 0) + (audioContext.outputLatency || 0)) * 1000;
    return Math.min(SCHED_LOOKAHEAD_MAX_MS, Math.max(base, schedStallMs * 1.5)) + latencyMs;
}

function trackScheduledSource(source, when) {
    if (!(when > audioContext.currentTime + 0.005)) return;
    const entry = { source, when };
    scheduledSources.add(entry);
    source.addEventListener('ended', () => scheduledSources.delete(entry));
}

// Drop notes that were scheduled but have not started yet (stop, re-sync).
function cancelScheduledAudio() {
    const now = audioContext.currentTime;
    scheduledSources.forEach((entry) => {
        if (entry.when > now) {
            try { entry.source.stop(); } catch {}
        }
    });
    scheduledSources.clear();
}

// Worker timers keep their rate in background tabs, where window timers drop to 1/s.
const schedTicker = (() => {
    let worker = null;
    let interval = null;
    let handler = null;
    try {
        const src = `let id=null;onmessage=(e)=>{if(e.data==='start'){if(id===null)id=setInterval(()=>postMessage(0),${SCHED_TICK_MS});}else{clearInterval(id);id=null;}};`;
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = () => { if (handler) handler(); };
    } catch { worker = null; }
    return {
        kind: worker ? 'worker' : 'interval',
        start(fn) {
            handler = fn;
            if (worker) worker.postMessage('start');
            else if (interval === null) interval = setInterval(() => { if (handler) handler(); }, SCHED_TICK_MS);
        },
        stop() {
            handler = null;
            if (worker) worker.postMessage('stop');
            if (interval !== null) { clearInterval(interval); interval = null; }
        }
    };
})();

function ensureInlineUiFeedback() {
    if (window.__notationUiFeedback) return window.__notationUiFeedback;

    const root = document.createElement('div');
    root.className = 'notation-ui-feedback-root';
    const stack = document.createElement('div');
    stack.className = 'notation-ui-feedback-stack';
    root.appendChild(stack);
    document.body.appendChild(root);

    const toast = (message, tone = 'info', timeoutMs = 2200) => {
        const text = String(message || '').trim();
        if (!text) return;
        const item = document.createElement('div');
        item.className = `notation-ui-toast ${tone}`.trim();
        item.textContent = text;
        stack.appendChild(item);
        setTimeout(() => {
            if (item.parentNode) item.parentNode.removeChild(item);
        }, Math.max(1000, timeoutMs));
    };

    const dialog = ({ title = 'Message', message = '', mode = 'alert' } = {}) => {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'notation-ui-dialog-overlay';
            const card = document.createElement('div');
            card.className = 'notation-ui-dialog-card';
            overlay.appendChild(card);
            const titleEl = document.createElement('h4');
            titleEl.className = 'notation-ui-dialog-title';
            titleEl.textContent = title;
            card.appendChild(titleEl);
            const messageEl = document.createElement('div');
            messageEl.className = 'notation-ui-dialog-message';
            messageEl.textContent = String(message || '');
            card.appendChild(messageEl);
            const actions = document.createElement('div');
            actions.className = 'notation-ui-dialog-actions';
            card.appendChild(actions);

            const close = (value) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(value);
            };

            if (mode === 'confirm') {
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', () => close(false));
                actions.appendChild(cancelBtn);
            }
            const okBtn = document.createElement('button');
            okBtn.className = 'btn';
            okBtn.textContent = 'OK';
            okBtn.addEventListener('click', () => close(mode === 'confirm' ? true : true));
            actions.appendChild(okBtn);

            overlay.addEventListener('click', (e) => {
                if (e.target !== overlay) return;
                close(mode === 'confirm' ? false : true);
            });
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') close(mode === 'confirm' ? false : true);
                if (e.key === 'Enter') close(mode === 'confirm' ? true : true);
            });

            document.body.appendChild(overlay);
            okBtn.focus();
        });
    };

    window.__notationUiFeedback = {
        toast,
        alert: (message, title = 'Message') => dialog({ title, message, mode: 'alert' }),
        confirm: (message, title = 'Confirm') => dialog({ title, message, mode: 'confirm' })
    };
    return window.__notationUiFeedback;
}

function getSharedTooltipTypeSpeed() {
    const raw = parseInt(localStorage.getItem('tooltipTypeSpeed'), 10);
    if (!Number.isFinite(raw)) return 11;
    return Math.max(4, Math.min(80, raw));
}

function getSharedTooltipHoverDelayMs() {
    const raw = parseInt(localStorage.getItem('tooltipHoverDelayMs'), 10);
    if (!Number.isFinite(raw)) return 500;
    return Math.max(0, Math.min(3000, raw));
}

function getSharedTooltipWindowScale() {
    const raw = parseFloat(localStorage.getItem('tooltipWindowScale'));
    if (!Number.isFinite(raw)) return 1.15;
    return Math.max(0.6, Math.min(2.6, raw));
}

function getSharedTooltipTextScale() {
    const raw = parseFloat(localStorage.getItem('tooltipTextScale'));
    if (!Number.isFinite(raw)) return 1.15;
    return Math.max(0.6, Math.min(2.6, raw));
}

function isTooltipTouchMode() {
    try {
        return window.matchMedia('(hover: none), (pointer: coarse)').matches || ('ontouchstart' in window);
    } catch {
        return true;
    }
}

function shouldHideHintOnUnhoverDesktop() {
    if (isTooltipTouchMode()) return false;
    return localStorage.getItem('tooltipHideOnUnhover') === 'true';
}

const SHARED_HINT_MESSAGES_STORAGE_KEY = 'rrcHintMessagesV1';
const DEFAULT_NOTATION_HINT_MESSAGES = Object.freeze({
    'notation-cycle-help': [
        'GRID INPUT',
        '',
        'Tap: write selected articulation.',
        'Fast repeat tap (same box): cycle articulations.',
        'Cycle now updates active articulation buttons too.',
        'Drag: paint with current articulation.',
        'Hold (mouse/touch): write silence.',
        'Hold + drag: erase multiple boxes.'
    ].join('\n'),
    'notation-grid-help': [
        'GRID SIZE HELP',
        '',
        'Beats controls groups across the row.',
        'Subdivisions controls boxes inside each beat.',
        'Increase to add steps, decrease to remove visible steps.',
        'Export after major grid edits to save your structure.'
    ].join('\n')
});

function getSharedHintMessage(key) {
    const defaultText = DEFAULT_NOTATION_HINT_MESSAGES[key] || '';
    try {
        const raw = localStorage.getItem(SHARED_HINT_MESSAGES_STORAGE_KEY);
        if (!raw) return defaultText;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return defaultText;
        const value = String(parsed[key] || '');
        return value.trim().length > 0 ? value : defaultText;
    } catch {
        return defaultText;
    }
}

function ensureNotationHintPopup() {
    if (window.__notationHintPopup) return window.__notationHintPopup;

    const popup = document.createElement('div');
    popup.className = 'notation-typed-tooltip';
    popup.style.display = 'none';
    document.body.appendChild(popup);

    let typeTimer = null;
    const clearTimers = () => {
        if (typeTimer) {
            clearInterval(typeTimer);
            typeTimer = null;
        }
    };

    const hide = () => {
        clearTimers();
        popup.style.display = 'none';
        popup.textContent = '';
    };

    const show = (anchor, text) => {
        clearTimers();
        const message = String(text || '').trim();
        if (!message) return;
        const rect = anchor?.getBoundingClientRect?.() || { left: 12, top: 12, bottom: 28, width: 0 };
        const popupScale = getSharedTooltipWindowScale();
        const textScale = getSharedTooltipTextScale();
        popup.style.setProperty('--tooltip-window-scale', popupScale.toFixed(3));
        popup.style.setProperty('--tooltip-text-scale', textScale.toFixed(3));
        popup.style.display = 'block';
        popup.textContent = '';
        popup.style.left = '12px';
        popup.style.top = '12px';

        const maxWidth = Math.min(560, Math.max(180, Math.round(360 * popupScale), window.innerWidth - 24));
        const left = Math.max(8, Math.min(window.innerWidth - maxWidth - 8, rect.left - 6));
        const measuredHeight = Math.max(46, popup.getBoundingClientRect().height || 0);
        const preferredTop = rect.top - 12;
        const belowTop = rect.bottom + 8;
        const useAbove = preferredTop - measuredHeight > 8;
        popup.style.left = `${left}px`;
        popup.style.top = `${Math.max(8, useAbove ? preferredTop - measuredHeight : belowTop)}px`;

        let idx = 0;
        const typeSpeed = getSharedTooltipTypeSpeed();
        typeTimer = setInterval(() => {
            idx += 1;
            popup.textContent = message.slice(0, idx);
            if (idx >= message.length) {
                clearInterval(typeTimer);
                typeTimer = null;
            }
        }, typeSpeed);
    };

    popup.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hide();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hide();
    });

    window.__notationHintPopup = { show, hide };
    return window.__notationHintPopup;
}

// Round-robin state for each instrument/sound combination
const roundRobinState = {};

// Djembe sample sets (internal - not exposed to user)
const djembeSampleSets = ['One', 'Two', 'Three', 'Five', 'Six', 'Seven', 'Solo'];
let djembeCounter = 0;
const GRID_VIEWPORT_HEIGHT_STORAGE_KEY = 'notationGridViewportHeightByMode';
let gridViewportResizeState = null;
let autoScaleGridRaf = null;
let autoScaleGridTimeout = null;
let gridAutoScaleListenersBound = false;

// Available instrument types
const instrumentTypes = {
    djembe: {
        name: 'Djembe',
        icon: '🥁',
        articulations: ['slap', 'tone', 'bass', 'mute', 'silence'],
        sounds: {
            slap: { file: 'Slap', hasL: true },
            tone: { file: 'Open', hasL: true },
            bass: { file: 'Bass', hasL: true },
            mute: { file: 'Mute', hasL: true }
        }
    },
    kenkeni: {
        name: 'Kenkeni',
        icon: '🪘',
        articulations: ['tone', 'mute', 'silence'],
        sounds: {
            tone: { file: 'Open', hasL: false },
            mute: { file: 'Muffled', hasL: false }
        }
    },
    kenkeni_bell: {
        name: 'Kenkeni Bell',
        icon: '🔔',
        articulations: ['slap', 'silence'],
        sounds: {
            slap: { file: 'Bell_Open', hasL: false }
        }
    },
    sangban: {
        name: 'Sangban',
        icon: '🪘',
        articulations: ['tone', 'mute', 'silence'],
        sounds: {
            tone: { file: 'Open', hasL: false },
            mute: { file: 'Muffled', hasL: false }
        }
    },
    sangban_bell: {
        name: 'Sangban Bell',
        icon: '🔔',
        articulations: ['slap', 'silence'],
        sounds: {
            slap: { file: 'Bell_Open', hasL: false }
        }
    },
    doundoun: {
        name: 'Doundoun',
        icon: '🪘',
        articulations: ['tone', 'mute', 'silence'],
        sounds: {
            tone: { file: 'Open', hasL: false },
            mute: { file: 'Muffled', hasL: false }
        }
    },
    doundoun_bell: {
        name: 'Doundoun Bell',
        icon: '🔔',
        articulations: ['slap', 'silence'],
        sounds: {
            slap: { file: 'Bell_Open', hasL: false }
        }
    },
    shekere: {
        name: 'Shekere',
        icon: '🎶',
        articulations: ['slap', 'silence'],
        sounds: {
            slap: { file: 'B', hasL: false }
        }
    },
    djembe_solo: {
        name: 'Djembe Solo',
        icon: '📣',
        articulations: ['slap', 'tone', 'bass', 'mute', 'silence'],
        sampleSets: ['Solo'],
        sounds: {
            slap: { file: 'Slap', hasL: true },
            tone: { file: 'Open', hasL: true },
            bass: { file: 'Bass', hasL: true },
            mute: { file: 'Mute', hasL: true }
        }
    }
};

const INSTRUMENT_ICON_BASE = '../instrumentIcons/';
const INSTRUMENT_ICON_FILE_MAP = {
    call1: 'Call.png',
    djembe1: 'DjembeOne.png',
    djembe2: 'DjembeTwo.png',
    djembe3: 'DjembeThree.png',
    kenkeni1: 'Kenkeni.png',
    kenkeni_bell1: 'Kenkeni_Bell.png',
    sangban1: 'Sangban.png',
    sangban_bell1: 'Sangban_Bell.png',
    doundoun1: 'Doundoun.png',
    doundoun_bell1: 'DoundounBell.png',
    shekere1: 'Shekere.png'
};

function getInstrumentIconPath(instrument) {
    if (!instrument) return '';
    const id = String(instrument.id || '').trim();
    if (id && INSTRUMENT_ICON_FILE_MAP[id]) return INSTRUMENT_ICON_BASE + INSTRUMENT_ICON_FILE_MAP[id];
    const type = String(instrument.type || '').trim();
    if (type === 'djembe_solo') return INSTRUMENT_ICON_BASE + 'Call.png';
    if (type === 'djembe') {
        const sample = String(instrument.sampleSet || '').toLowerCase();
        if (sample === 'two') return INSTRUMENT_ICON_BASE + 'DjembeTwo.png';
        if (sample === 'three') return INSTRUMENT_ICON_BASE + 'DjembeThree.png';
        return INSTRUMENT_ICON_BASE + 'DjembeOne.png';
    }
    if (type === 'kenkeni') return INSTRUMENT_ICON_BASE + 'Kenkeni.png';
    if (type === 'kenkeni_bell') return INSTRUMENT_ICON_BASE + 'Kenkeni_Bell.png';
    if (type === 'sangban') return INSTRUMENT_ICON_BASE + 'Sangban.png';
    if (type === 'sangban_bell') return INSTRUMENT_ICON_BASE + 'Sangban_Bell.png';
    if (type === 'doundoun') return INSTRUMENT_ICON_BASE + 'Doundoun.png';
    if (type === 'doundoun_bell') return INSTRUMENT_ICON_BASE + 'DoundounBell.png';
    if (type === 'shekere') return INSTRUMENT_ICON_BASE + 'Shekere.png';
    return '';
}

function clampStageMinVolume(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0.1;
    return Math.max(0.05, Math.min(0.95, num));
}
let stageMinVolume = clampStageMinVolume(parseFloat(localStorage.getItem('stageMinVelocity')));
function clampStageMaxVolume(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.max(0.2, Math.min(1, num));
}
let stageMaxVolume = clampStageMaxVolume(parseFloat(localStorage.getItem('stageMaxVelocity')));
if (stageMaxVolume <= stageMinVolume) {
    stageMaxVolume = Math.min(1, stageMinVolume + 0.05);
}
const STAGE_DEFAULT_PAN_MIN = -0.5; // -25 on a -50..50 UI scale
const STAGE_DEFAULT_PAN_MAX = 0.5;  // +25 on a -50..50 UI scale

function clampStageNorm(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, Math.min(1, fallback));
    return Math.max(0, Math.min(1, n));
}

function parseStageNormOrNull(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
}

function volumeFromStageY(stageY) {
    const y = clampStageNorm(stageY, 0);
    const span = Math.max(0.0001, stageMaxVolume - stageMinVolume);
    return Math.max(stageMinVolume, Math.min(stageMaxVolume, stageMinVolume + (span * y)));
}

function stageYFromVolume(volumeValue) {
    const volume = Number(volumeValue);
    const span = Math.max(0.0001, stageMaxVolume - stageMinVolume);
    const clampedVolume = Number.isFinite(volume) ? Math.max(stageMinVolume, Math.min(stageMaxVolume, volume)) : stageMaxVolume;
    return Math.max(0, Math.min(1, (clampedVolume - stageMinVolume) / span));
}

function setStageMinVolume(value, options = {}) {
    stageMinVolume = clampStageMinVolume(value);
    if (stageMaxVolume <= stageMinVolume) {
        stageMaxVolume = Math.min(1, stageMinVolume + 0.05);
    }
    if (options.persist !== false) {
        localStorage.setItem('stageMinVelocity', String(stageMinVolume));
        localStorage.setItem('stageMaxVelocity', String(stageMaxVolume));
    }
    if (options.applyRuntime === false) return;
    let changed = false;
    state.instruments.forEach((instrument) => {
        const stageY = Number.isFinite(Number(instrument?.stageY))
            ? clampStageNorm(Number(instrument.stageY), 0)
            : stageYFromVolume(instrument?.volume ?? 1);
        const nextVolume = volumeFromStageY(stageY);
        if (Math.abs(nextVolume - (Number(instrument?.volume) || 0)) > 0.0001) {
            instrument.volume = nextVolume;
            changed = true;
        }
    });
    if (changed) {
        updateInstrumentToolbar();
        if (options.persist !== false) saveToLocalStorage();
        if (options.broadcast !== false) postRhythmStateToParent();
    }
}

function setStageVolumeRange(minValue, maxValue, options = {}) {
    const minV = clampStageMinVolume(minValue);
    const rawMax = clampStageMaxVolume(maxValue);
    stageMinVolume = minV;
    stageMaxVolume = Math.max(minV + 0.01, Math.min(1, rawMax));
    if (options.persist !== false) {
        localStorage.setItem('stageMinVelocity', String(stageMinVolume));
        localStorage.setItem('stageMaxVelocity', String(stageMaxVolume));
    }
    if (options.applyRuntime === false) return;
    let changed = false;
    state.instruments.forEach((instrument) => {
        const stageY = Number.isFinite(Number(instrument?.stageY))
            ? clampStageNorm(Number(instrument.stageY), 0)
            : stageYFromVolume(instrument?.volume ?? stageMaxVolume);
        const nextVolume = volumeFromStageY(stageY);
        if (Math.abs(nextVolume - (Number(instrument?.volume) || 0)) > 0.0001) {
            instrument.volume = nextVolume;
            changed = true;
        }
    });
    if (changed) {
        updateInstrumentToolbar();
        if (options.persist !== false) saveToLocalStorage();
        if (options.broadcast !== false) postRhythmStateToParent();
    }
}

function applyDefaultSoundStageLayout(options = {}) {
    const force = !!options.force;
    const playable = state.instruments.slice();
    if (!playable.length) return false;

    const hasAnyStageData = playable.some((instrument) => (
        Number.isFinite(Number(instrument?.stageX)) && Number.isFinite(Number(instrument?.stageY))
    ));
    if (!force && hasAnyStageData) return false;

    const count = playable.length;
    playable.forEach((instrument, idx) => {
        const ratio = count <= 1 ? 0.5 : (idx / (count - 1));
        const pan = STAGE_DEFAULT_PAN_MIN + ((STAGE_DEFAULT_PAN_MAX - STAGE_DEFAULT_PAN_MIN) * ratio);
        const x = (pan + 1) / 2;
        instrument.pan = Math.max(-1, Math.min(1, pan));
        instrument.stageX = clampStageNorm(x, 0.5);
        instrument.stageY = 1;
        instrument.volume = volumeFromStageY(1);
    });

    return true;
}

function resetSoundStageLayout() {
    const presetMinRaw = parseFloat(localStorage.getItem('stageMinVelocityPreset'));
    const presetMaxRaw = parseFloat(localStorage.getItem('stageMaxVelocityPreset'));
    let resetMin = clampStageMinVolume(Number.isFinite(presetMinRaw) ? presetMinRaw : stageMinVolume);
    let resetMax = clampStageMaxVolume(Number.isFinite(presetMaxRaw) ? presetMaxRaw : stageMaxVolume);
    if (resetMax <= resetMin) resetMax = Math.min(1, resetMin + 0.1);
    setStageVolumeRange(resetMin, resetMax, {
        persist: true,
        applyRuntime: false,
        broadcast: false
    });
    const changed = applyDefaultSoundStageLayout({ force: true });
    if (!changed) return;
    updateGrid();
    updateInstrumentToolbar();
    renderSoundStageTokens();
    saveToLocalStorage();
    postRhythmStateToParent();
}

function normalizeInstrumentRuntimeState() {
    state.instruments.forEach((instrument) => {
        instrument.soloed = !!instrument.soloed || !!instrument.focused;
        instrument.focused = false;
        if (String(instrument.type || '').toLowerCase() === 'shekere' && Array.isArray(instrument.pattern)) {
            instrument.pattern = instrument.pattern.map((step) => {
                const token = String(step || '').toLowerCase();
                if (token === 'slap') return 'slap';
                if (token === 'tone' || token === 'open') return 'slap';
                return 'silence';
            });
        }
        instrument.pan = Number.isFinite(Number(instrument.pan)) ? Math.max(-1, Math.min(1, Number(instrument.pan))) : 0;
        instrument.stageX = parseStageNormOrNull(instrument.stageX);
        instrument.stageY = parseStageNormOrNull(instrument.stageY);
    });

    applyDefaultSoundStageLayout({ force: false });

    state.instruments.forEach((instrument) => {
        if (!Number.isFinite(Number(instrument.stageX))) {
            const fallbackX = Number.isFinite(Number(instrument.pan)) ? ((instrument.pan + 1) / 2) : 0.5;
            instrument.stageX = clampStageNorm(fallbackX, 0.5);
        }
        if (!Number.isFinite(Number(instrument.stageY))) {
            instrument.stageY = stageYFromVolume(instrument.volume ?? 1);
        }
        if (!Number.isFinite(Number(instrument.pan))) {
            instrument.pan = Math.max(-1, Math.min(1, (instrument.stageX * 2) - 1));
        }
    });
}

// Get available articulations for an instrument
function getInstrumentArticulations(instrument) {
    const type = instrumentTypes[instrument.type || 'djembe'];
    return type ? type.articulations : ['slap', 'tone', 'bass', 'mute', 'silence'];
}

// Metronome state
let metronomeEnabled = false;
let metronomeVolume = 0.5;
let masterVolume = 1.0;
let masterMuted = false;

// Reverb setup
let reverbNode = null;
let reverbGain = null;
let dryGain = null;
let masterGain = null;

// Create impulse response for reverb
function createReverbImpulse(duration = 2, decay = 2) {
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * duration;
    const impulse = audioContext.createBuffer(2, length, sampleRate);

    for (let channel = 0; channel < 2; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return impulse;
}

// Initialize reverb
function initReverb() {
    reverbNode = audioContext.createConvolver();
    reverbNode.buffer = createReverbImpulse(2, 2);

    reverbGain = audioContext.createGain();
    reverbGain.gain.value = 0.1; // Default reverb amount

    dryGain = audioContext.createGain();
    dryGain.gain.value = 1.0;

    masterGain = audioContext.createGain();
    masterGain.gain.value = 1.0;

    // Connect reverb path
    reverbNode.connect(reverbGain);
    reverbGain.connect(masterGain);
    dryGain.connect(masterGain);
    masterGain.connect(audioContext.destination);
    applyMasterGain();
}

// Load audio samples
async function loadAudioSamples() {
    if (audioSamplesLoaded) return audioSamples;
    if (audioSamplesLoadPromise) return audioSamplesLoadPromise;
    audioSamplesLoadPromise = (async () => {
    const basePath = 'public/audio/';
    Object.keys(audioSamples).forEach((k) => delete audioSamples[k]);

    // All files are fetched and decoded in parallel. Each sample keeps its slot in the
    // round-robin list (main take first, then the L take), regardless of arrival order.
    const jobs = [];
    const loadInto = (list, slot, filename) => {
        jobs.push((async () => {
            try {
                const response = await fetch(basePath + filename);
                if (!response.ok) return;
                const arrayBuffer = await response.arrayBuffer();
                list[slot] = await audioContext.decodeAudioData(arrayBuffer);
            } catch (error) {
                console.warn(`Failed to load: ${filename}`, error);
            }
        })());
    };
    const lists = [];
    const newList = () => { const list = []; lists.push(list); return list; };

    // Djembe samples for all sample sets
    audioSamples['djembe'] = {};
    for (const setName of djembeSampleSets) {
        audioSamples['djembe'][setName] = {};
        for (const [soundName, soundInfo] of Object.entries(instrumentTypes.djembe.sounds)) {
            const list = audioSamples['djembe'][setName][soundName] = newList();
            loadInto(list, 0, `Djembe${setName}_${soundInfo.file}.mp3`);
            if (soundInfo.hasL) loadInto(list, 1, `Djembe${setName}_${soundInfo.file}L.mp3`);
        }
    }

    // Dunun family samples
    const dununTypes = [
        { id: 'kenkeni', prefix: 'Kenkeni' },
        { id: 'kenkeni_bell', prefix: 'Kenkeni', bellOnly: true },
        { id: 'sangban', prefix: 'Sangban' },
        { id: 'sangban_bell', prefix: 'Sangban', bellOnly: true },
        { id: 'doundoun', prefix: 'Doundoun' },
        { id: 'doundoun_bell', prefix: 'Doundoun', bellOnly: true }
    ];
    for (const dunun of dununTypes) {
        audioSamples[dunun.id] = { 'default': {} };
        const type = instrumentTypes[dunun.id];
        for (const [soundName, soundInfo] of Object.entries(type.sounds)) {
            const list = audioSamples[dunun.id]['default'][soundName] = newList();
            loadInto(list, 0, `${dunun.prefix}_${soundInfo.file}.mp3`);
        }
    }

    // Shekere samples (metronome + performance)
    audioSamples['shekere'] = { 'default': {} };
    const shekereTone = audioSamples['shekere']['default']['tone'] = newList();
    const shekereSlap = audioSamples['shekere']['default']['slap'] = newList();
    loadInto(shekereTone, 0, 'Shekere.mp3');
    loadInto(shekereSlap, 0, 'Shekere.mp3');
    loadInto(shekereSlap, 1, 'ShekereB.mp3');

    await Promise.all(jobs);
    // Remove slots whose file failed to load.
    lists.forEach((list) => {
        const kept = list.filter(Boolean);
        list.length = 0;
        kept.forEach((buffer) => list.push(buffer));
    });

    console.log('Audio samples loaded:', audioSamples);
    // Alias djembe_solo to djembe samples (uses same sounds, different sample sets)
    audioSamples['djembe_solo'] = audioSamples['djembe'];
    audioSamplesLoaded = true;
    return audioSamples;
    })();
    try {
        return await audioSamplesLoadPromise;
    } finally {
        if (audioSamplesLoaded) {
            audioSamplesLoadPromise = null;
        }
    }
}

function ensureAudioSamplesReady() {
    if (audioSamplesLoaded) return Promise.resolve(audioSamples);
    return loadAudioSamples();
}

async function primeAudioEngineForPlayback() {
    // Resume every time playback starts: iOS reports "interrupted" (not "suspended") and an earlier warm-up
    // outside a tap could not resume it, so "primed" alone does not mean the audio is running.
    if (audioContext && audioContext.state !== 'running') {
        try { await audioContext.resume(); } catch {}
    }
    if (audioEnginePrimed) return true;
    if (audioPrimePromise) return audioPrimePromise;
    audioPrimePromise = (async () => {
        if (audioContext.state === 'suspended') {
            try { await audioContext.resume(); } catch {}
        }
        await ensureAudioSamplesReady();
        if (!reverbNode) initReverb();
        // Touch the graph once so first real step is not penalized by lazy init.
        try {
            const buffer = audioContext.createBuffer(1, Math.max(1, Math.floor(audioContext.sampleRate * 0.002)), audioContext.sampleRate);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            const gain = audioContext.createGain();
            gain.gain.value = 0.0001;
            source.connect(gain);
            gain.connect(masterGain || audioContext.destination);
            source.start(audioContext.currentTime + 0.005);
            source.stop(audioContext.currentTime + 0.02);
        } catch {}
        // Give browser audio thread one frame to settle.
        await new Promise((resolve) => setTimeout(resolve, 16));
        audioEnginePrimed = true;
        return true;
    })();
    try {
        return await audioPrimePromise;
    } finally {
        audioPrimePromise = null;
    }
}

// Play a sound for a specific instrument
// Flams and rolls: pattern values like 'toneFlam' (grace and main the same stroke) or
// 'toneSlapFlam' (grace tone, main slap). A flam's grace note lands just before the main
// stroke; a roll is three quick strokes inside the step, the last one the main stroke.
const FLAM_GRACE_LEAD_SEC = 0.028;
function parseStroke(value) {
    const m = /^(tone|slap|bass|mute)(Tone|Slap|Bass|Mute)?(Flam|Roll)$/.exec(String(value || ''));
    if (!m) return null;
    return { grace: m[1], main: m[2] ? m[2].toLowerCase() : m[1], kind: m[3].toLowerCase() };
}

function playSound(soundType, instrument, volume = 1.0, options = {}) {
    const stroke = parseStroke(soundType);
    if (!stroke) { playSingleSound(soundType, instrument, volume, options); return; }
    const scheduled = Number.isFinite(options?.when) ? options.when : (schedWhen !== null ? schedWhen : null);
    const now = audioContext ? audioContext.currentTime : 0;
    if (stroke.kind === 'flam') {
        const mainAt = scheduled !== null ? scheduled : now + FLAM_GRACE_LEAD_SEC;
        playSingleSound(stroke.grace, instrument, volume * 0.55, { ...options, when: Math.max(now, mainAt - FLAM_GRACE_LEAD_SEC) });
        playSingleSound(stroke.main, instrument, volume, { ...options, when: mainAt });
        return;
    }
    const start = scheduled !== null ? scheduled : now;
    const stepSec = 60 / Math.max(20, parseFloat(state.tempo) || 100) / Math.max(1, parseInt(state.subdivisions, 10) || 4);
    for (let i = 0; i < 3; i++) {
        playSingleSound(i < 2 ? stroke.grace : stroke.main, instrument, volume * (i < 2 ? 0.7 : 1), { ...options, when: start + (i * stepSec) / 3 });
    }
}

function playSingleSound(soundType, instrument, volume = 1.0, options = {}) {
    // Resume audio context if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
    }

    // Initialize reverb if not done
    if (!reverbNode) {
        initReverb();
    }

    // Get instrument type and sample set
    const instType = instrument.type || 'djembe';
    const sampleSet = instrument.sampleSet || 'One';

    if (!audioSamplesLoaded) {
        ensureAudioSamplesReady().catch(() => {});
        return;
    }

    // Check if samples exist for this instrument
    if (!audioSamples[instType] || !audioSamples[instType][sampleSet]) {
        console.warn(`No samples for ${instType}/${sampleSet}`);
        return;
    }

    let samples = audioSamples[instType][sampleSet][soundType];
    if (!samples || samples.length === 0) {
        // Single-stroke instruments (bells) play their one sound for any stroke name,
        // so bell rows written as "tone"/"open" are not silent.
        const available = Object.keys(audioSamples[instType][sampleSet]).filter((k) => audioSamples[instType][sampleSet][k]?.length);
        if (available.length === 1) samples = audioSamples[instType][sampleSet][available[0]];
    }
    if (!samples || samples.length === 0) {
        console.warn(`No ${soundType} sample for ${instType}/${sampleSet}`);
        return;
    }

    // Round-robin selection
    const rrKey = `${instrument.id}_${soundType}`;
    if (!roundRobinState[rrKey]) {
        roundRobinState[rrKey] = 0;
    }
    const sampleIndex = roundRobinState[rrKey] % samples.length;
    roundRobinState[rrKey]++;

    const buffer = samples[sampleIndex];

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const baseGain = volume * (instrument.volume !== undefined ? instrument.volume : 1.0);
    const reverbMixRaw = parseFloat(options?.reverbMix);
    const reverbMix = Number.isFinite(reverbMixRaw) ? Math.max(0, Math.min(1, reverbMixRaw)) : 1.0;
    const drySend = audioContext.createGain();
    const wetSend = audioContext.createGain();
    const panValue = Number.isFinite(Number(instrument?.pan)) ? Math.max(-1, Math.min(1, Number(instrument.pan))) : 0;
    const panNode = (typeof audioContext.createStereoPanner === 'function')
        ? audioContext.createStereoPanner()
        : null;
    if (panNode) panNode.pan.value = panValue;
    drySend.gain.value = baseGain;
    wetSend.gain.value = baseGain * reverbMix;

    // Connect through pan, reverb and dry paths
    if (panNode) {
        source.connect(panNode);
        panNode.connect(drySend);
        panNode.connect(wetSend);
    } else {
        source.connect(drySend);
        source.connect(wetSend);
    }
    drySend.connect(dryGain);
    wetSend.connect(reverbNode);

    // Scheduled steps pass an exact audio-clock time; live hits (pads, clicks) play now.
    const when = Number.isFinite(options?.when) ? options.when : (schedWhen !== null ? schedWhen : 0);
    source.start(when);
    trackScheduledSource(source, when);
}

function warmupAudioContext() {
    if (!audioContext) return;
    if (audioContext.state !== 'running') {                    // "suspended", or "interrupted" on iOS
        audioContext.resume().catch(() => {});
    }
    if (!reverbNode) initReverb();
    ensureAudioSamplesReady().catch(() => {});
    try {
        const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        const gain = audioContext.createGain();
        gain.gain.value = 0.0001;
        source.connect(gain);
        gain.connect(masterGain || audioContext.destination);
        source.start(0);
        source.stop(audioContext.currentTime + 0.001);
    } catch {}
    audioEnginePrimed = true;
}

// Whether this player's audio is actually running (for the page around it to decide whether to wake it).
window.__rrcAudioRunning = () => !!audioContext && audioContext.state === 'running';

function tryUnlockAudioFromGesture() {
    if (!audioContext) return;
    if (audioContext.state === 'running') return;
    warmupAudioContext();
}

window.addEventListener('pointerdown', tryUnlockAudioFromGesture, { passive: true });
window.addEventListener('touchstart', tryUnlockAudioFromGesture, { passive: true });
window.addEventListener('mousedown', tryUnlockAudioFromGesture, { passive: true });
window.addEventListener('keydown', tryUnlockAudioFromGesture, { passive: true });

// Legacy playSound for simple use (backwards compatibility)
function playSoundSimple(soundType, volume = 1.0) {
    playSound(soundType, { id: 'default', type: 'djembe', sampleSet: 'One', volume: 1.0 }, volume);
}

// Update reverb amount
function setReverbAmount(amount) {
    if (reverbGain) {
        reverbGain.gain.value = amount;
    }
    // Adjust dry signal inversely (optional - keeps overall volume consistent)
    if (dryGain) {
        dryGain.gain.value = 1 - (amount * 0.5);
    }
}

function applyMasterGain() {
    if (!masterGain) return;
    const level = masterMuted ? 0 : Math.max(0, Math.min(1, Number(masterVolume) || 0));
    masterGain.gain.value = level;
}

// Debug settings
let debugSettings = {
    playheadGlow: 0.5,
    playheadBorder: 2,
    playheadPointer: 6,
    showPointer: true,
    showGlow: true,
    boxGrowth: 1.15,
    keepSize: false,
    playheadSeparation: 12,
    boxSize: 40,
    groupGap: 8,
    boxGap: 2,
    rowGap: 8,
    instrumentInfoWidth: 180,
    instrumentNameWidth: 80,
    reverbAmount: 0.1,
    useNeonArticulationStyle: true,
    disableResponsiveButtonSwap: false,
    openSymbolSize: 80, // percent
    beatNumberAlign: 0, // px
    toneOutlineWidth: 2, // px
    beatIndicatorHeight: 3, // px (border thickness for beat indicators)
    beatIndicatorOffset: 0, // px (y-offset to push border down)
    playbackBeatOffsetX: 0, // px (x offset for Beat label next to BPM)
    playbackBeatOffsetY: 0, // px (y offset for Beat label next to BPM)
    transportEmojiTint: '#ffffff', // hex color for beat/subdivision icon chip tint
    beatColors: [
        '#ce1126', '#ff8c00', '#fcd116', '#006b3f', // red, orange, yellow, green
        '#2196f3', '#9c27b0', '#e91e63', '#00bcd4', // blue, purple, pink, cyan
        '#009688', '#cddc39', '#673ab7', '#03a9f4'  // teal, lime, deep purple, light blue
    ],
    titleFontSize: 24, // px
    titleVisible: true,
    dialSyncOffset: 0, // ms offset for visual-to-audio sync in circular view
    smoothCircularArrow: true, // smooth or stepped radar pointer movement
    usePadBeatVisuals: false, // legacy option retained for compatibility (disabled)
    useBeatArcVisual: false, // legacy option retained for compatibility (disabled)
    beatArcHeightPx: 7, // shared with main app settings when available
    gridScale: 1.0,  // Overall grid scaling factor (0.5-2.0)
    wrapNotationRows: true, // Wrap long notation rows
    wrapAfterBeats: 5, // Number of beats per wrapped row
    holdToSilenceMs: TOUCH_HOLD_ERASE_MS_DEFAULT,
    cycleTapWindowMs: RAPID_CYCLE_WINDOW_MS_DEFAULT
};

function getNotationWrapBeatsPerRow() {
    const beats = Math.max(2, Math.min(16, parseInt(debugSettings?.wrapAfterBeats, 10) || 5));
    debugSettings.wrapAfterBeats = beats;
    return beats;
}

function isNotationWrappedLayout() {
    const beats = Math.max(1, parseInt(state?.beats, 10) || 1);
    return !!debugSettings.wrapNotationRows && beats > getNotationWrapBeatsPerRow();
}

function getNotationBeatSegments() {
    const beats = Math.max(1, parseInt(state?.beats, 10) || 1);
    if (!isNotationWrappedLayout()) {
        return [{ startBeat: 0, beatCount: beats }];
    }
    const perRow = Math.max(1, getNotationWrapBeatsPerRow());
    const segments = [];
    for (let startBeat = 0; startBeat < beats; startBeat += perRow) {
        segments.push({
            startBeat,
            beatCount: Math.min(perRow, beats - startBeat)
        });
    }
    return segments;
}

function syncWrappedSegmentTrackWidths(grid, beatNumbers) {
    if (!grid || !beatNumbers) return;
    const rootStyles = getComputedStyle(document.documentElement);
    const boxWidth = Math.max(1, parseFloat(rootStyles.getPropertyValue('--box-size')) || 40);
    const groupWidth = Math.max(0, parseFloat(rootStyles.getPropertyValue('--group-gap')) || 8);
    const beatSegmentRows = Array.from(beatNumbers.querySelectorAll('.beat-segment-row'));
    if (!beatSegmentRows.length) return;
    const instrumentRows = Array.from(grid.querySelectorAll('.instrument-row'));
    beatSegmentRows.forEach((beatSegment, segmentIndex) => {
        const beatNodes = Array.from(beatSegment.querySelectorAll('.beat-track-node, .beat-number, .group-spacer'));
        if (!beatNodes.length) return;
        beatNodes.forEach((node) => {
            const width = node.classList.contains('group-spacer') ? groupWidth : boxWidth;
            node.style.width = `${width}px`;
            node.style.minWidth = `${width}px`;
            node.style.maxWidth = `${width}px`;
        });

        const segmentGap = Math.max(0, parseFloat(getComputedStyle(beatSegment).gap) || 0);
        const segmentWidth = Math.max(
            1,
            beatNodes.reduce((sum, node) => sum + (node.classList.contains('group-spacer') ? groupWidth : boxWidth), 0)
            + Math.max(0, beatNodes.length - 1) * segmentGap
        );
        beatSegment.style.width = `${segmentWidth}px`;
        beatSegment.style.minWidth = `${segmentWidth}px`;
        beatSegment.style.maxWidth = `${segmentWidth}px`;

        instrumentRows.forEach((row) => {
            const stack = row.querySelector('.boxes-stack');
            const segment = stack
                ? stack.querySelectorAll('.boxes-segment')[segmentIndex]
                : (segmentIndex === 0 ? row.querySelector('.boxes-container') : null);
            if (!segment) return;
            const trackNodes = Array.from(segment.querySelectorAll('.track-node, .notation-box, .group-divider'));
            if (trackNodes.length !== beatNodes.length) return;
            for (let i = 0; i < trackNodes.length; i++) {
                const targetWidth = trackNodes[i].classList.contains('group-divider') ? groupWidth : boxWidth;
                trackNodes[i].style.width = `${targetWidth}px`;
                trackNodes[i].style.minWidth = `${targetWidth}px`;
                trackNodes[i].style.maxWidth = `${targetWidth}px`;
            }
            segment.style.width = `${segmentWidth}px`;
            segment.style.minWidth = `${segmentWidth}px`;
            segment.style.maxWidth = `${segmentWidth}px`;
        });
    });
}

function getHoldToSilenceMs() {
    const raw = Number(debugSettings?.holdToSilenceMs);
    if (!Number.isFinite(raw)) return TOUCH_HOLD_ERASE_MS_DEFAULT;
    return Math.max(120, Math.min(1200, Math.round(raw)));
}

function getCycleTapWindowMs() {
    const raw = Number(debugSettings?.cycleTapWindowMs);
    if (!Number.isFinite(raw)) return RAPID_CYCLE_WINDOW_MS_DEFAULT;
    return Math.max(120, Math.min(1200, Math.round(raw)));
}

// Tap tempo state
let tapTempoTaps = [];
const tapTempoWindow = 3000; // 3 seconds
let suppressPersistence = false;
let patternArchive = {};
let gridRestoreHints = {};
let gridRestoreSnapshots = {};

function normalizeHexColor(color, fallback = '#fcd116') {
    const raw = String(color || '').trim();
    const cleaned = raw.startsWith('#') ? raw.slice(1) : raw;
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned}`;
    if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
        const expanded = cleaned.split('').map((ch) => ch + ch).join('');
        return `#${expanded}`;
    }
    return fallback;
}

function hexToRgbaColor(hex, alpha) {
    const safeHex = normalizeHexColor(hex, '#fcd116').replace('#', '');
    const r = parseInt(safeHex.slice(0, 2), 16);
    const g = parseInt(safeHex.slice(2, 4), 16);
    const b = parseInt(safeHex.slice(4, 6), 16);
    const a = Number.isFinite(Number(alpha)) ? Math.max(0, Math.min(1, Number(alpha))) : 1;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function getBeatColorForStep(stepIndex) {
    const subdivisions = Math.max(1, parseInt(state.subdivisions, 10) || 1);
    const totalSteps = Math.max(1, (parseInt(state.beats, 10) || 1) * subdivisions);
    const safeStep = ((parseInt(stepIndex, 10) || 0) % totalSteps + totalSteps) % totalSteps;
    const beatIndex = Math.floor(safeStep / subdivisions) % 12;
    const palette = Array.isArray(debugSettings?.beatColors) ? debugSettings.beatColors : [];
    return normalizeHexColor(palette[beatIndex] || '#fcd116', '#fcd116');
}

function syncActiveBeatColor(stepIndex) {
    const activeColor = getBeatColorForStep(stepIndex);
    const root = document.documentElement;
    root.style.setProperty('--active-beat-color', activeColor);
    root.style.setProperty('--active-beat-glow', hexToRgbaColor(activeColor, 0.62));
    return activeColor;
}

function gridKey(beats, subdivisions) {
    const b = Math.max(1, parseInt(beats, 10) || 1);
    const s = Math.max(1, parseInt(subdivisions, 10) || 1);
    return `${b}x${s}`;
}

function instrumentArchiveKey(instrument, idx) {
    if (instrument && instrument.id) return `id:${instrument.id}`;
    return `idx:${idx}`;
}

function normalizePattern(pattern, totalSteps) {
    const total = Math.max(1, parseInt(totalSteps, 10) || 1);
    const source = Array.isArray(pattern) ? pattern : [];
    const next = new Array(total).fill(null);
    const copyLength = Math.min(total, source.length);
    for (let i = 0; i < copyLength; i++) {
        next[i] = source[i] || null;
    }
    return next;
}

function setArchivedPattern(instrument, idx, beats, subdivisions, pattern) {
    const key = instrumentArchiveKey(instrument, idx);
    const gk = gridKey(beats, subdivisions);
    if (!patternArchive[key]) patternArchive[key] = {};
    patternArchive[key][gk] = normalizePattern(pattern, (parseInt(beats, 10) || 1) * (parseInt(subdivisions, 10) || 1));
}

function getArchivedPattern(instrument, idx, beats, subdivisions) {
    const key = instrumentArchiveKey(instrument, idx);
    const gk = gridKey(beats, subdivisions);
    const total = Math.max(1, (parseInt(beats, 10) || 1) * (parseInt(subdivisions, 10) || 1));
    const raw = patternArchive[key]?.[gk];
    if (!Array.isArray(raw)) return null;
    return normalizePattern(raw, total);
}

function captureCurrentPatternsToArchive(beats = state.beats, subdivisions = state.subdivisions) {
    state.instruments.forEach((instrument, idx) => {
        setArchivedPattern(instrument, idx, beats, subdivisions, instrument.pattern);
    });
}

function captureGridRestoreSnapshot(fromBeats, fromSubdivisions, toBeats, toSubdivisions) {
    const fromBeatsSafe = Math.max(1, parseInt(fromBeats, 10) || 1);
    const fromSubsSafe = Math.max(1, parseInt(fromSubdivisions, 10) || 1);
    const fromTotal = fromBeatsSafe * fromSubsSafe;
    const toKey = gridKey(toBeats, toSubdivisions);
    const fromKey = gridKey(fromBeats, fromSubdivisions);
    const patterns = {};
    state.instruments.forEach((instrument, idx) => {
        patterns[instrumentArchiveKey(instrument, idx)] = normalizePattern(instrument.pattern, fromTotal);
    });
    gridRestoreSnapshots[toKey] = {
        fromKey,
        patterns
    };
}

function clampTempo(value) {
    return Math.max(40, Math.min(240, parseInt(value, 10) || 100));
}

function postTempoStateToParent() {
    try {
        window.parent.postMessage({ type: 'notationTempoState', tempo: state.tempo }, '*');
    } catch {}
}

function postNotationStateToParent() {
    try {
        window.parent.postMessage({
            type: 'notationState',
            tempo: state.tempo,
            playing: !!state.isPlaying,
            mode: state.viewMode,
            step: state.currentStep,
            stepEpoch: state._lastStepEpoch || Date.now(),
            masterVolume: masterVolume,
            masterMuted: !!masterMuted
        }, '*');
    } catch {}
}

// Solo / mute of every instrument, for the drum circle room.
function postInstrumentMixToParent() {
    try {
        window.parent.postMessage({
            type: 'notationInstrumentMix',
            rhythmName: state.rhythmName || '',
            mix: state.instruments.map((i) => ({ id: i.id, muted: i.muted === true, soloed: i.soloed === true }))
        }, '*');
    } catch {}
}

function postCallStateToParent(payload = null) {
    const nextPayload = payload && typeof payload === 'object' ? payload : {};
    const signature = JSON.stringify(nextPayload);
    if (signature === lastPostedCallStateKey) return;
    lastPostedCallStateKey = signature;
    try {
        window.parent.postMessage({
            type: 'notationCallState',
            ...nextPayload
        }, '*');
    } catch {}
}

function buildRhythmSyncData() {
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const instruments = state.instruments.map((instrument) => {
        const pattern = Array.isArray(instrument.pattern)
            ? instrument.pattern.slice(0, totalSteps)
            : [];
        while (pattern.length < totalSteps) pattern.push(null);
        return {
            ...instrument,
            pattern
        };
    });
    return {
        rhythmName: state.rhythmName,
        beats: state.beats,
        subdivisions: state.subdivisions,
        tempo: state.tempo,
        swing: { ...state.swing },
        themeColor: state.themeColor,
        instruments
    };
}

function postRhythmStateToParent() {
    const neonStyle = !!debugSettings.useNeonArticulationStyle;
    try {
        window.parent.postMessage({
            type: 'notationRhythmState',
            rhythmData: buildRhythmSyncData(),
            beatColors: Array.isArray(debugSettings.beatColors) ? debugSettings.beatColors.slice(0, 12) : null,
            usePadBeatVisuals: !!debugSettings.usePadBeatVisuals,
            useBeatArcVisual: !!debugSettings.useBeatArcVisual,
            beatArcHeightPx: Number.isFinite(Number(debugSettings.beatArcHeightPx)) ? Number(debugSettings.beatArcHeightPx) : 7,
            useCircularToneSymbol: neonStyle,
            useNeonArticulationStyle: neonStyle
        }, '*');
    } catch {}
}

function applyTempo(nextTempo, options = {}) {
    const restartPlayback = options.restartPlayback !== false;
    const persist = options.persist !== false;
    const broadcast = options.broadcast !== false;

    state.tempo = clampTempo(nextTempo);
    const tempoInput = document.getElementById('tempo');
    if (tempoInput) tempoInput.value = state.tempo;
    const tempoDisplay = document.getElementById('tempoDisplay');
    if (tempoDisplay) tempoDisplay.innerHTML = `${state.tempo}<span>BPM</span>`;
    syncCompactUi();

    if (state.isPlaying && !circularOnlyMode) {
        if (restartPlayback) {
            stopPlayback();
            startPlayback();
        } else {
            retimePlaybackForLiveTempoChange();
        }
    } else if (state.isPlaying && circularOnlyMode) {
        // In circular-only mirror mode, timing is driven externally by sync ticks.
        drawCircularView();
    }
    if (persist) saveToLocalStorage();
    if (broadcast) {
        postTempoStateToParent();
        postNotationStateToParent();
    }
}

function retimePlaybackForLiveTempoChange() {
    if (!state.isPlaying) return;
    clearTimeout(state.playbackTimeout);
    state.playbackTimeout = null;
    const plan = buildStepTimingPlan();
    const counter = Math.max(0, Math.floor(Number(state._playbackStepCounter) || 0));
    const cycle = Math.floor(counter / plan.totalSteps);
    const stepInCycle = counter % plan.totalSteps;
    const stepLead = Math.max(12, Math.min(60, (plan.stepDelays[stepInCycle] || 24) * 0.35));
    const nowEpoch = transportEpochNow();
    // Steps inside the look-ahead window are already scheduled at the old tempo. The next
    // unscheduled step keeps the time it had, and the new tempo applies from there on.
    const nextEpoch = Number.isFinite(schedNextEpoch) ? Math.max(schedNextEpoch, nowEpoch + stepLead) : (nowEpoch + stepLead);
    state._playbackAnchorEpoch = nextEpoch - ((cycle * plan.cycleMs) + plan.cumulativeMs[stepInCycle]);
    scheduleNextStep();
}

// Toggle debug panel visibility
function toggleDebugPanel() {
    const panel = document.getElementById('debugPanel');
    panel.classList.toggle('visible');
}

// Setup debug panel event listeners
function setupDebugPanel() {
    // Load saved debug settings
    const saved = localStorage.getItem('notationDebugSettings');
    if (saved) {
        debugSettings = { ...debugSettings, ...JSON.parse(saved) };
    }
    // Roll back to stable legacy beat-number/arrow behavior.
    debugSettings.usePadBeatVisuals = false;
    debugSettings.useBeatArcVisual = false;

    // Apply initial settings
    applyDebugSettings();

    // Update UI controls to match saved values
    document.getElementById('playheadGlow').value = debugSettings.playheadGlow;
    document.getElementById('playheadGlowValue').textContent = debugSettings.playheadGlow;
    document.getElementById('playheadBorder').value = debugSettings.playheadBorder;
    document.getElementById('playheadBorderValue').textContent = debugSettings.playheadBorder + 'px';
    document.getElementById('playheadPointer').value = debugSettings.playheadPointer;
    document.getElementById('playheadPointerValue').textContent = debugSettings.playheadPointer + 'px';
    document.getElementById('showPointer').checked = debugSettings.showPointer;
    document.getElementById('showGlow').checked = debugSettings.showGlow;
    document.getElementById('boxGrowth').value = debugSettings.boxGrowth;
    document.getElementById('boxGrowthValue').textContent = debugSettings.boxGrowth;
    document.getElementById('keepSize').checked = debugSettings.keepSize;
    document.getElementById('playheadSeparation').value = debugSettings.playheadSeparation;
    document.getElementById('playheadSeparationValue').textContent = debugSettings.playheadSeparation + 'px';
    document.getElementById('boxSize').value = debugSettings.boxSize;
    document.getElementById('boxSizeValue').textContent = debugSettings.boxSize + 'px';
    document.getElementById('groupGap').value = debugSettings.groupGap;
    document.getElementById('groupGapValue').textContent = debugSettings.groupGap + 'px';
    document.getElementById('boxGap').value = debugSettings.boxGap;
    document.getElementById('boxGapValue').textContent = debugSettings.boxGap + 'px';
    document.getElementById('rowGap').value = debugSettings.rowGap;
    document.getElementById('rowGapValue').textContent = debugSettings.rowGap + 'px';
    document.getElementById('instrumentInfoWidth').value = debugSettings.instrumentInfoWidth;
    document.getElementById('instrumentInfoWidthValue').textContent = debugSettings.instrumentInfoWidth + 'px';
    document.getElementById('instrumentNameWidth').value = debugSettings.instrumentNameWidth;
    document.getElementById('instrumentNameWidthValue').textContent = debugSettings.instrumentNameWidth + 'px';
    document.getElementById('gridScale').value = debugSettings.gridScale;
    document.getElementById('gridScaleValue').textContent = debugSettings.gridScale.toFixed(1) + 'x';
    const wrapNotationRowsEl = document.getElementById('wrapNotationRows');
    if (wrapNotationRowsEl) {
        wrapNotationRowsEl.checked = debugSettings.wrapNotationRows !== false;
    }
    const wrapAfterBeatsEl = document.getElementById('wrapAfterBeats');
    const wrapAfterBeatsValueEl = document.getElementById('wrapAfterBeatsValue');
    if (wrapAfterBeatsEl) {
        const safeWrapAfter = getNotationWrapBeatsPerRow();
        wrapAfterBeatsEl.value = String(safeWrapAfter);
        if (wrapAfterBeatsValueEl) wrapAfterBeatsValueEl.textContent = String(safeWrapAfter);
    }
    const holdToSilenceMs = getHoldToSilenceMs();
    debugSettings.holdToSilenceMs = holdToSilenceMs;
    document.getElementById('holdToSilenceMs').value = holdToSilenceMs;
    document.getElementById('holdToSilenceMsValue').textContent = holdToSilenceMs + 'ms';
    const cycleTapWindowMs = getCycleTapWindowMs();
    debugSettings.cycleTapWindowMs = cycleTapWindowMs;
    document.getElementById('cycleTapWindowMs').value = cycleTapWindowMs;
    document.getElementById('cycleTapWindowMsValue').textContent = cycleTapWindowMs + 'ms';
    document.getElementById('reverbAmount').value = debugSettings.reverbAmount;
    document.getElementById('reverbAmountValue').textContent = debugSettings.reverbAmount.toFixed(2);
    const useNeonArticulationStyleEl = document.getElementById('useNeonArticulationStyle');
    if (useNeonArticulationStyleEl) {
        useNeonArticulationStyleEl.checked = !!debugSettings.useNeonArticulationStyle;
    }
    const disableResponsiveButtonSwapEl = document.getElementById('disableResponsiveButtonSwap');
    if (disableResponsiveButtonSwapEl) {
        disableResponsiveButtonSwapEl.checked = !!debugSettings.disableResponsiveButtonSwap;
    }

    // Swing factor (uses state, not debugSettings)
    document.getElementById('swingFactor').value = state.swing.factor;
    document.getElementById('swingFactorValue').textContent = state.swing.factor;

    // Playhead glow
    document.getElementById('playheadGlow').addEventListener('input', (e) => {
        debugSettings.playheadGlow = parseFloat(e.target.value);
        document.getElementById('playheadGlowValue').textContent = debugSettings.playheadGlow;
        applyDebugSettings();
        saveDebugSettings();
    });

    // Playhead border width
    document.getElementById('playheadBorder').addEventListener('input', (e) => {
        debugSettings.playheadBorder = parseFloat(e.target.value);
        document.getElementById('playheadBorderValue').textContent = debugSettings.playheadBorder + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Playhead pointer size
    document.getElementById('playheadPointer').addEventListener('input', (e) => {
        debugSettings.playheadPointer = parseInt(e.target.value);
        document.getElementById('playheadPointerValue').textContent = debugSettings.playheadPointer + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Show pointer toggle
    document.getElementById('showPointer').addEventListener('change', (e) => {
        debugSettings.showPointer = e.target.checked;
        applyDebugSettings();
        saveDebugSettings();
    });

    // Show glow toggle
    document.getElementById('showGlow').addEventListener('change', (e) => {
        debugSettings.showGlow = e.target.checked;
        applyDebugSettings();
        saveDebugSettings();
    });

    // Box growth - ISOLATED (only affects this property)
    document.getElementById('boxGrowth').addEventListener('input', (e) => {
        debugSettings.boxGrowth = parseFloat(e.target.value);
        document.getElementById('boxGrowthValue').textContent = debugSettings.boxGrowth;
        // ONLY update the box growth CSS variable, nothing else
        document.documentElement.style.setProperty('--playhead-box-growth', debugSettings.boxGrowth);
        saveDebugSettings();
        // DON'T call applyDebugSettings() or updateGrid() - just the CSS var
    });

    // Keep size toggle
    document.getElementById('keepSize').addEventListener('change', (e) => {
        debugSettings.keepSize = e.target.checked;
        applyDebugSettings();
        saveDebugSettings();
    });

    // Playhead separation
    document.getElementById('playheadSeparation').addEventListener('input', (e) => {
        debugSettings.playheadSeparation = parseInt(e.target.value);
        document.getElementById('playheadSeparationValue').textContent = debugSettings.playheadSeparation + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Box size
    document.getElementById('boxSize').addEventListener('input', (e) => {
        debugSettings.boxSize = parseInt(e.target.value);
        document.getElementById('boxSizeValue').textContent = debugSettings.boxSize + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Group gap
    document.getElementById('groupGap').addEventListener('input', (e) => {
        debugSettings.groupGap = parseInt(e.target.value);
        document.getElementById('groupGapValue').textContent = debugSettings.groupGap + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Box gap
    document.getElementById('boxGap').addEventListener('input', (e) => {
        debugSettings.boxGap = parseInt(e.target.value);
        document.getElementById('boxGapValue').textContent = debugSettings.boxGap + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Row gap
    document.getElementById('rowGap').addEventListener('input', (e) => {
        debugSettings.rowGap = parseInt(e.target.value);
        document.getElementById('rowGapValue').textContent = debugSettings.rowGap + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Instrument info width
    document.getElementById('instrumentInfoWidth').addEventListener('input', (e) => {
        debugSettings.instrumentInfoWidth = parseInt(e.target.value);
        document.getElementById('instrumentInfoWidthValue').textContent = debugSettings.instrumentInfoWidth + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // Instrument name width
    document.getElementById('instrumentNameWidth').addEventListener('input', (e) => {
        debugSettings.instrumentNameWidth = parseInt(e.target.value);
        document.getElementById('instrumentNameWidthValue').textContent = debugSettings.instrumentNameWidth + 'px';
        applyDebugSettings();
        saveDebugSettings();
    });

    // NEW: Grid scale - multiplies box size before autoScale
    document.getElementById('gridScale').addEventListener('input', (e) => {
        debugSettings.gridScale = parseFloat(e.target.value);
        document.getElementById('gridScaleValue').textContent = debugSettings.gridScale.toFixed(1) + 'x';
        autoScaleGrid();  // Recalculate with new scale
        saveDebugSettings();
    });

    const wrapNotationRowsControl = document.getElementById('wrapNotationRows');
    if (wrapNotationRowsControl) {
        wrapNotationRowsControl.addEventListener('change', (e) => {
            debugSettings.wrapNotationRows = !!e.target.checked;
            updateGrid();
            autoScaleGrid();
            saveDebugSettings();
        });
    }
    const wrapAfterBeatsControl = document.getElementById('wrapAfterBeats');
    const wrapAfterBeatsValue = document.getElementById('wrapAfterBeatsValue');
    if (wrapAfterBeatsControl) {
        wrapAfterBeatsControl.addEventListener('input', (e) => {
            const nextValue = Math.max(2, Math.min(16, parseInt(e.target.value, 10) || 5));
            debugSettings.wrapAfterBeats = nextValue;
            if (wrapAfterBeatsValue) wrapAfterBeatsValue.textContent = String(nextValue);
            updateGrid();
            autoScaleGrid();
            saveDebugSettings();
        });
    }

    // Hold-to-silence timing (mouse/touch hold before erase mode)
    document.getElementById('holdToSilenceMs').addEventListener('input', (e) => {
        debugSettings.holdToSilenceMs = Math.max(120, Math.min(1200, parseInt(e.target.value, 10) || TOUCH_HOLD_ERASE_MS_DEFAULT));
        document.getElementById('holdToSilenceMsValue').textContent = debugSettings.holdToSilenceMs + 'ms';
        saveDebugSettings();
    });

    // Rapid repeat tap window for integrated cycling on same box
    document.getElementById('cycleTapWindowMs').addEventListener('input', (e) => {
        debugSettings.cycleTapWindowMs = Math.max(120, Math.min(1200, parseInt(e.target.value, 10) || RAPID_CYCLE_WINDOW_MS_DEFAULT));
        document.getElementById('cycleTapWindowMsValue').textContent = debugSettings.cycleTapWindowMs + 'ms';
        saveDebugSettings();
    });

    // Reverb amount
    document.getElementById('reverbAmount').addEventListener('input', (e) => {
        debugSettings.reverbAmount = parseFloat(e.target.value);
        document.getElementById('reverbAmountValue').textContent = debugSettings.reverbAmount.toFixed(2);
        setReverbAmount(debugSettings.reverbAmount);
        saveDebugSettings();
    });

    // Swing factor
    document.getElementById('swingFactor').addEventListener('input', (e) => {
        updateSwingFactor(e.target.value);
    });

    // Open symbol size
    const openSymbolEl = document.getElementById('openSymbolSize');
    const openSymbolVal = document.getElementById('openSymbolSizeValue');
    if (openSymbolEl) {
        // initialize control from debugSettings (saved or defaults)
        openSymbolEl.value = debugSettings.openSymbolSize;
        openSymbolVal.textContent = debugSettings.openSymbolSize + '%';

        openSymbolEl.addEventListener('input', function() {
            const val = parseFloat(this.value);
            debugSettings.openSymbolSize = val;
            applyDebugSettings();
            document.getElementById('openSymbolSizeValue').textContent = val + '%';
            saveDebugSettings();
        });
    }

    const useNeonArticulationStyleControl = document.getElementById('useNeonArticulationStyle');
    if (useNeonArticulationStyleControl) {
        useNeonArticulationStyleControl.addEventListener('change', function() {
            debugSettings.useNeonArticulationStyle = !!this.checked;
            applyDebugSettings();
            updateGrid();
            drawCircularView();
            saveDebugSettings();
            postRhythmStateToParent();
        });
    }

    const disableResponsiveButtonSwapControl = document.getElementById('disableResponsiveButtonSwap');
    if (disableResponsiveButtonSwapControl) {
        disableResponsiveButtonSwapControl.addEventListener('change', function() {
            debugSettings.disableResponsiveButtonSwap = !!this.checked;
            applyDebugSettings();
            syncCompactUi();
            saveDebugSettings();
        });
    }

    // Beat number alignment
    const beatAlignEl = document.getElementById('beatNumberAlign');
    const beatAlignVal = document.getElementById('beatNumberAlignValue');
    if (beatAlignEl) {
        beatAlignEl.value = debugSettings.beatNumberAlign;
        beatAlignVal.textContent = debugSettings.beatNumberAlign + 'px';

        beatAlignEl.addEventListener('input', function() {
            const val = parseInt(this.value);
            debugSettings.beatNumberAlign = val;
            applyDebugSettings();
            document.getElementById('beatNumberAlignValue').textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Tone outline width
    const toneOutlineEl = document.getElementById('toneOutlineWidth');
    const toneOutlineVal = document.getElementById('toneOutlineWidthValue');
    if (toneOutlineEl) {
        toneOutlineEl.value = debugSettings.toneOutlineWidth;
        toneOutlineVal.textContent = debugSettings.toneOutlineWidth + 'px';

        toneOutlineEl.addEventListener('input', function() {
            const val = parseFloat(this.value);
            debugSettings.toneOutlineWidth = val;
            applyDebugSettings();
            document.getElementById('toneOutlineWidthValue').textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Beat indicator height
    const beatHeightEl = document.getElementById('beatIndicatorHeight');
    const beatHeightVal = document.getElementById('beatIndicatorHeightValue');
    if (beatHeightEl) {
        beatHeightEl.value = debugSettings.beatIndicatorHeight;
        beatHeightVal.textContent = debugSettings.beatIndicatorHeight + 'px';

        beatHeightEl.addEventListener('input', function() {
            const val = parseInt(this.value);
            debugSettings.beatIndicatorHeight = val;
            applyDebugSettings();
            document.getElementById('beatIndicatorHeightValue').textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Beat indicator Y offset
    const beatOffsetEl = document.getElementById('beatIndicatorOffset');
    const beatOffsetVal = document.getElementById('beatIndicatorOffsetValue');
    if (beatOffsetEl) {
        beatOffsetEl.value = debugSettings.beatIndicatorOffset;
        beatOffsetVal.textContent = debugSettings.beatIndicatorOffset + 'px';

        beatOffsetEl.addEventListener('input', function() {
            const val = parseInt(this.value);
            debugSettings.beatIndicatorOffset = val;
            applyDebugSettings();
            document.getElementById('beatIndicatorOffsetValue').textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Beat label X offset (next to BPM)
    const playbackBeatOffsetXEl = document.getElementById('playbackBeatOffsetX');
    const playbackBeatOffsetXVal = document.getElementById('playbackBeatOffsetXValue');
    if (playbackBeatOffsetXEl) {
        playbackBeatOffsetXEl.value = debugSettings.playbackBeatOffsetX || 0;
        if (playbackBeatOffsetXVal) {
            playbackBeatOffsetXVal.textContent = (debugSettings.playbackBeatOffsetX || 0) + 'px';
        }
        playbackBeatOffsetXEl.addEventListener('input', function() {
            const val = parseInt(this.value, 10) || 0;
            debugSettings.playbackBeatOffsetX = val;
            applyDebugSettings();
            if (playbackBeatOffsetXVal) playbackBeatOffsetXVal.textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Beat label Y offset (next to BPM)
    const playbackBeatOffsetYEl = document.getElementById('playbackBeatOffsetY');
    const playbackBeatOffsetYVal = document.getElementById('playbackBeatOffsetYValue');
    if (playbackBeatOffsetYEl) {
        playbackBeatOffsetYEl.value = debugSettings.playbackBeatOffsetY || 0;
        if (playbackBeatOffsetYVal) {
            playbackBeatOffsetYVal.textContent = (debugSettings.playbackBeatOffsetY || 0) + 'px';
        }
        playbackBeatOffsetYEl.addEventListener('input', function() {
            const val = parseInt(this.value, 10) || 0;
            debugSettings.playbackBeatOffsetY = val;
            applyDebugSettings();
            if (playbackBeatOffsetYVal) playbackBeatOffsetYVal.textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Transport emoji chip tint
    const transportEmojiTintEl = document.getElementById('transportEmojiTint');
    const transportEmojiTintVal = document.getElementById('transportEmojiTintValue');
    if (transportEmojiTintEl) {
        transportEmojiTintEl.value = debugSettings.transportEmojiTint || '#ffffff';
        if (transportEmojiTintVal) transportEmojiTintVal.textContent = transportEmojiTintEl.value;
        transportEmojiTintEl.addEventListener('input', function() {
            const val = this.value || '#ffffff';
            debugSettings.transportEmojiTint = val;
            if (transportEmojiTintVal) transportEmojiTintVal.textContent = val;
            applyDebugSettings();
            saveDebugSettings();
        });
    }

    // Beat color pickers (12 colors)
    for (let i = 1; i <= 12; i++) {
        const colorEl = document.getElementById(`beatColor${i}`);
        if (colorEl) {
            colorEl.value = debugSettings.beatColors[i - 1];
            colorEl.addEventListener('input', function() {
                debugSettings.beatColors[i - 1] = this.value;
                applyDebugSettings();
                saveDebugSettings();
                postRhythmStateToParent();
            });
        }
    }

    // Title font size
    const titleFontEl = document.getElementById('titleFontSize');
    const titleFontVal = document.getElementById('titleFontSizeValue');
    if (titleFontEl) {
        titleFontEl.value = debugSettings.titleFontSize;
        titleFontVal.textContent = debugSettings.titleFontSize + 'px';

        titleFontEl.addEventListener('input', function() {
            const val = parseInt(this.value);
            debugSettings.titleFontSize = val;
            applyDebugSettings();
            document.getElementById('titleFontSizeValue').textContent = val + 'px';
            saveDebugSettings();
        });
    }

    // Title visible toggle
    const titleVisibleEl = document.getElementById('titleVisible');
    if (titleVisibleEl) {
        titleVisibleEl.checked = debugSettings.titleVisible;

        titleVisibleEl.addEventListener('change', function() {
            debugSettings.titleVisible = this.checked;
            applyDebugSettings();
            saveDebugSettings();
        });
    }

    // Dial sync offset
    const dialSyncEl = document.getElementById('dialSyncOffset');
    const dialSyncVal = document.getElementById('dialSyncOffsetValue');
    if (dialSyncEl) {
        dialSyncEl.value = debugSettings.dialSyncOffset || 0;
        dialSyncVal.textContent = (debugSettings.dialSyncOffset || 0) + 'ms';
        dialSyncEl.addEventListener('input', function() {
            debugSettings.dialSyncOffset = parseInt(this.value);
            dialSyncVal.textContent = this.value + 'ms';
            saveDebugSettings();
        });
    }

    const smoothCircularArrowEl = document.getElementById('smoothCircularArrow');
    if (smoothCircularArrowEl) {
        smoothCircularArrowEl.checked = debugSettings.smoothCircularArrow !== false;
        smoothCircularArrowEl.addEventListener('change', function() {
            debugSettings.smoothCircularArrow = !!this.checked;
            saveDebugSettings();
            drawCircularView();
        });
    }

    const usePadBeatVisualsEl = document.getElementById('usePadBeatVisuals');
    if (usePadBeatVisualsEl) {
        usePadBeatVisualsEl.checked = debugSettings.usePadBeatVisuals !== false;
        usePadBeatVisualsEl.addEventListener('change', function() {
            debugSettings.usePadBeatVisuals = !!this.checked;
            applyDebugSettings();
            saveDebugSettings();
            postRhythmStateToParent();
        });
    }

    const useBeatArcVisualEl = document.getElementById('useBeatArcVisual');
    if (useBeatArcVisualEl) {
        useBeatArcVisualEl.checked = !!debugSettings.useBeatArcVisual;
        useBeatArcVisualEl.addEventListener('change', function() {
            debugSettings.useBeatArcVisual = !!this.checked;
            applyDebugSettings();
            saveDebugSettings();
            postRhythmStateToParent();
        });
    }
}

// Apply debug settings to CSS variables
function applyDebugSettings() {
    const root = document.documentElement;
    root.style.setProperty('--playhead-glow', debugSettings.showGlow ? debugSettings.playheadGlow : 0);
    root.style.setProperty('--playhead-border-width', debugSettings.playheadBorder + 'px');
    root.style.setProperty('--playhead-pointer-size', debugSettings.showPointer ? debugSettings.playheadPointer + 'px' : '0px');
    root.style.setProperty('--playhead-box-growth', debugSettings.boxGrowth);
    root.style.setProperty('--playhead-separation', debugSettings.playheadSeparation + 'px');
    root.style.setProperty('--box-size', debugSettings.boxSize + 'px');
    root.style.setProperty('--group-gap', debugSettings.groupGap + 'px');
    root.style.setProperty('--box-gap', debugSettings.boxGap + 'px');
    const rowGap = Number.isFinite(Number(debugSettings.rowGap)) ? Number(debugSettings.rowGap) : 8;
    root.style.setProperty('--row-gap', rowGap + 'px');
    root.style.setProperty('--instrument-info-width', debugSettings.instrumentInfoWidth + 'px');
    root.style.setProperty('--instrument-name-width', debugSettings.instrumentNameWidth + 'px');
    root.style.setProperty('--open-symbol-size', (debugSettings.openSymbolSize / 100).toString());
    root.style.setProperty('--beat-number-align', (debugSettings.beatNumberAlign || 0) + 'px');
    root.style.setProperty('--tone-outline-width', (debugSettings.toneOutlineWidth || 2) + 'px');
    root.style.setProperty('--beat-indicator-height', (debugSettings.beatIndicatorHeight || 3) + 'px');
    root.style.setProperty('--beat-indicator-offset', (debugSettings.beatIndicatorOffset || 0) + 'px');
    root.style.setProperty('--playback-beat-offset-x', (debugSettings.playbackBeatOffsetX || 0) + 'px');
    root.style.setProperty('--playback-beat-offset-y', (debugSettings.playbackBeatOffsetY || 0) + 'px');
    root.style.setProperty('--title-font-size', (debugSettings.titleFontSize || 24) + 'px');
    root.style.setProperty('--notation-beat-arrow-arc-height', `${Math.max(1, Math.min(40, Number(debugSettings.beatArcHeightPx) || 7))}px`);
    const transportTint = debugSettings.transportEmojiTint || '#ffffff';
    root.style.setProperty('--transport-emoji-bg', hexToRgbaColor(transportTint, 0.92));
    root.style.setProperty('--transport-emoji-border', hexToRgbaColor(transportTint, 0.98));

    // Apply beat colors (12 colors)
    if (debugSettings.beatColors) {
        for (let i = 0; i < 12; i++) {
            root.style.setProperty(`--beat-color-${i + 1}`, debugSettings.beatColors[i]);
        }
    }
    syncActiveBeatColor(state.currentStep || 0);

    document.body.classList.toggle('use-circular-tone-symbol', !!debugSettings.useNeonArticulationStyle);
    document.body.classList.toggle('use-neon-articulation-style', !!debugSettings.useNeonArticulationStyle);
    document.body.classList.toggle('disable-responsive-button-swap', !!debugSettings.disableResponsiveButtonSwap);
    document.body.classList.remove('use-pad-beat-visuals');
    document.body.classList.remove('use-beat-arc-visual');

    // Apply title visibility
    const titleEl = document.getElementById('appTitle');
    if (titleEl) {
        if (debugSettings.titleVisible) {
            titleEl.classList.remove('hidden');
        } else {
            titleEl.classList.add('hidden');
        }
    }
}

// Save debug settings to localStorage
function saveDebugSettings() {
    localStorage.setItem('notationDebugSettings', JSON.stringify(debugSettings));
}

// Export debug settings as JSON
function exportDebugSettings() {
    const json = JSON.stringify(debugSettings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'debug-settings.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function importDebugSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            debugSettings = { ...debugSettings, ...imported };
            applyDebugSettings();
            setupDebugPanel(); // Re-initialize UI controls
            saveDebugSettings();
            ensureInlineUiFeedback().toast('Debug settings imported.', 'success');
        } catch (error) {
            await ensureInlineUiFeedback().alert('Error importing settings: ' + error.message, 'Import Error');
        }
    };
    reader.readAsText(file);
}

function syncViewButtons() {
    const toggleBtn = document.getElementById('viewToggleBtn');
    if (toggleBtn) {
        toggleBtn.textContent = state.viewMode === 'circular' ? '📊 Close Circular' : '🔄 Circular View';
    }
}

function syncPlaybackButtons() {
    const playBtn = document.getElementById('playBtn');
    const compactPlayBtn = document.getElementById('compactPlayBtn');
    const circularPlayBtn = document.getElementById('circularPlayBtn');
    const isPlaying = !!state.isPlaying;

    if (playBtn) {
        playBtn.textContent = isPlaying ? '⏹ Stop' : '▶ Play';
        playBtn.classList.toggle('btn-play', !isPlaying);
        playBtn.classList.toggle('btn-stop', isPlaying);
    }
    if (compactPlayBtn) {
        compactPlayBtn.textContent = isPlaying ? 'Stop' : 'Play';
        compactPlayBtn.classList.toggle('btn-play', !isPlaying);
        compactPlayBtn.classList.toggle('btn-stop', isPlaying);
    }
    if (circularPlayBtn) {
        circularPlayBtn.textContent = isPlaying ? '⏹ Stop' : '▶ Play';
        circularPlayBtn.classList.toggle('btn-play', !isPlaying);
        circularPlayBtn.classList.toggle('btn-stop', isPlaying);
    }
}

function syncMetronomeButtons() {
    ['metronomeBtn', 'compactMetronomeBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', !!metronomeEnabled);
    });    try { window.parent.postMessage({ type: 'notationMetronomeState', enabled: !!metronomeEnabled }, '*'); } catch {}
}

function syncMasterUi() {
    const muteButtons = ['masterMuteBtn', 'compactMasterMuteBtn'];
    muteButtons.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', !!masterMuted);
        if (id === 'masterMuteBtn') {
            btn.textContent = masterMuted ? '🔇 Muted' : '🔊 Global';
        } else {
            btn.textContent = masterMuted ? 'MUTED' : 'MUTE';
        }
    });

    const volumeSlider = document.getElementById('masterVolume');
    if (volumeSlider) {
        volumeSlider.value = String(Math.round((masterVolume || 0) * 100) / 100);
        volumeSlider.style.setProperty('--slider-fill', Math.round((masterVolume || 0) * 100) + '%');
    }
    const valueEl = document.getElementById('masterVolumeValue');
    if (valueEl) valueEl.textContent = Math.round((masterVolume || 0) * 100) + '%';
}

function getTotalGridSteps() {
    return Math.max(1, (parseInt(state.beats, 10) || 1) * (parseInt(state.subdivisions, 10) || 1));
}

function defaultCallInStepOffset() {
    return 2;
}

function clampCallInStepOffset(value) {
    const parsed = parseInt(value, 10);
    const totalSteps = getTotalGridSteps();
    if (!Number.isFinite(parsed)) return Math.max(1, Math.min(totalSteps, defaultCallInStepOffset()));
    return Math.max(1, Math.min(totalSteps, parsed));
}

function syncCallInStepInputs() {
    const totalSteps = getTotalGridSteps();
    if (callInStepOffset !== null) callInStepOffset = clampCallInStepOffset(callInStepOffset);
    const shownOffset = clampCallInStepOffset(callInStepOffset);
    ['callInStepInput', 'compactCallInStepInput', 'circularCallInStepInput'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('pattern', '[0-9]*');
        input.setAttribute('autocomplete', 'off');
        input.dataset.min = '1';
        input.dataset.max = String(totalSteps);
        const isEditing = input.dataset.callInEditing === '1' || document.activeElement === input;
        if (!isEditing) {
            input.value = String(shownOffset);
        }
    });
}

function setCallInStepOffset(value, options = {}) {
    const persist = options.persist !== false;
    const broadcast = options.broadcast !== false;
    callInStepOffset = clampCallInStepOffset(value);
    if (persist) {
        localStorage.setItem(CALL_IN_STEP_STORAGE_KEY, String(callInStepOffset));
    }
    syncCallInStepInputs();
    if (!broadcast) return;
    if (circularOnlyMode) {
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'setCallInStep',
                payload: { value: callInStepOffset }
            }, '*');
        } catch {}
    }
    syncCallButtons();
}

function bindCallInStepInputs() {
    const bind = (id) => {
        const input = document.getElementById(id);
        if (!input || input.dataset.boundCallInStep === '1') return;
        input.dataset.boundCallInStep = '1';
        input.addEventListener('focus', () => {
            input.dataset.callInEditing = '1';
        });
        const onInput = () => {
            const digitsOnly = String(input.value || '').replace(/[^\d]/g, '');
            if (digitsOnly !== input.value) input.value = digitsOnly;
            const raw = digitsOnly.trim();
            if (!raw) return;
            const parsed = parseInt(raw, 10);
            if (!Number.isFinite(parsed)) return;
            setCallInStepOffset(parsed, { persist: true });
        };
        const onCommit = () => {
            input.dataset.callInEditing = '0';
            const raw = String(input.value || '').trim();
            const parsed = parseInt(raw, 10);
            const value = Number.isFinite(parsed) ? parsed : 1;
            setCallInStepOffset(value, { persist: true });
        };
        input.addEventListener('input', onInput);
        input.addEventListener('change', onCommit);
        input.addEventListener('blur', onCommit);
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onCommit();
            input.blur();
        });
    };
    bind('callInStepInput');
    bind('compactCallInStepInput');
    bind('circularCallInStepInput');
    syncCallInStepInputs();
}

function syncCallButtons() {
    const isPlaying = !!state.isPlaying;
    const callInActive = !!(callInSequenceState && callInSequenceState.active);
    const callOutActive = !!(callOutSequenceState && callOutSequenceState.active);
    const callLabel = (!isPlaying || callInActive) ? 'Call In' : 'Call';
    const callTitle = (!isPlaying)
        ? 'Start with one metronome measure, then call measure with Step In entry'
        : (callInActive ? 'Call In sequence is running' : 'Cue call for next measure');

    ['callBtn', 'compactCallBtn', 'circularCallBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.textContent = callLabel;
        btn.title = callTitle;
        btn.classList.toggle('pending', !!callPending);
        btn.classList.toggle('active-call', !!callActive);
        btn.disabled = !!(isPlaying && callInActive);
    });

    ['callOutBtn', 'compactCallOutBtn', 'circularCallOutBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const show = isPlaying && !callInActive;
        btn.style.display = show ? 'inline-flex' : 'none';
        btn.classList.toggle('active-callout', callOutActive);
        btn.disabled = !!callOutActive;
    });

    ['callInStepInput', 'compactCallInStepInput', 'circularCallInStepInput'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = !!isPlaying;
    });

    syncCallInStepInputs();
    postCallStateToParent({
        callLabel,
        callTitle,
        showCallOut: isPlaying && !callInActive,
        callPending: !!callPending,
        callActive: !!callActive,
        callInActive,
        callOutActive,
        playing: isPlaying,
        callInStepOffset: clampCallInStepOffset(callInStepOffset),
        callInStepMax: getTotalGridSteps()
    });
}

function applyCallStateFromParent(data) {
    const callLabel = String(data?.callLabel || 'Call In');
    const callTitle = String(data?.callTitle || '');
    const showCallOut = !!data?.showCallOut;
    const callPending = !!data?.callPending;
    const callActiveState = !!data?.callActive;
    const callInActive = !!data?.callInActive;
    const callOutActive = !!data?.callOutActive;
    const isPlaying = !!data?.playing;
    if (Number.isFinite(Number(data?.callInStepOffset))) {
        callInStepOffset = clampCallInStepOffset(Number(data.callInStepOffset));
        syncCallInStepInputs();
    }

    ['circularCallBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.textContent = callLabel;
        btn.title = callTitle;
        btn.classList.toggle('pending', callPending);
        btn.classList.toggle('active-call', callActiveState);
        btn.disabled = !!callInActive;
    });

    ['circularCallOutBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.style.display = showCallOut ? 'inline-flex' : 'none';
        btn.classList.toggle('active-callout', callOutActive);
        btn.disabled = !!callOutActive;
    });

    const stepInput = document.getElementById('circularCallInStepInput');
    if (stepInput) {
        stepInput.disabled = isPlaying;
    }
}

function syncCycleModeUi() {
    const helpBtn = document.getElementById('cycleBtn');
    if (helpBtn) {
        helpBtn.classList.remove('active');
        helpBtn.textContent = 'GRID INPUT ?';
        helpBtn.setAttribute('aria-pressed', 'false');
        helpBtn.title = 'How tap/hold grid input works';
    }
    const toggleBtn = document.getElementById('cycleToggleBtn');
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', !!state.rapidCycleEnabled);
        toggleBtn.setAttribute('aria-pressed', state.rapidCycleEnabled ? 'true' : 'false');
        toggleBtn.textContent = state.rapidCycleEnabled ? 'Cycle: On' : 'Cycle: Off';
        toggleBtn.title = state.rapidCycleEnabled
            ? 'Rapid repeat taps cycle articulations'
            : 'Rapid cycle disabled';
    }
}

function syncCompactUi() {
    const rhythmEl = document.getElementById('compactRhythmName');
    if (rhythmEl) rhythmEl.textContent = state.rhythmName || 'Rhythm';

    const tempoEl = document.getElementById('compactTempo');
    if (tempoEl) tempoEl.value = state.tempo;
    const instBtn = document.getElementById('compactInstPanelBtn');
    if (instBtn) {
        const isOpen = state.compactInstrumentPanelOpen !== false;
        instBtn.textContent = isOpen ? 'Hide Instruments' : 'Show Instruments';
        instBtn.classList.toggle('active', isOpen);
    }
    const compactFullBtn = document.getElementById('compactFullViewBtn');
    if (compactFullBtn) {
        compactFullBtn.textContent = state.compactMode ? 'Expand View' : 'Compact View';
    }
    const settingsBtn = document.getElementById('mainSettingsBtn');
    if (settingsBtn) {
        settingsBtn.textContent = '⚙ Settings';
    }

    syncViewButtons();
    syncPlaybackButtons();
    syncMetronomeButtons();
    syncMasterUi();
    syncCallButtons();
}

function postViewModeToParent() {
    try { window.parent.postMessage({ type: 'notationViewMode', mode: state.viewMode }, '*'); } catch {}
}

function setViewMode(mode) {
    const nextMode = mode === 'circular' ? 'circular' : 'linear';
    state.viewMode = nextMode;
    const circularPopout = document.getElementById('circularPopout');

    if (state.viewMode === 'circular') {
        circularPopout?.classList.remove('hidden');
        initCircularView();
        if (state.isPlaying) startCircularAnimation();
        else drawCircularView();
    } else {
        circularPopout?.classList.add('hidden');
        stopCircularAnimation();
    }
    syncViewButtons();
    postViewModeToParent();
    postNotationStateToParent();
}

// Toggle between linear and circular view
function toggleView() {
    setViewMode(state.viewMode === 'linear' ? 'circular' : 'linear');
}

function setupCircularPopout() {
    const popout = document.getElementById('circularPopout');
    const header = document.getElementById('circularPopoutHeader');
    if (!popout || !header) return;

    if (circularOnlyMode) {
        popout.classList.remove('hidden');
        const closeBtn = popout.querySelector('.circular-popout-close');
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    const minW = 160;
    const minH = 160;
    const edgeGap = 8;

    const savedRaw = localStorage.getItem('notationCircularPopoutLayout');
    let hasSavedLayout = false;
    if (savedRaw) {
        try {
            const saved = JSON.parse(savedRaw);
            if (Number.isFinite(saved.width)) popout.style.width = Math.max(minW, saved.width) + 'px';
            if (Number.isFinite(saved.height)) popout.style.height = Math.max(minH, saved.height) + 'px';
            if (Number.isFinite(saved.left)) popout.style.left = Math.round(saved.left) + 'px';
            if (Number.isFinite(saved.top)) popout.style.top = Math.round(saved.top) + 'px';
            if (saved.left !== undefined) popout.style.right = 'auto';
            hasSavedLayout = true;
        } catch (err) {}
    }

    function saveLayout() {
        const rect = popout.getBoundingClientRect();
        localStorage.setItem('notationCircularPopoutLayout', JSON.stringify({
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        }));
    }

    function clampPosition(left, top, width, height) {
        const maxLeft = Math.max(edgeGap, window.innerWidth - width - edgeGap);
        const maxTop = Math.max(edgeGap, window.innerHeight - height - edgeGap);
        return {
            left: Math.min(Math.max(edgeGap, left), maxLeft),
            top: Math.min(Math.max(edgeGap, top), maxTop)
        };
    }

    function clampWindowToViewport() {
        const rect = popout.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;
        const width = Math.max(minW, rect.width);
        const height = Math.max(minH, rect.height);
        const clamped = clampPosition(rect.left, rect.top, width, height);
        popout.style.width = Math.round(Math.min(width, window.innerWidth - edgeGap * 2)) + 'px';
        popout.style.height = Math.round(Math.min(height, window.innerHeight - edgeGap * 2)) + 'px';
        popout.style.left = Math.round(clamped.left) + 'px';
        popout.style.top = Math.round(clamped.top) + 'px';
        popout.style.right = 'auto';
    }

    let mode = null;
    let pointerId = null;
    let activeDir = '';
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let startW = 0;
    let startH = 0;

    function beginInteraction(nextMode, e, dir = '') {
        if (e.pointerType !== 'touch' && e.button !== 0) return;
        const rect = popout.getBoundingClientRect();
        mode = nextMode;
        pointerId = e.pointerId;
        activeDir = dir;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        startW = rect.width;
        startH = rect.height;
        popout.classList.add(nextMode === 'drag' ? 'dragging' : 'resizing');
        try { popout.setPointerCapture(pointerId); } catch (err) {}
    }

    header.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, select, textarea, a, [role="button"]')) return;
        beginInteraction('drag', e);
    });

    popout.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-circular-resize]');
        if (!handle) return;
        beginInteraction('resize', e, handle.getAttribute('data-circular-resize') || '');
    });

    popout.addEventListener('pointermove', (e) => {
        if (!mode || e.pointerId !== pointerId) return;
        e.preventDefault();

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (mode === 'drag') {
            const next = clampPosition(startLeft + dx, startTop + dy, startW, startH);
            popout.style.left = Math.round(next.left) + 'px';
            popout.style.top = Math.round(next.top) + 'px';
            popout.style.right = 'auto';
            return;
        }

        let newLeft = startLeft;
        let newTop = startTop;
        let newW = startW;
        let newH = startH;

        const resizeRight = activeDir.includes('e');
        const resizeLeft = activeDir.includes('w');
        const resizeBottom = activeDir.includes('s');
        const resizeTop = activeDir.includes('n');

        if (resizeRight) newW = startW + dx;
        if (resizeLeft) {
            newW = startW - dx;
            newLeft = startLeft + dx;
        }
        if (resizeBottom) newH = startH + dy;
        if (resizeTop) {
            newH = startH - dy;
            newTop = startTop + dy;
        }

        if (newW < minW) {
            if (resizeLeft) newLeft -= (minW - newW);
            newW = minW;
        }
        if (newH < minH) {
            if (resizeTop) newTop -= (minH - newH);
            newH = minH;
        }

        const maxW = Math.max(minW, window.innerWidth - edgeGap * 2);
        const maxH = Math.max(minH, window.innerHeight - edgeGap * 2);
        newW = Math.min(newW, maxW);
        newH = Math.min(newH, maxH);

        const clamped = clampPosition(newLeft, newTop, newW, newH);
        popout.style.width = Math.round(newW) + 'px';
        popout.style.height = Math.round(newH) + 'px';
        popout.style.left = Math.round(clamped.left) + 'px';
        popout.style.top = Math.round(clamped.top) + 'px';
        popout.style.right = 'auto';
        if (state.viewMode === 'circular') initCircularView();
    }, { passive: false });

    const finish = () => {
        if (!mode) return;
        popout.classList.remove('dragging', 'resizing');
        mode = null;
        pointerId = null;
        activeDir = '';
        saveLayout();
        if (state.viewMode === 'circular') initCircularView();
    };

    popout.addEventListener('pointerup', finish);
    popout.addEventListener('pointercancel', finish);
    popout.addEventListener('lostpointercapture', finish);

    const ro = new ResizeObserver(() => {
        if (state.viewMode === 'circular') initCircularView();
    });
    ro.observe(popout);

    window.addEventListener('resize', () => {
        clampWindowToViewport();
        if (state.viewMode === 'circular') initCircularView();
    });

    if (hasSavedLayout) clampWindowToViewport();
}

function setupCircularOnlyDragBridge() {
    if (!circularOnlyMode) return;
    let dragging = false;
    let pointerId = null;
    let lastX = 0;
    let lastY = 0;
    const interactiveSelector = 'button, input, select, textarea, a, [role="button"], [data-no-drag]';

    function send(phase, extra = {}) {
        try {
            window.parent.postMessage({
                type: 'notationCircularDragBridge',
                phase,
                ...extra
            }, '*');
        } catch {}
    }

    document.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' && e.button !== 0) return;
        if (!(e.target instanceof Element)) return;
        if (e.target.closest(interactiveSelector)) return;
        dragging = true;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        try { e.target.setPointerCapture(pointerId); } catch (err) {}
        send('start', {
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY
        });
        e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (dx !== 0 || dy !== 0) {
            send('move', {
                dx,
                dy,
                clientX: e.clientX,
                clientY: e.clientY,
                screenX: e.screenX,
                screenY: e.screenY
            });
        }
        e.preventDefault();
    }, { passive: false });

    const finish = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        pointerId = null;
        send('end');
    };

    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    document.addEventListener('lostpointercapture', finish);
    window.addEventListener('blur', () => {
        if (!dragging) return;
        dragging = false;
        pointerId = null;
        send('cancel');
    });
}

function applyCompactMode() {
    document.body.classList.toggle('compact-mode', !!state.compactMode);
    const compactBtn = document.getElementById('compactViewBtn');
    if (compactBtn) {
        compactBtn.textContent = state.compactMode ? 'Full' : 'Compact';
    }
    const compactFullBtn = document.getElementById('compactFullViewBtn');
    if (compactFullBtn) {
        compactFullBtn.textContent = state.compactMode ? 'Expand View' : 'Compact View';
    }
    applyCompactInstrumentPanel();
    applyCompactModeRows();
    syncCompactUi();
    requestAnimationFrame(() => {
        syncNotationContainerToViewport();
        applyGridViewportHeightForMode();
        requestAutoScaleGridPasses();
    });
}

function toggleCompactMode() {
    state.compactMode = !state.compactMode;
    applyCompactMode();
    saveToLocalStorage();
}

function applyCompactInstrumentPanel() {
    const panel = document.getElementById('compactBottomControls');
    if (!panel) return;
    panel.classList.toggle('is-collapsed', state.compactInstrumentPanelOpen === false);
}

function toggleCompactInstrumentPanel() {
    state.compactInstrumentPanelOpen = state.compactInstrumentPanelOpen === false;
    applyCompactInstrumentPanel();
    syncCompactUi();
    requestAutoScaleGridPasses();
    saveToLocalStorage();
}

function toggleSoundStagePanel() {
    const panel = document.getElementById('soundStagePanel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        renderSoundStageTokens();
    }
    localStorage.setItem('notationSoundStageOpen', panel.classList.contains('hidden') ? 'false' : 'true');
    saveToLocalStorage();
}

function updateInstrumentFromStagePosition(instrument, xNorm, yNorm) {
    instrument.stageX = clampStageNorm(xNorm, instrument.stageX || 0);
    instrument.stageY = clampStageNorm(yNorm, instrument.stageY || 0);
    instrument.pan = (instrument.stageX * 2) - 1;
    instrument.volume = volumeFromStageY(instrument.stageY);
}

function setInstrumentStagePositionById(instrumentId, xNorm, yNorm, options = {}) {
    const targetId = String(instrumentId || '').trim();
    if (!targetId) return false;
    const transient = !!options.transient;
    const instrument = state.instruments.find((entry) => String(entry?.id || '') === targetId);
    if (!instrument) return false;
    updateInstrumentFromStagePosition(instrument, xNorm, yNorm);
    const row = document.querySelector(`.instrument-row[data-instrument="${targetId}"]`);
    if (row) {
        const slider = row.querySelector('.instrument-volume input[type="range"]');
        const icon = row.querySelector('.instrument-volume-icon');
        if (slider) {
            slider.value = String(instrument.volume);
            slider.style.setProperty('--volume-fill', `${instrument.volume * 100}%`);
            slider.title = `Volume: ${Math.round(instrument.volume * 100)}%`;
        }
        if (icon) {
            icon.textContent = instrument.volume === 0 ? '🔇' : instrument.volume < 0.5 ? '🔉' : '🔊';
        }
    }
    if (!transient) {
        updateInstrumentToolbar();
    }
    if (!transient) {
        renderSoundStageTokens();
        saveToLocalStorage();
        postRhythmStateToParent();
    }
    return true;
}

function renderSoundStageTokens() {
    const area = document.getElementById('soundStageArea');
    if (!area) return;
    area.querySelectorAll('.sound-stage-token').forEach((el) => el.remove());
    const playable = state.instruments.slice();
    playable.forEach((instrument, idx) => {
        const token = document.createElement('div');
        token.className = 'sound-stage-token';
        token.dataset.instrumentId = instrument.id;
        const x = Number.isFinite(Number(instrument.stageX)) ? Number(instrument.stageX) : ((idx + 1) / (playable.length + 1));
        const y = Number.isFinite(Number(instrument.stageY)) ? Number(instrument.stageY) : stageYFromVolume(instrument.volume ?? 1);
        token.style.left = `${Math.round(x * 1000) / 10}%`;
        token.style.top = `${Math.round(y * 1000) / 10}%`;

        const iconWrap = document.createElement('div');
        iconWrap.className = 'sound-stage-token-icon';
        const iconPath = getInstrumentIconPath(instrument);
        if (iconPath) {
            const img = document.createElement('img');
            img.src = iconPath;
            img.alt = instrument.name || 'Instrument';
            iconWrap.appendChild(img);
        } else {
            iconWrap.textContent = instrument.icon || '🎵';
        }
        token.appendChild(iconWrap);

        const label = document.createElement('div');
        label.className = 'sound-stage-token-label';
        label.textContent = instrument.name || instrument.id;
        label.style.color = `hsl(${(idx * 43) % 360} 90% 72%)`;
        token.appendChild(label);
        area.appendChild(token);
    });
}

function setupSoundStagePanel() {
    const panel = document.getElementById('soundStagePanel');
    const header = document.getElementById('soundStageHeader');
    const area = document.getElementById('soundStageArea');
    const resetBtn = document.getElementById('soundStageResetBtn');
    if (!panel || !header || !area) return;

    const savedRaw = localStorage.getItem('notationSoundStageLayout');
    if (savedRaw) {
        try {
            const saved = JSON.parse(savedRaw);
            if (Number.isFinite(saved.left)) panel.style.left = `${Math.round(saved.left)}px`;
            if (Number.isFinite(saved.top)) panel.style.top = `${Math.round(saved.top)}px`;
            if (Number.isFinite(saved.width)) panel.style.width = `${Math.round(saved.width)}px`;
            if (Number.isFinite(saved.height)) panel.style.height = `${Math.round(saved.height)}px`;
        } catch {}
    }
    if (localStorage.getItem('notationSoundStageOpen') === 'true') {
        panel.classList.remove('hidden');
    }

    const persistLayout = () => {
        const rect = panel.getBoundingClientRect();
        localStorage.setItem('notationSoundStageLayout', JSON.stringify({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        }));
        localStorage.setItem('notationSoundStageOpen', panel.classList.contains('hidden') ? 'false' : 'true');
    };

    let dragPointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    header.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' && e.button !== 0) return;
        if (e.target.closest('button')) return;
        dragPointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        try { header.setPointerCapture(dragPointerId); } catch {}
    });
    header.addEventListener('pointermove', (e) => {
        if (dragPointerId !== e.pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = `${Math.round(startLeft + dx)}px`;
        panel.style.top = `${Math.round(startTop + dy)}px`;
    });
    const finishHeaderDrag = (e) => {
        if (dragPointerId !== e.pointerId) return;
        dragPointerId = null;
        persistLayout();
    };
    header.addEventListener('pointerup', finishHeaderDrag);
    header.addEventListener('pointercancel', finishHeaderDrag);

    let tokenPointerId = null;
    let activeToken = null;
    let pendingTokenPos = null;
    let lastSentPixelPos = null;
    const liveUpdatePixelThreshold = 6;
    const moveToken = (clientX, clientY) => {
        if (!activeToken) return;
        const rect = area.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
        pendingTokenPos = { x, y };
        activeToken.style.left = `${Math.round(x * 1000) / 10}%`;
        activeToken.style.top = `${Math.round(y * 1000) / 10}%`;

        const instrumentId = activeToken.dataset.instrumentId;
        if (!instrumentId) return;

        const px = x * Math.max(1, rect.width);
        const py = y * Math.max(1, rect.height);
        if (!lastSentPixelPos) {
            lastSentPixelPos = { x: px, y: py };
            setInstrumentStagePositionById(instrumentId, x, y, { transient: true });
            return;
        }

        const dx = px - lastSentPixelPos.x;
        const dy = py - lastSentPixelPos.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= liveUpdatePixelThreshold) {
            lastSentPixelPos = { x: px, y: py };
            setInstrumentStagePositionById(instrumentId, x, y, { transient: true });
        }
    };

    area.addEventListener('pointerdown', (e) => {
        const token = e.target instanceof Element ? e.target.closest('.sound-stage-token') : null;
        if (!token) return;
        tokenPointerId = e.pointerId;
        activeToken = token;
        pendingTokenPos = null;
        lastSentPixelPos = null;
        activeToken.classList.add('dragging');
        try { token.setPointerCapture(tokenPointerId); } catch {}
        moveToken(e.clientX, e.clientY);
        e.preventDefault();
    }, { passive: false });

    area.addEventListener('pointermove', (e) => {
        if (!activeToken || tokenPointerId !== e.pointerId) return;
        moveToken(e.clientX, e.clientY);
    });

    const releaseToken = (e) => {
        if (!activeToken || tokenPointerId !== e.pointerId) return;
        const instrumentId = activeToken.dataset.instrumentId;
        const commitPos = pendingTokenPos;
        activeToken.classList.remove('dragging');
        activeToken = null;
        tokenPointerId = null;
        lastSentPixelPos = null;
        pendingTokenPos = null;
        if (instrumentId && commitPos) {
            setInstrumentStagePositionById(instrumentId, commitPos.x, commitPos.y, { transient: false });
        }
        persistLayout();
    };
    area.addEventListener('pointerup', releaseToken);
    area.addEventListener('pointercancel', releaseToken);

    if (resetBtn && !resetBtn.dataset.bound) {
        resetBtn.dataset.bound = 'true';
        resetBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resetSoundStageLayout();
            persistLayout();
        });
    }

    window.addEventListener('resize', () => {
        if (!panel.classList.contains('hidden')) renderSoundStageTokens();
        persistLayout();
    });

    if (!panel.classList.contains('hidden')) {
        renderSoundStageTokens();
    }
}

function applyCompactModeRows() {
    const rows = Array.from(document.querySelectorAll('#notationGrid .instrument-row'));
    if (!rows.length) return;
    rows.forEach((row) => {
        row.classList.remove('compact-hidden');
    });
}

function cyclicalPrevInstrument() {
    const visibleInstruments = state.instruments.filter(i => i.visible !== false);
    if (visibleInstruments.length === 0) return;

    state.circularInstrumentIndex = (state.circularInstrumentIndex - 1 + visibleInstruments.length) % visibleInstruments.length;
    drawCircularView();
}

function cyclicalNextInstrument() {
    const visibleInstruments = state.instruments.filter(i => i.visible !== false);
    if (visibleInstruments.length === 0) return;

    state.circularInstrumentIndex = (state.circularInstrumentIndex + 1) % visibleInstruments.length;
    drawCircularView();
}

function getCircularCanvasSize() {
    const popoutBody = document.getElementById('circularPopoutBody');
    if (!popoutBody) return 240;
    const rect = popoutBody.getBoundingClientRect();
    let availableW = Math.max(90, rect.width - 12);
    let availableH = Math.max(90, rect.height - 12);
    if (!Number.isFinite(availableW) || availableW < 10) availableW = Math.max(90, window.innerWidth * 0.3);
    if (!Number.isFinite(availableH) || availableH < 10) availableH = Math.max(90, window.innerHeight * 0.3);
    return Math.max(90, Math.floor(Math.min(availableW, availableH)));
}

function initCircularView() {
    const canvas = document.getElementById('circularCanvas');
    if (!canvas) return;
    const size = getCircularCanvasSize();
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    drawCircularView();
}

// Circular view animation loop
let circularAnimId = null;
let circularLastStep = -1;

function startCircularAnimation() {
    if (circularAnimId) return;
    function frame() {
        drawCircularView();
        circularAnimId = requestAnimationFrame(frame);
    }
    circularAnimId = requestAnimationFrame(frame);
}

function stopCircularAnimation() {
    if (circularAnimId) { cancelAnimationFrame(circularAnimId); circularAnimId = null; }
}

function drawCircularView() {
    const canvas = document.getElementById('circularCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const s = getCircularCanvasSize();
    if (canvas.width !== s * dpr || canvas.height !== s * dpr) {
        canvas.width = s * dpr;
        canvas.height = s * dpr;
        canvas.style.width = s + 'px';
        canvas.style.height = s + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const dispSize = parseInt(canvas.style.width) || 400;
    const baseDialScale = Math.max(0.5, Math.min(1.5, dispSize / 400));
    const dialScale = Math.max(0.35, Math.min(2.2, baseDialScale));
    const centerX = dispSize / 2;
    const centerY = dispSize / 2;
    const radius = Math.max(34, centerX - (40 * dialScale));

    ctx.clearRect(0, 0, dispSize, dispSize);

    // Draw circular background
    ctx.fillStyle = 'rgba(38, 38, 38, 0.6)';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + (25 * dialScale), 0, 2 * Math.PI);
    ctx.fill();

    const visibleInstruments = state.instruments.filter(i => i.visible !== false);
    if (visibleInstruments.length === 0) return;

    state.circularInstrumentIndex = ((state.circularInstrumentIndex % visibleInstruments.length) + visibleInstruments.length) % visibleInstruments.length;
    const instrument = visibleInstruments[state.circularInstrumentIndex];
    document.getElementById('circularInstrumentName').textContent = instrument.name;

    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const anglePerStep = (2 * Math.PI) / totalSteps;

    // Smooth radar angle synced to the last played step timestamp.
    let radarAngle = -Math.PI / 2;
    const fallbackStep = Number.isFinite(Number(state.currentStep)) ? parseInt(state.currentStep, 10) : 0;
    const anchorStepRaw = Number.isFinite(Number(state._lastPlayedStep))
        ? parseInt(state._lastPlayedStep, 10)
        : fallbackStep;
    const anchorStep = ((anchorStepRaw % totalSteps) + totalSteps) % totalSteps;
    let radarBeatStep = anchorStep;
    let radarStepProgress = 0;
    if (state.isPlaying) {
        const plan = buildStepTimingPlan();
        const stepMs = Math.max(
            1,
            Number.isFinite(Number(plan.cycleMs))
                ? (Number(plan.cycleMs) / Math.max(1, totalSteps))
                : ((60000 / Math.max(1, state.tempo)) / Math.max(1, state.subdivisions))
        );
        const useSmoothCircularArrow = debugSettings.smoothCircularArrow !== false;
        const timeSinceStep = state._lastStepEpoch
            ? (Date.now() - state._lastStepEpoch + (debugSettings.dialSyncOffset || 0))
            : (performance.now() - (state._lastStepTime || performance.now()) + (debugSettings.dialSyncOffset || 0));
        const progress = useSmoothCircularArrow
            ? Math.min(0.999, Math.max(0, timeSinceStep / stepMs))
            : 0;
        radarStepProgress = progress;
        const smoothStep = anchorStep + progress;
        radarBeatStep = anchorStep;
        radarAngle = -Math.PI / 2 + (smoothStep / totalSteps) * 2 * Math.PI;
        const radarBeatColor = getBeatColorForStep(radarBeatStep);
        const radarGlowStrong = hexToRgbaColor(radarBeatColor, 0.25);
        const radarGlowMid = hexToRgbaColor(radarBeatColor, 0.1);
        const radarGlowEdge = hexToRgbaColor(radarBeatColor, 0);

        // Draw gradient sweep (centered on radar line)
        const sweepHalf = Math.PI / 12;
        const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
        gradient.addColorStop(0, radarGlowStrong);
        gradient.addColorStop(0.5, radarGlowMid);
        gradient.addColorStop(1, radarGlowEdge);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, radarAngle - sweepHalf, radarAngle + sweepHalf);
        ctx.closePath();
        ctx.fill();

        // Draw radar line
        ctx.strokeStyle = radarBeatColor;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 15;
        ctx.shadowColor = radarBeatColor;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(centerX + Math.cos(radarAngle) * radius, centerY + Math.sin(radarAngle) * radius);
        ctx.stroke();
        ctx.shadowBlur = 0;
    }
    const centerBeatColor = getBeatColorForStep(radarBeatStep);

    // Pulse only on beat starts (downbeats), not every subdivision step.
    const isBeatStartStep = (radarBeatStep % Math.max(1, state.subdivisions)) === 0;
    const subProgress = state.isPlaying ? radarStepProgress : 0;
    const heartPulse = (state.isPlaying && isBeatStartStep) ? Math.max(0, 1 - subProgress * 2.5) : 0;
    const heartSize = (12 * dialScale) + heartPulse * (6 * dialScale);
    ctx.fillStyle = hexToRgbaColor(centerBeatColor, 0.62 + (heartPulse * 0.26));
    ctx.shadowBlur = 10 + heartPulse * 8;
    ctx.shadowColor = hexToRgbaColor(centerBeatColor, 0.8);
    ctx.beginPath();
    ctx.arc(centerX, centerY, heartSize, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Tick marks
    for (let i = 0; i < totalSteps; i++) {
        const beat = Math.floor(i / state.subdivisions);
        const sub = i % state.subdivisions;
        const isDownbeat = sub === 0;
        const angle = -Math.PI / 2 + i * anglePerStep;
        const tickStart = radius;
        const tickEnd = radius - ((isDownbeat ? 18 : 10) * dialScale);
        const beatColor = debugSettings.beatColors[beat % 12];

        ctx.strokeStyle = beatColor;
        ctx.lineWidth = isDownbeat ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(centerX + Math.cos(angle) * tickStart, centerY + Math.sin(angle) * tickStart);
        ctx.lineTo(centerX + Math.cos(angle) * tickEnd, centerY + Math.sin(angle) * tickEnd);
        ctx.stroke();

        if (isDownbeat) {
            ctx.fillStyle = beatColor;
            ctx.font = `bold ${Math.max(8, Math.round(13 * dialScale))}px Orbitron`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const numRadius = radius - (30 * dialScale);
            ctx.fillText(beat + 1, centerX + Math.cos(angle) * numRadius, centerY + Math.sin(angle) * numRadius);
        }
    }

    // Notation symbols
    for (let i = 0; i < totalSteps; i++) {
        const sound = instrument.pattern[i];
        if (sound && sound !== 'silence') {
            const sub = i % state.subdivisions;
            const swingKey = String.fromCharCode(65 + (sub % 4));
            const swingOffset = (state.swing[swingKey] || 0) / 100;
            const angle = -Math.PI / 2 + i * anglePerStep + swingOffset * anglePerStep;
            const notationRadius = radius - (55 * dialScale);
            const noteX = centerX + Math.cos(angle) * notationRadius;
            const noteY = centerY + Math.sin(angle) * notationRadius;
            const soundType = soundTypes[sound];
            if (!soundType) continue;

            // Pulse on current step
            const isCurrentStep = state.isPlaying && i === anchorStep;
            const sizeBoost = isCurrentStep ? 4 : 0;

            if (sound === 'tone') {
                ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-yellow').trim();
                ctx.fillStyle = `rgba(252, 209, 22, ${isCurrentStep ? 0.4 : 0.15})`;
                ctx.lineWidth = isCurrentStep ? 3.5 : 2.5;
                ctx.beginPath();
                ctx.arc(noteX, noteY, (10 * dialScale) + sizeBoost, 0, 2 * Math.PI);
                ctx.fill(); ctx.stroke();
            } else {
                const accent = sound === 'slap' || sound === 'bell'
                    ? getComputedStyle(document.documentElement).getPropertyValue('--accent-red').trim()
                    : sound === 'bass'
                        ? getComputedStyle(document.documentElement).getPropertyValue('--accent-green').trim()
                        : sound === 'mute'
                            ? getComputedStyle(document.documentElement).getPropertyValue('--accent-orange').trim()
                            : 'rgba(100, 100, 100, 0.5)';
                if (debugSettings.useNeonArticulationStyle) {
                    ctx.fillStyle = 'rgba(20, 20, 20, 0.86)';
                    ctx.strokeStyle = accent;
                    ctx.lineWidth = isCurrentStep ? 2.8 : 2.1;
                    if (isCurrentStep) { ctx.shadowBlur = 12; ctx.shadowColor = accent; }
                    ctx.beginPath();
                    ctx.arc(noteX, noteY, (9 * dialScale) + sizeBoost, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                } else {
                    ctx.fillStyle = accent;
                    if (isCurrentStep) { ctx.shadowBlur = 12; ctx.shadowColor = ctx.fillStyle; }
                    ctx.beginPath();
                    ctx.arc(noteX, noteY, (9 * dialScale) + sizeBoost, 0, 2 * Math.PI);
                    ctx.fill();
                }
                ctx.beginPath();
                ctx.shadowBlur = 0;
                ctx.fillStyle = debugSettings.useNeonArticulationStyle ? accent : 'white';
                ctx.font = `bold ${Math.max(8, Math.round((11 * dialScale) + sizeBoost))}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(soundType.char, noteX, noteY);
            }
        }
    }
}

/* Update soundTypes mapping for notation standards */
const soundTypes = {
    slap: { char: 'X', class: 'slap' },
    tone: { char: '○', class: 'tone' },
    bass: { char: 'B', class: 'active' },
    mute: { char: 'M', class: 'mute' },
    bell: { char: 'X', class: 'bell' },
    silence: { char: '—', class: 'silence' },
    clear: { char: '—', class: 'silence' }
};
// Flam and roll values look and colour like their main stroke; the grace note is drawn small before it.
['tone', 'slap', 'bass', 'mute'].forEach((grace) => {
    [null, 'tone', 'slap', 'bass', 'mute'].forEach((main) => {
        ['Flam', 'Roll'].forEach((kind) => {
            const name = grace + (main ? main[0].toUpperCase() + main.slice(1) : '') + kind;
            const base = soundTypes[main || grace];
            soundTypes[name] = { char: base.char, class: base.class, stroke: true };
        });
    });
});

function renderBoxSymbol(box, sound) {
    box.textContent = '';
    const stroke = parseStroke(sound);
    if (stroke) {
        const grace = document.createElement('span');
        grace.className = 'stroke-grace';
        grace.textContent = (stroke.kind === 'roll' ? '≈' : '') + soundTypes[stroke.grace].char;
        box.appendChild(grace);
        if (stroke.main === 'tone') {
            const ring = document.createElement('span');
            ring.className = 'open-circle-symbol';
            box.appendChild(ring);
        } else {
            box.appendChild(document.createTextNode(soundTypes[stroke.main].char));
        }
        return;
    }
    if (sound === 'tone') {
        const ring = document.createElement('span');
        ring.className = 'open-circle-symbol';
        if (debugSettings.useNeonArticulationStyle) {
            ring.classList.add('open-circle-symbol-filled');
        }
        box.appendChild(ring);
        return;
    }
    if (soundTypes[sound]) {
        box.textContent = soundTypes[sound].char;
    }
}

// Articulation definitions
const ARTICULATIONS = {
    Open: {
        label: 'Open',
        symbol: 'O',
        color: '--accent-yellow',
        audio: ['Open', 'OpenL'],
    },
    Slap: {
        label: 'Slap',
        symbol: 'X',
        color: '--accent-red',
        audio: ['Slap', 'SlapL'],
    },
    Bass: {
        label: 'Bass',
        symbol: '●',
        color: '--accent-green',
        audio: ['Bass', 'BassL'],
    },
    Ghost: {
        label: 'Mute/Muffle',
        symbol: 'M',
        color: '--accent-gray',
        audio: ['Mute', 'MuteL'],
    },
    Silence: {
        label: 'Silence',
        symbol: '—',
        color: '--accent-silence',
        audio: [],
    },
    Muffled: {
        label: 'Muffled',
        symbol: 'm',
        color: '--accent-muffled',
        audio: ['Muffled'],
    }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadFromLocalStorage();
    ensureCallInstrumentExists(); // NEW: Safeguard to ensure Call is always present
    ensureShekereInstrumentExists();
    normalizeInstrumentRuntimeState();
    const legacyStagePanel = document.getElementById('soundStagePanel');
    if (legacyStagePanel) legacyStagePanel.classList.add('hidden');
    setupCircularPopout();
    setupDebugPanel();
    updateInstrumentToolbar();
    updateGrid();
    setupGridViewportResizer();
    setupEventListeners();
    populateRhythmSelectionDropdowns();
    requestRhythmCatalogFromParent();
    setupNotationHelpInteractions();
    applyCompactMode();
    syncCompactUi();
    syncViewButtons();
    syncPlaybackButtons();
    syncMetronomeButtons();
    syncMasterUi();
    syncCycleModeUi();

    // Initialize swing UI
    updateSwingUI();

    // Auto-scale grid to container width
    setupGridAutoScale();

    if (circularOnlyMode) {
        document.body.classList.add('circular-only-mode');
        setViewMode('circular');
        setupCircularOnlyDragBridge();
    }

    if (!circularOnlyMode) {
        // Load audio in the background so the grid/UI appears immediately.
        Promise.resolve()
            .then(() => ensureAudioSamplesReady())
            .then(() => {
                // Initialize reverb after context + samples are ready.
                initReverb();
                setReverbAmount(debugSettings.reverbAmount);
                applyMasterGain();
            })
            .catch((err) => {
                console.warn('Audio preload failed:', err);
                // Keep playback functional even when preload fails.
                if (!masterGain) {
                    initReverb();
                    setReverbAmount(debugSettings.reverbAmount);
                    applyMasterGain();
                }
            });
    }

    postTempoStateToParent();
    postNotationStateToParent();
});

function setupGridAutoScale() {
    // Observe both the container AND the body (catches iframe resize)
    const container = document.querySelector('.notation-container') || document.getElementById('notationContainer');
    if (!container) return;
    const ro = new ResizeObserver(() => {
        requestAutoScaleGridPasses();
        if (state.viewMode === 'circular') initCircularView();
    });
    ro.observe(container);
    ro.observe(document.body);
    if (!gridAutoScaleListenersBound) {
        gridAutoScaleListenersBound = true;
        window.addEventListener('orientationchange', () => requestAutoScaleGridPasses(), { passive: true });
        window.addEventListener('pageshow', () => requestAutoScaleGridPasses(), { passive: true });
        window.addEventListener('resize', () => requestAutoScaleGridPasses(), { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') requestAutoScaleGridPasses();
        });
    }
    requestAutoScaleGridPasses();
}

function getGridViewportModeKey() {
    return state.compactMode ? 'compact' : 'full';
}

function requestAutoScaleGridPasses() {
    if (autoScaleGridRaf) {
        cancelAnimationFrame(autoScaleGridRaf);
        autoScaleGridRaf = null;
    }
    autoScaleGridRaf = requestAnimationFrame(() => {
        autoScaleGridRaf = null;
        autoScaleGrid();
        requestAnimationFrame(() => autoScaleGrid());
    });
    if (autoScaleGridTimeout) {
        clearTimeout(autoScaleGridTimeout);
        autoScaleGridTimeout = null;
    }
    autoScaleGridTimeout = window.setTimeout(() => {
        autoScaleGridTimeout = null;
        autoScaleGrid();
    }, 140);
}

function readGridViewportHeights() {
    try {
        const raw = localStorage.getItem(GRID_VIEWPORT_HEIGHT_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

function writeGridViewportHeights(map) {
    try {
        localStorage.setItem(GRID_VIEWPORT_HEIGHT_STORAGE_KEY, JSON.stringify(map || {}));
    } catch {}
}

function clampGridViewportHeight(value) {
    const viewport = document.getElementById('notationGridViewport');
    if (!viewport) return 220;
    const container = document.getElementById('notationContainer') || viewport.parentElement;
    const minH = state.compactMode ? 90 : 110;
    if (!container) return Math.max(minH, Math.round(value || minH));
    const rect = container.getBoundingClientRect();
    const maxH = Math.max(minH, Math.round(rect.height - 28));
    return Math.max(minH, Math.min(maxH, Math.round(value || minH)));
}

function syncNotationContainerToViewport() {
    const container = document.getElementById('notationContainer');
    if (!container) return;
    if (state.viewMode === 'circular') return;

    const rect = container.getBoundingClientRect();
    if (!Number.isFinite(rect.top)) return;

    const bottomPadding = state.compactMode ? 6 : 10;
    const minContainerHeight = state.compactMode ? 130 : 150;
    const available = Math.max(0, Math.floor(window.innerHeight - rect.top - bottomPadding));
    const target = Math.max(minContainerHeight, available);

    if (state.compactMode) {
        // Compact mode is fixed-layout by design.
        container.style.height = `${target}px`;
        container.style.minHeight = `${target}px`;
        container.style.maxHeight = `${target}px`;
        return;
    }

    // Full mode should fill available space, but still allow page scrolling on
    // very small windows when controls + grid exceed viewport height.
    container.style.height = 'auto';
    container.style.minHeight = `${target}px`;
    container.style.maxHeight = 'none';
}

function applyGridViewportHeightForMode(modeKey = getGridViewportModeKey()) {
    const viewport = document.getElementById('notationGridViewport');
    if (!viewport) return;
    const byMode = readGridViewportHeights();
    const saved = Number(byMode[modeKey]);
    if (!Number.isFinite(saved)) {
        viewport.style.height = '';
        viewport.style.minHeight = state.compactMode ? '90px' : '110px';
        return;
    }
    const clamped = clampGridViewportHeight(saved);
    viewport.style.height = clamped + 'px';
}

function setupGridViewportResizer() {
    const viewport = document.getElementById('notationGridViewport');
    const topHandle = document.getElementById('notationGridResizeTop');
    const bottomHandle = document.getElementById('notationGridResizeBottom');
    if (!viewport || !topHandle || !bottomHandle) return;

    syncNotationContainerToViewport();
    applyGridViewportHeightForMode();

    const beginResize = (event, direction) => {
        const startY = Number(event.clientY);
        if (!Number.isFinite(startY)) return;
        const startHeight = viewport.getBoundingClientRect().height;
        gridViewportResizeState = { direction, startY, startHeight };
        document.body.classList.add('notation-grid-resizing');
        try { event.target.setPointerCapture(event.pointerId); } catch {}
        event.preventDefault();
    };

    const onPointerMove = (event) => {
        if (!gridViewportResizeState) return;
        const currentY = Number(event.clientY);
        if (!Number.isFinite(currentY)) return;
        const deltaY = currentY - gridViewportResizeState.startY;
        const signedDelta = gridViewportResizeState.direction === 'top' ? -deltaY : deltaY;
        const next = clampGridViewportHeight(gridViewportResizeState.startHeight + signedDelta);
        viewport.style.height = next + 'px';
        event.preventDefault();
    };

    const finishResize = () => {
        if (!gridViewportResizeState) return;
        const modeKey = getGridViewportModeKey();
        const byMode = readGridViewportHeights();
        const currentHeight = viewport.getBoundingClientRect().height;
        byMode[modeKey] = clampGridViewportHeight(currentHeight);
        writeGridViewportHeights(byMode);
        gridViewportResizeState = null;
        document.body.classList.remove('notation-grid-resizing');
        requestAutoScaleGridPasses();
    };

    topHandle.addEventListener('pointerdown', (event) => beginResize(event, 'top'));
    bottomHandle.addEventListener('pointerdown', (event) => beginResize(event, 'bottom'));
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', finishResize);
    window.addEventListener('resize', () => {
        syncNotationContainerToViewport();
        applyGridViewportHeightForMode();
        requestAutoScaleGridPasses();
    });
    window.addEventListener('scroll', () => {
        syncNotationContainerToViewport();
        applyGridViewportHeightForMode();
    }, { passive: true });

    // Keep page/main scrolling responsive after interacting with the internal
    // grid scroll area by handing overflow wheel delta back to the window.
    if (!viewport.dataset.scrollBridgeBound) {
        viewport.dataset.scrollBridgeBound = '1';
        viewport.addEventListener('wheel', (event) => {
            const deltaY = Number(event.deltaY) || 0;
            if (deltaY === 0) return;
            const atTop = viewport.scrollTop <= 0;
            const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
            const atBottom = viewport.scrollTop >= (maxTop - 1);
            const scrollingUp = deltaY < 0;
            const scrollingDown = deltaY > 0;

            if ((scrollingUp && atTop) || (scrollingDown && atBottom)) {
                event.preventDefault();
                window.scrollBy({ top: deltaY, behavior: 'auto' });
            }
        }, { passive: false });
    }
}

function updateNotationGridGuideMetrics() {
    const container = document.getElementById('notationContainer');
    const grid = document.getElementById('notationGrid');
    if (!container || !grid) return;

    const beatNumbers = document.getElementById('beatNumbers');
    const visibleRows = Array.from(grid.querySelectorAll('.instrument-row'))
        .filter((row) => row.offsetParent !== null && !row.classList.contains('hidden-row') && !row.classList.contains('compact-hidden'));
    let firstRowBoxes = null;
    let firstRowElement = null;
    for (const row of visibleRows) {
        const boxes = row.querySelector('.boxes-container');
        if (!boxes) continue;
        const rect = boxes.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
            firstRowElement = row;
            firstRowBoxes = boxes;
            break;
        }
    }
    if (!firstRowBoxes) firstRowBoxes = grid.querySelector('.instrument-row .boxes-container');
    if (!firstRowElement) firstRowElement = firstRowBoxes ? firstRowBoxes.closest('.instrument-row') : null;
    if (!firstRowBoxes) return;

    // Keep beat-number widths deterministic (box/divider widths), then derive only
    // the runtime center offset from the first visible notation box.
    if (beatNumbers) {
        const beatChildren = Array.from(beatNumbers.querySelectorAll('.beat-track-node, .beat-number, .group-spacer'));
        const rootStyles = getComputedStyle(document.documentElement);
        const boxWidth = Math.max(1, parseFloat(rootStyles.getPropertyValue('--box-size')) || 40);
        const groupWidth = Math.max(0, parseFloat(rootStyles.getPropertyValue('--group-gap')) || 8);
        beatChildren.forEach((child) => {
            const width = child.classList.contains('group-spacer') ? groupWidth : boxWidth;
            child.style.width = `${width}px`;
            child.style.minWidth = `${width}px`;
            child.style.maxWidth = `${width}px`;
        });

        const firstBeatNumber = beatNumbers.querySelector('.beat-number');
        const firstNotationBox = firstRowElement
            ? firstRowElement.querySelector('.boxes-container .notation-box')
            : firstRowBoxes.querySelector('.notation-box');
        if (firstBeatNumber && firstNotationBox) {
            const sourceRect = firstNotationBox.getBoundingClientRect();
            const targetRect = firstBeatNumber.getBoundingClientRect();
            const runtimeOffset = (sourceRect.left + (sourceRect.width * 0.5)) - (targetRect.left + (targetRect.width * 0.5));
            beatNumbers.style.setProperty('--beat-number-runtime-offset', `${runtimeOffset.toFixed(2)}px`);
        } else {
            beatNumbers.style.setProperty('--beat-number-runtime-offset', '0px');
        }

        // In wrapped layouts, lock every segment's node widths to the beat strip
        // so each wrapped row stays perfectly column-aligned.
        syncWrappedSegmentTrackWidths(grid, beatNumbers);
    }

    const sourceRect = firstRowBoxes.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!Number.isFinite(sourceRect.left) || !Number.isFinite(containerRect.left)) return;

    const left = Math.max(0, Math.round(sourceRect.left - containerRect.left));
    const width = Math.max(0, Math.round(sourceRect.width));
    container.style.setProperty('--notation-grid-guide-left', `${left}px`);
    container.style.setProperty('--notation-grid-guide-width', `${width}px`);
}

function autoScaleGrid() {
    const root = document.documentElement;
    const container = document.getElementById('notationContainer') || document.querySelector('.notation-container');
    const totalSteps = state.beats * state.subdivisions;
    if (!container || totalSteps <= 0) return;

    const wrappedLayout = isNotationWrappedLayout();
    const beatsPerRow = wrappedLayout
        ? Math.min(Math.max(1, parseInt(state.beats, 10) || 1), getNotationWrapBeatsPerRow())
        : Math.max(1, parseInt(state.beats, 10) || 1);
    const stepsPerRow = Math.max(1, beatsPerRow * Math.max(1, parseInt(state.subdivisions, 10) || 1));
    const dividerCount = Math.max(0, beatsPerRow - 1);
    const viewport = document.getElementById('notationGridViewport');
    const containerStyle = getComputedStyle(container);
    const containerPadX = (parseFloat(containerStyle.paddingLeft) || 0) + (parseFloat(containerStyle.paddingRight) || 0);
    const viewportWidth = viewport && viewport.clientWidth > 0 ? viewport.clientWidth : 0;
    const containerInnerWidth = Math.max(0, Math.floor(container.clientWidth - containerPadX));
    const widthCandidates = [viewportWidth, containerInnerWidth].filter((v) => Number.isFinite(v) && v > 0);
    // Use the narrower real width so we never size to a space the viewport cannot show.
    let availableWidth = widthCandidates.length > 0
        ? Math.min(...widthCandidates)
        : 0;
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
        availableWidth = Math.max(120, Math.floor(window.innerWidth - 24));
    }
    availableWidth = Math.max(96, availableWidth);

    // Preserve user tuning when possible, but always fit all steps in view.
    const baseInfoWidth = Math.max(96, debugSettings.instrumentInfoWidth || 180);
    const baseInfoCap = state.compactMode ? 220 : 240;
    const hardInfoFloor = state.compactMode ? 72 : 84;
    const playbackInfoPreferred = state.compactMode ? 182 : 192;
    // On narrow mobile windows, allow the info rail to shrink so the grid can still fit.
    const playbackInfoMinWidth = availableWidth < 560
        ? Math.max(hardInfoFloor, Math.floor(availableWidth * (state.compactMode ? 0.26 : 0.30)))
        : playbackInfoPreferred;
    const minInfoWidth = Math.max(hardInfoFloor, playbackInfoMinWidth);
    const baseInfo = Math.max(minInfoWidth, Math.min(baseInfoCap, baseInfoWidth));
    const baseBoxGap = Math.max(0, debugSettings.boxGap || 2);
    const baseGroupGap = Math.max(0, debugSettings.groupGap || 8);
    const baseBoxSize = Math.max(6, debugSettings.boxSize || 40);
    const gridScale = Math.max(0.5, debugSettings.gridScale || 1.0);
    const playheadGrowth = Math.max(1, Number(debugSettings.boxGrowth) || 1);
    const instrumentInfoTrailingPad = 10; // matches .instrument-info padding-right in CSS
    const rowRightPad = 10; // matches .boxes-container padding-right in CSS
    const trackNodeCount = Math.max(1, stepsPerRow + dividerCount);
    const interNodeGapCount = Math.max(0, trackNodeCount - 1);
    const computeEffectiveNodeGap = (boxSizeValue, boxGapValue) =>
        Math.max(0, boxGapValue + Math.max(0, (playheadGrowth - 1) * boxSizeValue * 0.5));
    const computeBoxesTrackWidth = (boxSizeValue, boxGapValue, groupGapValue) => {
        const nodeGap = computeEffectiveNodeGap(boxSizeValue, boxGapValue);
        return (stepsPerRow * boxSizeValue)
            + (dividerCount * groupGapValue)
            + (interNodeGapCount * nodeGap)
            + rowRightPad;
    };

    const desiredBoxSize = baseBoxSize * gridScale;
    const desiredBoxesWidth = computeBoxesTrackWidth(desiredBoxSize, baseBoxGap, baseGroupGap);
    const desiredTotal = baseInfo + instrumentInfoTrailingPad + desiredBoxesWidth;
    const fitRatio = Math.min(1, availableWidth / Math.max(1, desiredTotal));

    let infoWidth = Math.max(minInfoWidth, Math.round(baseInfo * fitRatio));
    let boxSize = Math.max(3, Math.min(60, desiredBoxSize * fitRatio));
    let boxGap = Math.max(0, Math.round(baseBoxGap * fitRatio));
    let groupGap = Math.max(0, Math.round(baseGroupGap * fitRatio));

    const estimateTotalWidth = () => (
        infoWidth + instrumentInfoTrailingPad + computeBoxesTrackWidth(boxSize, boxGap, groupGap)
    );
    let totalWidth = estimateTotalWidth();
    let guard = 0;
    while (totalWidth > availableWidth && guard < 64) {
        guard += 1;
        if (boxSize > 3) {
            boxSize -= 1;
        } else if (groupGap > 0) {
            groupGap -= 1;
        } else if (boxGap > 0) {
            boxGap -= 1;
        } else if (infoWidth > hardInfoFloor) {
            infoWidth -= 1;
        } else {
            break;
        }
        totalWidth = estimateTotalWidth();
    }

    const rawNameWidth = Math.max(34, Math.round((debugSettings.instrumentNameWidth || 80) * fitRatio));
    const compactNameCap = Math.max(62, Math.min(92, infoWidth - 52));
    let nameWidth = state.compactMode
        ? Math.min(rawNameWidth, compactNameCap)
        : Math.min(rawNameWidth, Math.max(58, infoWidth - 56));
    const fontSize = Math.max(5, Math.min(16, Math.round(boxSize * 0.42)));

    const applyGridSizingVars = () => {
        root.style.setProperty('--box-size', boxSize + 'px');
        root.style.setProperty('--box-gap', boxGap + 'px');
        root.style.setProperty('--group-gap', groupGap + 'px');
        root.style.setProperty('--instrument-info-width', infoWidth + 'px');
        root.style.setProperty('--instrument-name-width', nameWidth + 'px');
    };
    applyGridSizingVars();

    // Final safety pass: fit against the real rendered row width, not just estimates.
    const grid = document.getElementById('notationGrid');
    if (viewport && grid) {
        const getRenderedOverflowPx = () => {
            const viewportRect = viewport.getBoundingClientRect();
            if (!(viewportRect.width > 0)) return 0;
            const visibleRows = Array.from(grid.querySelectorAll('.instrument-row'))
                .filter((row) => row.offsetParent !== null && !row.classList.contains('hidden-row') && !row.classList.contains('compact-hidden'));
            const refRow = visibleRows.find((row) => {
                const rect = row.getBoundingClientRect();
                return rect.width > 1 && rect.height > 1;
            }) || visibleRows[0] || null;
            if (!refRow) return 0;
            const rowRect = refRow.getBoundingClientRect();
            // Compare full row width against viewport width to guarantee right-most boxes remain visible.
            const overflow = Math.ceil(rowRect.width - viewportRect.width);
            return Number.isFinite(overflow) ? Math.max(0, overflow) : 0;
        };

        let overflowPx = getRenderedOverflowPx();
        let renderGuard = 0;
        while (overflowPx > 0 && renderGuard < 80) {
            renderGuard += 1;
            if (boxSize > 3) {
                boxSize -= 1;
            } else if (groupGap > 0) {
                groupGap -= 1;
            } else if (boxGap > 0) {
                boxGap -= 1;
            } else if (infoWidth > hardInfoFloor) {
                infoWidth -= 1;
            } else {
                break;
            }

            const adjustedRawNameWidth = Math.max(34, Math.round((debugSettings.instrumentNameWidth || 80) * fitRatio));
            const adjustedCompactNameCap = Math.max(62, Math.min(92, infoWidth - 52));
            nameWidth = state.compactMode
                ? Math.min(adjustedRawNameWidth, adjustedCompactNameCap)
                : Math.min(adjustedRawNameWidth, Math.max(58, infoWidth - 56));
            applyGridSizingVars();
            overflowPx = getRenderedOverflowPx();
        }
    }

    document.querySelectorAll('.notation-box').forEach((box) => {
        box.style.fontSize = fontSize + 'px';
    });

    updateNotationGridGuideMetrics();
}

function remapPatternToGrid(pattern, oldBeats, oldSubdivisions, newBeats, newSubdivisions) {
    const oldBeatsSafe = Math.max(1, parseInt(oldBeats, 10) || 1);
    const oldSubsSafe = Math.max(1, parseInt(oldSubdivisions, 10) || 1);
    const newBeatsSafe = Math.max(1, parseInt(newBeats, 10) || 1);
    const newSubsSafe = Math.max(1, parseInt(newSubdivisions, 10) || 1);
    const oldTotal = oldBeatsSafe * oldSubsSafe;
    const newTotal = newBeatsSafe * newSubsSafe;
    const source = Array.isArray(pattern) ? pattern : [];
    const next = new Array(newTotal).fill(null);

    // Keep beat/sub indices stable. No interpolation or duplication:
    // overlapping indices are copied as-is; newly added cells remain silence/null.
    const sharedBeats = Math.min(oldBeatsSafe, newBeatsSafe);
    const sharedSubs = Math.min(oldSubsSafe, newSubsSafe);
    for (let beat = 0; beat < sharedBeats; beat++) {
        for (let sub = 0; sub < sharedSubs; sub++) {
            const oldIndex = beat * oldSubsSafe + sub;
            const newIndex = beat * newSubsSafe + sub;
            if (oldIndex >= 0 && oldIndex < oldTotal && newIndex >= 0 && newIndex < newTotal) {
                next[newIndex] = source[oldIndex] || null;
            }
        }
    }
    return next;
}

function overlaySharedPatternSlots(basePattern, currentPattern, oldBeats, oldSubdivisions, newBeats, newSubdivisions) {
    const oldBeatsSafe = Math.max(1, parseInt(oldBeats, 10) || 1);
    const oldSubsSafe = Math.max(1, parseInt(oldSubdivisions, 10) || 1);
    const newBeatsSafe = Math.max(1, parseInt(newBeats, 10) || 1);
    const newSubsSafe = Math.max(1, parseInt(newSubdivisions, 10) || 1);
    const result = normalizePattern(basePattern, newBeatsSafe * newSubsSafe);
    const source = normalizePattern(currentPattern, oldBeatsSafe * oldSubsSafe);
    const sharedBeats = Math.min(oldBeatsSafe, newBeatsSafe);
    const sharedSubs = Math.min(oldSubsSafe, newSubsSafe);
    for (let beat = 0; beat < sharedBeats; beat++) {
        for (let sub = 0; sub < sharedSubs; sub++) {
            const oldIndex = beat * oldSubsSafe + sub;
            const newIndex = beat * newSubsSafe + sub;
            result[newIndex] = source[oldIndex] || null;
        }
    }
    return result;
}

function remapAllInstrumentPatterns(oldBeats, oldSubdivisions, newBeats, newSubdivisions, options = {}) {
    captureCurrentPatternsToArchive(oldBeats, oldSubdivisions);
    const preferArchiveRestore = !!options.preferArchiveRestore;
    const snapshotPatterns = options.snapshotPatterns && typeof options.snapshotPatterns === 'object'
        ? options.snapshotPatterns
        : null;
    state.instruments.forEach((instrument) => {
        const idx = state.instruments.indexOf(instrument);
        const currentPattern = Array.isArray(instrument.pattern) ? instrument.pattern : [];
        if (preferArchiveRestore) {
            const snapshotTarget = snapshotPatterns ? snapshotPatterns[instrumentArchiveKey(instrument, idx)] : null;
            if (Array.isArray(snapshotTarget)) {
                instrument.pattern = overlaySharedPatternSlots(
                    snapshotTarget,
                    currentPattern,
                    oldBeats,
                    oldSubdivisions,
                    newBeats,
                    newSubdivisions
                );
                return;
            }
        }
        instrument.pattern = remapPatternToGrid(
            currentPattern,
            oldBeats,
            oldSubdivisions,
            newBeats,
            newSubdivisions
        );
    });
}

function remapCurrentStep(oldBeats, oldSubdivisions, newBeats, newSubdivisions) {
    const oldBeatsSafe = Math.max(1, parseInt(oldBeats, 10) || 1);
    const oldSubsSafe = Math.max(1, parseInt(oldSubdivisions, 10) || 1);
    const newBeatsSafe = Math.max(1, parseInt(newBeats, 10) || 1);
    const newSubsSafe = Math.max(1, parseInt(newSubdivisions, 10) || 1);
    const oldTotal = oldBeatsSafe * oldSubsSafe;
    const normalizedStep = ((state.currentStep % oldTotal) + oldTotal) % oldTotal;
    const oldBeat = Math.floor(normalizedStep / oldSubsSafe);
    const oldSub = normalizedStep % oldSubsSafe;
    // Preserve index when possible; clamp only when new grid is smaller.
    const mappedBeat = Math.min(newBeatsSafe - 1, oldBeat);
    const mappedSub = Math.min(newSubsSafe - 1, oldSub);
    state.currentStep = mappedBeat * newSubsSafe + mappedSub;
    state._lastPlayedStep = state.currentStep;
}

function applyExternalPlaybackCursor(stepValue, stepEpochValue) {
    if (!Number.isFinite(Number(stepValue))) return false;
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const nextStep = ((parseInt(stepValue, 10) % totalSteps) + totalSteps) % totalSteps;
    const incomingEpoch = Number.isFinite(Number(stepEpochValue))
        ? Math.max(0, Math.round(Number(stepEpochValue)))
        : 0;
    const currentEpoch = Number.isFinite(Number(state._lastStepEpoch))
        ? Number(state._lastStepEpoch)
        : 0;

    // Ignore stale cursor packets to prevent visual rewinds/jitter.
    if (incomingEpoch && currentEpoch && incomingEpoch < (currentEpoch - 20)) {
        return false;
    }

    state.currentStep = nextStep;
    state._lastPlayedStep = nextStep;
    if (incomingEpoch) {
        state._lastStepEpoch = incomingEpoch;
        state._lastStepTime = performance.now();
    }
    syncActiveBeatColor(nextStep);
    return true;
}

function applySessionSyncNudge(payload = {}) {
    if (!state.isPlaying) return;
    const incomingStep = Number(payload.step);
    if (!Number.isFinite(incomingStep)) return;
    const incomingTempo = Number(payload.tempo);
    if (Number.isFinite(incomingTempo)) {
        applyTempo(incomingTempo, { restartPlayback: false, persist: false, broadcast: false });
    }

    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const targetStep = ((Math.floor(incomingStep) % totalSteps) + totalSteps) % totalSteps;
    const targetEpoch = Number.isFinite(Number(payload.stepEpoch))
        ? Math.max(0, Math.round(Number(payload.stepEpoch)))
        : Date.now();

    const plan = buildStepTimingPlan();
    const currentCounter = Math.max(0, Math.floor(Number(state._playbackStepCounter) || 0));
    const lastCounter = Math.max(0, currentCounter - 1);
    const total = Math.max(1, plan.totalSteps);
    let alignedCounter = (Math.floor(lastCounter / total) * total) + targetStep;
    while (alignedCounter < (lastCounter - (total / 2))) alignedCounter += total;
    while (alignedCounter > (lastCounter + (total / 2))) alignedCounter -= total;
    if (alignedCounter < 0) alignedCounter = targetStep;

    const localStep = ((parseInt(state.currentStep, 10) || 0) % total + total) % total;
    let deltaSteps = targetStep - localStep;
    if (deltaSteps > total / 2) deltaSteps -= total;
    if (deltaSteps < -total / 2) deltaSteps += total;
    const stepMs = Math.max(1, (60000 / Math.max(1, parseInt(state.tempo, 10) || 100)) / Math.max(1, state.subdivisions));
    const driftMs = deltaSteps * stepMs;

    // Ignore ultra-small differences to avoid unnecessary scheduler churn.
    if (Math.abs(driftMs) < 5) return;

    const cycle = Math.floor(alignedCounter / total);
    const stepInCycle = ((alignedCounter % total) + total) % total;
    const offsetMs = (cycle * plan.cycleMs) + plan.cumulativeMs[stepInCycle];
    state._playbackAnchorEpoch = targetEpoch - offsetMs;
    state._playbackStepCounter = alignedCounter + 1;
    state._lastStepEpoch = targetEpoch;
    state._lastStepTime = performance.now();
    state.currentStep = targetStep;
    state._lastPlayedStep = targetStep;
    syncActiveBeatColor(targetStep);
    drawCircularView();

    if (state.playbackTimeout) {
        clearTimeout(state.playbackTimeout);
        state.playbackTimeout = null;
    }
    cancelScheduledAudio();
    schedGeneration += 1;
    schedNextEpoch = null;
    scheduleNextStep(state._playbackRunId);
}

function populateRhythmSelectionDropdowns() {
    const selects = [
        document.getElementById('rhythmSelect'),
        document.getElementById('compactRhythmSelect'),
        document.getElementById('circularRhythmSelect')
    ].filter(Boolean);
    if (!selects.length) return;
    if (!Array.isArray(availableRhythmCatalog) || availableRhythmCatalog.length === 0) {
        selects.forEach((selectEl) => {
            selectEl.innerHTML = '';
            const option = document.createElement('option');
            option.value = '';
            option.textContent = state.rhythmName || 'Current';
            selectEl.appendChild(option);
            selectEl.value = '';
        });
        return;
    }

    let targetValue = '';
    if (selectedRhythmCatalogKey && availableRhythmCatalog.some((entry) => entry.key === selectedRhythmCatalogKey)) {
        targetValue = selectedRhythmCatalogKey;
    } else if (selectedRhythmCatalogName) {
        const byName = availableRhythmCatalog.find((entry) => String(entry.name || '').trim().toLowerCase() === selectedRhythmCatalogName.toLowerCase());
        if (byName) targetValue = byName.key;
    }
    if (!targetValue) {
        const byState = availableRhythmCatalog.find((entry) => String(entry.name || '').trim().toLowerCase() === String(state.rhythmName || '').trim().toLowerCase());
        if (byState) targetValue = byState.key;
    }

    suppressDropdownSync = true;
    selects.forEach((selectEl) => {
        selectEl.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Current';
        selectEl.appendChild(placeholder);
        availableRhythmCatalog.forEach((entry) => {
            const option = document.createElement('option');
            option.value = entry.key;
            option.textContent = entry.name;
            selectEl.appendChild(option);
        });
        selectEl.value = targetValue || '';
    });
    suppressDropdownSync = false;
}

function requestRhythmCatalogFromParent() {
    try {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'requestRhythmCatalog' }, '*');
        }
    } catch {}
}

function setupEventListeners() {
    bindCallInStepInputs();

    document.getElementById('rhythmName').addEventListener('input', (e) => {
        state.rhythmName = e.target.value;
        selectedRhythmCatalogName = String(state.rhythmName || '').trim();
        selectedRhythmCatalogKey = '';
        populateRhythmSelectionDropdowns();
        syncCompactUi();
    });

    document.getElementById('rhythmName').addEventListener('change', (e) => {
        state.rhythmName = e.target.value;
        selectedRhythmCatalogName = String(state.rhythmName || '').trim();
        selectedRhythmCatalogKey = '';
        populateRhythmSelectionDropdowns();
        syncCompactUi();
        saveToLocalStorage();
    });

    const rhythmSelect = document.getElementById('rhythmSelect');
    const compactRhythmSelect = document.getElementById('compactRhythmSelect');
    const circularRhythmSelect = document.getElementById('circularRhythmSelect');
    const onRhythmSelectChange = (event) => {
        if (suppressDropdownSync) return;
        const key = String(event?.target?.value || '').trim();
        if (!key) return;
        const entry = availableRhythmCatalog.find((item) => item.key === key);
        if (!entry) return;
        selectedRhythmCatalogKey = entry.key;
        selectedRhythmCatalogName = String(entry.name || '').trim();
        state.rhythmName = selectedRhythmCatalogName || state.rhythmName;
        const rhythmInput = document.getElementById('rhythmName');
        if (rhythmInput) rhythmInput.value = state.rhythmName;
        syncCompactUi();
        saveToLocalStorage();
        try {
            window.parent.postMessage({
                type: 'notationSelectRhythm',
                key: entry.key,
                name: entry.name || state.rhythmName
            }, '*');
        } catch {}
    };
    if (rhythmSelect) rhythmSelect.addEventListener('change', onRhythmSelectChange);
    if (compactRhythmSelect) compactRhythmSelect.addEventListener('change', onRhythmSelectChange);
    if (circularRhythmSelect) circularRhythmSelect.addEventListener('change', onRhythmSelectChange);

    document.getElementById('beatCount').addEventListener('change', (e) => {
        const oldBeats = state.beats;
        const oldSubdivisions = state.subdivisions;
        const parsedBeats = parseInt(e.target.value, 10);
        const newBeats = Math.max(1, Math.min(16, Number.isFinite(parsedBeats) ? parsedBeats : oldBeats));
        if (newBeats === oldBeats) {
            e.target.value = oldBeats;
            return;
        }
        e.target.value = newBeats;

        const wasPlaying = state.isPlaying;
        if (wasPlaying) {
            stopPlayback();
        }
        const oldKey = gridKey(oldBeats, oldSubdivisions);
        const newKey = gridKey(newBeats, oldSubdivisions);
        const oldTotal = oldBeats * oldSubdivisions;
        const newTotal = newBeats * oldSubdivisions;
        let preferArchiveRestore = gridRestoreHints[oldKey] === newKey;
        const snapshotEntry = preferArchiveRestore ? gridRestoreSnapshots[oldKey] : null;
        const snapshotPatterns = (snapshotEntry && snapshotEntry.fromKey === newKey) ? snapshotEntry.patterns : null;
        preferArchiveRestore = preferArchiveRestore && !!snapshotPatterns;
        if (!preferArchiveRestore && gridRestoreHints[oldKey] === newKey) {
            delete gridRestoreHints[oldKey];
            delete gridRestoreSnapshots[oldKey];
        }
        state.isDragging = false;
        if (oldTotal > newTotal) {
            captureGridRestoreSnapshot(oldBeats, oldSubdivisions, newBeats, oldSubdivisions);
        }
        remapAllInstrumentPatterns(oldBeats, oldSubdivisions, newBeats, oldSubdivisions, {
            preferArchiveRestore,
            snapshotPatterns
        });
        if (preferArchiveRestore) {
            delete gridRestoreHints[oldKey];
            delete gridRestoreSnapshots[oldKey];
        }
        if (oldTotal > newTotal) {
            gridRestoreHints[newKey] = oldKey;
        }
        state.beats = newBeats;
        remapCurrentStep(oldBeats, oldSubdivisions, newBeats, oldSubdivisions);
        updateGrid();
        if (wasPlaying) startPlayback();
        saveToLocalStorage();
    });

    document.getElementById('subdivisions').addEventListener('change', (e) => {
        const oldBeats = state.beats;
        const oldSubdivisions = state.subdivisions;
        const parsedSubdivisions = parseInt(e.target.value, 10);
        const newSubdivisions = Math.max(1, Math.min(8, Number.isFinite(parsedSubdivisions) ? parsedSubdivisions : oldSubdivisions));
        if (newSubdivisions === oldSubdivisions) {
            e.target.value = oldSubdivisions;
            return;
        }
        e.target.value = newSubdivisions;

        const wasPlaying = state.isPlaying;
        if (wasPlaying) {
            stopPlayback();
        }
        const oldKey = gridKey(oldBeats, oldSubdivisions);
        const newKey = gridKey(oldBeats, newSubdivisions);
        const oldTotal = oldBeats * oldSubdivisions;
        const newTotal = oldBeats * newSubdivisions;
        let preferArchiveRestore = gridRestoreHints[oldKey] === newKey;
        const snapshotEntry = preferArchiveRestore ? gridRestoreSnapshots[oldKey] : null;
        const snapshotPatterns = (snapshotEntry && snapshotEntry.fromKey === newKey) ? snapshotEntry.patterns : null;
        preferArchiveRestore = preferArchiveRestore && !!snapshotPatterns;
        if (!preferArchiveRestore && gridRestoreHints[oldKey] === newKey) {
            delete gridRestoreHints[oldKey];
            delete gridRestoreSnapshots[oldKey];
        }
        state.isDragging = false;
        if (oldTotal > newTotal) {
            captureGridRestoreSnapshot(oldBeats, oldSubdivisions, oldBeats, newSubdivisions);
        }
        remapAllInstrumentPatterns(oldBeats, oldSubdivisions, oldBeats, newSubdivisions, {
            preferArchiveRestore,
            snapshotPatterns
        });
        if (preferArchiveRestore) {
            delete gridRestoreHints[oldKey];
            delete gridRestoreSnapshots[oldKey];
        }
        if (oldTotal > newTotal) {
            gridRestoreHints[newKey] = oldKey;
        }
        state.subdivisions = newSubdivisions;
        remapCurrentStep(oldBeats, oldSubdivisions, oldBeats, newSubdivisions);
        updateGrid();
        if (wasPlaying) startPlayback();
        saveToLocalStorage();
    });

    document.getElementById('tempo').addEventListener('change', (e) => {
        applyTempo(e.target.value, { restartPlayback: false, persist: true });
    });

    const masterVolumeSlider = document.getElementById('masterVolume');
    if (masterVolumeSlider) {
        masterVolumeSlider.addEventListener('change', () => {
            saveToLocalStorage();
        });
    }

    const compactTempo = document.getElementById('compactTempo');
    if (compactTempo) {
        compactTempo.addEventListener('change', (e) => {
            applyTempo(e.target.value, { restartPlayback: false, persist: true });
        });
    }

    // Keyboard shortcuts - letters and numbers
    document.addEventListener('keydown', (e) => {
        // Don't trigger if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Letter shortcuts
        switch(e.key.toLowerCase()) {
            case 's': setSound('slap'); break;
            case 't': setSound('tone'); break;
            case 'b': setSound('bass'); break;
            case 'm': setSound('mute'); break;
            case '-': setSound('silence'); break;
            case 'x': setSound('clear'); break;
            case ' ':
                e.preventDefault();
                togglePlayback();
                break;
        }
        // Number shortcuts: 1=slap, 2=tone, 3=bass, 4=mute, 5=silence, 0=clear
        switch(e.key) {
            case '1': setSound('slap'); break;
            case '2': setSound('tone'); break;
            case '3': setSound('bass'); break;
            case '4': setSound('mute'); break;
            case '5': setSound('silence'); break;
            case '0': setSound('clear'); break;
        }
    });
}

// Set current sound and update articulation buttons
function setSound(sound) {
    state.currentSound = sound;
    // Update button states
    document.querySelectorAll('.articulation-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.sound === sound) {
            btn.classList.add('active');
        }
    });
}

// Adjust tempo by delta
function adjustTempo(delta) {
    if (circularOnlyMode) {
        const baseTempo = Math.max(40, Math.min(240, parseInt(state.tempo, 10) || 100));
        const nextTempo = Math.max(40, Math.min(240, baseTempo + (parseInt(delta, 10) || 0)));
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'setTempo',
                payload: { tempo: nextTempo }
            }, '*');
        } catch {}
        return;
    }
    applyTempo(state.tempo + delta, { restartPlayback: false, persist: true });
}

// Tap tempo - tap button rhythmically to set tempo
function tapTempo() {
    if (circularOnlyMode) {
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'tapTempo'
            }, '*');
        } catch {}
        return;
    }

    const now = Date.now();

    // Clear old taps outside the window
    tapTempoTaps = tapTempoTaps.filter(tap => now - tap < tapTempoWindow);

    // Add current tap
    tapTempoTaps.push(now);

    // Need at least 2 taps to calculate tempo
    if (tapTempoTaps.length >= 2) {
        // Calculate average interval between taps
        let totalInterval = 0;
        for (let i = 1; i < tapTempoTaps.length; i++) {
            totalInterval += tapTempoTaps[i] - tapTempoTaps[i - 1];
        }
        const avgInterval = totalInterval / (tapTempoTaps.length - 1);

        // Convert to BPM (60000ms per minute / interval in ms)
        const bpm = Math.round(60000 / avgInterval);

        // Clamp to valid range
        const newTempo = Math.max(40, Math.min(240, bpm));
        applyTempo(newTempo, { restartPlayback: false, persist: true });
    }
}

function bindClickAndHoldAction(target, instrIndex, onClick, onHold) {
    let holdTimer = null;
    let held = false;
    const holdMs = 420;

    const startHold = () => {
        held = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            held = true;
            if (typeof onHold === 'function') onHold(instrIndex);
        }, holdMs);
    };

    const clearHold = () => {
        clearTimeout(holdTimer);
    };

    target.addEventListener('mousedown', () => startHold());
    target.addEventListener('mouseup', () => clearHold());
    target.addEventListener('mouseleave', () => clearHold());

    target.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startHold();
    }, { passive: false });

    target.addEventListener('touchend', (e) => {
        clearHold();
        e.preventDefault();
        if (!held) onClick();
        held = false;
    }, { passive: false });

    target.addEventListener('touchcancel', () => clearHold());

    target.addEventListener('click', (e) => {
        if (held) {
            e.preventDefault();
            e.stopImmediatePropagation();
            held = false;
            return;
        }
        onClick();
    });
}

// Update the instrument toolbar (icons at top for show/hide)
function updateInstrumentToolbar() {
    const populateToolbar = (toolbarId) => {
        const toolbar = document.getElementById(toolbarId);
        if (!toolbar) return;
        const label = toolbar.querySelector('.instrument-toolbar-label');
        toolbar.innerHTML = '';
        if (label) toolbar.appendChild(label);

        state.instruments.forEach((instrument, index) => {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'instrument-toolbar-icon'
                + (instrument.visible === false ? ' hidden-icon' : '')
                + (instrument.focused ? ' focused-icon' : '')
                + (instrument.soloed ? ' soloed-icon' : '');
            iconDiv.dataset.index = index;
            const iconPath = getInstrumentIconPath(instrument);
            if (iconPath) {
                const img = document.createElement('img');
                img.src = iconPath;
                img.alt = instrument.name || 'Instrument';
                iconDiv.appendChild(img);
            } else {
                iconDiv.textContent = instrument.icon || '🎵';
            }
            const tooltip = document.createElement('span');
            tooltip.className = 'tooltip';
            tooltip.textContent = `${instrument.name}${instrument.soloed ? ' (Solo)' : ''}${instrument.focused ? ' (Focus)' : ''}`;
            iconDiv.appendChild(tooltip);
            // Click = toggle visibility, hold = solo/unsolo
            bindClickAndHoldAction(iconDiv, index, () => toggleInstrumentVisibility(index), toggleInstrumentSolo);
            toolbar.appendChild(iconDiv);
        });
    };

    populateToolbar('instrumentToolbar');
    populateToolbar('compactInstrumentToolbar');
    const soundStagePanel = document.getElementById('soundStagePanel');
    if (soundStagePanel && !soundStagePanel.classList.contains('hidden')) {
        renderSoundStageTokens();
    }
    syncCompactUi();
}

function updateGrid() {
    const grid = document.getElementById('notationGrid');
    const beatStrip = document.getElementById('notationBeatstrip');
    const totalSteps = state.beats * state.subdivisions;
    const beatSegments = getNotationBeatSegments();
    const wrappedLayout = beatSegments.length > 1;

    // Clear existing rows except beat numbers
    grid.innerHTML = '';
    grid.classList.toggle('has-focus', state.instruments.some((instrument) => instrument.focused === true));

    // Create beat numbers row
    const beatNumbersRow = document.createElement('div');
    beatNumbersRow.className = 'beat-numbers';
    beatNumbersRow.id = 'beatNumbers';
    if (wrappedLayout) beatNumbersRow.classList.add('wrapped');

    const appendBeatSegmentToContainer = (containerEl, startBeat, beatCount) => {
        const endBeatExclusive = startBeat + beatCount;
        for (let beat = startBeat; beat < endBeatExclusive; beat++) {
            const beatColorClass = `beat-${(beat % 12) + 1}`;
            for (let sub = 0; sub < state.subdivisions; sub++) {
                const numDiv = document.createElement('div');
                let classes = 'beat-number beat-track-node';
                if (sub === 0) {
                    classes += ` downbeat ${beatColorClass}`;
                }
                numDiv.className = classes;
                numDiv.textContent = sub === 0 ? (beat + 1) : (sub + 1);
                containerEl.appendChild(numDiv);
            }
            if (beat < endBeatExclusive - 1) {
                const spacer = document.createElement('div');
                spacer.className = 'group-spacer beat-track-node';
                containerEl.appendChild(spacer);
            }
        }
    };

    if (wrappedLayout) {
        beatSegments.forEach((segment) => {
            const segmentRow = document.createElement('div');
            segmentRow.className = 'beat-segment-row';
            appendBeatSegmentToContainer(segmentRow, segment.startBeat, segment.beatCount);
            beatNumbersRow.appendChild(segmentRow);
        });
    } else {
        appendBeatSegmentToContainer(beatNumbersRow, 0, state.beats);
    }

    if (beatStrip) {
        beatStrip.innerHTML = '';
        beatStrip.appendChild(beatNumbersRow);
    } else {
        grid.appendChild(beatNumbersRow);
    }

    // Create instrument rows
    state.instruments.forEach((instrument, instrIndex) => {
        // Initialize pattern if needed
        if (!Array.isArray(instrument.pattern)) {
            instrument.pattern = new Array(totalSteps).fill(null);
        } else if (instrument.pattern.length !== totalSteps) {
            const archivedCurrent = getArchivedPattern(instrument, instrIndex, state.beats, state.subdivisions);
            if (archivedCurrent) {
                instrument.pattern = archivedCurrent;
            } else {
                instrument.pattern = normalizePattern(instrument.pattern, totalSteps);
            }
        }

        const row = createInstrumentRow(instrument, instrIndex, beatSegments);
        grid.appendChild(row);
    });

    const soundStagePanel = document.getElementById('soundStagePanel');
    if (soundStagePanel && !soundStagePanel.classList.contains('hidden')) {
        renderSoundStageTokens();
    }

    // Dynamically set --steps CSS variable for min-width calculation
    const maxBeatsPerRow = wrappedLayout
        ? Math.min(state.beats, getNotationWrapBeatsPerRow())
        : state.beats;
    document.getElementById('notationGrid').style.setProperty('--steps', maxBeatsPerRow * state.subdivisions);
    document.getElementById('notationGrid').style.setProperty('--beats', maxBeatsPerRow);
    syncCallInStepInputs();
    applyCompactModeRows();
    rebuildPlaybackDomCache();

    saveToLocalStorage();
    // Re-scale grid to fit after rebuilding
    requestAnimationFrame(() => {
        requestAutoScaleGridPasses();
        if (state.viewMode === 'circular') initCircularView();
    });
}

function rebuildPlaybackDomCache() {
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const boxesByStep = Array.from({ length: totalSteps }, () => []);
    document.querySelectorAll('.notation-box[data-step]').forEach((box) => {
        const stepIdx = parseInt(box.dataset.step, 10);
        if (!Number.isFinite(stepIdx)) return;
        if (stepIdx < 0 || stepIdx >= totalSteps) return;
        boxesByStep[stepIdx].push(box);
    });
    const beatNumbers = Array.from(document.querySelectorAll('.beat-number'));
    state._playbackDomCache = {
        totalSteps,
        boxesByStep,
        beatNumbers,
        prevStep: null,
        prevBeatEl: null
    };
    return state._playbackDomCache;
}

function getPlaybackDomCache() {
    const cache = state._playbackDomCache;
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    if (!cache) return rebuildPlaybackDomCache();
    if (cache.totalSteps !== totalSteps) return rebuildPlaybackDomCache();
    return cache;
}

function createBoxesContainerSegment(instrument, instrIndex, startBeat, beatCount) {
    const boxesContainer = document.createElement('div');
    boxesContainer.className = 'boxes-container';

    let stepIndex = Math.max(0, startBeat * state.subdivisions);
    const endBeatExclusive = startBeat + beatCount;
    for (let beat = startBeat; beat < endBeatExclusive; beat++) {
        for (let sub = 0; sub < state.subdivisions; sub++) {
            const box = createNotationBox(instrument, instrIndex, stepIndex, sub === 0, beat);
            boxesContainer.appendChild(box);
            stepIndex++;
        }

        if (beat < endBeatExclusive - 1) {
            const divider = document.createElement('div');
            divider.className = 'group-divider track-node';
            boxesContainer.appendChild(divider);
        }
    }

    return boxesContainer;
}

function createInstrumentRow(instrument, instrIndex, beatSegments = null) {
    const row = document.createElement('div');
    row.className = 'instrument-row';
    row.dataset.instrument = instrument.id;

    // Apply hidden state if instrument is not visible
    const isVisible = instrument.visible !== false; // Default to true if undefined
    if (!isVisible) {
        row.classList.add('hidden-row');
    }

    // Apply muted state
    const isMuted = instrument.muted === true;
    if (isMuted) {
        row.classList.add('muted-row');
    }

    // Apply solo state
    const isSoloed = instrument.soloed === true;
    const isFocused = instrument.focused === true;
    if (isFocused) {
        row.classList.add('focused-row');
    }
    if (isSoloed) {
        row.classList.add('soloed-row');
    }

    // Instrument info with clickable icon for mute
    const info = document.createElement('div');
    info.className = 'instrument-info';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'instrument-icon' + (isMuted ? ' muted' : '');
    const iconPath = getInstrumentIconPath(instrument);
    if (iconPath) {
        const img = document.createElement('img');
        img.src = iconPath;
        img.alt = instrument.name || 'Instrument';
        iconDiv.appendChild(img);
    } else {
        iconDiv.textContent = instrument.icon || '🎵';
    }
    iconDiv.title = isFocused
        ? 'Hold to unfocus; click to mute/unmute'
        : 'Hold to focus; click to mute/unmute';
    bindClickAndHoldAction(iconDiv, instrIndex, () => toggleInstrumentMute(instrIndex), toggleInstrumentFocus);
    info.appendChild(iconDiv);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'instrument-name';
    nameDiv.textContent = instrument.name;
    info.appendChild(nameDiv);


    // Volume slider
    const volumeDiv = document.createElement('div');
    volumeDiv.className = 'instrument-volume';

    const volumeIcon = document.createElement('span');
    volumeIcon.className = 'instrument-volume-icon';
    volumeIcon.textContent = '🔊';
    volumeDiv.appendChild(volumeIcon);

    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '1';
    volumeSlider.step = '0.05';
    volumeSlider.value = instrument.volume !== undefined ? instrument.volume : 1.0;
    volumeSlider.style.setProperty('--volume-fill', `${(instrument.volume || 1) * 100}%`);
    volumeSlider.title = `Volume: ${Math.round((instrument.volume || 1) * 100)}%`;
    volumeSlider.addEventListener('input', (e) => {
        instrument.volume = parseFloat(e.target.value);
        instrument.stageY = stageYFromVolume(instrument.volume);
        volumeSlider.style.setProperty('--volume-fill', `${instrument.volume * 100}%`);
        volumeSlider.title = `Volume: ${Math.round(instrument.volume * 100)}%`;
        volumeIcon.textContent = instrument.volume === 0 ? '🔇' : instrument.volume < 0.5 ? '🔉' : '🔊';
        renderSoundStageTokens();
        postRhythmStateToParent();
        saveToLocalStorage();
    });
    volumeDiv.appendChild(volumeSlider);

    info.appendChild(volumeDiv);

    row.appendChild(info);

    const normalizedSegments = Array.isArray(beatSegments) && beatSegments.length > 0
        ? beatSegments
        : [{ startBeat: 0, beatCount: state.beats }];

    if (normalizedSegments.length > 1) {
        row.classList.add('wrapped-layout');
        const stack = document.createElement('div');
        stack.className = 'boxes-stack';
        normalizedSegments.forEach((segment) => {
            const segmentContainer = createBoxesContainerSegment(
                instrument,
                instrIndex,
                segment.startBeat,
                segment.beatCount
            );
            segmentContainer.classList.add('boxes-segment');
            stack.appendChild(segmentContainer);
        });
        row.appendChild(stack);
    } else {
        row.appendChild(createBoxesContainerSegment(instrument, instrIndex, 0, state.beats));
    }
    return row;
}

// Cycle through sample sets for an instrument
function cycleSampleSet(instrIndex) {
    const instrument = state.instruments[instrIndex];
    const instType = instrumentTypes[instrument.type || 'djembe'];
    if (!instType || instType.sampleSets.length <= 1) return;

    const currentIndex = instType.sampleSets.indexOf(instrument.sampleSet || instType.sampleSets[0]);
    const nextIndex = (currentIndex + 1) % instType.sampleSets.length;
    instrument.sampleSet = instType.sampleSets[nextIndex];

    // Update the display
    updateGrid();
    saveToLocalStorage();
}

function createNotationBox(instrument, instrIndex, stepIndex, isDownbeat, beat) {
    const box = document.createElement('div');
    let classes = 'notation-box track-node';
    if (isDownbeat) {
        classes += ' downbeat';
        // Calculate beat color class (cycles through 1-4)
        const beatColorClass = `beat-${(beat % 4) + 1}`;
        classes += ' ' + beatColorClass;
    }
    box.className = classes;
    box.dataset.instrument = instrIndex;
    box.dataset.step = stepIndex;

    // Set initial state from pattern (default to silence)
    const sound = instrument.pattern[stepIndex] || 'silence';
    if (soundTypes[sound]) {
        box.classList.add(soundTypes[sound].class);
        renderBoxSymbol(box, sound);
    }

    // Mouse down - start dragging and apply sound
    box.addEventListener('mousedown', (e) => {
        if (Date.now() < touchSuppressMouseUntil) {
            e.preventDefault();
            return;
        }
        if (e.button === 0) { // Left click only
            mouseLeftDown = true;
            state.isDragging = true;
            state.dragMode = 'write';
            // With cycle on, lock drag-write to the first resolved articulation.
            state.dragWriteSound = state.cycleMode ? resolveGridWriteSound(state.instruments[instrIndex], stepIndex) : null;
            handleBoxClick(box, instrIndex, stepIndex, {
                forcedSound: state.dragWriteSound || undefined
            });
            clearTimeout(mouseHoldEraseTimer);
            mouseHoldStart = { box, instrIndex, stepIndex };
            mouseHoldEraseTimer = setTimeout(() => {
                if (!mouseLeftDown || !state.isDragging || state.dragMode !== 'write' || !mouseHoldStart) return;
                state.dragMode = 'clear';
                state.dragWriteSound = null;
                clearBox(mouseHoldStart.box, mouseHoldStart.instrIndex, mouseHoldStart.stepIndex, true);
            }, getHoldToSilenceMs());
            return;
        }

        if (e.button === 2) { // Right click: clear/erase mode
            e.preventDefault();
            mouseLeftDown = false;
            clearTimeout(mouseHoldEraseTimer);
            mouseHoldEraseTimer = null;
            mouseHoldStart = null;
            state.isDragging = true;
            state.dragMode = 'clear';
            state.dragWriteSound = null;
            clearBox(box, instrIndex, stepIndex, true);
        }
    });

    // Mouse enter while dragging - apply sound
    box.addEventListener('mouseenter', () => {
        if (state.isDragging) {
            if (state.dragMode === 'clear') {
                clearBox(box, instrIndex, stepIndex, true);
            } else {
                if (mouseHoldStart && (mouseHoldStart.instrIndex !== instrIndex || mouseHoldStart.stepIndex !== stepIndex)) {
                    clearTimeout(mouseHoldEraseTimer);
                    mouseHoldEraseTimer = null;
                    mouseHoldStart = null;
                }
                handleBoxClick(box, instrIndex, stepIndex, {
                    forcedSound: state.dragWriteSound || undefined
                });
            }
        }
    });

    // Right-click to clear (set to silence)
    box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // If not already in right-drag erase mode, clear this single box.
        if (!state.isDragging || state.dragMode !== 'clear') {
            clearBox(box, instrIndex, stepIndex);
        }
    });

    // Touch support:
    // - tap writes one box
    // - hold writes silence
    // - hold + drag erases across boxes
    box.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        e.preventDefault();
        touchSuppressMouseUntil = Date.now() + 700;
        touchPointerId = e.pointerId;
        touchHoldActive = false;
        touchHoldLastKey = '';
        touchHoldStart = { box, instrIndex, stepIndex };
        clearTimeout(touchHoldTimer);
        touchHoldTimer = setTimeout(() => {
            if (touchPointerId !== e.pointerId || !touchHoldStart) return;
            touchHoldActive = true;
            state.isDragging = true;
            state.dragMode = 'clear';
            state.dragWriteSound = null;
            clearBox(touchHoldStart.box, touchHoldStart.instrIndex, touchHoldStart.stepIndex, true);
            touchHoldLastKey = `${touchHoldStart.instrIndex}:${touchHoldStart.stepIndex}`;
        }, getHoldToSilenceMs());
        try { box.setPointerCapture(e.pointerId); } catch {}
    });

    box.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'touch' || e.pointerId !== touchPointerId) return;
        if (!touchHoldActive) return;
        e.preventDefault();
        const target = getNotationBoxFromPoint(e.clientX, e.clientY);
        if (!target) return;
        const key = `${target.instrIndex}:${target.stepIndex}`;
        if (key === touchHoldLastKey) return;
        touchHoldLastKey = key;
        clearBox(target.box, target.instrIndex, target.stepIndex, true);
    });

    const finishTouch = (e) => {
        if (e.pointerType !== 'touch' || e.pointerId !== touchPointerId) return;
        clearTimeout(touchHoldTimer);
        touchHoldTimer = null;

        if (touchHoldActive) {
            touchHoldActive = false;
            touchPointerId = null;
            touchHoldStart = null;
            touchHoldLastKey = '';
            state.isDragging = false;
            state.dragMode = null;
            state.dragWriteSound = null;
            saveToLocalStorage();
            return;
        }

        // Simple tap write on touch
        const target = getNotationBoxFromPoint(e.clientX, e.clientY) || { box, instrIndex, stepIndex };
        handleBoxClick(target.box, target.instrIndex, target.stepIndex);
        touchPointerId = null;
        touchHoldStart = null;
        state.isDragging = false;
        state.dragMode = null;
        state.dragWriteSound = null;
    };

    box.addEventListener('pointerup', finishTouch);
    box.addEventListener('pointercancel', finishTouch);

    return box;
}

function getNotationBoxFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const box = el?.closest?.('.notation-box');
    if (!box) return null;
    const instrIndex = parseInt(box.dataset.instrument, 10);
    const stepIndex = parseInt(box.dataset.step, 10);
    if (!Number.isFinite(instrIndex) || !Number.isFinite(stepIndex)) return null;
    return { box, instrIndex, stepIndex };
}

// Global mouse up listener to stop dragging
document.addEventListener('mouseup', () => {
    mouseLeftDown = false;
    clearTimeout(mouseHoldEraseTimer);
    mouseHoldEraseTimer = null;
    mouseHoldStart = null;
    if (state.isDragging) {
        state.isDragging = false;
        state.dragMode = null;
        state.dragWriteSound = null;
        saveToLocalStorage();
    }
});

// Suppress browser context menu while right-drag erasing.
document.addEventListener('contextmenu', (e) => {
    if (state.isDragging && state.dragMode === 'clear') {
        e.preventDefault();
    }
});

// Prevent text selection while dragging
document.addEventListener('selectstart', (e) => {
    if (state.isDragging) {
        e.preventDefault();
    }
});

function handleBoxClick(box, instrIndex, stepIndex, options = {}) {
    const instrument = state.instruments[instrIndex];
    let sound = options.forcedSound || resolveGridWriteSound(instrument, stepIndex);

    if (sound === 'clear') {
        clearBox(box, instrIndex, stepIndex);
        return;
    }

    // Immediate one-shot preview on edit (button-down path).
    // This lets users hear the exact articulation they're writing.
    if (sound && sound !== 'silence') {
        const previewVolume = instrument?.volume !== undefined ? instrument.volume : 1.0;
        const previewReverb = Number.isFinite(Number(instrument?.reverb)) ? Number(instrument.reverb) : undefined;
        playSound(sound, instrument, previewVolume, { reverbMix: previewReverb });
    }

    // Remove all sound classes
    box.classList.remove('active', 'tone', 'slap', 'bass', 'mute', 'silence');

    // Set new sound
    if (soundTypes[sound]) {
        box.classList.add(soundTypes[sound].class);
        renderBoxSymbol(box, sound);
        instrument.pattern[stepIndex] = sound;
        if (sound !== 'silence') {
            // Emit immediate grid-trigger events so MIDI out mirrors grid edits.
            emitNoteEvent('grid_note', sound, instrument.volume || 1.0, instrument.id, stepIndex, { instrumentType: instrument.type });
        }
    }

    // Only save immediately if not dragging (drag saves at end)
    if (!state.isDragging) {
        saveToLocalStorage();
    }
}

function resolveGridWriteSound(instrument, stepIndex) {
    const availableArticulations = getInstrumentArticulations(instrument);
    if (!availableArticulations || availableArticulations.length === 0) return 'silence';

    // Normal mode:
    // - first click uses currently selected articulation
    // - rapid repeat click on same box cycles articulations
    const selectedSound = availableArticulations.includes(state.currentSound)
        ? state.currentSound
        : availableArticulations[0];

    const boxKey = `${instrument.id}:${stepIndex}`;
    const now = Date.now();
    const isRapidRepeat = (
        state.lastGridClickKey === boxKey &&
        (now - (state.lastGridClickTime || 0)) <= getCycleTapWindowMs()
    );
    state.lastGridClickKey = boxKey;
    state.lastGridClickTime = now;

    if (!isRapidRepeat || !state.rapidCycleEnabled) {
        return selectedSound;
    }

    const cycleOrder = availableArticulations.filter(a => a !== 'silence');
    if (cycleOrder.length === 0) return selectedSound;
    const currentSound = instrument.pattern[stepIndex] || 'silence';
    const currentIdx = cycleOrder.indexOf(currentSound);
    const nextSound = currentIdx < 0 ? selectedSound : cycleOrder[(currentIdx + 1) % cycleOrder.length];
    if (nextSound && nextSound !== 'clear') {
        // Keep articulation picker in sync with rapid-cycle output.
        setSound(nextSound);
    }
    return nextSound;
}

// Toggle cycle mode
function toggleCycleMode() {
    // Legacy alias: keep callable for compatibility, but route to help.
    showCycleHelp();
}

function toggleRapidCycle() {
    state.rapidCycleEnabled = !state.rapidCycleEnabled;
    syncCycleModeUi();
    saveToLocalStorage();
}

function showCycleHelp() {
    const btn = document.getElementById('cycleBtn');
    ensureNotationHintPopup().show(btn, getSharedHintMessage('notation-cycle-help'));
}

function showGridEditHelp() {
    const btn = document.getElementById('gridHelpBtn');
    ensureNotationHintPopup().show(btn, getSharedHintMessage('notation-grid-help'));
}

function setupNotationHelpInteractions() {
    const hooks = [
        { id: 'cycleBtn', show: showCycleHelp },
        { id: 'gridHelpBtn', show: showGridEditHelp }
    ];
    hooks.forEach((entry) => {
        const btn = document.getElementById(entry.id);
        if (!btn || btn.dataset.helpBound === '1') return;
        btn.dataset.helpBound = '1';
        let hoverTimer = 0;
        const clearHoverTimer = () => {
            if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = 0;
            }
        };
        const showAfterDelay = () => {
            clearHoverTimer();
            const delay = getSharedTooltipHoverDelayMs();
            if (delay <= 0) {
                entry.show();
                return;
            }
            hoverTimer = window.setTimeout(() => {
                hoverTimer = 0;
                entry.show();
            }, delay);
        };
        btn.addEventListener('mouseenter', showAfterDelay);
        btn.addEventListener('mouseleave', () => {
            clearHoverTimer();
            if (!shouldHideHintOnUnhoverDesktop()) return;
            ensureNotationHintPopup().hide();
        });
        btn.addEventListener('blur', () => {
            clearHoverTimer();
            if (!shouldHideHintOnUnhoverDesktop()) return;
            ensureNotationHintPopup().hide();
        });
        btn.addEventListener('click', (e) => {
            clearHoverTimer();
            const popup = document.querySelector('.notation-typed-tooltip');
            const isOpen = !!(popup && popup.style.display === 'block');
            if (isOpen) ensureNotationHintPopup().hide();
            else entry.show();
            e.preventDefault();
            e.stopPropagation();
        });
    });
}

function clearBox(box, instrIndex, stepIndex, deferSave = false) {
    box.classList.remove('active', 'tone', 'slap', 'bass', 'mute', 'silence', 'ghost');
    box.classList.add('silence');
    renderBoxSymbol(box, 'silence');
    state.instruments[instrIndex].pattern[stepIndex] = 'silence';
    const instrument = state.instruments[instrIndex];
    emitNoteEvent('grid_clear', 'silence', instrument?.volume || 1.0, instrument?.id || '', stepIndex, { instrumentType: instrument?.type || '' });
    if (!deferSave) {
        saveToLocalStorage();
    }
}

async function clearAll() {
    const ok = await ensureInlineUiFeedback().confirm('Clear all patterns?', 'Clear Patterns');
    if (!ok) return;
    state.instruments.forEach(instr => {
        instr.pattern = new Array(state.beats * state.subdivisions).fill(null);
    });
    updateGrid();
}

/* COMMENTED OUT - Add Instrument functionality (kept for future use)
function addInstrument() {
    // Show instrument type selection
    showAddInstrumentDialog();
}

function showAddInstrumentDialog() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); z-index: 1000;
        display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: var(--bg-secondary); border: 1px solid var(--border-color);
        border-radius: 10px; padding: 20px; min-width: 350px; max-width: 450px;
    `;

    let html = `
        <h3 style="color: var(--accent-primary); margin-bottom: 15px; font-family: 'Orbitron', sans-serif;">Add Instrument</h3>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 15px;">
    `;

    // Add buttons for each instrument type
    for (const [typeId, type] of Object.entries(instrumentTypes)) {
        html += `
            <button class="btn" onclick="quickAddInstrument('${typeId}')" style="padding: 15px 10px; font-size: 14px;">
                <span style="font-size: 24px; display: block;">${type.icon}</span>
                ${type.name}
            </button>
        `;
    }

    html += `
        </div>
        <div style="display: flex; justify-content: center;">
            <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        </div>
    `;

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

function quickAddInstrument(typeId) {
    const type = instrumentTypes[typeId];

    // For djembe, auto-assign next sample set
    let sampleSet = 'default';
    let name = type.name;

    if (typeId === 'djembe') {
        sampleSet = djembeSampleSets[djembeCounter % djembeSampleSets.length];
        djembeCounter++;
        // Count existing djembes
        const djembeCount = state.instruments.filter(i => i.type === 'djembe').length + 1;
        name = `Djembe ${djembeCount}`;
    } else {
        // Count existing instruments of this type
        const count = state.instruments.filter(i => i.type === typeId).length + 1;
        if (count > 1) {
            name = `${type.name} ${count}`;
        }
    }

    state.instruments.push({
        id: 'instr_' + Date.now(),
        name: name,
        icon: type.icon,
        type: typeId,
        sampleSet: sampleSet,
        pattern: new Array(state.beats * state.subdivisions).fill(null),
        visible: true,
        muted: false,
        volume: 1.0,
        focused: false
    });

    // Close modal
    document.querySelector('.modal-overlay')?.remove();

    updateInstrumentToolbar();
    updateGrid();
}

// Legacy function - now unused
function confirmAddInstrument() {
    const typeId = document.getElementById('newInstrType')?.value || 'djembe';
    quickAddInstrument(typeId);
}
END COMMENTED OUT - Add Instrument functionality */

function toggleInstrumentVisibility(instrIndex) {
    const instrument = state.instruments[instrIndex];
    instrument.visible = instrument.visible === false ? true : false;

    // Update the row visually
    const rows = document.querySelectorAll('.instrument-row');
    const row = rows[instrIndex];
    if (row) {
        if (instrument.visible) {
            row.classList.remove('hidden-row');
        } else {
            row.classList.add('hidden-row');
        }
    }

    // Update toolbar icons in both normal + compact bars
    document.querySelectorAll(`.instrument-toolbar-icon[data-index="${instrIndex}"]`).forEach((toolbarIcon) => {
        toolbarIcon.classList.toggle('hidden-icon', !instrument.visible);
    });

    applyCompactModeRows();
    saveToLocalStorage();
}

function toggleInstrumentMute(instrIndex) {
    const instrument = state.instruments[instrIndex];
    instrument.muted = instrument.muted === true ? false : true;

    // Update the row visually
    const rows = document.querySelectorAll('.instrument-row');
    const row = rows[instrIndex];
    if (row) {
        const icon = row.querySelector('.instrument-icon');
        if (instrument.muted) {
            row.classList.add('muted-row');
            if (icon) {
                icon.classList.add('muted');
                icon.title = instrument.focused
                    ? 'Hold to unfocus; click to unmute'
                    : 'Hold to focus; click to unmute';
            }
        } else {
            row.classList.remove('muted-row');
            if (icon) {
                icon.classList.remove('muted');
                icon.title = instrument.focused
                    ? 'Hold to unfocus; click to mute'
                    : 'Hold to focus; click to mute';
            }
        }
    }

    saveToLocalStorage();
}

function toggleInstrumentSolo(instrIndex) {
    const instrument = state.instruments[instrIndex];
    if (!instrument) return;
    instrument.soloed = !(instrument.soloed === true);
    updateInstrumentToolbar();
    updateGrid();
    saveToLocalStorage();
}

function toggleInstrumentFocus(instrIndex) {
    const instrument = state.instruments[instrIndex];
    if (!instrument) return;
    const enableFocus = !instrument.focused;
    state.instruments.forEach((instr, idx) => {
        instr.focused = enableFocus ? idx === instrIndex : false;
    });
    updateInstrumentToolbar();
    updateGrid();
    saveToLocalStorage();
}

// Reverb UI control
function updateReverb(value) {
    const amount = parseFloat(value);
    setReverbAmount(amount);
    document.getElementById('reverbValue').textContent = Math.round(amount * 100) + '%';
}

// Metronome functions
function toggleMetronome() {
    metronomeEnabled = !metronomeEnabled;
    syncMetronomeButtons();
    saveToLocalStorage();
}

function updateMasterVolume(value, options = {}) {
    const next = Math.max(0, Math.min(1, parseFloat(value)));
    masterVolume = Number.isFinite(next) ? next : masterVolume;
    applyMasterGain();
    syncMasterUi();
    if (options.persist) saveToLocalStorage();
}

function toggleMasterMute() {
    masterMuted = !masterMuted;
    applyMasterGain();
    syncMasterUi();
    saveToLocalStorage();
}

function updateMetronomeVolume(value) {
    metronomeVolume = parseFloat(value);
    document.getElementById('metronomeVolumeValue').textContent = Math.round(metronomeVolume * 100) + '%';
}

// Swing functions - per beat position
function updateSwingFactor(value) {
    state.swing.factor = parseInt(value);
    document.getElementById('swingFactorValue').textContent = value;
    // If playing, restart to apply new swing timing
    if (state.isPlaying) {
        stopPlayback();
        startPlayback();
    }
    saveToLocalStorage();
}

function updateSwingBeat(beat, value) {
    const val = parseInt(value);
    const safeVal = Number.isFinite(val) ? val : 0;
    state.swing[beat] = safeVal;
    document.getElementById('swing' + beat + 'Value').textContent = safeVal;
    // Update slider fill (centered at 50% for 0, range -50 to +50)
    const slider = document.getElementById('swing' + beat);
    if (slider) {
        const fillPercent = ((safeVal + 50) / 100) * 100;
        slider.style.setProperty('--slider-fill', fillPercent + '%');
    }
    // If playing, restart to apply new swing timing
    if (state.isPlaying) {
        stopPlayback();
        startPlayback();
    }
    saveToLocalStorage();
}



function playMetronomeClick(isDownbeat) {
    if (!metronomeEnabled || metronomeVolume === 0) return;

    // Resume audio context if suspended
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    // Initialize reverb if not done
    if (!reverbNode) {
        initReverb();
    }

    // Use shekere samples for metronome
    const soundType = isDownbeat ? 'slap' : 'tone';
    const samples = audioSamples['shekere']?.['default']?.[soundType];

    if (!samples || samples.length === 0) return;

    const buffer = samples[0];
    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = metronomeVolume;

    source.connect(gainNode);
    gainNode.connect(dryGain);
    gainNode.connect(reverbNode);

    const when = schedWhen !== null ? schedWhen : 0;
    source.start(when);
    trackScheduledSource(source, when);
}

function toggleAllInstruments() {
    // Check if any are visible
    const anyVisible = state.instruments.some(instr => instr.visible !== false);

    // If any are visible, hide all. Otherwise, show all.
    const newVisibility = !anyVisible;

    state.instruments.forEach((instrument) => {
        instrument.visible = newVisibility;
    });

    // Update all rows visually
    const rows = document.querySelectorAll('.instrument-row');
    rows.forEach((row) => {
        if (newVisibility) {
            row.classList.remove('hidden-row');
        } else {
            row.classList.add('hidden-row');
        }
    });

    // Update toolbar icons
    document.querySelectorAll('.instrument-toolbar-icon').forEach((icon) => {
        icon.classList.toggle('hidden-icon', !newVisibility);
    });

    applyCompactModeRows();
    saveToLocalStorage();
}

// Playback
function isPlaybackBlockedBySession() {
    return (sessionControlRole === 'follower' && !sessionControlFreeMode);
}

function isLeaderSessionControl() {
    return sessionControlRole === 'leader';
}

function postLeaderTransportAction(action, payload = {}) {
    try {
        window.parent.postMessage({
            type: 'notationLeaderAction',
            action: String(action || '').trim().toLowerCase(),
            payload: payload && typeof payload === 'object' ? payload : {}
        }, '*');
    } catch {}
}

function postBlockedAction(action) {
    try {
        window.parent.postMessage({
            type: 'notationActionBlocked',
            action,
            reason: 'leader_only'
        }, '*');
    } catch {}
}

function togglePlayback(options = {}) {
    const fromParent = !!options.fromParent;
    if (circularOnlyMode && !fromParent) {
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'togglePlayback'
            }, '*');
        } catch {}
        return;
    }

    if (!fromParent && isPlaybackBlockedBySession()) {
        postBlockedAction('playback');
        return;
    }
    if (!fromParent && isLeaderSessionControl()) {
        postLeaderTransportAction(state.isPlaying ? 'stop' : 'play');
        return;
    }
    if (state.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function handleCallButton(options = {}) {
    const fromParent = !!options.fromParent;
    if (!state.isPlaying) {
        if (!fromParent && isPlaybackBlockedBySession()) {
            postBlockedAction('call_in');
            return;
        }
        if (!fromParent && isLeaderSessionControl()) {
            postLeaderTransportAction('call_in');
            return;
        }
        beginCallInSequence();
        return;
    }
    if (callInSequenceState && callInSequenceState.active) {
        return;
    }
    cueCall();
}

function handleCircularCallButton() {
    if (circularOnlyMode) {
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'callButton'
            }, '*');
        } catch {}
        return;
    }
    handleCallButton();
}

function runCallOut(options = {}) {
    const fromParent = !!options.fromParent;
    if (!state.isPlaying) return;
    if (!fromParent && isPlaybackBlockedBySession()) {
        postBlockedAction('call_out');
        return;
    }
    if (callInSequenceState && callInSequenceState.active) return;
    if (callOutSequenceState && callOutSequenceState.active) return;
    if (!fromParent && isLeaderSessionControl()) {
        postLeaderTransportAction('call_out');
        return;
    }

    cueCall({ silent: true, force: true });
    callOutSequenceState = {
        active: true,
        armed: true,
        startedCounter: null,
        stopCounter: null
    };
    const callStatus = document.getElementById('callStatus');
    if (callStatus) callStatus.textContent = 'Call Out armed';
    syncCallButtons();
}

function runCircularCallOut() {
    if (circularOnlyMode) {
        try {
            window.parent.postMessage({
                type: 'notationCircularCommand',
                command: 'callOut'
            }, '*');
        } catch {}
        return;
    }
    runCallOut();
}

function clearLocalPlaybackScheduler(keepAnchor = true) {
    transportDiag.push('info', 'clear_scheduler', {
        keepAnchor: !!keepAnchor,
        runIdBefore: parseInt(state._playbackRunId, 10) || 0,
        hadTimeout: !!state.playbackTimeout,
        hadInterval: !!state.playbackInterval,
        isPlaying: !!state.isPlaying
    });
    clearInterval(state.playbackInterval);
    clearTimeout(state.playbackTimeout);
    state.playbackInterval = null;
    state.playbackTimeout = null;
    schedTicker.stop();
    cancelScheduledAudio();
    schedGeneration += 1;
    schedNextEpoch = null;
    schedCallOutEnd = null;
    state._playbackRunId = (parseInt(state._playbackRunId, 10) || 0) + 1;
    if (!keepAnchor) {
        state._playbackStepCounter = 0;
        state._playbackAnchorEpoch = null;
    }
}

function startPlayback(options = {}) {
    const prepRequestId = (parseInt(state._playbackPrepareRequestId, 10) || 0) + 1;
    state._playbackPrepareRequestId = prepRequestId;

    if (!options._prepared) {
        const requestedAnchor = Number(options.anchorEpoch);
        primeAudioEngineForPlayback()
            .then(() => {
                if ((parseInt(state._playbackPrepareRequestId, 10) || 0) !== prepRequestId) return;
                if (state.isPlaying) return;
                const now = Date.now();
                const minLeadMs = Math.max(0, Math.min(300, Number(transportPrimeLeadMs) || 0));
                let anchorEpoch = Number.isFinite(requestedAnchor) ? requestedAnchor : (now + minLeadMs);
                // Session starts keep the shared start time even if warm-up overran: the scheduler skips any
                // step already missed instead of the whole device running late for the rest of the song.
                if (anchorEpoch < now + minLeadMs && !options.strictAnchor) anchorEpoch = now + minLeadMs;
                startPlayback({ ...options, _prepared: true, anchorEpoch });
            })
            .catch(() => {
                if ((parseInt(state._playbackPrepareRequestId, 10) || 0) !== prepRequestId) return;
                if (state.isPlaying) return;
                const now = Date.now();
                const minLeadMs = Math.max(0, Math.min(300, Number(transportPrimeLeadMs) || 0));
                let anchorEpoch = Number.isFinite(requestedAnchor) ? requestedAnchor : (now + minLeadMs);
                if (anchorEpoch < now + minLeadMs && !options.strictAnchor) anchorEpoch = now + minLeadMs;
                startPlayback({ ...options, _prepared: true, anchorEpoch });
            });
        return;
    }

    if (!audioSamplesLoaded) {
        ensureAudioSamplesReady()
            .then(() => {
                if (!state.isPlaying) startPlayback({ ...options, _deferredFromSampleLoad: true });
            })
            .catch(() => {});
        return;
    }
    // Hard guard: never allow overlapping transport loops.
    transportDiag.push('info', 'start_playback_requested', {
        wasPlaying: !!state.isPlaying,
        requestedAnchor: Number(options.anchorEpoch) || null
    });
    clearLocalPlaybackScheduler(false);
    state.isPlaying = true;
    state.currentStep = 0;
    state._lastPlayedStep = 0;
    const requestedAnchor = Number(options.anchorEpoch);
    const anchorEpoch = Number.isFinite(requestedAnchor)
        ? Math.max(0, Math.round(requestedAnchor))
        : Date.now();
    schedStallMs = 0;
    schedNextEpoch = null;
    Object.assign(transportStats, { scheduled: 0, late: 0, skipped: 0, maxTickGapMs: 0, worstLateMs: 0 });
    state._playbackAnchorEpoch = anchorEpoch;
    state._playbackStepCounter = 0;
    state._lastStepTime = performance.now();
    state._lastStepEpoch = anchorEpoch;
    transportDiag.push('info', 'start_playback_committed', {
        runId: parseInt(state._playbackRunId, 10) || 0,
        anchorEpoch,
        tempo: state.tempo,
        beats: state.beats,
        subdivisions: state.subdivisions
    });
    syncPlaybackButtons();

    // Hide call row during playback (unless call is active)
    updateCallRowVisibility();

    if (state.viewMode === 'circular') startCircularAnimation();
    try { window.parent.postMessage({ type: 'notationPlaybackState', playing: true }, '*'); } catch {}
    postNotationStateToParent();
    scheduleNextStep(state._playbackRunId);
}

function buildStepTimingPlan() {
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const baseStepMs = Math.max(1, (60000 / Math.max(1, state.tempo)) / Math.max(1, state.subdivisions));
    const beatLabels = ['A', 'B', 'C', 'D'];
    const swingFactor = (state.swing.factor !== undefined ? state.swing.factor : 100) / 100;
    const swingValues = [];
    for (let i = 0; i < totalSteps; i++) {
        const posInBeat = i % state.subdivisions;
        const beatLabel = beatLabels[posInBeat] || 'A';
        const swingValue = (state.swing[beatLabel] || 0) + 20;
        swingValues.push(swingValue);
    }
    const swingAmounts = swingValues.map((value) => swingFactor * (value / 100) * baseStepMs);
    const totalSwing = swingAmounts.reduce((acc, value) => acc + value, 0);
    const totalBase = totalSteps * baseStepMs;
    const norm = (totalBase - totalSwing) / totalSteps;
    const stepDelays = swingAmounts.map((amount) => Math.max(1, amount + norm));
    const cumulativeMs = new Array(totalSteps).fill(0);
    let running = 0;
    for (let i = 0; i < totalSteps; i++) {
        cumulativeMs[i] = running;
        running += stepDelays[i];
    }
    return {
        totalSteps,
        stepDelays,
        cumulativeMs,
        cycleMs: Math.max(1, running)
    };
}

function scheduleNextStep(runId = state._playbackRunId) {
    if (!state.isPlaying) return;
    const activeRunId = Number.isFinite(Number(runId))
        ? Number(runId)
        : (parseInt(state._playbackRunId, 10) || 0);
    if (activeRunId !== state._playbackRunId) {
        transportDiag.push('warn', 'schedule_stale_run_rejected', {
            activeRunId,
            stateRunId: parseInt(state._playbackRunId, 10) || 0
        });
        return;
    }
    schedLastTickPerf = 0;
    schedTicker.start(() => transportSchedulerTick(activeRunId));
    transportSchedulerTick(activeRunId);
}

function transportSchedulerTick(activeRunId) {
    if (!state.isPlaying || activeRunId !== state._playbackRunId) {
        if (activeRunId !== state._playbackRunId && !state.isPlaying) schedTicker.stop();
        return;
    }
    if (schedCallOutEnd) {
        if (audioContext.currentTime >= schedCallOutEnd.audioTime
            && transportEpochNow() >= schedCallOutEnd.epoch) stopPlayback();
        return;
    }
    const perfNow = performance.now();
    if (schedLastTickPerf) {
        const gap = perfNow - schedLastTickPerf;
        if (gap > transportStats.maxTickGapMs) transportStats.maxTickGapMs = Math.round(gap);
        // Remember recent main-thread stalls and look further ahead for a while.
        schedStallMs = Math.max(gap, schedStallMs * 0.985);
    }
    schedLastTickPerf = perfNow;

    if (!Number.isFinite(Number(state._playbackAnchorEpoch))) {
        state._playbackAnchorEpoch = transportEpochNow();
    }
    if (!Number.isFinite(Number(state._playbackStepCounter))) {
        state._playbackStepCounter = 0;
    }

    const now = transportEpochNow();
    const horizon = now + transportLookaheadMs();
    let guard = 0;
    while (guard++ < 256) {
        if (!state.isPlaying || activeRunId !== state._playbackRunId) return;
        // Rebuilt every step so tempo, swing and grid changes apply to the next unscheduled step.
        const plan = buildStepTimingPlan();
        let anchorEpoch = Number(state._playbackAnchorEpoch);
        const eventEpochForCounter = (counter) => {
            const cycle = Math.floor(counter / plan.totalSteps);
            const stepInCycle = counter % plan.totalSteps;
            return anchorEpoch + (cycle * plan.cycleMs) + plan.cumulativeMs[stepInCycle];
        };
        let counter = Math.max(0, Math.floor(Number(state._playbackStepCounter) || 0));
        let targetEpoch = eventEpochForCounter(counter);

        // Fell behind (page stalled, or the anchor moved): jump to the next step that can still be on time.
        if (targetEpoch < (now - 35) && callOutSequenceState?.active && !callOutSequenceState.armed) {
            // Keep every stroke of the ending in order after a scheduler stall.
            anchorEpoch += now - targetEpoch;
            state._playbackAnchorEpoch = anchorEpoch;
            targetEpoch = now;
        } else if (targetEpoch < (now - 35)) {
            let skipped = 0;
            const maxCatchup = Math.max(plan.totalSteps * 4, 16);
            if ((now - targetEpoch) > plan.cycleMs * 4) {
                const cyclesBehind = Math.floor((now - targetEpoch) / plan.cycleMs) - 1;
                counter += cyclesBehind * plan.totalSteps;
                skipped += cyclesBehind * plan.totalSteps;
                targetEpoch = eventEpochForCounter(counter);
            }
            let catchGuard = 0;
            while (targetEpoch < (now - 35) && catchGuard < maxCatchup) {
                counter += 1;
                targetEpoch = eventEpochForCounter(counter);
                catchGuard += 1;
                skipped += 1;
            }
            transportStats.skipped += skipped;
            transportDiag.push('warn', 'schedule_catchup', { runId: activeRunId, skipped, now, targetEpoch });
            state._playbackStepCounter = counter;
        }
        if (targetEpoch > horizon) break;

        const stepToPlay = counter % plan.totalSteps;
        const when = audioTimeForEpoch(targetEpoch);
        const lateMs = (audioContext.currentTime - when) * 1000;
        transportStats.scheduled += 1;
        if (lateMs > 1) {
            transportStats.late += 1;
            if (lateMs > transportStats.worstLateMs) transportStats.worstLateMs = Math.round(lateMs);
        }
        transportDiag.push('debug', 'schedule_step', {
            runId: activeRunId,
            stepToPlay,
            counter,
            leadMs: Math.round(targetEpoch - now),
            tempo: state.tempo
        });

        schedWhen = Math.max(when, audioContext.currentTime);
        try {
            playStep(stepToPlay, { targetEpoch, generation: schedGeneration, runId: activeRunId });
        } finally {
            schedWhen = null;
        }
        if (activeRunId !== state._playbackRunId) return;
        // playStep may re-anchor (call sequences); only advance if the counter was not moved.
        if (Math.floor(Number(state._playbackStepCounter) || 0) === counter) {
            state._playbackStepCounter = counter + 1;
        }
        schedNextEpoch = eventEpochForCounter(counter + 1);
        if (schedCallOutEnd) break;
    }
}

function stopPlayback() {
    state._playbackPrepareRequestId = (parseInt(state._playbackPrepareRequestId, 10) || 0) + 1;
    transportDiag.push('info', 'stop_playback_requested', {
        runId: parseInt(state._playbackRunId, 10) || 0,
        currentStep: parseInt(state.currentStep, 10) || 0
    });
    clearSessionSequenceTimers();
    if (callInSequenceState && callInSequenceState.active) {
        finishCallInSequence({ cancelled: true });
    }
    callOutSequenceState = null;
    callPending = false;
    callActive = false;
    callStep = 0;
    state.isPlaying = false;
    clearLocalPlaybackScheduler(false);
    stopCircularAnimation();
    syncPlaybackButtons();
    document.getElementById('currentBeat').textContent = '';
    syncActiveBeatColor(0);

    // Show call row when not playing
    updateCallRowVisibility();
    const callStatus = document.getElementById('callStatus');
    if (callStatus) callStatus.textContent = '';
    syncCallButtons();

    const cache = getPlaybackDomCache();
    if (cache) {
        if (cache.prevStep !== null && cache.boxesByStep[cache.prevStep]) {
            cache.boxesByStep[cache.prevStep].forEach((box) => {
                box.classList.remove('playing');
                box.classList.remove('keep-size');
                box.classList.remove('current-step');
                box.classList.remove('playhead-active');
            });
        }
        if (cache.prevBeatEl) {
            cache.prevBeatEl.classList.remove('current-beat');
            cache.prevBeatEl.classList.remove('arc-hop');
        }
        cache.prevStep = null;
        cache.prevBeatEl = null;
    } else {
        document.querySelectorAll('.notation-box.playing, .notation-box.current-step, .notation-box.playhead-active').forEach(box => {
            box.classList.remove('playing');
            box.classList.remove('keep-size');
            box.classList.remove('current-step');
            box.classList.remove('playhead-active');
        });
        document.querySelectorAll('.beat-number.current-beat, .beat-number.arc-hop').forEach(el => {
            el.classList.remove('current-beat');
            el.classList.remove('arc-hop');
        });
    }
    try { window.parent.postMessage({ type: 'notationPlaybackState', playing: false }, '*'); } catch {}
    postNotationStateToParent();
}

// Runs when a step is SCHEDULED (slightly ahead of time): transport logic and sounds happen
// here with exact audio times. Everything the player sees or that leaves this frame (playhead,
// beat display, ticks to the parent, note events) is deferred until the step is heard.
function playStep(step, sched = {}) {
    const totalSteps = Math.max(1, state.beats * state.subdivisions);
    const safeStep = ((parseInt(step, 10) || 0) % totalSteps + totalSteps) % totalSteps;
    const absoluteStepCounter = Math.max(0, Math.floor(Number(state._playbackStepCounter) || 0));
    const targetEpoch = Number.isFinite(sched.targetEpoch) ? sched.targetEpoch : transportEpochNow();
    const generation = Number.isFinite(sched.generation) ? sched.generation : schedGeneration;
    const visuals = [];
    const atAudibleTime = (fn) => visuals.push(fn);

    // Tell the parent ahead of time exactly when this step will be heard, so its own
    // timelines (pad preview) can follow the clock instead of the arrival of messages.
    try {
        const schedPlan = buildStepTimingPlan();
        window.parent.postMessage({
            type: 'notationStepScheduled',
            step: safeStep,
            stepEpoch: targetEpoch,
            stepDurationMs: schedPlan.stepDelays[safeStep % schedPlan.totalSteps] || 0,
            tempo: state.tempo,
            metronome: !!metronomeEnabled,
            callActive: !!callActive,
            // The call stroke heard on this step (processCallStep runs after this message).
            callSound: (callPending && safeStep === callStartStep) ? (callPattern?.[callStartStep] || null)
                : (callActive && callStep < (callPattern?.length || 0)) ? (callPattern[callStep] || null) : null,
            // Parts held back this step (Call In: count-in bar, then the call alone).
            silentIds: state.instruments.filter((i) => shouldSuppressInstrumentForCallInSequence(i, absoluteStepCounter)).map((i) => i.id)
        }, '*');
    } catch {}

    if (callInSequenceState && callInSequenceState.active) {
        if (absoluteStepCounter >= callInSequenceState.completeCounter) {
            finishCallInSequence();
        }
        if (callInSequenceState && callInSequenceState.active && !callInSequenceState.callCued && absoluteStepCounter >= callInSequenceState.callCueCounter) {
            cueCall({ silent: true, force: true, fromSession: true });
            callInSequenceState.callCued = true;
        }
    }

    atAudibleTime(() => {
    state.currentStep = safeStep;
    state._lastPlayedStep = safeStep;
    state._lastStepTime = performance.now();
    state._lastStepEpoch = targetEpoch;
    // Update current beat display
    const beat = Math.floor(safeStep / state.subdivisions) + 1;
    const sub = (safeStep % state.subdivisions) + 1;
    const beatColor = syncActiveBeatColor(safeStep);
    document.getElementById('currentBeat').textContent = `${beat}.${sub}`;
    const driftMs = transportEpochNow() - targetEpoch;
    if (Math.abs(driftMs) > 40) {
        transportDiag.push('warn', 'step_drift_high', {
            runId: parseInt(state._playbackRunId, 10) || 0,
            step: safeStep,
            driftMs,
            tempo: state.tempo
        });
    } else {
        transportDiag.push('debug', 'step_played', {
            runId: parseInt(state._playbackRunId, 10) || 0,
            step: safeStep,
            driftMs
        });
    }

    // Update circular view if in circular mode
    if (state.viewMode === 'circular') {
        drawCircularView();
    }

    try {
        window.parent.postMessage({
            type: 'notationPlaybackTick',
            step: safeStep,
            stepEpoch: state._lastStepEpoch || Date.now(),
            tempo: state.tempo,
            beatColor,
            playing: !!state.isPlaying
        }, '*');
    } catch {}
    });

    // Play metronome click only on beat positions (first subdivision of each beat)
    const isDownbeat = (safeStep % state.subdivisions) === 0;
    const allowMetronomeThisStep = !(callInSequenceState && callInSequenceState.active && absoluteStepCounter >= callInSequenceState.totalSteps);
    if (isDownbeat && allowMetronomeThisStep) {
        const isFirstBeat = safeStep === 0; // First beat of the pattern
        playMetronomeClick(isFirstBeat);
    }

    atAudibleTime(() => {
    const cache = getPlaybackDomCache();
    if (cache) {
        if (cache.prevStep !== null && cache.prevStep !== safeStep && cache.boxesByStep[cache.prevStep]) {
            cache.boxesByStep[cache.prevStep].forEach((box) => {
                box.classList.remove('playing');
                box.classList.remove('keep-size');
                box.classList.remove('current-step');
                box.classList.remove('playhead-active');
            });
        }
        const currentBeatEl = cache.beatNumbers[safeStep] || null;
        if (cache.prevBeatEl && cache.prevBeatEl !== currentBeatEl) {
            cache.prevBeatEl.classList.remove('current-beat');
            cache.prevBeatEl.classList.remove('arc-hop');
        }
        if (currentBeatEl) {
            currentBeatEl.classList.add('current-beat');
            if (cache.prevBeatEl !== currentBeatEl) {
                currentBeatEl.classList.remove('arc-hop');
                void currentBeatEl.offsetWidth;
                currentBeatEl.classList.add('arc-hop');
            }
            cache.prevBeatEl = currentBeatEl;
        }
    } else {
        document.querySelectorAll('.notation-box.playing, .notation-box.current-step, .notation-box.playhead-active').forEach(box => {
            box.classList.remove('playing');
            box.classList.remove('keep-size');
            box.classList.remove('current-step');
            box.classList.remove('playhead-active');
        });
        document.querySelectorAll('.beat-number.current-beat, .beat-number.arc-hop').forEach(el => {
            el.classList.remove('current-beat');
            el.classList.remove('arc-hop');
        });
        const beatNumbers = document.querySelectorAll('.beat-number');
        if (beatNumbers[safeStep]) {
            beatNumbers[safeStep].classList.add('current-beat');
            beatNumbers[safeStep].classList.remove('arc-hop');
            void beatNumbers[safeStep].offsetWidth;
            beatNumbers[safeStep].classList.add('arc-hop');
        }
    }

    // Highlight current step column with playhead
    const stepBoxes = cache && Array.isArray(cache.boxesByStep?.[safeStep])
        ? cache.boxesByStep[safeStep]
        : Array.from(document.querySelectorAll(`.notation-box[data-step="${safeStep}"]`));
    stepBoxes.forEach(box => {
        box.classList.add('playing');
        box.classList.add('current-step');
        box.classList.add('playhead-active');

        // Add keep-size class if enabled
        if (debugSettings.keepSize) {
            box.classList.add('keep-size');
        }

    });
    if (cache) cache.prevStep = safeStep;
    });

    const hasSoloActive = state.instruments.some((instr) => instr?.soloed === true);

    // Trigger actual sounds by instrument model (avoids per-cell DOM reads)
    state.instruments.forEach((instrument) => {
        const soloAllowed = !hasSoloActive || instrument?.soloed === true;
        const suppressedByCallIn = shouldSuppressInstrumentForCallInSequence(instrument, absoluteStepCounter);
        if (!soloAllowed || suppressedByCallIn) return;
        if (instrument.visible === false || instrument.muted === true) return;
        const sound = instrument.pattern?.[safeStep];
        if (!sound || sound === 'silence') return;
        playSound(sound, instrument);
        const noteVolume = instrument.volume || 1.0;
        const noteId = instrument.id;
        const noteType = instrument.type;
        atAudibleTime(() => emitNoteEvent('note', sound, noteVolume, noteId, safeStep, { instrumentType: noteType }));
    });

    // === CALL INSTRUMENT MANAGEMENT ===
    const callInstr = state.instruments.find(i => i.isCall);

    // When call is pending (cued for next measure), activate it slightly before beat 1
    if (callPending && safeStep === ((callStartStep - 1 + totalSteps) % totalSteps)) {
        // Activate call 1 step before beat 1 (unmute and show)
        if (callInstr) {
            callInstr.volume = 1.0;
            callInstr.visible = true;
        }
        updateGrid();
    }

    // Process call voice if active
    const callSound = processCallStep(safeStep, absoluteStepCounter);
    if (callSound && callSound !== 'silence' && callActive) {
        const callInstrPlay = { type: 'djembe_solo', sampleSet: 'Solo', volume: 1.0, id: 'call' };
        playSound(callSound, callInstrPlay);
        atAudibleTime(() => emitNoteEvent('call', callSound, 1.0, 'call', safeStep, { instrumentType: callInstrPlay.type }));
    }

    // When call finishes, mute and hide immediately
    if (callInstr && !callActive && !callPending && state.isPlaying) {
        if (callInstr.volume !== 0 || callInstr.visible !== false) {
            callInstr.volume = 0;
            callInstr.visible = false;
            updateGrid();
        }
    }

    if (callOutSequenceState && callOutSequenceState.active && Number.isFinite(callOutSequenceState.stopCounter)) {
        if (absoluteStepCounter >= callOutSequenceState.stopCounter) {
            // The audible epoch and AudioContext clock differ by output latency.
            // Wait for the final scheduled attack, including any roll strokes, before
            // stopping the transport, which cancels sources that have yet to start.
            let audioTime = schedWhen ?? audioContext.currentTime;
            for (const entry of scheduledSources) audioTime = Math.max(audioTime, entry.when);
            schedCallOutEnd = { audioTime, epoch: targetEpoch };
        }
    }

    // Run the visual half when this step is heard. Dropped if the transport stopped or re-synced meanwhile.
    const runVisuals = () => {
        if (generation !== schedGeneration || !state.isPlaying) return;
        for (let i = 0; i < visuals.length; i += 1) {
            try { visuals[i](); } catch (err) { console.error(err); }
        }
    };
    const visualDelay = targetEpoch - transportEpochNow();
    if (visualDelay > 4) setTimeout(runVisuals, visualDelay);
    else runVisuals();
}

// Local Storage
function saveToLocalStorage() {
    if (suppressPersistence) return;
    captureCurrentPatternsToArchive(state.beats, state.subdivisions);
    const data = {
        rhythmName: state.rhythmName,
        beats: state.beats,
        subdivisions: state.subdivisions,
        tempo: state.tempo,
        cycleMode: !!state.cycleMode,
        rapidCycleEnabled: state.rapidCycleEnabled !== false,
        compactMode: state.compactMode,
        compactInstrumentPanelOpen: state.compactInstrumentPanelOpen !== false,
        masterVolume: masterVolume,
        masterMuted: !!masterMuted,
        swing: state.swing,
        themeColor: state.themeColor,
        instruments: state.instruments,
        patternArchive: patternArchive
    };
    localStorage.setItem('rhythmNotation', JSON.stringify(data));
    postRhythmStateToParent();
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('rhythmNotation');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            state.rhythmName = data.rhythmName || 'Kassa';
            state.beats = data.beats || 4;
            state.subdivisions = data.subdivisions || 4;
            state.tempo = data.tempo || 100;
            state.cycleMode = false;
            state.rapidCycleEnabled = data.rapidCycleEnabled !== false;
            state.compactMode = !!data.compactMode;
            state.compactInstrumentPanelOpen = data.compactInstrumentPanelOpen !== false;
            masterVolume = Math.max(0, Math.min(1, Number.isFinite(Number(data.masterVolume)) ? Number(data.masterVolume) : 1));
            masterMuted = !!data.masterMuted;
            patternArchive = (data.patternArchive && typeof data.patternArchive === 'object')
                ? data.patternArchive
                : {};
            gridRestoreHints = {};
            gridRestoreSnapshots = {};
            // Handle both old (number) and new (object) swing formats
            if (typeof data.swing === 'object') {
                state.swing = data.swing;
            } else {
                state.swing = { factor: data.swing || 35, A: 0, B: 15, C: 0, D: 15 };
            }
            state.themeColor = data.themeColor || '#fcd116';
            state.instruments = data.instruments || state.instruments;
            normalizeInstrumentRuntimeState();

            // CRITICAL: Ensure Call instrument is always present at position 0 (NEW!)
            // This fixes the issue where old saved rhythms don't have the Call
            const hasCall = state.instruments.some(i => i.isCall);
            if (!hasCall) {
                const callInstrument = {
                    id: 'call1',
                    name: 'Call',
                    icon: '📣',
                    type: 'djembe_solo',
                    sampleSet: 'Solo',
                    pattern: [],
                    visible: true,
                    muted: false,
                    volume: 1.0,
                    soloed: false,
                    pan: 0,
                    focused: false,
                    isCall: true
                };
                // Insert Call at position 0 (FIRST)
                state.instruments.unshift(callInstrument);
                console.log('✅ Call instrument injected at position 0');
            } else {
                // If Call exists but not at position 0, move it
                const callIndex = state.instruments.findIndex(i => i.isCall);
                if (callIndex !== 0) {
                    const call = state.instruments.splice(callIndex, 1)[0];
                    state.instruments.unshift(call);
                    console.log('✅ Call instrument moved to position 0 from loaded data');
                }
            }

            captureCurrentPatternsToArchive(state.beats, state.subdivisions);
            // Update UI
            document.getElementById('rhythmName').value = state.rhythmName;
            document.getElementById('beatCount').value = state.beats;
            document.getElementById('subdivisions').value = state.subdivisions;
            document.getElementById('tempo').value = state.tempo;
            document.getElementById('tempoDisplay').innerHTML = `${state.tempo}<span>BPM</span>`;

            // Update swing sliders
            updateSwingUI();
            applyMasterGain();
            syncMasterUi();
            syncCompactUi();
            postTempoStateToParent();
            postNotationStateToParent();

        } catch (e) {
            console.error('Error loading saved notation:', e);
        }
    }
}

// NEW: Ensure Call instrument always exists and is first
function ensureCallInstrumentExists() {
    const hasCall = state.instruments.some(i => i.isCall);
    if (!hasCall) {
        const callInstrument = {
            id: 'call1',
            name: 'Call',
            icon: '📣',
            type: 'djembe_solo',
            sampleSet: 'Solo',
            pattern: [],
            visible: true,
            muted: false,
            volume: 1.0,
            soloed: false,
            pan: 0,
            focused: false,
            isCall: true
        };
        // Insert Call at position 0 (FIRST)
        state.instruments.unshift(callInstrument);
        console.log('✅ Call instrument ensured at position 0');
    } else {
        // If Call exists but not at position 0, move it
        const callIndex = state.instruments.findIndex(i => i.isCall);
        if (callIndex !== 0) {
            const call = state.instruments.splice(callIndex, 1)[0];
            state.instruments.unshift(call);
            console.log('✅ Call instrument moved to position 0');
        }
    }
}

function ensureShekereInstrumentExists() {
    const hasShekere = state.instruments.some((instrument) => String(instrument?.type || '').toLowerCase() === 'shekere');
    if (hasShekere) return;
    const totalSteps = Math.max(1, (parseInt(state.beats, 10) || 1) * (parseInt(state.subdivisions, 10) || 1));
    const shekereInstrument = {
        id: 'shekere1',
        name: 'Shekere',
        icon: '🎶',
        type: 'shekere',
        sampleSet: 'default',
        pattern: new Array(totalSteps).fill('silence'),
        visible: true,
        muted: false,
        volume: 1.0,
        soloed: false,
        pan: 0,
        focused: false
    };
    state.instruments.push(shekereInstrument);
    console.log('✅ Shekere instrument ensured');
}

// Update swing UI from state
function updateSwingUI() {
    // Factor is in debug panel
    const factorSlider = document.getElementById('swingFactor');
    if (factorSlider) {
        factorSlider.value = state.swing.factor;
        document.getElementById('swingFactorValue').textContent = state.swing.factor;
    }

    // Beat sliders (A, B, C, D) range from -50 to +50
    ['A', 'B', 'C', 'D'].forEach(beat => {
        const slider = document.getElementById('swing' + beat);
        const value = state.swing[beat] || 0;
        if (slider) {
            slider.value = value;
            // Fill: -50 = 0%, 0 = 50%, +50 = 100%
            const fillPercent = ((value + 50) / 100) * 100;
            slider.style.setProperty('--slider-fill', fillPercent + '%');
            document.getElementById('swing' + beat + 'Value').textContent = value;
        }
    });
}

// Export rhythm to JSON file
function exportRhythm() {
    const data = {
        rhythmName: state.rhythmName,
        beats: state.beats,
        subdivisions: state.subdivisions,
        tempo: state.tempo,
        swing: state.swing,
        themeColor: state.themeColor,
        instruments: state.instruments,
        exportedAt: new Date().toISOString()
    };

    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.rhythmName.replace(/\s+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Trigger file import
function importRhythm() {
    document.getElementById('importFile').click();
}

// Handle file import
function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            loadRhythmData(data);
            ensureInlineUiFeedback().toast(`Loaded rhythm: ${data.rhythmName || 'Imported'}`, 'success');
        } catch (err) {
            await ensureInlineUiFeedback().alert('Error importing file: Invalid JSON format', 'Import Error');
            console.error('Import error:', err);
        }
    };
    reader.readAsText(file);

    // Reset file input
    event.target.value = '';
}

function applyRhythmSyncData(data) {
    if (!data || typeof data !== 'object') return;

    const nextBeats = Math.max(1, Math.min(32, parseInt(data.beats, 10) || state.beats || 4));
    const nextSubdivisions = Math.max(1, Math.min(16, parseInt(data.subdivisions, 10) || state.subdivisions || 4));
    const totalSteps = Math.max(1, nextBeats * nextSubdivisions);

    state.rhythmName = typeof data.rhythmName === 'string' ? data.rhythmName : state.rhythmName;
    state.beats = nextBeats;
    state.subdivisions = nextSubdivisions;
    if (data.swing && typeof data.swing === 'object') {
        state.swing = { ...state.swing, ...data.swing };
    }
    if (data.themeColor) state.themeColor = data.themeColor;
    if (Number.isFinite(Number(data.tempo))) {
        applyTempo(data.tempo, { restartPlayback: false, persist: false, broadcast: false });
    }

    if (Array.isArray(data.instruments)) {
        const previousInstruments = state.instruments;
        state.instruments = data.instruments.map((instrument) => {
            const nextPattern = Array.isArray(instrument.pattern)
                ? instrument.pattern.slice(0, totalSteps)
                : [];
            while (nextPattern.length < totalSteps) nextPattern.push(null);
            return {
                ...instrument,
                pattern: nextPattern
            };
        });
        carryInstrumentMix(previousInstruments);
    }

    state.currentStep = ((state.currentStep % totalSteps) + totalSteps) % totalSteps;
    state._lastPlayedStep = state.currentStep;
    ensureCallInstrumentExists();
    ensureShekereInstrumentExists();
    normalizeInstrumentRuntimeState();

    const rhythmNameInput = document.getElementById('rhythmName');
    const beatInput = document.getElementById('beatCount');
    const subdivisionInput = document.getElementById('subdivisions');
    const tempoInput = document.getElementById('tempo');
    if (rhythmNameInput) rhythmNameInput.value = state.rhythmName || '';
    if (beatInput) beatInput.value = state.beats;
    if (subdivisionInput) subdivisionInput.value = state.subdivisions;
    if (tempoInput) tempoInput.value = state.tempo;

    updateSwingUI();
    updateInstrumentToolbar();
    suppressPersistence = true;
    try {
        updateGrid();
    } finally {
        suppressPersistence = false;
    }
    captureCurrentPatternsToArchive(state.beats, state.subdivisions);
    syncCompactUi();
    if (state.viewMode === 'circular') initCircularView();
}

// Load rhythm data from object (used by import and example)
// Mute and solo belong to this device, not to the rhythm: keep them by instrument id when a rhythm is
// (re)loaded, e.g. when a session reloads it on Play, so a soloed drum stays soloed.
function carryInstrumentMix(previous) {
    if (!Array.isArray(previous) || !previous.length || !Array.isArray(state.instruments)) return;
    const byId = new Map(previous.filter(Boolean).map((i) => [String(i.id), i]));
    state.instruments.forEach((instrument) => {
        const prev = instrument && byId.get(String(instrument.id));
        if (!prev) return;
        instrument.muted = prev.muted === true;
        instrument.soloed = prev.soloed === true;
    });
}

function loadRhythmData(data) {
    state.rhythmName = data.rhythmName || 'Imported Rhythm';
    selectedRhythmCatalogName = String(state.rhythmName || '').trim();
    if (!selectedRhythmCatalogKey && Array.isArray(availableRhythmCatalog) && availableRhythmCatalog.length) {
        const matched = availableRhythmCatalog.find((entry) => String(entry.name || '').trim().toLowerCase() === selectedRhythmCatalogName.toLowerCase());
        if (matched) selectedRhythmCatalogKey = matched.key;
    }
    state.beats = data.beats || 4;
    state.subdivisions = data.subdivisions || 4;
    state.tempo = data.tempo || 100;
    // Handle both old (number) and new (object) swing formats
    if (typeof data.swing === 'object') {
        state.swing = data.swing;
    } else {
        state.swing = { factor: data.swing || 35, A: 0, B: 15, C: 0, D: 15 };
    }
    state.themeColor = data.themeColor || '#fcd116';
    const previousInstruments = state.instruments;
    state.instruments = data.instruments || state.instruments;
    carryInstrumentMix(previousInstruments);
    ensureCallInstrumentExists();
    ensureShekereInstrumentExists();
    normalizeInstrumentRuntimeState();

    // Update UI
    document.getElementById('rhythmName').value = state.rhythmName;
    document.getElementById('beatCount').value = state.beats;
    document.getElementById('subdivisions').value = state.subdivisions;
    document.getElementById('tempo').value = state.tempo;
    document.getElementById('tempoDisplay').innerHTML = `${state.tempo}<span>BPM</span>`;
    populateRhythmSelectionDropdowns();
    syncCompactUi();

    // Update swing sliders
    updateSwingUI();
    setSwingFromMeta(data.swing);

    updateGrid();
    captureCurrentPatternsToArchive(state.beats, state.subdivisions);
    postTempoStateToParent();
    postNotationStateToParent();
}

function setSwingFromMeta(swingMeta) {
    if (!swingMeta || typeof swingMeta !== 'object') return;
    // swingMeta is an object like {A: 0, B: 15, C: 0, D: 15}
    ['A', 'B', 'C', 'D'].forEach(beat => {
        if (swingMeta.hasOwnProperty(beat)) {
            const val = parseInt(swingMeta[beat]);
            state.swing[beat] = Number.isFinite(val) ? val : 0;
            // Update slider and label
            const slider = document.getElementById('swing' + beat);
            const label = document.getElementById('swing' + beat + 'Value');
            if (slider) {
                const safeVal = Number.isFinite(val) ? val : 0;
                slider.value = safeVal;
                const fillPercent = ((safeVal + 50) / 100) * 100;
                slider.style.setProperty('--slider-fill', fillPercent + '%');
            }
            if (label) {
                label.textContent = Number.isFinite(val) ? val : 0;
            }
        }
    });
    // If playing, restart to apply new swing timing
    if (state.isPlaying) {
        stopPlayback();
        startPlayback();
    }
    saveToLocalStorage();
}


// Helper to convert notation format: Open=tone, Slap=slap, Bass=bass, Muffled=mute, null=silence
function convertStep(step) {
    if (!step) return 'silence';
    const lower = step.toLowerCase();
    if (lower === 'open') return 'tone';
    if (lower === 'slap') return 'slap';
    if (lower === 'bass') return 'bass';
    if (lower === 'muffled') return 'mute';
    return 'silence';
}

// Load example rhythm - Kassa (Malinke harvest rhythm from Guinea)
function loadExample() {
    const kassaRhythm = {
        rhythmName: 'Kassa',
        beats: 4,
        subdivisions: 4, // 16 steps = 4 beats x 4 subdivisions
        tempo: 100,
        swing: {
            factor: 100,
            A: 0,
            B: 15,
            C: 0,
            D: 15
        },
        themeColor: '#fcd116',
        instruments: [
            {
                id: 'djembe1',
                name: 'Djembe 1',
                icon: '🥁',
                type: 'djembe',
                sampleSet: 'One',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, Open, Slap, Slap, null, null, Slap, Slap, Open, Open, Slap, Slap, Bass, null, Slap, Slap
                pattern: ['tone', 'tone', 'slap', 'slap', 'silence', 'silence', 'slap', 'slap', 'tone', 'tone', 'slap', 'slap', 'bass', 'silence', 'slap', 'slap']
            },
            {
                id: 'djembe2',
                name: 'Djembe 2',
                icon: '🥁',
                type: 'djembe',
                sampleSet: 'Two',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Slap, null, null, Slap, Slap, null, Open, Open, Slap, null, null, Slap, Slap, null, Open, Open
                pattern: ['slap', 'silence', 'silence', 'slap', 'slap', 'silence', 'tone', 'tone', 'slap', 'silence', 'silence', 'slap', 'slap', 'silence', 'tone', 'tone']
            },
            {
                id: 'djembe3',
                name: 'Djembe 3',
                icon: '🥁',
                type: 'djembe',
                sampleSet: 'Three',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, null, Slap, Slap, null, Bass, Slap, Slap, Bass, null, Slap, Slap, Bass, Bass, Slap, Slap
                pattern: ['tone', 'silence', 'slap', 'slap', 'silence', 'bass', 'slap', 'slap', 'bass', 'silence', 'slap', 'slap', 'bass', 'bass', 'slap', 'slap']
            },
            {
                id: 'kenkeni1',
                name: 'Kenkeni',
                icon: '🪘',
                type: 'kenkeni',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, Open, null, null, null, null, Muffled, null, Open, Open, null, null, null, null, Muffled, null
                pattern: ['tone', 'tone', 'silence', 'silence', 'silence', 'silence', 'mute', 'silence', 'tone', 'tone', 'silence', 'silence', 'silence', 'silence', 'mute', 'silence']
            },
            {
                id: 'kenkeni_bell1',
                name: 'Kenkeni Bell',
                icon: '🔔',
                type: 'kenkeni_bell',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, Open, null, Open, null, Open, Open, null, Open, Open, null, Open, null, Open, Open, null
                pattern: ['tone', 'tone', 'silence', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'silence', 'tone', 'tone', 'silence']
            },
            {
                id: 'sangban1',
                name: 'Sangban',
                icon: '🪘',
                type: 'sangban',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Muffled, null, null, Open, null, null, Muffled, null, Muffled, null, null, Open, null, null, Muffled, null
                pattern: ['mute', 'silence', 'silence', 'tone', 'silence', 'silence', 'mute', 'silence', 'mute', 'silence', 'silence', 'tone', 'silence', 'silence', 'mute', 'silence']
            },
            {
                id: 'sangban_bell1',
                name: 'Sangban Bell',
                icon: '🔔',
                type: 'sangban_bell',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, null, Open, Open, null, Open, Open, null, Open, null, Open, Open, null, Open, Open, null
                pattern: ['tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence']
            },
            {
                id: 'doundoun1',
                name: 'Doundoun',
                icon: '🪘',
                type: 'doundoun',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, null, Open, Open, null, null, null, null, null, null, Open, Open, null, Open, Open, null
                pattern: ['tone', 'silence', 'tone', 'tone', 'silence', 'silence', 'silence', 'silence', 'silence', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence']
            },
            {
                id: 'doundoun_bell1',
                name: 'Doundoun Bell',
                icon: '🔔',
                type: 'doundoun_bell',
                sampleSet: 'default',
                visible: true,
                muted: false,
                volume: 1.0,
                focused: false,
                // Open, null, Open, Open, null, Open, Open, null, Open, null, Open, Open, null, Open, Open, null
                pattern: ['tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'silence', 'tone', 'tone', 'silence', 'tone', 'tone', 'silence']
            }
        ]
    };

    loadRhythmData(kassaRhythm);
}

// For future integration with map - get rhythm data object
function getRhythmData() {
    return {
        rhythmName: state.rhythmName,
        beats: state.beats,
        subdivisions: state.subdivisions,
        tempo: state.tempo,
        themeColor: state.themeColor,
        instruments: state.instruments
    };
}

// For future integration - set rhythm from map data
function setRhythmFromMap(rhythmData, themeColor) {
    if (themeColor) {
        rhythmData.themeColor = themeColor;
        // Could apply theme color to UI elements here
    }
    loadRhythmData(rhythmData);
}

// ── Integration with parent globe app ──────────────────────

function applyThemeColor(hexColor) {
    if (!hexColor || hexColor === '#000000') return;
    // Apply subtle theming from rhythm color
    document.documentElement.style.setProperty('--theme-accent', hexColor);
    document.documentElement.style.setProperty('--notation-scrollbar-thumb', hexToRgbaColor(hexColor, 0.55));
    document.documentElement.style.setProperty('--notation-scrollbar-thumb-hover', hexToRgbaColor(hexColor, 0.8));
    document.documentElement.style.setProperty('--notation-scrollbar-track', hexToRgbaColor(hexColor, 0.2));
    // Tint shared chrome without overriding articulation-specific active colors
    const style = document.getElementById('dynamic-theme') || document.createElement('style');
    style.id = 'dynamic-theme';
    style.textContent = `
        .notation-container { border-color: ${hexColor}30 !important; }
        .btn:hover { border-color: ${hexColor}60 !important; }
        .instrument-toolbar { border-color: ${hexColor}20 !important; }
        .combined-controls-bar { border-color: ${hexColor}20 !important; }
    `;
    if (!style.parentNode) document.head.appendChild(style);
    console.log('Notation: applied theme color', hexColor);
}

function resolveTriggerPadInstrument(instrumentId, instrumentType) {
    const byId = String(instrumentId || '').trim();
    if (byId) {
        const match = state.instruments.find((instrument) => instrument.id === byId);
        if (match) return match;
    }
    const byType = String(instrumentType || '').trim();
    if (byType) {
        const visibleMatch = state.instruments.find((instrument) => instrument.type === byType && instrument.visible !== false);
        if (visibleMatch) return visibleMatch;
        const typeMatch = state.instruments.find((instrument) => instrument.type === byType);
        if (typeMatch) return typeMatch;
    }
    return state.instruments.find((instrument) => !instrument.isCall) || state.instruments[0] || null;
}

function getTriggerPadBellType(type) {
    const base = String(type || '').trim().toLowerCase();
    if (!base) return '';
    if (base.endsWith('_bell')) return base;
    if (base === 'kenkeni' || base === 'sangban' || base === 'doundoun') return `${base}_bell`;
    return '';
}

function resolveTriggerPadBellInstrument(instrumentId, instrumentType, fallbackInstrument = null) {
    const byId = String(instrumentId || '').trim();
    if (byId) {
        const bellId = byId.includes('_bell')
            ? byId
            : (/\d+$/.test(byId) ? byId.replace(/(\d+)$/, '_bell$1') : `${byId}_bell`);
        const bellById = state.instruments.find((instrument) => instrument.id === bellId);
        if (bellById) return bellById;
    }

    const candidateTypes = [
        getTriggerPadBellType(fallbackInstrument?.type),
        getTriggerPadBellType(instrumentType)
    ].filter(Boolean);
    for (const type of candidateTypes) {
        const visible = state.instruments.find((instrument) => instrument.type === type && instrument.visible !== false);
        if (visible) return visible;
        const any = state.instruments.find((instrument) => instrument.type === type);
        if (any) return any;
    }
    return null;
}

function normalizeTriggerPadSound(sound, instrument) {
    if (!instrument) return null;
    let next = String(sound || '').trim().toLowerCase();
    if (!next) return null;
    if (next === 'open') next = 'tone';
    if (next === 'bell') next = 'slap';

    const articulations = getInstrumentArticulations(instrument);
    if (articulations.includes(next)) return next;
    if (articulations.includes('tone')) return 'tone';
    if (articulations.includes('slap')) return 'slap';
    if (articulations.includes('bass')) return 'bass';
    if (articulations.includes('mute')) return 'mute';
    return null;
}

function normalizeTriggerPadLane(rawLane) {
    const lane = parseInt(rawLane, 10);
    return lane === 1 ? 1 : 0;
}

function shouldEmitTriggerPadEvents() {
    // Default off for low-latency finger drumming; set localStorage key to "true" to re-enable.
    return localStorage.getItem('notationPadEmitEvents') === 'true';
}

function triggerPadHit(data) {
    if (!audioSamplesLoaded) {
        ensureAudioSamplesReady().then(() => {
            triggerPadHit(data);
        }).catch(() => {});
        return;
    }
    const rawSound = String(data?.sound || '').trim().toLowerCase();
    let instrument = resolveTriggerPadInstrument(data?.instrumentId, data?.instrumentType);
    if (!instrument) return;
    if (rawSound === 'bell') {
        const bellInstrument = resolveTriggerPadBellInstrument(data?.instrumentId, data?.instrumentType, instrument);
        if (bellInstrument) instrument = bellInstrument;
    }
    const sound = normalizeTriggerPadSound(rawSound, instrument);
    if (!sound || sound === 'silence') return;
    const velocityRaw = Number(data?.velocity);
    const velocity = Number.isFinite(velocityRaw) ? Math.max(0, Math.min(1, velocityRaw)) : 1.0;
    const reverbMixRaw = Number(data?.reverbMix);
    const reverbMix = Number.isFinite(reverbMixRaw) ? Math.max(0, Math.min(1, reverbMixRaw)) : 0.1;
    const triggerLane = normalizeTriggerPadLane(data?.triggerLane);
    // Pad playback intentionally ignores stage mix so finger drumming stays predictable:
    // - pan is always centered
    // - loudness comes from velocity only (plus global/master chain)
    // Alternate trigger lanes so rapid taps don't fight over one playback key.
    const laneSuffix = triggerLane === 1 ? '__padlane1' : '__padlane0';
    const playbackInstrument = {
        ...instrument,
        id: `${instrument.id}${laneSuffix}`,
        pan: 0,
        volume: 1.0
    };
    playSound(sound, playbackInstrument, velocity, { reverbMix });
    if (shouldEmitTriggerPadEvents()) {
        emitNoteEvent('trigger_pad', sound, velocity, instrument.id, state.currentStep, { instrumentType: instrument.type });
    }
}

// Same-origin fast path used by parent trigger-pad UI to reduce input latency.
window.__rrcTriggerPadHit = (data) => {
    triggerPadHit(data);
};
window.__rrcWarmupAudio = () => {
    warmupAudioContext();
};

window.addEventListener('message', (event) => {
    if (event.data?.type === 'notationRhythmCatalog') {
        const items = Array.isArray(event.data.items) ? event.data.items : [];
        availableRhythmCatalog = items
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const key = String(entry.key || '').trim();
                const name = String(entry.name || key).trim();
                if (!key || !name) return null;
                return { key, name };
            })
            .filter(Boolean);
        if (event.data.selectedKey) selectedRhythmCatalogKey = String(event.data.selectedKey).trim();
        if (event.data.selectedName) selectedRhythmCatalogName = String(event.data.selectedName).trim();
        populateRhythmSelectionDropdowns();
        return;
    }
    if (event.data?.type === 'notationForceLayout') {
        requestAutoScaleGridPasses();
        return;
    }
    const messageType = String(event?.data?.type || '').trim();
    if (messageType) {
        const important = (
            messageType === 'startPlayback' ||
            messageType === 'stopPlayback' ||
            messageType === 'togglePlayback' ||
            messageType === 'callButton' ||
            messageType === 'callOut' ||
            messageType === 'syncPlaybackState' ||
            messageType === 'syncPlaybackTick' ||
            messageType === 'syncNotationState' ||
            messageType === 'sessionSyncNudge' ||
            messageType === 'runSessionStartSequence' ||
            messageType === 'setTempo' ||
            messageType === 'syncTempo'
        );
        if (important) {
            transportDiag.push('info', 'incoming_message', {
                type: messageType,
                playing: !!state.isPlaying,
                runId: parseInt(state._playbackRunId, 10) || 0,
                step: parseInt(state.currentStep, 10) || 0
            });
        }
    }
    if (event.data?.type === 'loadRhythm') {
        const reqName = String(event.data.name || '').trim();
        const reqPath = String(event.data.notationPath || '').trim();
        const reqLookup = String(event.data.lookupKey || '').trim();
        const reqHasData = !!event.data.notationData;
        const reqKey = `${reqName}|${reqLookup}|${reqPath}|${reqHasData ? 'data' : 'nodata'}`;
        const now = Date.now();
        if (reqKey === lastLoadRhythmRequestKey && (now - lastLoadRhythmRequestAt) < 800) {
            transportDiag.push('debug', 'load_rhythm_dedup_skipped', { reqKey });
            return;
        }
        lastLoadRhythmRequestKey = reqKey;
        lastLoadRhythmRequestAt = now;

        if (event.data.notationData) {
            // Direct notation data passed from parent (from Supabase)
            loadRhythmData(event.data.notationData);
            console.log('Notation: loaded data from parent');
        } else if (event.data.notationPath) {
            const notationPath = String(event.data.notationPath || '').trim();
            if (notationPath) {
                loadRhythmFromPath(notationPath, event.data.name || 'remote hint').then((loaded) => {
                    if (!loaded && event.data.name) {
                        loadRhythmByName(event.data.name, event.data.lookupKey || '');
                    }
                });
            } else if (event.data.name) {
                console.log('Notation: received loadRhythm for:', event.data.name);
                loadRhythmByName(event.data.name, event.data.lookupKey || '');
            }
        } else if (event.data.name) {
            console.log('Notation: received loadRhythm for:', event.data.name);
            loadRhythmByName(event.data.name, event.data.lookupKey || '');
        }
        if (event.data.themeColor) applyThemeColor(event.data.themeColor);
        postTempoStateToParent();
        postNotationStateToParent();
    }
    if (event.data?.type === 'stopPlayback') {
        if (state.isPlaying) {
            stopPlayback();
            console.log('Notation: playback stopped by parent');
        }
    }
    if (event.data?.type === 'startPlayback') {
        if (!state.isPlaying) {
            const anchorEpoch = Number.isFinite(Number(event.data.anchorEpoch))
                ? Math.max(0, Math.round(Number(event.data.anchorEpoch)))
                : undefined;
            startPlayback(anchorEpoch ? { anchorEpoch, strictAnchor: event.data.strictAnchor === true } : {});
        }
    }
    if (event.data?.type === 'runSessionStartSequence') {
        runSessionStartSequence(event.data || {});
    }
    if (event.data?.type === 'cueCall') {
        cueCall({ silent: true, fromSession: !!event.data.fromSession });
    }
    if (event.data?.type === 'setSessionRole') {
        const role = String(event.data.role || '').trim().toLowerCase();
        sessionControlRole = (role === 'leader' || role === 'follower') ? role : 'none';
        sessionControlFreeMode = !!event.data.freeMode;
    }
    if (event.data?.type === 'setMetronomeEnabled') {
        metronomeEnabled = !!event.data.enabled;
        syncMetronomeButtons();
    }
    if (event.data?.type === 'setInstrumentMix') {           // room: solo / mute one seat's parts by id
        const ids = new Set(Array.isArray(event.data.ids) ? event.data.ids.map(String) : []);
        state.instruments.forEach((instr, idx) => {
            if (!instr || !ids.has(String(instr.id))) return;
            if (typeof event.data.muted === 'boolean' && (instr.muted === true) !== event.data.muted) toggleInstrumentMute(idx);
            if (typeof event.data.soloed === 'boolean' && (instr.soloed === true) !== event.data.soloed) toggleInstrumentSolo(idx);
        });
        postInstrumentMixToParent();
    }
    if (event.data?.type === 'requestInstrumentMix') postInstrumentMixToParent();
    if (event.data?.type === 'setTimingOffsetMs') {
        const v = Number(event.data.value);
        userTimingOffsetMs = Number.isFinite(v) ? Math.max(-150, Math.min(150, v)) : 0;
    }
    if (event.data?.type === 'setViewMode') {
        setViewMode(event.data.mode);
    }
    if (event.data?.type === 'togglePlayback') {
        togglePlayback({ fromParent: true });
    }
    if (event.data?.type === 'callButton') {
        handleCallButton({ fromParent: true, fromSession: !!event.data.fromSession });
    }
    if (event.data?.type === 'callOut') {
        runCallOut({ fromParent: true });
    }
    if (event.data?.type === 'setCallInStepOffset') {
        setCallInStepOffset(event.data.value, { persist: true, broadcast: true });
        return;
    }
    if (event.data?.type === 'tapTempo') {
        tapTempo();
    }
    if (event.data?.type === 'triggerPadHit') {
        triggerPadHit(event.data);
    }
    if (event.data?.type === 'warmupAudio') {
        warmupAudioContext();
    }
    if (event.data?.type === 'setTempo') {
        applyTempo(event.data.tempo, { restartPlayback: false, persist: true });
    }
    if (event.data?.type === 'setMasterVolume') {
        updateMasterVolume(event.data.value, { persist: false });
        postNotationStateToParent();
    }
    if (event.data?.type === 'setCompactMode') {
        const enabled = !!event.data.enabled;
        if (state.compactMode !== enabled) {
            state.compactMode = enabled;
            applyCompactMode();
            saveToLocalStorage();
        }
    }
    if (event.data?.type === 'setTransportPrimeLeadMs') {
        const next = Number(event.data.value);
        if (Number.isFinite(next)) {
            transportPrimeLeadMs = Math.max(0, Math.min(300, next));
            localStorage.setItem('notationPrimeLeadMs', String(transportPrimeLeadMs));
        }
    }
    if (event.data?.type === 'setInstrumentStagePosition') {
        const xNorm = Number(event.data.xNorm);
        const yNorm = Number(event.data.yNorm);
        setInstrumentStagePositionById(event.data.instrumentId, xNorm, yNorm, {
            transient: !!event.data.transient
        });
        return;
    }
    if (event.data?.type === 'setStageMinVolume') {
        setStageMinVolume(event.data.value, {
            persist: true,
            applyRuntime: true,
            broadcast: false
        });
        return;
    }
    if (event.data?.type === 'setStageVolumeRange') {
        setStageVolumeRange(event.data.min, event.data.max, {
            persist: true,
            applyRuntime: true,
            broadcast: false
        });
        return;
    }
    if (event.data?.type === 'syncTempo') {
        applyTempo(event.data.tempo, { restartPlayback: false, persist: false, broadcast: false });
        drawCircularView();
    }
    if (event.data?.type === 'shiftFollowerTiming') {
        const delta = Number(event.data.deltaMs);
        if (state.isPlaying && Number.isFinite(delta) && Math.abs(delta) <= 500 && Number.isFinite(state._playbackAnchorEpoch)) {
            state._playbackAnchorEpoch += delta;
            if (Number.isFinite(schedNextEpoch)) schedNextEpoch += delta;
        }
        return;
    }
    if (event.data?.type === 'sessionSyncNudge') {
        applySessionSyncNudge(event.data || {});
        return;
    }
    if (event.data?.type === 'syncPlaybackState') {
        clearLocalPlaybackScheduler(true);
        state.isPlaying = !!event.data.playing;
        syncPlaybackButtons();
        if (state.isPlaying) startCircularAnimation();
        else stopCircularAnimation();
        drawCircularView();
    }
    if (event.data?.type === 'syncPlaybackTick') {
        clearLocalPlaybackScheduler(true);
        if (Number.isFinite(Number(event.data.tempo))) {
            applyTempo(event.data.tempo, { restartPlayback: false, persist: false, broadcast: false });
        }
        if (Number.isFinite(Number(event.data.beats))) {
            state.beats = Math.max(1, parseInt(event.data.beats, 10) || state.beats || 1);
        }
        if (Number.isFinite(Number(event.data.subdivisions))) {
            state.subdivisions = Math.max(1, parseInt(event.data.subdivisions, 10) || state.subdivisions || 1);
        }
        if (Number.isFinite(Number(event.data.step))) {
            applyExternalPlaybackCursor(event.data.step, event.data.stepEpoch);
        } else if (Number.isFinite(Number(event.data.stepEpoch))) {
            state._lastStepEpoch = Math.max(0, Math.round(Number(event.data.stepEpoch)));
            state._lastStepTime = performance.now();
        }
        state.isPlaying = !!event.data.playing;
        if (state.isPlaying) startCircularAnimation();
        else stopCircularAnimation();
        drawCircularView();
    }
    if (event.data?.type === 'syncNotationState') {
        clearLocalPlaybackScheduler(true);
        if (Number.isFinite(Number(event.data.tempo))) {
            applyTempo(event.data.tempo, { restartPlayback: false, persist: false, broadcast: false });
        }
        if (Number.isFinite(Number(event.data.beats))) {
            state.beats = Math.max(1, parseInt(event.data.beats, 10) || state.beats || 1);
        }
        if (Number.isFinite(Number(event.data.subdivisions))) {
            state.subdivisions = Math.max(1, parseInt(event.data.subdivisions, 10) || state.subdivisions || 1);
        }
        if (event.data.mode) {
            setViewMode(event.data.mode);
        }
        if (Number.isFinite(Number(event.data.step))) {
            applyExternalPlaybackCursor(event.data.step, event.data.stepEpoch);
        } else if (Number.isFinite(Number(event.data.stepEpoch))) {
            state._lastStepEpoch = Math.max(0, Math.round(Number(event.data.stepEpoch)));
            state._lastStepTime = performance.now();
        }
        state.isPlaying = !!event.data.playing;
        syncPlaybackButtons();
        if (state.isPlaying) startCircularAnimation();
        else stopCircularAnimation();
        drawCircularView();
    }
    if (event.data?.type === 'syncRhythmData') {
        if (event.data.rhythmData) {
            applyRhythmSyncData(event.data.rhythmData);
        }
        if (Array.isArray(event.data.beatColors) && event.data.beatColors.length) {
            debugSettings.beatColors = event.data.beatColors.slice(0, 12);
        }
        if (typeof event.data.usePadBeatVisuals !== 'undefined') {
            debugSettings.usePadBeatVisuals = !!event.data.usePadBeatVisuals;
        }
        if (typeof event.data.useBeatArcVisual !== 'undefined') {
            debugSettings.useBeatArcVisual = !!event.data.useBeatArcVisual;
        }
        if (Number.isFinite(Number(event.data.beatArcHeightPx))) {
            debugSettings.beatArcHeightPx = Math.max(1, Math.min(40, Number(event.data.beatArcHeightPx)));
        }
        if (typeof event.data.useNeonArticulationStyle !== 'undefined') {
            debugSettings.useNeonArticulationStyle = !!event.data.useNeonArticulationStyle;
        }
        applyDebugSettings();
        drawCircularView();
    }
    if (event.data?.type === 'syncCallState') {
        applyCallStateFromParent(event.data || {});
        return;
    }
    if (event.data?.type === 'setBeatArcVisual') {
        if (Number.isFinite(Number(event.data.arcHeightPx))) {
            debugSettings.beatArcHeightPx = Math.max(1, Math.min(40, Number(event.data.arcHeightPx)));
            applyDebugSettings();
            saveDebugSettings();
        }
    }
    if (event.data?.type === 'requestNotationState') {
        try { window.parent.postMessage({ type: 'notationPlaybackState', playing: !!state.isPlaying }, '*'); } catch {}
        postTempoStateToParent();
        postNotationStateToParent();
    }
    if (event.data?.type === 'requestRhythmState') {
        postRhythmStateToParent();
    }
    if (event.data?.type === 'rrcTransportDiag') {
        const command = String(event.data.command || '').trim();
        if (command === 'setEnabled') transportDiag.setEnabled(!!event.data.enabled);
        else if (command === 'setVerbose') transportDiag.setVerbose(!!event.data.verbose);
        else if (command === 'clear') transportDiag.clear();
        else if (command === 'export') {
            try {
                window.parent.postMessage({
                    type: 'rrcTransportDiagReport',
                    report: transportDiag.exportReport()
                }, '*');
            } catch {}
        }
    }
});

function normalizeRhythmLookupKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

async function loadRhythmFromPath(path, label = '') {
    const target = String(path || '').trim();
    if (!target) return false;
    try {
        const notResp = await fetch(target);
        if (notResp.ok) {
            const data = await notResp.json();
            if (data) {
                loadRhythmData(data);
                console.log('Loaded notation from path:', label || target);
                return true;
            }
        }
    } catch {}
    return false;
}

function pickBestRhythmRow(rows, targetName, targetKey) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const key = normalizeRhythmLookupKey(targetKey || targetName);
    const exact = rows.find((row) => normalizeRhythmLookupKey(row?.name) === key);
    if (exact) return exact;
    const lowerName = String(targetName || '').trim().toLowerCase();
    const contains = rows.find((row) => String(row?.name || '').trim().toLowerCase().includes(lowerName));
    return contains || rows[0];
}

async function loadRhythmByName(name, lookupKey = '') {
    const rhythmName = String(name || '').trim();
    if (!rhythmName) return;
    const targetKey = normalizeRhythmLookupKey(lookupKey || rhythmName);
    const slug = normalizeRhythmLookupKey(rhythmName);
    const inflightKey = `${targetKey || slug || rhythmName.toLowerCase()}`;
    if (loadRhythmInflightByName.has(inflightKey)) {
        transportDiag.push('debug', 'load_by_name_inflight_reused', { key: inflightKey });
        return loadRhythmInflightByName.get(inflightKey);
    }
    const run = (async () => {
    const localFailCacheKey = `notationLocalMiss:${targetKey || slug || rhythmName.toLowerCase()}`;
    const now = Date.now();
    const lastLocalMiss = parseInt(sessionStorage.getItem(localFailCacheKey) || '0', 10) || 0;
    const skipLocalLookup = (now - lastLocalMiss) < 30000;

    // 1. Try local notation JSON files
    if (!skipLocalLookup) {
        const paths = [
            `notations/${slug}.json`,
            `notations/${targetKey}.json`,
            `../notations/${slug}.json`
        ];
        let localLoaded = false;
        for (const path of paths) {
            try {
                const resp = await fetch(path);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data) {
                        loadRhythmData(data);
                        console.log('Loaded notation from file:', path);
                        localLoaded = true;
                        break;
                    }
                }
            } catch {}
        }
        if (localLoaded) return;
        sessionStorage.setItem(localFailCacheKey, String(now));
    }

    // 2. Try Supabase REST API (if available via parent tokens)
    try {
        // Ask parent for Supabase credentials
        const creds = await new Promise((resolve) => {
            const handler = (e) => {
                if (e.data?.type === 'supabaseCredentials') {
                    window.removeEventListener('message', handler);
                    resolve(e.data);
                }
            };
            window.addEventListener('message', handler);
            window.parent.postMessage({ type: 'requestSupabaseCredentials' }, '*');
            // Timeout after 3s to allow cold mobile load.
            setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 3000);
        });

        if (creds?.url && creds?.key) {
            const headers = { 'apikey': creds.key, 'Authorization': `Bearer ${creds.key}` };
            const fetchRows = async (matchFilter) => {
                const params = new URLSearchParams();
                params.set('select', 'notation_path,name');
                params.set('name', matchFilter);
                const resp = await fetch(`${creds.url}/rest/v1/rhythms?${params.toString()}`, { headers });
                if (!resp.ok) return [];
                const rows = await resp.json();
                return Array.isArray(rows) ? rows : [];
            };

            let rows = await fetchRows(`eq.${rhythmName}`);
            if (rows.length === 0) {
                rows = await fetchRows(`ilike.*${rhythmName}*`);
            }

            let best = pickBestRhythmRow(rows, rhythmName, targetKey);
            if (!best) {
                const params = new URLSearchParams();
                params.set('select', 'notation_path,name');
                params.set('limit', '1000');
                const resp = await fetch(`${creds.url}/rest/v1/rhythms?${params.toString()}`, { headers });
                if (resp.ok) {
                    const allRows = await resp.json();
                    best = pickBestRhythmRow(Array.isArray(allRows) ? allRows : [], rhythmName, targetKey);
                }
            }

            if (best && best.notation_path) {
                const loaded = await loadRhythmFromPath(best.notation_path, best.name || rhythmName);
                if (loaded) return;
            }
        }
    } catch (err) { console.log('Supabase notation fetch failed:', err); }

        console.log('No notation found for:', rhythmName, '— keeping current rhythm');
    })();
    loadRhythmInflightByName.set(inflightKey, run);
    try {
        return await run;
    } finally {
        if (loadRhythmInflightByName.get(inflightKey) === run) {
            loadRhythmInflightByName.delete(inflightKey);
        }
    }
}

// URL params on load
const urlParams = new URLSearchParams(window.location.search);
const rhythmParam = urlParams.get('rhythm');
const colorParam = urlParams.get('color');
if (rhythmParam && window.self === window.top) loadRhythmByName(rhythmParam);
if (colorParam) applyThemeColor(decodeURIComponent(colorParam));

// Hide title when embedded in iframe to save space
if (window.self !== window.top) {
    document.body.classList.add('embedded-mode');
    const h1 = document.querySelector('h1');
    if (h1) h1.style.display = 'none';
}

// ── MIDI INPUT (trigger samples via MIDI controller) ───────
let midiAccess = null;
let midiInputEnabled = false;

// MIDI note-to-instrument+sound mapping
// Djembe 2 and 3 are mapped after djembe_solo to avoid flooding same notes.
const MIDI_NOTE_MAP = {
    // Djembe 1 (C2-D#2)
    36: { instrument: 'djembe1', sound: 'slap' },   // C2
    37: { instrument: 'djembe1', sound: 'tone' },   // C#2
    38: { instrument: 'djembe1', sound: 'bass' },   // D2
    39: { instrument: 'djembe1', sound: 'mute' },   // D#2
    // Kenkeni (E2-F2)
    40: { instrument: 'kenkeni', sound: 'tone' },   // E2
    41: { instrument: 'kenkeni', sound: 'mute' },   // F2
    // Kenkeni Bell (F#2)
    42: { instrument: 'kenkeni_bell', sound: 'slap' }, // F#2
    // Sangban (G2-G#2)
    43: { instrument: 'sangban', sound: 'tone' },    // G2
    44: { instrument: 'sangban', sound: 'mute' },    // G#2
    // Sangban Bell (A2)
    45: { instrument: 'sangban_bell', sound: 'slap' }, // A2
    // Doundoun (Bb2-B2)
    46: { instrument: 'doundoun', sound: 'tone' },   // Bb2
    47: { instrument: 'doundoun', sound: 'mute' },   // B2
    // Doundoun Bell (C3)
    48: { instrument: 'doundoun_bell', sound: 'slap' }, // C3
    // DjembeSolo Call (C#3-E3)
    49: { instrument: 'djembe_solo', sound: 'slap' }, // C#3
    50: { instrument: 'djembe_solo', sound: 'tone' }, // D3
    51: { instrument: 'djembe_solo', sound: 'bass' }, // D#3
    52: { instrument: 'djembe_solo', sound: 'mute' }, // E3
    // Djembe 2 (F3-A3)
    53: { instrument: 'djembe2', sound: 'slap' },    // F3
    54: { instrument: 'djembe2', sound: 'tone' },    // F#3
    55: { instrument: 'djembe2', sound: 'bass' },    // G3
    56: { instrument: 'djembe2', sound: 'mute' },    // G#3
    // Djembe 3 (A3-C4)
    57: { instrument: 'djembe3', sound: 'slap' },    // A3
    58: { instrument: 'djembe3', sound: 'tone' },    // Bb3
    59: { instrument: 'djembe3', sound: 'bass' },    // B3
    60: { instrument: 'djembe3', sound: 'mute' },    // C4
};

// Helper: note number to name
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','Bb','B'];
function noteName(n) { return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1); }

let midiOutputEnabled = true;
let selectedMidiInput = null;
let selectedMidiOutput = null;

function toggleMidiPanel() {
    const cfg = document.getElementById('midiConfig');
    cfg.style.display = cfg.style.display === 'none' ? '' : 'none';
    if (cfg.style.display !== 'none') refreshMidiDevices();
}

function refreshMidiDevices() {
    if (!midiAccess) {
        document.getElementById('midiStatus').textContent = 'MIDI: Not supported';
        return;
    }
    const inSel = document.getElementById('midiInputSelect');
    const outSel = document.getElementById('midiOutputSelect');
    inSel.innerHTML = '<option value="">None</option>';
    outSel.innerHTML = '<option value="">None</option>';
    midiAccess.inputs.forEach(input => {
        const opt = document.createElement('option');
        opt.value = input.id; opt.textContent = input.name;
        if (selectedMidiInput === input.id) opt.selected = true;
        inSel.appendChild(opt);
    });
    midiAccess.outputs.forEach(output => {
        const opt = document.createElement('option');
        opt.value = output.id; opt.textContent = output.name;
        if (selectedMidiOutput === output.id) opt.selected = true;
        outSel.appendChild(opt);
    });
    document.getElementById('midiStatus').textContent = `MIDI: ${midiAccess.inputs.size} in / ${midiAccess.outputs.size} out`;
    document.getElementById('midiStatus').classList.toggle('connected', midiAccess.inputs.size > 0 || midiAccess.outputs.size > 0);

    inSel.onchange = () => {
        selectedMidiInput = inSel.value || null;
        // Rebind input
        midiAccess.inputs.forEach(input => { input.onmidimessage = null; });
        if (selectedMidiInput) {
            const input = midiAccess.inputs.get(selectedMidiInput);
            if (input) input.onmidimessage = handleMidiMessage;
        }
    };
    outSel.onchange = () => { selectedMidiOutput = outSel.value || null; };

    // Bind checkboxes
    document.getElementById('midiInputEnabled').checked = midiInputEnabled;
    document.getElementById('midiOutputEnabled').checked = midiOutputEnabled;
    document.getElementById('midiInputEnabled').onchange = (e) => { midiInputEnabled = e.target.checked; };
    document.getElementById('midiOutputEnabled').onchange = (e) => { midiOutputEnabled = e.target.checked; };
}

async function initMidiInput() {
    if (!navigator.requestMIDIAccess) { console.log('Web MIDI not supported'); return; }
    try {
        midiAccess = await navigator.requestMIDIAccess();
        midiAccess.inputs.forEach(input => {
            input.onmidimessage = handleMidiMessage;
            console.log('MIDI input connected:', input.name);
        });
        midiAccess.onstatechange = (e) => {
            if (e.port.type === 'input' && e.port.state === 'connected') {
                e.port.onmidimessage = handleMidiMessage;
                console.log('MIDI input added:', e.port.name);
            }
        };
        midiInputEnabled = true;
        console.log('MIDI input initialized');
    } catch (err) { console.warn('MIDI init failed:', err); }
}

function handleMidiMessage(msg) {
    if (!midiInputEnabled) return;
    const [status, note, velocity] = msg.data;
    const command = status & 0xf0;
    if (command === 0x90 && velocity > 0) {
        const mapping = MIDI_NOTE_MAP[note];
        if (mapping) {
            let instrIndex = state.instruments.findIndex(i =>
                i.id === mapping.instrument && i.visible !== false);
            if (instrIndex < 0) {
                // Fallback to instrument type mappings.
                instrIndex = state.instruments.findIndex(i =>
                    i.type === mapping.instrument && i.visible !== false);
            }
            if (instrIndex >= 0) {
                const instrument = state.instruments[instrIndex];
                playSound(mapping.sound, instrument);
                emitNoteEvent('midi_trigger', mapping.sound, velocity / 127, instrument.id, state.currentStep, { instrumentType: instrument.type });
            } else {
                emitNoteEvent('midi_trigger', mapping.sound, velocity / 127, mapping.instrument);
            }
        }
    }
}

// ── MIDI OUTPUT / VUPLEX MESSAGES (rhythm playback events) ─
// Emits events for each voice during playback that Unity/Vuplex can listen to

function resolveMidiInstrumentType(instrumentId, explicitType) {
    if (typeof explicitType === 'string' && explicitType && instrumentTypes[explicitType]) {
        return explicitType;
    }
    if (typeof instrumentId === 'string' && instrumentId) {
        if (instrumentTypes[instrumentId]) return instrumentId;
        const lower = instrumentId.toLowerCase();
        const keys = Object.keys(instrumentTypes);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (lower === key || lower.startsWith(`${key}_`) || lower.startsWith(key)) {
                return key;
            }
        }
    }
    return '';
}

function findMidiNoteNumberForEvent(sound, instrumentId, explicitType) {
    const candidates = [];
    if (typeof instrumentId === 'string' && instrumentId) candidates.push(instrumentId);
    if (typeof explicitType === 'string' && explicitType) candidates.push(explicitType);
    const resolvedType = resolveMidiInstrumentType(instrumentId, explicitType);
    if (resolvedType) candidates.push(resolvedType);

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const exact = Object.entries(MIDI_NOTE_MAP).find(
            ([k, v]) => v.sound === sound && v.instrument === candidate
        );
        if (exact) return exact[0];
    }

    const fallback = Object.entries(MIDI_NOTE_MAP).find(
        ([k, v]) => v.sound === sound
    );
    return fallback ? fallback[0] : null;
}

function emitNoteEvent(type, sound, velocity, instrumentId, stepIndex, options = {}) {
    const midiInstrumentType = resolveMidiInstrumentType(instrumentId, options.instrumentType);
    const event = {
        type: type || 'note',
        sound: sound,
        velocity: velocity || 1.0,
        instrument: instrumentId || '',
        instrumentType: midiInstrumentType,
        step: stepIndex || 0,
        timestamp: performance.now()
    };
    // PostMessage to parent (for globe app or Unity WebView)
    try { window.parent.postMessage({ type: 'notation_event', payload: event }, '*'); } catch {}
    // Vuplex-compatible: post to Unity bridge if available
    if (window.vuplex) {
        try { window.vuplex.postMessage(JSON.stringify(event)); } catch {}
    }
    // Also send as MIDI output if available and enabled
    if (midiAccess && midiOutputEnabled) {
        const output = selectedMidiOutput ? midiAccess.outputs.get(selectedMidiOutput) : null;
        if (output && sound && sound !== 'silence') {
            const noteNum = findMidiNoteNumberForEvent(sound, instrumentId, options.instrumentType);
            if (noteNum) {
                const vel = Math.round((velocity || 1.0) * 127);
                output.send([0x90, parseInt(noteNum), vel]);
                setTimeout(() => output.send([0x80, parseInt(noteNum), 0]), 100);
            }
        }
    }
}

// ── CALL SYSTEM (quantized signal pattern for transitions) ──
// The Call is a special pattern played by DjembeSolo voice
// It always starts at beat 1 and plays through once when cued

let callPattern = null; // Array of sounds, same length as totalSteps
let callActive = false;
let callStep = 0;
let callPending = false; // Queued to start at next beat 1 (or at callStartStep, see below)
// Where in the cycle the call starts. Long cycles (8-beat rhythms) store a short call written twice across
// the row; it then starts halfway (beat 5 of 8) and plays once, so the ensemble still comes in on beat 1.
let callStartStep = 0;
function computeCallStartStep(pattern, totalSteps) {
    // A call row that is one phrase repeated across the bar (a 4-beat call written twice in an 8-beat
    // rhythm, a 12-step signal four times in 48 steps) starts at its last repeat and plays once.
    if (!Array.isArray(pattern) || totalSteps < 2 || pattern.length !== totalSteps) return 0;
    const norm = (v) => (v && v !== 'silence' ? String(v) : '');
    if (!pattern.some((v) => norm(v))) return 0;
    const minPhrase = Math.max(2, Math.ceil(totalSteps / 4));
    for (let p = minPhrase; p <= totalSteps / 2; p++) {
        if (totalSteps % p) continue;
        let repeats = true;
        for (let i = p; i < totalSteps && repeats; i++) if (norm(pattern[i]) !== norm(pattern[i % p])) repeats = false;
        if (repeats) return totalSteps - p;
    }
    return 0;
}
let sessionSequenceRestoreTimeout = null;
let sessionSequenceCallTimeout = null;

function clearSessionSequenceTimers() {
    if (sessionSequenceCallTimeout) {
        clearTimeout(sessionSequenceCallTimeout);
        sessionSequenceCallTimeout = null;
    }
    if (sessionSequenceRestoreTimeout) {
        clearTimeout(sessionSequenceRestoreTimeout);
        sessionSequenceRestoreTimeout = null;
    }
}

function finishCallInSequence(options = {}) {
    if (!callInSequenceState) return;
    const cancelled = options.cancelled === true;
    const restoreMetronome = !!callInSequenceState.restoreMetronome;
    callInSequenceState = null;
    metronomeEnabled = restoreMetronome;
    syncMetronomeButtons();
    if (!cancelled) {
        const callStatus = document.getElementById('callStatus');
        if (callStatus && !(callOutSequenceState && callOutSequenceState.active)) {
            callStatus.textContent = '';
        }
    }
    syncCallButtons();
}

function beginCallInSequence() {
    if (state.isPlaying) return;
    const totalSteps = getTotalGridSteps();
    if (totalSteps < 1) return;

    clearSessionSequenceTimers();
    callOutSequenceState = null;
    callPending = false;
    callActive = false;
    callStep = 0;
    const previousMetronome = !!metronomeEnabled;
    const entryStepFromEnd = clampCallInStepOffset(callInStepOffset);

    // Bar 1 = metronome only, Bar 2 = call solo, then non-call voices join
    // "entryStepFromEnd" steps before Bar 2 ends.
    // A call written twice across a long cycle starts halfway (see computeCallStartStep): then the count-in
    // is only up to that point (4 beats in an 8-beat rhythm) and the call fills the rest of the same bar.
    const callInstrument = state.instruments.find((i) => i.isCall);
    const halfStart = computeCallStartStep(callInstrument?.pattern, totalSteps);
    const introSteps = halfStart > 0 ? halfStart : totalSteps;
    const phraseEnd = halfStart > 0 ? totalSteps : 2 * totalSteps;
    callInSequenceState = {
        active: true,
        totalSteps,
        introSteps,
        callCueCounter: Math.max(0, introSteps - 1),
        callEntryCounter: Math.max(introSteps, phraseEnd - entryStepFromEnd),
        completeCounter: phraseEnd,
        restoreMetronome: previousMetronome,
        callCued: false
    };

    metronomeEnabled = true;
    syncMetronomeButtons();
    const callStatus = document.getElementById('callStatus');
    if (callStatus) {
        callStatus.textContent = `Call In • step ${entryStepFromEnd}`;
    }
    syncCallButtons();
    updateCallRowVisibility();
    startPlayback();
}

function shouldSuppressInstrumentForCallInSequence(instrument, absoluteStepCounter) {
    if (!(callInSequenceState && callInSequenceState.active)) return false;
    const seq = callInSequenceState;
    const counter = Math.max(0, Math.floor(Number(absoluteStepCounter) || 0));
    if (counter >= seq.completeCounter) return false;
    const isCallInstrument = !!instrument?.isCall;

    // Count-in: metronome only (a full bar, or up to the call's start in long cycles).
    if (counter < (seq.introSteps || seq.totalSteps)) return true;

    // Measure 2: call solo. Bring ensemble in near the end based on step setting.
    if (counter < seq.callEntryCounter) {
        return !isCallInstrument;
    }
    return false;
}

function runSessionStartSequence(payload = {}) {
    clearSessionSequenceTimers();
    callInSequenceState = null;
    callOutSequenceState = null;

    const incomingTempo = parseInt(payload.tempo, 10);
    if (Number.isFinite(incomingTempo)) {
        applyTempo(incomingTempo, { restartPlayback: false, persist: false, broadcast: false });
    }

    const safeTempo = Math.max(1, parseInt(state.tempo, 10) || 100);
    const safeBeats = Math.max(1, parseInt(state.beats, 10) || 4);
    const safeSubs = Math.max(1, parseInt(state.subdivisions, 10) || 4);
    const baseStepMs = (60000 / safeTempo) / safeSubs;
    const measureMs = Math.max(240, Math.round((60000 / safeTempo) * safeBeats));
    const previousMetronome = !!metronomeEnabled;
    const instrumentSnapshot = state.instruments.map((instrument) => ({
        id: instrument.id,
        muted: !!instrument.muted,
        visible: instrument.visible !== false,
        volume: Number.isFinite(Number(instrument.volume)) ? Number(instrument.volume) : 1
    }));
    const callInstr = state.instruments.find((instrument) => instrument.isCall);

    if (state.isPlaying) stopPlayback();

    state.instruments.forEach((instrument) => {
        instrument.muted = true;
    });
    if (callInstr) {
        // Keep call lane muted during bar 1 so the first measure is strictly metronome-only.
        callInstr.muted = true;
        callInstr.visible = false;
        callInstr.volume = 0;
    }

    metronomeEnabled = true;
    syncMetronomeButtons();
    callPending = false;
    callActive = false;
    callStep = 0;
    syncCallButtons();
    updateGrid();

    const startAtEpoch = Number.isFinite(Number(payload.startAt))
        ? Math.max(0, Math.round(Number(payload.startAt)))
        : Date.now();
    const nowEpoch = Date.now();
    startPlayback({ anchorEpoch: startAtEpoch });

    // Bar 1: metronome only, then cue call just before bar 2.
    const callCueEpoch = startAtEpoch + measureMs - Math.round(baseStepMs * 0.65);
    sessionSequenceCallTimeout = setTimeout(() => {
        sessionSequenceCallTimeout = null;
        cueCall({ silent: true, fromSession: true });
        updateGrid();
    }, Math.max(0, callCueEpoch - nowEpoch));

    // End of bar 2: restore normal instrument mutes/visibility.
    const restoreEpoch = startAtEpoch + (measureMs * 2) + Math.round(baseStepMs);
    sessionSequenceRestoreTimeout = setTimeout(() => {
        const stillPlaying = !!state.isPlaying;
        state.instruments.forEach((instrument) => {
            const previous = instrumentSnapshot.find((entry) => entry.id === instrument.id);
            if (!previous) return;
            instrument.muted = !!previous.muted;
            instrument.visible = previous.visible !== false;
            instrument.volume = Number.isFinite(previous.volume) ? previous.volume : instrument.volume;
        });
        metronomeEnabled = previousMetronome;
        syncMetronomeButtons();
        if (stillPlaying) {
            updateGrid();
            postNotationStateToParent();
        }
        sessionSequenceRestoreTimeout = null;
    }, Math.max(0, restoreEpoch - nowEpoch));
}

function cueCall(options = {}) {
    if (!options.force && !options.fromSession && isPlaybackBlockedBySession()) {
        postBlockedAction('call');
        return;
    }
    // Find the call instrument in the grid
    const callInstr = state.instruments.find(i => i.isCall);
    if (callInstr) {
        // Use the call instrument's own pattern from the grid
        callPattern = callInstr.pattern && callInstr.pattern.some(s => s && s !== 'silence')
            ? [...callInstr.pattern]
            : null;
    }
    if (!callPattern) {
        // Auto-generate a default call if no pattern written yet
        const totalSteps = state.beats * state.subdivisions;
        callPattern = new Array(totalSteps).fill('silence');
        if (totalSteps >= 3 * state.subdivisions) {
            callPattern[0] = 'slap';
            callPattern[state.subdivisions] = 'tone';
            callPattern[state.subdivisions * 2] = 'bass';
        } else {
            callPattern[0] = 'slap';
            if (totalSteps > 1) callPattern[1] = 'tone';
        }
    }

    // Queue Call to start at next beat 1 (step 0), or halfway for a call written twice - quantized
    callStartStep = computeCallStartStep(callPattern, state.beats * state.subdivisions);
    callPending = true;

    const callStatus = document.getElementById('callStatus');
    syncCallButtons();
    if (callStatus) callStatus.textContent = 'Cued - plays at beat 1';
    updateCallRowVisibility();
    if (!options.silent) {
        try { window.parent.postMessage({ type: 'notationCallCue', fromSession: !!options.fromSession }, '*'); } catch {}
    }
    console.log('✅ Call cued — will play at next beat 1');
}


function setCallPattern(pattern) {
    callPattern = pattern;
    console.log('Call pattern set:', pattern?.length, 'steps');
}

function updateCallRowVisibility() {
    const callInstrIndex = state.instruments.findIndex(i => i.isCall);
    if (callInstrIndex < 0) return;
    const callInstr = state.instruments[callInstrIndex];
    syncCallButtons();

    // Always keep the ICON visible in toolbar (unless user manually hid it)
    document.querySelectorAll(`.instrument-toolbar-icon[data-index="${callInstrIndex}"]`).forEach((callIcon) => {
        if (callInstr.visible !== false) callIcon.classList.remove('hidden-icon');
    });

    // Grid row visibility logic
    const callRow = document.querySelector(`.instrument-row[data-instrument="call1"]`);
    if (!callRow) return;

    // If user manually hid instrument via toolbar, hide the row completely
    if (callInstr.visible === false) {
        callRow.classList.add('hidden-row');
        return;
    }

    // Remove manual hide if we're here
    callRow.classList.remove('hidden-row');

    // During playback: hide grid row ONLY when call is not active/pending
    if (state.isPlaying) {
        if (!callActive && !callPending) {
            // Playing but call not active - hide GRID ROW
            callRow.classList.add('call-hidden');
        } else {
            // Call is active/pending - show GRID ROW
            callRow.classList.remove('call-hidden');
        }
    } else {
        // Not playing - always show GRID ROW
        callRow.classList.remove('call-hidden');
    }
}


function processCallStep(currentStep, absoluteStepCounter = NaN) {
    const callStatus = document.getElementById('callStatus');

    // Activate Call at beat 1 (step 0), or at callStartStep for a call written twice
    if (callPending && currentStep === callStartStep) {
        callActive = true;
        callPending = false;
        callStep = callStartStep;
        if (callOutSequenceState && callOutSequenceState.active && callOutSequenceState.armed) {
            const totalSteps = getTotalGridSteps();
            const startCounter = Math.max(0, Math.floor(Number(absoluteStepCounter) || 0));
            callOutSequenceState.armed = false;
            callOutSequenceState.startedCounter = startCounter;
            const phraseMeasures = Math.max(1, Math.ceil((callPattern?.length || 0) / totalSteps));
            // The phrase may start mid-cycle (callStartStep): stop on the next beat 1 after it ends.
            callOutSequenceState.stopCounter = startCounter + phraseMeasures * totalSteps - callStartStep;
            if (callStatus) callStatus.textContent = 'Call Out running';
        }
        syncCallButtons();
        if (callStatus && !(callOutSequenceState && callOutSequenceState.active)) callStatus.textContent = '🎙️ Playing...';
        updateCallRowVisibility();
        console.log('✅ Call started at beat 1');
    }

    if (!callActive) return null;
    if (callStep >= (callPattern?.length || 0)) {
        callActive = false;
        callStep = 0;
        syncCallButtons();
        if (callStatus && !(callOutSequenceState && callOutSequenceState.active)) callStatus.textContent = '';
        updateCallRowVisibility();
        return null;
    }
    const sound = callPattern[callStep];
    callStep++;
    return sound;
}

// Initialize MIDI on load
if (!circularOnlyMode) {
    if (document.readyState === 'complete') { initMidiInput(); }
    else { window.addEventListener('load', initMidiInput); }
}
