/* ============================================================
   Rhythms Re/Connected — app.js
   ============================================================ */

// ─── SUPABASE DATA LAYER ───────────────────────────────────

const GRAPHQL_URL = (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') + '/graphql/v1';

const RHYTHM_QUERY = `query {
  rhythmsCollection(first: 100) {
    edges { node {
      id name subtitle region community summary
      notation_path notation_data lat lon library creator color created_at
      song_texts listening_examples
    }}
  }
}`;

// Prevent native browser image dragging (ghost image) from interfering with
// the app's drag/resize interactions.
document.addEventListener('dragstart', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.tagName === 'IMG' || target.closest('img')) {
        e.preventDefault();
    }
});

// ─── MOBILE AUDIO ENGINE (for pad-remote mode) ────────────────────────────
// This standalone audio engine works directly in the main window, bypassing
// iframe audio context issues on iOS/iPad. It only initializes in pad-remote mode.
const MobileAudioEngine = (() => {
    let audioContext = null;
    let isInitialized = false;
    let samplesLoaded = false;
    let audioSamples = {};
    let reverbNode = null;
    let reverbGain = null;
    let dryGain = null;
    let roundRobinState = {};
    let loadingPromise = null;
    let backgroundLoadStarted = false;
    let loadProgressState = null;
    const loadProgressListeners = new Set();
    const decodedSampleCache = new Map();
    const pendingDjembeSetLoads = new Set();

    const AUDIO_BASE_PATH = 'Notation/public/audio/';
    const djembeSampleSets = ['One', 'Two', 'Three', 'Five', 'Six', 'Seven', 'Solo'];
    const coreDjembeSampleSets = ['One'];

    const instrumentTypes = {
        djembe: { sounds: { slap: { file: 'Slap', hasL: true }, tone: { file: 'Open', hasL: true }, bass: { file: 'Bass', hasL: true }, mute: { file: 'Mute', hasL: true } } },
        kenkeni: { sounds: { tone: { file: 'Open' }, mute: { file: 'Muffled' } } },
        kenkeni_bell: { sounds: { slap: { file: 'Bell_Open' }, bell: { file: 'Bell_Open' } } },
        sangban: { sounds: { tone: { file: 'Open' }, mute: { file: 'Muffled' } } },
        sangban_bell: { sounds: { slap: { file: 'Bell_Open' }, bell: { file: 'Bell_Open' } } },
        doundoun: { sounds: { tone: { file: 'Open' }, mute: { file: 'Muffled' } } },
        doundoun_bell: { sounds: { slap: { file: 'Bell_Open' }, bell: { file: 'Bell_Open' } } },
        shekere: { sounds: { slap: { file: 'Shekere' }, bell: { file: 'Shekere' } } }
    };

    function resolveAudioUrl(filename) {
        const raw = String(filename || '').trim();
        if (!raw) return '';
        const base = String(window.location?.pathname || '').trim();
        const rootMatch = base.match(/^(\/[^/]+\/)/);
        const rootPrefix = rootMatch ? rootMatch[1] : '/';
        const candidates = [
            `${AUDIO_BASE_PATH}${raw}`,
            `./${AUDIO_BASE_PATH}${raw}`,
            `/${AUDIO_BASE_PATH}${raw}`,
            `${rootPrefix}${AUDIO_BASE_PATH}${raw}`.replace(/\/{2,}/g, '/')
        ];
        for (const candidate of candidates) {
            if (!candidate || /^https?:\/\//i.test(candidate)) continue;
            try {
                return new URL(candidate, window.location.href).href;
            } catch {}
        }
        try {
            return new URL(`${AUDIO_BASE_PATH}${raw}`, window.location.href).href;
        } catch {
            return `${AUDIO_BASE_PATH}${raw}`;
        }
    }

    function emitLoadProgress(patch = {}) {
        const prev = loadProgressState || {};
        const total = Math.max(0, Number.isFinite(patch.total) ? patch.total : (Number(prev.total) || 0));
        const completed = Math.max(0, Number.isFinite(patch.completed) ? patch.completed : (Number(prev.completed) || 0));
        const loaded = Math.max(0, Number.isFinite(patch.loaded) ? patch.loaded : (Number(prev.loaded) || 0));
        const failed = Math.max(0, Number.isFinite(patch.failed) ? patch.failed : (Number(prev.failed) || Math.max(0, completed - loaded)));
        const percent = Number.isFinite(patch.percent)
            ? Math.max(0, Math.min(100, patch.percent))
            : (total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0);
        loadProgressState = {
            phase: patch.phase || prev.phase || 'idle',
            label: patch.label || prev.label || '',
            total,
            completed,
            loaded,
            failed,
            percent,
            ready: patch.ready !== undefined ? !!patch.ready : !!prev.ready
        };
        const snapshot = { ...loadProgressState };
        loadProgressListeners.forEach((listener) => {
            try { listener(snapshot); } catch {}
        });
        return snapshot;
    }

    function subscribeLoadProgress(listener) {
        if (typeof listener !== 'function') return () => {};
        loadProgressListeners.add(listener);
        if (loadProgressState) {
            try { listener({ ...loadProgressState }); } catch {}
        }
        return () => loadProgressListeners.delete(listener);
    }

    function getCoreLoadOperationCount() {
        let count = 0;
        for (const setName of coreDjembeSampleSets) {
            for (const soundInfo of Object.values(instrumentTypes.djembe.sounds)) {
                count += soundInfo.hasL ? 2 : 1;
            }
        }
        const dununTypes = [
            'kenkeni',
            'kenkeni_bell',
            'sangban',
            'sangban_bell',
            'doundoun',
            'doundoun_bell'
        ];
        dununTypes.forEach((type) => {
            const sounds = instrumentTypes[type] && instrumentTypes[type].sounds
                ? Object.values(instrumentTypes[type].sounds)
                : [];
            count += sounds.length;
        });
        count += 2; // Shekere + ShekereB
        return Math.max(1, count);
    }

    async function fetchDecodeSample(filename) {
        const url = resolveAudioUrl(filename);
        if (!url || !audioContext) return null;
        const cachedPromise = decodedSampleCache.get(url);
        if (cachedPromise) return cachedPromise;
        const decodePromise = (async () => {
            try {
                const response = await fetch(url, { cache: 'force-cache' });
                if (!response.ok) return null;
                const arrayBuffer = await response.arrayBuffer();
                return await audioContext.decodeAudioData(arrayBuffer);
            } catch {
                return null;
            }
        })();
        decodedSampleCache.set(url, decodePromise);
        const decoded = await decodePromise;
        if (!decoded) decodedSampleCache.delete(url);
        return decoded;
    }

    function ensureSampleBucket(instrumentType, sampleSet, soundName) {
        if (!audioSamples[instrumentType]) audioSamples[instrumentType] = {};
        if (!audioSamples[instrumentType][sampleSet]) audioSamples[instrumentType][sampleSet] = {};
        if (!audioSamples[instrumentType][sampleSet][soundName]) audioSamples[instrumentType][sampleSet][soundName] = [];
        return audioSamples[instrumentType][sampleSet][soundName];
    }

    async function loadDjembeSet(setName, onSampleResolved = null) {
        const setLabel = String(setName || '').trim();
        if (!setLabel) return;
        for (const [soundName, soundInfo] of Object.entries(instrumentTypes.djembe.sounds)) {
            const bucket = ensureSampleBucket('djembe', setLabel, soundName);
            if (bucket.length > 0) continue;
            const primaryName = `Djembe${setLabel}_${soundInfo.file}.mp3`;
            const primary = await fetchDecodeSample(primaryName);
            if (primary) bucket.push(primary);
            if (typeof onSampleResolved === 'function') {
                try { onSampleResolved(!!primary, primaryName); } catch {}
            }
            if (soundInfo.hasL) {
                const altName = `Djembe${setLabel}_${soundInfo.file}L.mp3`;
                const alt = await fetchDecodeSample(altName);
                if (alt) bucket.push(alt);
                if (typeof onSampleResolved === 'function') {
                    try { onSampleResolved(!!alt, altName); } catch {}
                }
            }
        }
    }

    async function loadShekereSamples(onSampleResolved = null) {
        const bucket = ensureSampleBucket('shekere', 'default', 'slap');
        if (bucket.length > 0) return;
        const aName = 'Shekere.mp3';
        const bName = 'ShekereB.mp3';
        const a = await fetchDecodeSample(aName);
        if (typeof onSampleResolved === 'function') {
            try { onSampleResolved(!!a, aName); } catch {}
        }
        const b = await fetchDecodeSample(bName);
        if (typeof onSampleResolved === 'function') {
            try { onSampleResolved(!!b, bName); } catch {}
        }
        if (a) bucket.push(a);
        if (b) bucket.push(b);
        if (!audioSamples.shekere.default.bell) {
            audioSamples.shekere.default.bell = bucket;
        }
    }

    function queueDjembeSetLoad(setName) {
        const label = String(setName || '').trim();
        if (!label || label === 'One') return;
        if (pendingDjembeSetLoads.has(label)) return;
        const existing = audioSamples?.djembe?.[label];
        if (existing && Object.keys(existing).length > 0) return;
        pendingDjembeSetLoads.add(label);
        (async () => {
            try {
                await loadDjembeSet(label);
                audioSamples['djembe_solo'] = audioSamples['djembe'];
                console.log(`[MobileAudio] Lazy-loaded djembe set: ${label}`);
            } catch {}
            pendingDjembeSetLoads.delete(label);
        })();
    }

    function queueBackgroundDjembeLoads() {
        if (backgroundLoadStarted) return;
        backgroundLoadStarted = true;
        const rest = djembeSampleSets.filter((setName) => !coreDjembeSampleSets.includes(setName));
        (async () => {
            for (const setName of rest) {
                await loadDjembeSet(setName);
            }
            audioSamples['djembe_solo'] = audioSamples['djembe'];
            console.log('[MobileAudio] Background djembe sample sets loaded');
        })().catch(() => {});
    }

    function init() {
        if (isInitialized) return true;
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            console.error('[MobileAudio] AudioContext is not supported on this device');
            return false;
        }
        try {
            audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
        } catch {
            try {
                // Some iOS builds reject constructor options; retry plain constructor.
                audioContext = new AudioContextCtor();
            } catch (e) {
                console.error('[MobileAudio] Failed to create AudioContext:', e);
                return false;
            }
        }
        if (audioContext) {
            isInitialized = true;
            console.log('[MobileAudio] Initialized AudioContext');
            return true;
        }
        return false;
    }

    function warmup() {
        if (!audioContext) init();
        if (!audioContext) return;
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('[MobileAudio] AudioContext resumed');
            }).catch(() => {});
        }
        // Also trigger sample loading
        if (!samplesLoaded && !loadingPromise) {
            loadSamples();
        }
    }

    async function initReverb() {
        if (reverbNode || !audioContext) return;
        try {
            reverbNode = audioContext.createConvolver();
            reverbGain = audioContext.createGain();
            dryGain = audioContext.createGain();
            reverbGain.gain.value = 0.1;
            dryGain.gain.value = 0.85;
            reverbGain.connect(audioContext.destination);
            dryGain.connect(audioContext.destination);
            // Create simple impulse response
            const sampleRate = audioContext.sampleRate;
            const length = sampleRate * 1.5;
            const impulse = audioContext.createBuffer(2, length, sampleRate);
            for (let channel = 0; channel < 2; channel++) {
                const channelData = impulse.getChannelData(channel);
                for (let i = 0; i < length; i++) {
                    channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
                }
            }
            reverbNode.buffer = impulse;
            reverbNode.connect(reverbGain);
            console.log('[MobileAudio] Reverb initialized');
        } catch (e) {
            console.warn('[MobileAudio] Reverb init failed:', e);
        }
    }

    async function loadSamples(options = {}) {
        const onProgress = typeof options === 'function'
            ? options
            : (options && typeof options.onProgress === 'function' ? options.onProgress : null);
        const unsubscribe = onProgress ? subscribeLoadProgress(onProgress) : null;
        if (!audioContext) init();
        if (!audioContext) {
            emitLoadProgress({
                phase: 'error',
                label: 'Audio context failed',
                ready: false
            });
            if (unsubscribe) unsubscribe();
            return false;
        }
        if (samplesLoaded && !loadingPromise) {
            emitLoadProgress({
                phase: 'ready',
                label: 'Audio ready',
                total: 1,
                completed: 1,
                loaded: 1,
                failed: 0,
                percent: 100,
                ready: true
            });
            if (unsubscribe) unsubscribe();
            return true;
        }
        if (loadingPromise) {
            try {
                return await loadingPromise;
            } finally {
                if (unsubscribe) unsubscribe();
            }
        }

        loadingPromise = (async () => {
            console.log('[MobileAudio] Loading core audio samples...');
            audioSamples = {};
            const totalOps = getCoreLoadOperationCount();
            let completedOps = 0;
            let loadedOps = 0;
            emitLoadProgress({
                phase: 'init',
                label: 'Initializing audio...',
                total: totalOps,
                completed: 0,
                loaded: 0,
                failed: 0,
                percent: 0,
                ready: false
            });
            const markSample = (ok, label) => {
                completedOps += 1;
                if (ok) loadedOps += 1;
                emitLoadProgress({
                    phase: 'samples',
                    label: `Loading ${label}`,
                    total: totalOps,
                    completed: completedOps,
                    loaded: loadedOps,
                    failed: Math.max(0, completedOps - loadedOps),
                    ready: false
                });
            };

            audioSamples['djembe'] = {};
            for (const setName of coreDjembeSampleSets) {
                await loadDjembeSet(setName, markSample);
            }
            audioSamples['djembe_solo'] = audioSamples['djembe'];

            // Load dunun + bell families.
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
                if (!type) continue;
                for (const [soundName, soundInfo] of Object.entries(type.sounds)) {
                    audioSamples[dunun.id]['default'][soundName] = [];
                    const filename = `${dunun.prefix}_${soundInfo.file}.mp3`;
                    const buffer = await fetchDecodeSample(filename);
                    if (buffer) audioSamples[dunun.id]['default'][soundName].push(buffer);
                    markSample(!!buffer, filename);
                }
            }

            await loadShekereSamples(markSample);
            samplesLoaded = true;
            emitLoadProgress({
                phase: 'finalizing',
                label: 'Finalizing audio...',
                total: totalOps,
                completed: totalOps,
                loaded: loadedOps,
                failed: Math.max(0, totalOps - loadedOps),
                percent: 100,
                ready: false
            });
            await initReverb();
            console.log('[MobileAudio] Core samples loaded and ready');
            emitLoadProgress({
                phase: 'ready',
                label: 'Audio ready',
                total: totalOps,
                completed: totalOps,
                loaded: loadedOps,
                failed: Math.max(0, totalOps - loadedOps),
                percent: 100,
                ready: true
            });
            return true;
        })().catch((error) => {
            emitLoadProgress({
                phase: 'error',
                label: 'Audio load failed',
                ready: false
            });
            throw error;
        }).finally(() => {
            if (!samplesLoaded) loadingPromise = null;
        })();

        try {
            return await loadingPromise;
        } finally {
            if (unsubscribe) unsubscribe();
        }
    }

    function resolveSamplesForPlayback(instType, sampleSet, normalizedSound) {
        let samples = audioSamples[instType]?.[sampleSet]?.[normalizedSound];
        if ((!samples || samples.length === 0) && instType === 'djembe') {
            samples = audioSamples[instType]?.One?.[normalizedSound];
        }
        if ((!samples || samples.length === 0) && instType === 'djembe_solo') {
            samples = audioSamples.djembe?.One?.[normalizedSound];
        }
        if ((!samples || samples.length === 0) && instType === 'shekere') {
            samples = audioSamples.shekere?.default?.slap;
        }
        return samples;
    }

    function playSound(instrumentType, instrumentId, sound, velocity = 1.0, reverbMix = 0.1) {
        if (!audioContext) {
            console.warn('[MobileAudio] Not ready for playback');
            return false;
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

        // Normalize sound name
        let normalizedSound = sound;
        if (sound === 'bell') normalizedSound = 'slap';
        if (!normalizedSound || normalizedSound === 'silence') return false;

        // Find sample set
        let instType = instrumentType || 'djembe';
        let sampleSet = 'default';
        if (instType.startsWith('djembe')) {
            sampleSet = 'One'; // Default djembe set
            // Try to find a different set based on ID
            const idMatch = instrumentId?.match(/(\d)/);
            if (idMatch) {
                const idx = parseInt(idMatch[1], 10) - 1;
                if (idx >= 0 && idx < djembeSampleSets.length) {
                    sampleSet = djembeSampleSets[idx];
                }
            }
            if (sampleSet !== 'One') {
                queueDjembeSetLoad(sampleSet);
            }
        }

        const samples = resolveSamplesForPlayback(instType, sampleSet, normalizedSound);
        if (!samples || samples.length === 0) {
            if (!loadingPromise) loadSamples().catch(() => {});
            else {
                // Retry once after core load completes for first-touch reliability.
                loadingPromise.then(() => {
                    const retry = resolveSamplesForPlayback(instType, sampleSet, normalizedSound);
                    if (!retry || retry.length === 0) return;
                    try { playSound(instType, instrumentId, normalizedSound, velocity, reverbMix); } catch {}
                }).catch(() => {});
            }
            console.warn(`[MobileAudio] Sample not yet ready for ${instType}/${sampleSet}/${normalizedSound}`);
            return false;
        }

        // Round-robin selection
        const rrKey = `${instrumentId || instType}_${normalizedSound}`;
        if (!roundRobinState[rrKey]) roundRobinState[rrKey] = 0;
        const sampleIndex = roundRobinState[rrKey] % samples.length;
        roundRobinState[rrKey]++;

        const buffer = samples[sampleIndex];
        const source = audioContext.createBufferSource();
        source.buffer = buffer;

        const gainNode = audioContext.createGain();
        gainNode.gain.value = Math.max(0.1, Math.min(1.5, velocity));
        source.connect(gainNode);

        // Connect to dry and reverb paths
        if (dryGain && reverbNode) {
            const wetSend = audioContext.createGain();
            wetSend.gain.value = Math.max(0, Math.min(1, reverbMix));
            gainNode.connect(dryGain);
            gainNode.connect(wetSend);
            wetSend.connect(reverbNode);
        } else {
            gainNode.connect(audioContext.destination);
        }

        source.start(0);
        return true;
    }

    function isReady() {
        return isInitialized && samplesLoaded;
    }

    return { init, warmup, loadSamples, playSound, isReady, subscribeLoadProgress };
})();

if (typeof window !== 'undefined') {
    window.__rrcMobileAudio = MobileAudioEngine;
}

function parseTimeToSeconds(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10) || 0);
    const h = raw.match(/(\d+)h/);
    const m = raw.match(/(\d+)m/);
    const s = raw.match(/(\d+)s/);
    const seconds = (h ? parseInt(h[1], 10) * 3600 : 0)
        + (m ? parseInt(m[1], 10) * 60 : 0)
        + (s ? parseInt(s[1], 10) : 0);
    return Math.max(0, seconds || 0);
}

function buildYouTubeEmbedUrl(videoId, opts = {}) {
    const id = String(videoId || '').trim();
    if (!id) return '';
    const query = new URLSearchParams();
    query.set('rel', '0');
    query.set('modestbranding', '1');
    query.set('playsinline', '1');
    query.set('iv_load_policy', '3');
    query.set('autohide', '1');
    query.set('loop', '1');
    query.set('playlist', id);
    if (opts.start > 0) query.set('start', String(opts.start));
    if (opts.list) query.set('list', String(opts.list));
    try {
        if (window.location && window.location.origin) query.set('origin', window.location.origin);
    } catch {}
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${query.toString()}`;
}

function toEmbedUrl(url) {
    if (!url) return '';
    let u;
    try {
        u = new URL(url, window.location?.origin || undefined);
    } catch {
        return url;
    }
    const host = String(u.hostname || '').toLowerCase();
    const isYouTube = host.includes('youtube.com') || host.includes('youtube-nocookie.com') || host.includes('youtu.be');
    if (!isYouTube) return url;

    let videoId = '';
    if (host.includes('youtu.be')) {
        videoId = u.pathname.split('/').filter(Boolean)[0] || '';
    } else if (u.pathname.includes('/embed/')) {
        videoId = u.pathname.split('/embed/')[1]?.split('/')[0] || '';
    } else if (u.pathname.includes('/shorts/')) {
        videoId = u.pathname.split('/shorts/')[1]?.split('/')[0] || '';
    } else {
        videoId = u.searchParams.get('v') || '';
    }
    if (!videoId) return url;

    const start = parseTimeToSeconds(u.searchParams.get('start') || u.searchParams.get('t'));
    const list = String(u.searchParams.get('list') || '').trim();
    return buildYouTubeEmbedUrl(videoId, { start, list });
}

function normalizeRhythmMediaEmbeds(rhythmMap) {
    if (!rhythmMap || typeof rhythmMap !== 'object') return rhythmMap;
    const out = {};
    Object.entries(rhythmMap).forEach(([key, rhythm]) => {
        if (!rhythm || typeof rhythm !== 'object') {
            out[key] = rhythm;
            return;
        }
        const listeningExamples = Array.isArray(rhythm.listeningExamples)
            ? rhythm.listeningExamples.map((v) => ({
                ...v,
                url: toEmbedUrl(v?.url || '')
            }))
            : [];
        out[key] = {
            ...rhythm,
            listeningExamples,
            videoUrl: toEmbedUrl(rhythm.videoUrl || '')
        };
    });
    return out;
}

function countryFromRegion(region) {
    if (!region) return '';
    const r = region.toLowerCase();
    const map = { guinea:'guinea', mali:'mali', senegal:'senegal', brazil:'brazil',
        japan:'japan', uruguay:'uruguay', ireland:'ireland', morocco:'morocco',
        indonesia:'indonesia', bali:'indonesia' };
    for (const [k,v] of Object.entries(map)) if (r.includes(k)) return v;
    return region.split(',')[0].trim().split(' ')[0].toLowerCase();
}

function normalizePadHex(value, fallback = '#fcd116') {
    const raw = String(value || '').trim();
    const cleaned = raw.startsWith('#') ? raw.slice(1) : raw;
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned}`;
    if (/^[0-9a-fA-F]{3}$/.test(cleaned)) return `#${cleaned.split('').map((ch) => ch + ch).join('')}`;
    return fallback;
}

function slugifyRhythmKey(value) {
    const base = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || 'rhythm';
}

const LOCAL_TRANSCRIBED_NOTATION_URL = 'assets/transcribed-notations.json';
let localTranscribedNotationEntriesPromise = null;

function normalizeRhythmLookupToken(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function cloneNotationDataSafe(value) {
    if (!value || typeof value !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function normalizeTranscribedNotationEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const notationData = cloneNotationDataSafe(entry.notationData);
    if (!notationData || !Array.isArray(notationData.instruments) || notationData.instruments.length === 0) {
        return null;
    }
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    const aliasesNormalized = Array.isArray(entry.aliasesNormalized)
        ? entry.aliasesNormalized
        : aliases.map((alias) => normalizeRhythmLookupToken(alias));
    const tokenSet = new Set(
        aliasesNormalized
            .map((token) => normalizeRhythmLookupToken(token))
            .filter(Boolean)
    );
    if (tokenSet.size === 0) return null;
    return {
        sourceKey: String(entry.sourceKey || '').trim(),
        sourceName: String(entry.sourceName || '').trim(),
        aliasesNormalized: Array.from(tokenSet),
        notationData
    };
}

async function getLocalTranscribedNotationEntries() {
    if (localTranscribedNotationEntriesPromise) return localTranscribedNotationEntriesPromise;
    localTranscribedNotationEntriesPromise = (async () => {
        try {
            const resp = await fetch(LOCAL_TRANSCRIBED_NOTATION_URL, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const payload = await resp.json();
            const entriesRaw = Array.isArray(payload?.entries) ? payload.entries : [];
            const entries = entriesRaw.map(normalizeTranscribedNotationEntry).filter(Boolean);
            if (entries.length > 0) {
                console.log(`[RRC] Loaded ${entries.length} local transcribed notation entries`);
            }
            return entries;
        } catch (error) {
            console.warn('[RRC] Could not load local transcribed notations:', error?.message || error);
            return [];
        }
    })();
    return localTranscribedNotationEntriesPromise;
}

function buildRhythmLookupTokens(key, rhythm) {
    const tokens = new Set();
    const add = (value) => {
        const normalized = normalizeRhythmLookupToken(value);
        if (normalized) tokens.add(normalized);
    };
    add(key);
    add(rhythm?.name);
    add(rhythm?.notationPath);
    add(rhythm?.location);
    add(rhythm?.fullLocation);
    return tokens;
}

async function applyLocalTranscribedNotations(rhythmMap) {
    if (!rhythmMap || typeof rhythmMap !== 'object') return 0;
    const entries = await getLocalTranscribedNotationEntries();
    if (!entries.length) return 0;

    const lookup = new Map();
    entries.forEach((entry) => {
        entry.aliasesNormalized.forEach((token) => {
            if (!lookup.has(token)) lookup.set(token, entry);
        });
    });

    let applied = 0;
    Object.entries(rhythmMap).forEach(([key, rhythm]) => {
        if (!rhythm || typeof rhythm !== 'object') return;
        const tokens = buildRhythmLookupTokens(key, rhythm);
        let matched = null;
        for (const token of tokens) {
            if (lookup.has(token)) {
                matched = lookup.get(token);
                break;
            }
        }
        if (!matched) return;
        const clonedNotation = cloneNotationDataSafe(matched.notationData);
        if (!clonedNotation) return;
        const resolvedTempo = Math.max(
            40,
            Math.min(
                240,
                parseInt(clonedNotation.tempo, 10)
                || parseInt(rhythm.tempo, 10)
                || parseInt(matched?.notationData?.tempo, 10)
                || 100
            )
        );
        clonedNotation.tempo = resolvedTempo;
        rhythm.notationData = clonedNotation;
        rhythm.tempo = resolvedTempo;
        if (!String(rhythm.notationPath || '').trim()) {
            rhythm.notationPath = `local-transcribed:${matched.sourceKey || matched.sourceName || key}`;
        }
        applied += 1;
    });

    if (applied > 0) {
        console.log(`[RRC] Applied local transcribed notation to ${applied} rhythm(s)`);
    }
    return applied;
}

function buildUniqueRhythmKey(rhythm, usedKeys) {
    const base = slugifyRhythmKey(rhythm?.name || '');
    if (!usedKeys.has(base)) {
        usedKeys.add(base);
        return base;
    }
    const candidates = [
        rhythm?.id,
        rhythm?.notationPath,
        rhythm?.fullLocation,
        rhythm?.location
    ].map((value) => slugifyRhythmKey(value)).filter(Boolean);
    for (let i = 0; i < candidates.length; i++) {
        const candidate = `${base}_${candidates[i]}`;
        if (!usedKeys.has(candidate)) {
            usedKeys.add(candidate);
            return candidate;
        }
    }
    let idx = 2;
    while (usedKeys.has(`${base}_${idx}`)) idx += 1;
    const fallback = `${base}_${idx}`;
    usedKeys.add(fallback);
    return fallback;
}

function normaliseRhythm(node) {
    // ── Song texts (JSONB array on rhythms row) ──
    // Shape: [{ id, language, role, lyrics, created_at }]
    const rawSongTexts = Array.isArray(node.song_texts) ? node.song_texts
        : (node.song_textsCollection?.edges || []).map(e => e.node); // GraphQL fallback
    const songTexts = rawSongTexts.map(st => ({
        id: st.id || '',
        language: st.language || '',
        role: st.role || '',
        text: st.lyrics || st.text || '', // DB uses "lyrics", normalise to "text" for UI
        created_at: st.created_at || ''
    }));

    // ── Listening examples (JSONB array on rhythms row) ──
    // Shape: [{ id, title, description, videos: [{ id, title, url, video_type }] }]
    const rawExamples = Array.isArray(node.listening_examples) ? node.listening_examples
        : (node.listening_examplesCollection?.edges || []).map(e => e.node); // GraphQL fallback

    // Flatten all videos from all examples into a single list for the video player
    const allVideos = [];
    const allImages = [];
    rawExamples.forEach(ex => {
        const videos = Array.isArray(ex.videos) ? ex.videos : [];
        const images = Array.isArray(ex.images) ? ex.images : [];
        if (videos.length > 0) {
            videos.forEach(v => {
                allVideos.push({
                    id: v.id || '',
                    url: toEmbedUrl(v.url || ''),
                    caption: v.title || ex.title || '',
                    videoType: v.video_type || '',
                    exampleTitle: ex.title || '',
                    exampleDescription: ex.description || ''
                });
            });
        } else if (ex.url) {
            // Legacy shape: example has url directly (no nested videos)
            allVideos.push({
                id: ex.id || '',
                url: toEmbedUrl(ex.url),
                caption: ex.caption || ex.title || '',
                videoType: '',
                exampleTitle: '', exampleDescription: ''
            });
        }
        if (images.length > 0) {
            images.forEach((img) => {
                const imageUrl = String(img?.url || '').trim();
                if (!imageUrl) return;
                allImages.push({
                    id: img.id || '',
                    url: imageUrl,
                    caption: img.caption || ex.title || ''
                });
            });
        }
    });

    const tags = (node.rhythm_tagsCollection?.edges || []).map(e => e.node?.tag || e.node);
    const region = node.region || '';

    return {
        id: node.id, lat: node.lat, lng: node.lon,
        name: node.name || 'Untitled',
        tempo: Math.max(40, Math.min(240, parseInt(node.tempo, 10) || parseInt(node?.notation_data?.tempo, 10) || 100)),
        location: region.split(',')[0].trim(),
        fullLocation: region,
        community: node.community || '',
        description: node.subtitle || '',
        culturalContext: node.summary || '',
        colorHex: node.color || null,
        library: node.library || 'Local',
        creator: node.creator || 'RRC',
        country: countryFromRegion(region),
        notationPath: node.notation_path || '',
        notationData: node.notation_data || null,
        songTexts: songTexts,
        listeningExamples: allVideos,
        tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string') : [],
        videoUrl: allVideos.length > 0 ? allVideos[0].url : '',
        cachedImageUrl: allImages.length > 0 ? allImages[0].url : null,
        imageCaption: allImages.length > 0 ? allImages[0].caption || '' : ''
    };
}

async function fetchRhythmsFromSupabase(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const forceFresh = !!opts.forceFresh;
    const RHYTHM_CACHE_VALIDATE_MS = 5 * 60 * 1000;
    // Check if Supabase is configured
    const hasUrl = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL && SUPABASE_URL !== '';
    const hasKey = typeof SUPABASE_ANON_KEY !== 'undefined' && SUPABASE_ANON_KEY &&
        SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

    if (!hasUrl || !hasKey) {
        console.warn('Supabase not configured — missing', !hasUrl ? 'URL' : 'ANON KEY', '→ using fallback');
        return null;
    }

    console.log('Checking Supabase for updates...');

    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact'
    };

    const cachedFingerprint = localStorage.getItem('rrc_db_fingerprint');
    const cachedData = localStorage.getItem('rrc_rhythm_cache');
    const cachedAt = parseInt(localStorage.getItem('rrc_rhythm_cache_at') || '0', 10) || 0;
    const cacheAgeMs = Date.now() - cachedAt;

    // Fast path: trust recent cache and skip any network calls.
    if (!forceFresh && cachedData && cachedFingerprint && cachedAt > 0 && cacheAgeMs <= RHYTHM_CACHE_VALIDATE_MS) {
        try {
            const parsed = JSON.parse(cachedData);
            const parsedCount = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
            if (parsed && parsedCount > 0) {
                console.log(`Using recent rhythm cache (${Math.round(cacheAgeMs / 1000)}s old)`);
                return normalizeRhythmMediaEmbeds(parsed);
            }
        } catch {
            // Cache parse failed; continue to normal fingerprint check.
        }
    }

    // ── Step 1: Lightweight fingerprint check (1 tiny query) ──
    // Fetches count + latest updated/created timestamp to detect changes.
    try {
        let totalCount = '0';
        let latestDate = '';
        let fpResp = await fetch(
            `${SUPABASE_URL}/rest/v1/rhythms?select=updated_at,created_at&order=updated_at.desc&limit=1`,
            { headers: { ...headers, 'Prefer': 'count=exact' } }
        );
        if (!fpResp.ok) {
            fpResp = await fetch(
                `${SUPABASE_URL}/rest/v1/rhythms?select=created_at&order=created_at.desc&limit=1`,
                { headers: { ...headers, 'Prefer': 'count=exact' } }
            );
        }
        if (!fpResp.ok) throw new Error(`Fingerprint: HTTP ${fpResp.status}`);

        totalCount = fpResp.headers.get('content-range')?.split('/')[1] || '0';
        const latestRows = await fpResp.json();
        latestDate = latestRows[0]?.updated_at || latestRows[0]?.created_at || '';
        const fingerprint = `${totalCount}|${latestDate}`;

        if (!forceFresh && cachedFingerprint === fingerprint && cachedData) {
            try {
                const parsed = JSON.parse(cachedData);
                const parsedCount = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
                const expectedCount = Math.max(0, parseInt(totalCount, 10) || 0);
                if (parsed && parsedCount > 0 && (expectedCount === 0 || parsedCount === expectedCount)) {
                    console.log(`DB unchanged (${totalCount} rhythms) → using cache`);
                    return normalizeRhythmMediaEmbeds(parsed);
                }
                if (parsedCount > 0 && expectedCount > 0 && parsedCount !== expectedCount) {
                    console.warn(`Cached rhythm count mismatch (${parsedCount} vs ${expectedCount}) → refetching`);
                }
            } catch { /* corrupted cache, refetch */ }
        }

        console.log(`DB changed (fingerprint: ${fingerprint}) → full fetch`);

        // ── Step 2: Full fetch (only when data changed) ──
        const isPublishableKey = SUPABASE_ANON_KEY.startsWith('sb_publishable_');
        let result;
        if (isPublishableKey) {
            result = await fetchRhythmsViaREST();
        } else {
            result = await fetchRhythmsViaGraphQL();
        }
        result = normalizeRhythmMediaEmbeds(result);

        // Cache the result + fingerprint
        if (result && Object.keys(result).length > 0) {
            try {
                localStorage.setItem('rrc_rhythm_cache', JSON.stringify(result));
                localStorage.setItem('rrc_db_fingerprint', fingerprint);
                localStorage.setItem('rrc_rhythm_cache_at', String(Date.now()));
                console.log(`Cached ${Object.keys(result).length} rhythms`);
            } catch (e) {
                console.warn('Could not cache rhythm data:', e.message);
            }
        }

        return result;

    } catch (err) {
        console.error('Supabase fingerprint check failed:', err);
        // Try to use stale cache as last resort
        const staleCache = localStorage.getItem('rrc_rhythm_cache');
        if (staleCache) {
            try {
                const parsed = JSON.parse(staleCache);
                if (parsed && Object.keys(parsed).length > 0) {
                    console.warn('Using stale cache due to network error');
                    return normalizeRhythmMediaEmbeds(parsed);
                }
            } catch { /* fall through */ }
        }
        return null;
    }
}

// GraphQL fetch (for JWT anon keys starting with eyJ...)
async function fetchRhythmsViaGraphQL() {
    try {
        const resp = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({ query: RHYTHM_QUERY })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');
        const edges = json.data?.rhythmsCollection?.edges;
        if (!edges || edges.length === 0) return null;
        const out = {};
        const usedKeys = new Set();
        edges.forEach(edge => {
            const r = normaliseRhythm(edge.node);
            const key = buildUniqueRhythmKey(r, usedKeys);
            out[key] = r;
        });
        console.log(`Loaded ${Object.keys(out).length} rhythms from Supabase (GraphQL)`);
        return out;
    } catch (err) { console.error('Supabase GraphQL fetch failed:', err); return null; }
}

// REST API — works with both publishable keys and JWT anon keys
// song_texts and listening_examples are JSONB columns on rhythms, so one query is enough
async function fetchRhythmsViaREST() {
    const baseUrl = SUPABASE_URL + '/rest/v1';
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
    };

    try {
        const rResp = await fetch(`${baseUrl}/rhythms?select=*`, { headers });
        if (!rResp.ok) throw new Error(`Rhythms: HTTP ${rResp.status} ${await rResp.text()}`);
        const rhythms = await rResp.json();
        if (!rhythms || rhythms.length === 0) { console.warn('No rhythms from REST'); return null; }

        const out = {};
        const usedKeys = new Set();
        rhythms.forEach(r => {
            // REST returns columns directly — song_texts and listening_examples are already JSONB
            const norm = normaliseRhythm(r);
            const key = buildUniqueRhythmKey(norm, usedKeys);
            out[key] = norm;
        });

        console.log(`Loaded ${Object.keys(out).length} rhythms from Supabase (REST)`);
        return out;
    } catch (err) { console.error('Supabase REST fetch failed:', err); return null; }
}

// ─── FALLBACK DATA (used when Supabase unavailable) ────────

const FALLBACK_rhythmData = {
    kassa: {
        lat: 10.7, lng: -10.8,
        name: 'Kassa', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.ORANGERED,
        colorHex: '#FF6B35',
        // Guinea flag: Red, Yellow, Green
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Traditional harvest celebration in Guinea',
        description: 'A harvest rhythm played while workers walk to fields. Celebrates bountiful harvests at the Kassaladon festival.',
        culturalContext: 'Kassa means "granary" - a family of rhythms associated with the harvest season in Guinea. It is played to honor farmers and celebrate agricultural abundance, connecting community to the land.',
        historicalContext: 'Kassa means "granary": a family of rhythms tied to the harvest season in Guinea. It is played while workers walk to the fields, and it honors farmers and celebrates a bountiful harvest at the Kassaladon festival, connecting the community to the land.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    djole: {
        lat: 8.5, lng: -12.3,
        name: 'Djolé', location: 'Guinea/Sierra Leone',
        fullLocation: 'Guinea & Sierra Leone, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#FCD116'),
        colorHex: '#FCD116',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Wedding celebration with traditional djembe ensemble',
        description: 'Originated in southern Guinea and northern Sierra Leone. Played at weddings and end of Ramadan celebrations.',
        culturalContext: 'Originally played only on Sikkos (square drums), now adapted for djembe and dundun. This mask dance has become one of the most popular rhythms throughout West Africa for major festivities.',
        historicalContext: 'Djolé comes from southern Guinea and northern Sierra Leone. It was first played only on sikko (square drums) and is now adapted for djembe and dundun. This mask dance, played at weddings and at the end of Ramadan, has become one of the most popular rhythms for major festivities throughout West Africa.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    soli: {
        lat: 10.5, lng: -10.5,
        name: 'Soli', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#CE1126'),
        colorHex: '#CE1126',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Initiation ceremony drumming circle',
        description: 'Played during initiation ceremonies. Also features challenging fight dances where participants wrestle.',
        culturalContext: 'Specifically for circumcision and initiation rituals. When boys reach seven years old, the Soli announces their passage into manhood. Multiple regional versions exist (Fast, Slow, Wassolon, Mandiana).',
        historicalContext: 'Soli belongs to circumcision and initiation rituals. When boys reach seven years old, Soli announces their passage into manhood. The ceremonies also feature challenging fight dances where participants wrestle. Several regional versions exist (Fast, Slow, Wassolon, Mandiana).',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    mendiani: {
        lat: 10.3, lng: -9.5,
        name: 'Mendiani', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#009460'),
        colorHex: '#009460',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Young women in traditional celebration attire',
        description: 'A rhythm for young girls dressed in wide "Boubou" outfits and masks, carried on shoulders to village center.',
        culturalContext: 'A Malinke rhythm celebrating young women. Village women and their leaders organize the event. When girls remove their masks, the griot begins singing and the Mendiani dance begins.',
        historicalContext: 'A Malinke rhythm celebrating young women. Village women and their leaders organize the event: the girls, dressed in wide "boubou" outfits and masks, are carried on shoulders to the village centre. When they remove their masks, the griot begins singing and the Mendiani dance begins.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    dununba: {
        lat: 10.9, lng: -9.7,
        name: 'Dununba', location: 'Hamana, Guinea',
        fullLocation: 'Hamana Region, Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#FF8C42'),
        colorHex: '#FF8C42',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Traditional warrior dance performance',
        description: 'War dance where boys of different age groups confront each other with whips - the "dance of the strong men."',
        culturalContext: 'From the Hamana region (Kouroussa). Originally a war dance, now practiced peacefully at circumcision festivities. The dununba drum leads while djembe accompanies - over 50 rhythm variations exist in this family.',
        historicalContext: 'From the Hamana region (Kouroussa). Originally a war dance, the "dance of the strong men", in which boys of different age groups confront each other with whips. Today it is practiced peacefully at circumcision festivities. The dununba drum leads while the djembe accompanies, and over 50 rhythm variations exist in this family.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    konkoba: {
        lat: 12.2, lng: -8.3,
        name: 'Konkoba', location: 'Mali/Guinea',
        fullLocation: 'Mali & Guinea, West Africa',
        country: 'mali',
        color: Cesium.Color.GOLD,
        colorHex: '#D4AF37',
        // Mali flag: Green, Yellow, Red
        flagColors: ['#14B53A', '#FCD116', '#CE1126'],
        imageCaption: 'Agricultural workers celebrated in Mali',
        description: 'A Malinke rhythm played to pay tribute to important or devoted farmers.',
        culturalContext: 'Honors the agricultural workers who sustain the community. Related to Kassa, this rhythm recognizes those who dedicate their lives to farming and feeding their villages.',
        historicalContext: 'A Malinke rhythm played to pay tribute to important or devoted farmers. Related to Kassa, it honors the agricultural workers who sustain the community and recognizes those who dedicate their lives to farming and feeding their villages.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    yankadi: {
        lat: 10.0, lng: -12.0,
        name: 'Yankadi', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#FF5722'),
        colorHex: '#FF5722',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Courtship dance and celebration',
        description: 'The slow introductory part, often followed by Makru (the fast part). Also paired with Guine Fare and Djole.',
        culturalContext: 'A courtship rhythm where the slow Yankadi builds anticipation before transitioning to the faster Makru. Celebrates romantic relationships and community bonding.',
        historicalContext: 'A courtship rhythm. The slow Yankadi is the introductory part and builds anticipation before the transition to the faster Makru; it is also paired with Guine Fare and Djolé. It celebrates romantic relationships and community bonding.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    sorsornet: {
        lat: 10.3, lng: -14.4,
        name: 'Sorsornet', location: 'Coastal Guinea',
        fullLocation: 'Coastal Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#FF7043'),
        colorHex: '#FF7043',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Sacred mask ceremony of the Baga people',
        description: 'A sacred mask from the Baga people, kept in the forest and brought to villages for protection.',
        culturalContext: 'Women consult the Sorsornet mask through its elder woman guard for fertility and pregnancy concerns, and to give thanks for successful births. The mask is believed to protect entire villages.',
        historicalContext: 'A sacred mask from the Baga people, kept in the forest and brought to villages for protection. Women consult the Sorsornet mask through its elder woman guard about fertility and pregnancy, and to give thanks for successful births. The mask is believed to protect entire villages.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    balakulandyan: {
        lat: 10.4, lng: -10.0,
        name: 'Balakulandyan', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#FFA726'),
        colorHex: '#FFA726',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Fertility blessing ceremony',
        description: 'A Malinke fertility rhythm played before, during and after initiation rituals.',
        culturalContext: 'Played especially during the last three days before initiation. Now performed at marriage ceremonies for fertility. The song speaks of the priceless value of having children and offers help to women who cannot conceive.',
        historicalContext: 'A Malinke fertility rhythm played before, during and after initiation rituals, especially during the last three days before initiation. It is now also performed at marriage ceremonies for fertility. The song speaks of the priceless value of having children and offers help to women who cannot conceive.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    djabara: {
        lat: 11.5, lng: -8.5,
        name: 'Djabara', location: 'Wassolon, Guinea',
        fullLocation: 'Wassolon Region, Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#26A69A'),
        colorHex: '#26A69A',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Women with traditional Djabara shakers',
        description: 'Named after the Djabara shaker, originally played by women when important visitors arrived.',
        culturalContext: 'From the Wassolon ethnic group in northeast Guinea. Women would hold Djabaras (shakers) to welcome important people. Now adapted with dundun drums for various occasions.',
        historicalContext: 'From the Wassolon ethnic group in northeast Guinea. It is named after the djabara shaker: women held djabaras to welcome important visitors. It is now adapted with dundun drums for various occasions.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    kakilambe: {
        lat: 10.6, lng: -10.2,
        name: 'Kakilambe', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#E64A19'),
        colorHex: '#E64A19',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Sacred mask protecting young initiates',
        description: 'A sacred mask rhythm played during circumcision to protect young initiates from evil spirits.',
        culturalContext: 'The rhythm of the medicine man. Kakilambe is a masked figure who guards the bilakoro (young initiates) in the days before circumcision, containing evil spirits through the power of rhythm.',
        historicalContext: 'The rhythm of the medicine man, a sacred mask rhythm played during circumcision. Kakilambe is a masked figure who guards the bilakoro (young initiates) in the days before circumcision, protecting them by containing evil spirits through the power of rhythm.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    kuku: {
        lat: 10.8, lng: -10.4,
        name: 'Kuku', location: 'Guinea',
        fullLocation: 'Guinea, West Africa',
        country: 'guinea',
        color: Cesium.Color.fromCssColorString('#AB47BC'),
        colorHex: '#AB47BC',
        flagColors: ['#CE1126', '#FCD116', '#009460'],
        imageCaption: 'Community celebration and gathering',
        description: 'A popular rhythm played at celebrations and community gatherings across Guinea.',
        culturalContext: 'One of the foundational rhythms taught to beginning djembe students. Its accessible patterns make it perfect for bringing communities together in celebration.',
        historicalContext: 'A popular rhythm played at celebrations and community gatherings across Guinea. It is one of the foundational rhythms taught to beginning djembe students, and its accessible patterns make it perfect for bringing communities together in celebration.',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    }
};

const FALLBACK_communityRhythmData = {
    samba: {
        lat: -22.9, lng: -43.2,
        name: 'Samba de Roda', location: 'Brazil',
        fullLocation: 'Rio de Janeiro, Brazil',
        country: 'brazil',
        color: Cesium.Color.fromCssColorString('#009739'),
        colorHex: '#009739',
        flagColors: ['#009739', '#FFDF00', '#002776'],
        imageCaption: 'Traditional samba circle in Rio',
        description: 'A circular dance and rhythm from Bahia, featuring call-and-response patterns.',
        culturalContext: 'Shared by @DrumCircleBrazil - Samba de Roda is the root of modern samba, originating from enslaved Africans in Bahia. We play this at our weekly community gatherings.',
        uploadedBy: 'DrumCircleBrazil',
        uploadDate: '2025-11-15',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    taiko: {
        lat: 35.7, lng: 139.7,
        name: 'Matsuri Taiko', location: 'Japan',
        fullLocation: 'Tokyo, Japan',
        country: 'japan',
        color: Cesium.Color.fromCssColorString('#BC002D'),
        colorHex: '#BC002D',
        flagColors: ['#BC002D', '#FFFFFF'],
        imageCaption: 'Festival taiko drumming performance',
        description: 'Traditional festival drumming that brings communities together during celebrations.',
        culturalContext: 'Shared by @TokyoTaiko - Our group has been playing Matsuri rhythms for 30 years. This pattern is perfect for drum circle beginners!',
        uploadedBy: 'TokyoTaiko',
        uploadDate: '2025-10-22',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    candombe: {
        lat: -34.9, lng: -56.2,
        name: 'Candombe', location: 'Uruguay',
        fullLocation: 'Montevideo, Uruguay',
        country: 'uruguay',
        color: Cesium.Color.fromCssColorString('#001489'),
        colorHex: '#001489',
        flagColors: ['#001489', '#FFFFFF', '#FCD116'],
        imageCaption: 'Llamadas parade drumming',
        description: 'Afro-Uruguayan rhythm featuring three drums: chico, repique, and piano.',
        culturalContext: 'Shared by @CandombeUruguay - This rhythm has been in our family for generations. The three interlocking parts create an amazing polyrhythm.',
        uploadedBy: 'CandombeUruguay',
        uploadDate: '2025-09-08',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    bodran: {
        lat: 53.3, lng: -6.3,
        name: 'Bodhrán Jig', location: 'Ireland',
        fullLocation: 'Dublin, Ireland',
        country: 'ireland',
        color: Cesium.Color.fromCssColorString('#169B62'),
        colorHex: '#169B62',
        flagColors: ['#169B62', '#FFFFFF', '#FF883E'],
        imageCaption: 'Traditional Irish session',
        description: 'Classic Irish frame drum pattern for accompanying jigs and reels.',
        culturalContext: 'Shared by @DublinDrummers - We adapted this traditional pattern for drum circles. Works great with any melody instruments!',
        uploadedBy: 'DublinDrummers',
        uploadDate: '2025-12-01',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    gnawa: {
        lat: 31.6, lng: -8.0,
        name: 'Gnawa Lila', location: 'Morocco',
        fullLocation: 'Marrakech, Morocco',
        country: 'morocco',
        color: Cesium.Color.fromCssColorString('#C1272D'),
        colorHex: '#C1272D',
        flagColors: ['#C1272D', '#006233'],
        imageCaption: 'Gnawa musicians in traditional attire',
        description: 'Trance-inducing rhythm from the Gnawa spiritual tradition.',
        culturalContext: 'Shared by @GnawaMarrakech - This healing rhythm has been passed down for centuries. Perfect for meditation circles.',
        uploadedBy: 'GnawaMarrakech',
        uploadDate: '2025-08-19',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    },
    gamelan: {
        lat: -8.4, lng: 115.2,
        name: 'Gamelan Bali', location: 'Indonesia',
        fullLocation: 'Bali, Indonesia',
        country: 'indonesia',
        color: Cesium.Color.fromCssColorString('#FF0000'),
        colorHex: '#FF0000',
        flagColors: ['#FF0000', '#FFFFFF'],
        imageCaption: 'Balinese gamelan orchestra',
        description: 'Interlocking rhythmic pattern adapted for hand drums.',
        culturalContext: 'Shared by @BaliBeats - We simplified traditional gamelan interlocking for frame drums. Great for teaching polyrhythms!',
        uploadedBy: 'BaliBeats',
        uploadDate: '2025-07-04',
        videoUrl: 'https://www.youtube.com/embed/FgrBzOXvRmk'
    }
};

// ─── UNIFIED RHYTHM STORE ──────────────────────────────────
// allRhythms is populated from Supabase or fallback at init
let allRhythms = {};
const LOCAL_CUSTOM_RHYTHMS_KEY = 'rrc_local_custom_rhythms_v1';

function readLocalCustomRhythms() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_CUSTOM_RHYTHMS_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeLocalCustomRhythms(map) {
    const safeMap = map && typeof map === 'object' ? map : {};
    localStorage.setItem(LOCAL_CUSTOM_RHYTHMS_KEY, JSON.stringify(safeMap));
}

function mergeLocalCustomRhythmsIntoAllRhythms() {
    const localCustom = readLocalCustomRhythms();
    if (!localCustom || typeof localCustom !== 'object' || Object.keys(localCustom).length === 0) return;
    allRhythms = { ...(allRhythms || {}), ...localCustom };
}

// Normalise fallback data to match Supabase shape
function normaliseFallback(data, library) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        out[k] = {
            ...v,
            library: library,
            community: v.community || '',
            description: v.description || '',
            culturalContext: v.culturalContext || '',
            colorHex: v.colorHex || null,
            creator: v.uploadedBy || 'RRC',
            songTexts: v.songTexts || [],
            listeningExamples: v.listeningExamples || [],
            tags: v.tags || [],
            videoUrl: v.videoUrl ? toEmbedUrl(v.videoUrl) : '',
            cachedImageUrl: v.cachedImageUrl || null
        };
    }
    return out;
}

const DEMO_SOURCE = 'Demo';
const DEMO_RHYTHMS_TEXT_URL = 'rhythms.txt';
const DEMO_MAX_STEPS = 64;
const DEMO_REGION_LABELS = [
    'North America',
    'South America',
    'Europe',
    'North Africa',
    'West Africa',
    'East Africa',
    'Middle East',
    'Central Asia',
    'South Asia',
    'East Asia',
    'Southeast Asia',
    'Oceania'
];
const DEMO_PREFIX_INSTRUMENT_MAP = {
    DjembeOne_: { id: 'djembe1', name: 'Djembe 1', icon: '🥁', type: 'djembe', sampleSet: 'One' },
    DjembeTwo_: { id: 'djembe2', name: 'Djembe 2', icon: '🥁', type: 'djembe', sampleSet: 'Two' },
    DjembeThree_: { id: 'djembe3', name: 'Djembe 3', icon: '🥁', type: 'djembe', sampleSet: 'Three' },
    DjembeSolo_: { id: 'djembeSolo', name: 'Djembe Solo', icon: '🥁', type: 'djembe', sampleSet: 'Solo' },
    Kenkeni_: { id: 'kenkeni1', name: 'Kenkeni', icon: '🪘', type: 'kenkeni', sampleSet: 'default' },
    Kenkeni_Bell_: { id: 'kenkeni_bell1', name: 'Kenkeni Bell', icon: '🔔', type: 'kenkeni_bell', sampleSet: 'default' },
    Sangban_: { id: 'sangban1', name: 'Sangban', icon: '🪘', type: 'sangban', sampleSet: 'default' },
    Sangban_Bell_: { id: 'sangban_bell1', name: 'Sangban Bell', icon: '🔔', type: 'sangban_bell', sampleSet: 'default' },
    Doundoun_: { id: 'doundoun1', name: 'Doundoun', icon: '🪘', type: 'doundoun', sampleSet: 'default' },
    Doundoun_Bell_: { id: 'doundoun_bell1', name: 'Doundoun Bell', icon: '🔔', type: 'doundoun_bell', sampleSet: 'default' }
};
let demoRhythmKeys = new Set();
let demoRhythmLoadPromise = null;

function resetDemoRhythmsState() {
    if (allRhythms && typeof allRhythms === 'object') {
        Object.keys(allRhythms).forEach((key) => {
            if (allRhythms[key] && allRhythms[key].library === DEMO_SOURCE) {
                delete allRhythms[key];
            }
        });
    }
    demoRhythmKeys.clear();
    demoRhythmLoadPromise = null;
}

function normalizeDemoStep(step) {
    const raw = String(step || '').trim().toLowerCase();
    if (!raw) return 'silence';
    if (raw === 'open' || raw === 'tone' || raw === 'bell' || raw === 'shake') return 'tone';
    if (raw === 'slap') return 'slap';
    if (raw === 'bass') return 'bass';
    if (raw === 'muffled' || raw === 'mute' || raw === 'muffle') return 'mute';
    // Flams and rolls: OpenFlam -> toneFlam, OpenSlapFlam -> toneSlapFlam, SlapRoll -> slapRoll.
    const m = /^(open|slap|bass)(open|slap|bass)?(flam|roll)$/.exec(raw);
    if (m) {
        const name = (x) => (x === 'open' ? 'tone' : x);
        const cap = (x) => x[0].toUpperCase() + x.slice(1);
        return name(m[1]) + (m[2] ? cap(name(m[2])) : '') + cap(m[3]);
    }
    return 'silence';
}

function normalizeDemoStepsCount(value) {
    let next = Math.floor(Number(value) || 0);
    if (!Number.isFinite(next) || next < 1) next = 16;
    return Math.max(1, Math.min(DEMO_MAX_STEPS, next));
}

function getDemoSubdivisionsForSteps(stepCount) {
    const safe = normalizeDemoStepsCount(stepCount);
    const candidates = [4, 3, 5, 2, 6, 7, 8, 1];
    for (let i = 0; i < candidates.length; i += 1) {
        const subdivisions = candidates[i];
        if (safe % subdivisions !== 0) continue;
        const beats = safe / subdivisions;
        if (beats >= 1 && beats <= 64) return subdivisions;
    }
    return 4;
}

function buildDemoSwing(swingSource) {
    const fallback = { factor: 35, A: 0, B: 0, C: 0, D: 0 };
    if (!swingSource || typeof swingSource !== 'object') return fallback;
    const read = (key, fallbackValue) => {
        const parsed = parseInt(swingSource[key], 10);
        return Number.isFinite(parsed) ? parsed : fallbackValue;
    };
    return {
        factor: read('factor', fallback.factor),
        A: read('A', fallback.A),
        B: read('B', fallback.B),
        C: read('C', fallback.C),
        D: read('D', fallback.D)
    };
}

function getDemoWorldPosition(index, total) {
    const count = Math.max(1, parseInt(total, 10) || 1);
    const i = Math.max(0, parseInt(index, 10) || 0);
    const latRad = Math.asin(-1 + (2 * (i + 0.5)) / count);
    const lat = Math.max(-65, Math.min(65, latRad * (180 / Math.PI)));
    const golden = 137.507764;
    const lng = ((((i * golden) % 360) + 540) % 360) - 180;
    return {
        lat: Number(lat.toFixed(5)),
        lng: Number(lng.toFixed(5))
    };
}

function buildDemoLocationLabel(index, lat, lng) {
    const region = DEMO_REGION_LABELS[Math.abs(parseInt(index, 10) || 0) % DEMO_REGION_LABELS.length];
    const latCardinal = lat >= 0 ? 'N' : 'S';
    const lngCardinal = lng >= 0 ? 'E' : 'W';
    return `${region} (${Math.abs(lat).toFixed(1)}°${latCardinal}, ${Math.abs(lng).toFixed(1)}°${lngCardinal})`;
}

function buildDemoNotationData(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    const rawSteps = Number(entry.steps) || 0;
    const maxRowSteps = rows.reduce((max, row) => {
        const count = Array.isArray(row?.steps) ? row.steps.length : 0;
        return Math.max(max, count);
    }, 0);
    const steps = normalizeDemoStepsCount(rawSteps > 0 ? rawSteps : maxRowSteps);
    const subdivisions = getDemoSubdivisionsForSteps(steps);
    const beats = Math.max(1, Math.floor(steps / Math.max(1, subdivisions)));
    const instruments = [];

    rows.forEach((row) => {
        const prefix = String(row?.instrumentPrefix || '').trim();
        const meta = DEMO_PREFIX_INSTRUMENT_MAP[prefix];
        if (!meta) return;
        const rowSteps = Array.isArray(row.steps) ? row.steps : [];
        const pattern = new Array(steps).fill('silence').map((_, idx) => normalizeDemoStep(rowSteps[idx]));
        instruments.push({
            id: meta.id,
            name: meta.name,
            icon: meta.icon,
            type: meta.type,
            sampleSet: meta.sampleSet,
            visible: true,
            muted: false,
            volume: 1,
            focused: false,
            pan: 0,
            soloed: false,
            pattern
        });
    });

    if (instruments.length === 0) {
        instruments.push({
            id: 'djembe1',
            name: 'Djembe 1',
            icon: '🥁',
            type: 'djembe',
            sampleSet: 'One',
            visible: true,
            muted: false,
            volume: 1,
            focused: false,
            pan: 0,
            soloed: false,
            pattern: new Array(steps).fill('silence')
        });
    }

    const signalSteps = Array.isArray(entry?.signal?.pattern) ? entry.signal.pattern : [];
    if (signalSteps.length > 0) {
        const callPattern = new Array(steps).fill('silence').map((_, idx) => normalizeDemoStep(signalSteps[idx % signalSteps.length]));
        instruments.unshift({
            id: 'call1',
            name: 'Call',
            icon: '📣',
            type: 'djembe_solo',
            sampleSet: 'Solo',
            visible: true,
            muted: false,
            volume: 0,
            focused: false,
            pan: 0,
            soloed: false,
            isCall: true,
            pattern: callPattern
        });
    }

    return {
        rhythmName: String(entry.name || '').trim() || 'Demo Rhythm',
        beats,
        subdivisions,
        tempo: Math.max(40, Math.min(240, parseInt(entry.tempo, 10) || 100)),
        swing: buildDemoSwing(entry.swing),
        instruments
    };
}

function buildDemoRhythmEntry(entry, index, total, usedKeys) {
    const notationData = buildDemoNotationData(entry);
    if (!notationData) return null;
    const worldPos = getDemoWorldPosition(index, total);
    const displayName = String(entry?.name || '').trim() || `Demo Rhythm ${index + 1}`;
    const location = buildDemoLocationLabel(index, worldPos.lat, worldPos.lng);
    const fullLocation = `${location} · Demo Mode`;
    const rhythm = {
        id: `demo-${slugifyRhythmKey(String(entry?.key || displayName)) || index}`,
        lat: worldPos.lat,
        lng: worldPos.lng,
        name: displayName,
        location,
        fullLocation,
        community: 'Demo',
        description: String(entry?.footer || entry?.info || '').trim() || 'Prototype rhythm generated from rhythms.txt',
        culturalContext: String(entry?.info || entry?.footer || '').trim() || 'Demo mode entry',
        colorHex: null,
        library: DEMO_SOURCE,
        creator: 'Demo Generator',
        country: 'world',
        tempo: Math.max(40, Math.min(240, parseInt(notationData?.tempo, 10) || 100)),
        notationPath: `demo:${String(entry?.key || entry?.matrixName || displayName).trim()}`,
        notationData,
        songTexts: [],
        listeningExamples: [],
        tags: Array.isArray(entry?.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
        videoUrl: '',
        cachedImageUrl: getBundledFallbackImage(`${entry?.key || displayName}-${index}`),
        imageCaption: 'Demo image'
    };
    const preferredKey = slugifyRhythmKey(String(entry?.key || entry?.matrixName || displayName).trim());
    let key = preferredKey || buildUniqueRhythmKey(rhythm, usedKeys);
    if (usedKeys.has(key)) {
        key = buildUniqueRhythmKey({ ...rhythm, id: `${rhythm.id}-${index}` }, usedKeys);
    } else {
        usedKeys.add(key);
    }
    return { key, rhythm };
}

// ── Rhythm library: the djembeloops collection, built from rhythms.txt by scripts/build-library-rhythms.py
// into a compact file. Merged into every rhythm list (startup and refreshes); a rhythm already in the
// library under the same name keeps the existing entry.
const LIBRARY_RHYTHMS_URL = 'assets/library-rhythms.json';
const LIBRARY_COLLECTION = 'djembeloops';
let libraryRhythmsPromise = null;

function fetchLibraryRhythms() {
    if (!libraryRhythmsPromise) {
        libraryRhythmsPromise = fetch(LIBRARY_RHYTHMS_URL)
            .then((resp) => (resp.ok ? resp.json() : null))
            .catch((err) => { console.warn('[Library] could not load', err?.message || err); return null; });
    }
    return libraryRhythmsPromise;
}

function normaliseRhythmNameForMatch(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function mergeLibraryRhythms() {
    const payload = await fetchLibraryRhythms();
    if (!payload || !Array.isArray(payload.rhythms) || !allRhythms || typeof allRhythms !== 'object') return 0;
    const decode = { '.': null, ...(payload.codes || {}) };
    const takenNames = new Set();
    Object.values(allRhythms).forEach((r) => {
        if (r && r.collection !== LIBRARY_COLLECTION) takenNames.add(normaliseRhythmNameForMatch(r.name));
    });
    const usedKeys = new Set(Object.keys(allRhythms));
    let added = 0;
    payload.rhythms.forEach((e, index) => {
        if (!e || !e.k || !e.n) return;
        if (takenNames.has(normaliseRhythmNameForMatch(e.n))) return;          // already in the library
        const existing = Object.entries(allRhythms).find(([, r]) => r && r.collection === LIBRARY_COLLECTION && r.libraryKey === e.k);
        if (existing) return;                                                   // merged on an earlier pass
        const expand = (text) => String(text || '').split('').map((ch) => (ch in decode ? decode[ch] : null));
        const notationData = buildDemoNotationData({
            name: e.n,
            tempo: e.t,
            steps: e.s,
            swing: e.sw,
            rows: Object.entries(e.r || {}).map(([instrumentPrefix, steps]) => ({ instrumentPrefix, steps: expand(steps) })),
            signal: e.c ? { pattern: expand(e.c) } : null
        });
        if (!notationData) return;
        const [place, country, lat, lng] = Array.isArray(e.o) ? e.o : ['West Africa', 'West Africa', 11.3, -9.8];
        const description = String(e.d || '').trim();
        const rhythm = {
            id: `library-${slugifyRhythmKey(e.k) || index}`,
            libraryKey: e.k,
            collection: LIBRARY_COLLECTION,
            lat: Number(lat),
            lng: Number(lng),
            name: e.n,
            location: place,
            fullLocation: place,
            community: '',
            country,
            description,
            culturalContext: description,
            historicalContext: description,
            colorHex: null,
            library: 'Local',
            creator: 'djembeloops library',
            tempo: Math.max(40, Math.min(240, parseInt(e.t, 10) || 100)),
            notationPath: `library:${e.k}`,
            notationData,
            songTexts: [],
            listeningExamples: [],
            tags: Array.isArray(e.tags) ? e.tags : [],
            videoUrl: '',
            cachedImageUrl: getBundledFallbackImage(`${e.k}-${index}`),
            imageCaption: ''
        };
        let key = slugifyRhythmKey(e.k);
        if (!key || usedKeys.has(key)) key = buildUniqueRhythmKey(rhythm, usedKeys);
        usedKeys.add(key);
        allRhythms[key] = rhythm;
        added += 1;
    });
    if (added) {
        try { populateAllRhythmColors(); } catch {}
        console.log(`[Library] added ${added} rhythms from the ${LIBRARY_COLLECTION} collection`);
    }
    return added;
}

async function ensureDemoRhythmsLoaded(options = {}) {
    const force = !!options.force;
    if (force) {
        resetDemoRhythmsState();
    } else if (demoRhythmKeys.size > 0) {
        return true;
    }
    if (demoRhythmLoadPromise) return demoRhythmLoadPromise;
    demoRhythmLoadPromise = (async () => {
        try {
            const resp = await fetch(DEMO_RHYTHMS_TEXT_URL, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            // Parse robustly so demo mode still works even if the server serves .txt as plain text.
            const rawText = await resp.text();
            let payload = null;
            try {
                payload = JSON.parse(rawText);
            } catch (jsonErr) {
                throw new Error(`Invalid JSON in ${DEMO_RHYTHMS_TEXT_URL}: ${jsonErr?.message || jsonErr}`);
            }

            const sourceRhythms = Array.isArray(payload?.rhythms)
                ? payload.rhythms
                : (Array.isArray(payload) ? payload : []);
            if (sourceRhythms.length === 0) throw new Error('No rhythms found in rhythms.txt');

            const usedKeys = new Set(Object.keys(allRhythms || {}));
            const demoMap = {};
            let skipped = 0;
            sourceRhythms.forEach((entry, index) => {
                const built = buildDemoRhythmEntry(entry, index, sourceRhythms.length, usedKeys);
                if (!built) {
                    skipped += 1;
                    return;
                }
                demoMap[built.key] = built.rhythm;
                demoRhythmKeys.add(built.key);
            });

            if (Object.keys(demoMap).length === 0) throw new Error('No demo rhythms could be generated');
            allRhythms = { ...(allRhythms || {}), ...demoMap };
            populateAllRhythmColors();
            syncRhythmCatalogToNotationTargets();
            const loadedCount = Object.keys(demoMap).length;
            window.__rrcDemoRhythmCount = loadedCount;
            window.__rrcDemoRhythmSourceCount = sourceRhythms.length;
            console.log(`[Demo] Loaded ${loadedCount}/${sourceRhythms.length} demo rhythms from rhythms.txt${skipped ? ` (skipped ${skipped})` : ''}`);
            return true;
        } catch (error) {
            console.warn('[Demo] Could not enable demo mode:', error?.message || error);
            demoRhythmKeys.clear();
            window.__rrcDemoRhythmCount = 0;
            return false;
        } finally {
            demoRhythmLoadPromise = null;
        }
    })();
    return demoRhythmLoadPromise;
}

const USER_COLLECTION_SOURCE_PREFIX = 'user:';

function isUserCollectionSource(source) {
    return typeof source === 'string' && source.startsWith(USER_COLLECTION_SOURCE_PREFIX);
}

function getUserCollectionIdFromSource(source) {
    if (!isUserCollectionSource(source)) return '';
    return String(source.slice(USER_COLLECTION_SOURCE_PREFIX.length) || '').trim();
}

function getUserCollectionPresetById(id) {
    const target = String(id || '').trim();
    if (!target) return null;
    return readJourneyPresets().find((entry) => entry.id === target) || null;
}

function buildUserCollectionRhythmMap(preset) {
    const out = {};
    if (!preset || !Array.isArray(preset.items)) return out;
    preset.items.forEach((key) => {
        const normalized = String(key || '').trim();
        if (normalized && allRhythms[normalized]) out[normalized] = allRhythms[normalized];
    });
    return out;
}

function getFilteredRhythms(source) {
    if (isUserCollectionSource(source)) {
        const preset = getUserCollectionPresetById(getUserCollectionIdFromSource(source));
        return buildUserCollectionRhythmMap(preset);
    }
    if (source === DEMO_SOURCE) {
        const out = {};
        demoRhythmKeys.forEach((key) => {
            if (key && allRhythms[key]) out[key] = allRhythms[key];
        });
        return out;
    }
    if (source === 'Journey') return {};
    if (source === 'all') {
        const out = {};
        Object.entries(allRhythms).forEach(([k, r]) => {
            if (r && r.library === DEMO_SOURCE) return;
            out[k] = r;
        });
        return out;
    }
    const out = {};
    for (const [k, r] of Object.entries(allRhythms)) {
        if (r.library === source) out[k] = r;
    }
    return out;
}

function readJourneyPresets() {
    try {
        const parsed = JSON.parse(localStorage.getItem(JOURNEY_STORAGE_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const id = String(entry.id || '').trim();
                if (!id) return null;
                const name = String(entry.name || 'Untitled Collection').trim() || 'Untitled Collection';
                const items = Array.isArray(entry.items)
                    ? entry.items.map((key) => String(key || '').trim()).filter((key) => key && allRhythms[key])
                    : [];
                return { id, name, items };
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function writeJourneyPresets(presets) {
    localStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(Array.isArray(presets) ? presets : []));
}

function ensureJourneyDraftIntegrity() {
    journeyDraft.items = Array.from(new Set(
        (journeyDraft.items || []).map((key) => String(key || '').trim()).filter((key) => key && allRhythms[key])
    ));
    if (typeof journeyDraft.name !== 'string') journeyDraft.name = '';
    if (journeyDraft.id !== null && typeof journeyDraft.id !== 'string') journeyDraft.id = null;
}

function getJourneyItemLabel(key) {
    const rhythm = allRhythms[key];
    if (!rhythm) return key;
    const location = rhythm.location ? ` - ${rhythm.location}` : '';
    return `${rhythm.name}${location}`;
}

function addRhythmToJourneyDraft(key, index = null) {
    if (!key || !allRhythms[key]) return;
    ensureJourneyDraftIntegrity();
    if (journeyDraft.items.includes(key)) return;
    if (Number.isInteger(index) && index >= 0 && index <= journeyDraft.items.length) {
        journeyDraft.items.splice(index, 0, key);
    } else {
        journeyDraft.items.push(key);
    }
}

function removeRhythmFromJourneyDraft(key) {
    ensureJourneyDraftIntegrity();
    journeyDraft.items = journeyDraft.items.filter((entry) => entry !== key);
}

function moveJourneyDraftItem(fromIndex, toIndex) {
    ensureJourneyDraftIntegrity();
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= journeyDraft.items.length || toIndex >= journeyDraft.items.length) return;
    if (fromIndex === toIndex) return;
    const [moved] = journeyDraft.items.splice(fromIndex, 1);
    journeyDraft.items.splice(toIndex, 0, moved);
}

function setJourneyDraftFromPreset(preset) {
    if (!preset) return;
    journeyDraft.id = preset.id || null;
    journeyDraft.name = String(preset.name || '').trim();
    journeyDraft.items = Array.isArray(preset.items)
        ? preset.items.map((key) => String(key || '').trim()).filter((key) => key && allRhythms[key])
        : [];
    ensureJourneyDraftIntegrity();
}

function attachRhythmDragSource(el, key) {
    if (!el || !key) return;
    el.setAttribute('draggable', 'true');
    el.dataset.rhythmKey = key;
    el.dataset.dragOrigin = '';
    el.addEventListener('pointerdown', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) {
            el.dataset.dragOrigin = '';
            return;
        }
        if (target.closest('.rhythm-preview-btn, .carousel-preview-btn')) {
            el.dataset.dragOrigin = '';
            return;
        }
        el.dataset.dragOrigin = target.closest('.rhythm-card-image') ? 'image' : '';
    }, true);
    el.addEventListener('dragstart', (e) => {
        const target = e.target;
        const startedFromImage = el.dataset.dragOrigin === 'image';
        if (startedFromImage || (target instanceof Element && target.closest('.rhythm-card-image'))) {
            e.preventDefault();
            delete el.dataset.wasDragging;
            return;
        }
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.setData('application/x-rrc-rhythm', key);
        el.dataset.wasDragging = '1';
    });
    el.addEventListener('dragend', () => {
        setTimeout(() => { delete el.dataset.wasDragging; }, 50);
        el.dataset.dragOrigin = '';
    });
}

function renderJourneyItems() {
    const itemsEl = document.getElementById('journey-items');
    const dropZone = document.getElementById('journey-drop-zone');
    if (!itemsEl || !dropZone) return;
    ensureJourneyDraftIntegrity();
    itemsEl.innerHTML = '';

    if (journeyDraft.items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'journey-empty';
        empty.textContent = 'No rhythms yet. Drag from the source list into this collection.';
        itemsEl.appendChild(empty);
        dropZone.textContent = 'Drag rhythms into this collection';
        return;
    }

    dropZone.textContent = `Collection contains ${journeyDraft.items.length} rhythm${journeyDraft.items.length === 1 ? '' : 's'}`;

    journeyDraft.items.forEach((key, index) => {
        const row = document.createElement('div');
        row.className = 'journey-item';
        row.dataset.index = String(index);
        row.dataset.rhythm = key;
        row.setAttribute('draggable', 'true');
        row.innerHTML = `
            <span class="journey-item-index">${index + 1}.</span>
            <span class="journey-item-label">${getJourneyItemLabel(key)}</span>
            <div class="journey-item-actions">
                <button class="journey-item-btn" type="button" data-action="go">Go</button>
                <button class="journey-item-btn" type="button" data-action="remove">Remove</button>
            </div>
        `;

        row.addEventListener('dragstart', (e) => {
            if (!e.dataTransfer) return;
            row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-rrc-journey-index', String(index));
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const fromRaw = e.dataTransfer?.getData('application/x-rrc-journey-index') || '';
            const fromIndex = parseInt(fromRaw, 10);
            if (!Number.isInteger(fromIndex)) return;
            moveJourneyDraftItem(fromIndex, index);
            renderJourneyItems();
        });
        row.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('button[data-action]');
            if (!actionBtn) return;
            const action = actionBtn.getAttribute('data-action');
            if (action === 'go') {
                startJourney(key);
            } else if (action === 'remove') {
                removeRhythmFromJourneyDraft(key);
                renderJourneyItems();
            }
        });
        itemsEl.appendChild(row);
    });
}

function renderJourneyLibrary() {
    const libraryEl = document.getElementById('journey-library');
    if (!libraryEl) return;
    const presets = readJourneyPresets();
    libraryEl.innerHTML = '';
    if (presets.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'journey-empty';
        empty.textContent = 'No saved collections yet.';
        libraryEl.appendChild(empty);
        return;
    }

    presets.forEach((preset) => {
        const row = document.createElement('div');
        row.className = 'journey-library-item';
        row.innerHTML = `
            <span class="journey-library-name">${preset.name} (${preset.items.length})</span>
            <button class="journey-item-btn" type="button" data-action="load">Load</button>
            <button class="journey-item-btn" type="button" data-action="delete">Delete</button>
        `;
        row.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('button[data-action]');
            if (!actionBtn) return;
            const action = actionBtn.getAttribute('data-action');
            if (action === 'load') {
                setJourneyDraftFromPreset(preset);
                const nameInput = document.getElementById('journey-name-input');
                if (nameInput) nameInput.value = journeyDraft.name || '';
                renderJourneyItems();
                return;
            }
            if (action === 'delete') {
                const next = readJourneyPresets().filter((entry) => entry.id !== preset.id);
                writeJourneyPresets(next);
                if (journeyDraft.id === preset.id) {
                    journeyDraft = { id: null, name: '', items: [] };
                    const nameInput = document.getElementById('journey-name-input');
                    if (nameInput) nameInput.value = '';
                    renderJourneyItems();
                }
                renderJourneyLibrary();
                if (typeof window._refreshRhythmSourceAfterCollectionsChanged === 'function') {
                    window._refreshRhythmSourceAfterCollectionsChanged();
                }
            }
        });
        libraryEl.appendChild(row);
    });
}

function renderJourneySourceList() {
    const sourceListEl = document.getElementById('journey-source-list');
    if (!sourceListEl) return;
    const entries = Object.entries(allRhythms).sort((a, b) => a[1].name.localeCompare(b[1].name));
    sourceListEl.innerHTML = '';
    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'journey-empty';
        empty.textContent = 'No rhythms in this source.';
        sourceListEl.appendChild(empty);
        return;
    }
    entries.forEach(([key, rhythm]) => {
        const row = document.createElement('div');
        row.className = 'journey-source-item';
        row.dataset.floatingInteractive = 'true';
        row.innerHTML = `
            <span class="journey-source-name">${rhythm.name}</span>
            <span class="journey-source-kind">${rhythm.library || 'Local'}</span>
            <button class="journey-item-btn" type="button" data-action="add">+</button>
        `;
        attachRhythmDragSource(row, key);
        row.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('button[data-action="add"]');
            if (!actionBtn) return;
            addRhythmToJourneyDraft(key);
            renderJourneyItems();
        });
        sourceListEl.appendChild(row);
    });
}

function setupJourneyBuilder() {
    const viewEl = document.getElementById('rhythm-journey-view');
    const nameInput = document.getElementById('journey-name-input');
    const saveBtn = document.getElementById('journey-save-btn');
    const newBtn = document.getElementById('journey-new-btn');
    const clearBtn = document.getElementById('journey-clear-btn');
    const exportBtn = document.getElementById('journey-export-btn');
    const importBtn = document.getElementById('journey-import-btn');
    const importFile = document.getElementById('journey-import-file');
    const dropZone = document.getElementById('journey-drop-zone');
    const itemsEl = document.getElementById('journey-items');
    if (!viewEl || !nameInput || !saveBtn || !newBtn || !clearBtn || !exportBtn || !importBtn || !importFile || !dropZone || !itemsEl) return;
    if (viewEl.dataset.ready === '1') return;
    viewEl.dataset.ready = '1';
    nameInput.addEventListener('input', () => {
        journeyDraft.name = String(nameInput.value || '').trim();
    });

    saveBtn.addEventListener('click', () => {
        ensureJourneyDraftIntegrity();
        if (journeyDraft.items.length === 0) return;
        const presets = readJourneyPresets();
        const name = String(nameInput.value || '').trim() || `Collection ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
        journeyDraft.name = name;
        if (!journeyDraft.id) {
            journeyDraft.id = 'jrny_' + Date.now().toString(36);
        }
        const next = presets.filter((preset) => preset.id !== journeyDraft.id);
        next.unshift({
            id: journeyDraft.id,
            name: journeyDraft.name,
            items: journeyDraft.items.slice()
        });
        writeJourneyPresets(next);
        renderJourneyLibrary();
        if (typeof window._refreshRhythmSourceAfterCollectionsChanged === 'function') {
            window._refreshRhythmSourceAfterCollectionsChanged();
        }
    });

    newBtn.addEventListener('click', () => {
        journeyPlaybackAbort = true;
        journeyDraft = { id: null, name: '', items: [] };
        nameInput.value = '';
        renderJourneyItems();
    });

    clearBtn.addEventListener('click', () => {
        journeyDraft.items = [];
        renderJourneyItems();
    });

    exportBtn.addEventListener('click', () => {
        const payload = {
            exportedAt: new Date().toISOString(),
            version: JOURNEY_EXPORT_VERSION,
            collections: readJourneyPresets()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'rrc-collections.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
        importFile.value = '';
        importFile.click();
    });

    importFile.addEventListener('change', async () => {
        const file = importFile.files && importFile.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const list = Array.isArray(parsed?.collections)
                ? parsed.collections
                : (Array.isArray(parsed?.journeys)
                    ? parsed.journeys
                    : (Array.isArray(parsed) ? parsed : []));
            const current = readJourneyPresets();
            const merged = [...current];
            list.forEach((entry) => {
                const name = String(entry?.name || '').trim();
                const items = Array.isArray(entry?.items)
                    ? entry.items.map((key) => String(key || '').trim()).filter((key) => key && allRhythms[key])
                    : [];
                if (!name || items.length === 0) return;
                merged.unshift({
                    id: 'jrny_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
                    name,
                    items
                });
            });
            writeJourneyPresets(merged);
            renderJourneyLibrary();
            if (typeof window._refreshRhythmSourceAfterCollectionsChanged === 'function') {
                window._refreshRhythmSourceAfterCollectionsChanged();
            }
        } catch (err) {
            console.warn('Collection import failed:', err);
        }
    });

    const onDragOver = (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = () => dropZone.classList.remove('drag-over');
    const onDrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const fromIndexRaw = e.dataTransfer?.getData('application/x-rrc-journey-index') || '';
        const fromIndex = parseInt(fromIndexRaw, 10);
        if (Number.isInteger(fromIndex)) {
            moveJourneyDraftItem(fromIndex, Math.max(0, journeyDraft.items.length - 1));
            renderJourneyItems();
            return;
        }
        const key = e.dataTransfer?.getData('application/x-rrc-rhythm') || e.dataTransfer?.getData('text/plain') || '';
        if (!key || !allRhythms[key]) return;
        addRhythmToJourneyDraft(key);
        renderJourneyItems();
    };
    dropZone.addEventListener('dragover', onDragOver);
    dropZone.addEventListener('dragleave', onDragLeave);
    dropZone.addEventListener('drop', onDrop);
    itemsEl.addEventListener('dragover', onDragOver);
    itemsEl.addEventListener('dragleave', onDragLeave);
    itemsEl.addEventListener('drop', onDrop);

    const presets = readJourneyPresets();
    if (presets.length > 0) {
        setJourneyDraftFromPreset(presets[0]);
        nameInput.value = journeyDraft.name;
    }
    renderJourneySourceList();
    renderJourneyItems();
    renderJourneyLibrary();
}

function setRhythmBrowserTab(tab) {
    const nextTab = tab === 'journeys' ? 'journeys' : 'browse';
    rhythmPanelTab = nextTab;
    localStorage.setItem('rhythmPanelTab', rhythmPanelTab);
    const panel = document.getElementById('rhythm-panel');
    const browseBtn = document.getElementById('rhythm-tab-browse');
    const journeysBtn = document.getElementById('rhythm-tab-journeys');
    const browseView = document.getElementById('rhythm-browse-view');
    const journeyView = document.getElementById('rhythm-journey-view');
    if (!panel || !browseBtn || !journeysBtn || !browseView || !journeyView) return;
    const isJourney = nextTab === 'journeys';
    panel.classList.toggle('journey-tab', isJourney);
    browseBtn.classList.toggle('active', !isJourney);
    journeysBtn.classList.toggle('active', isJourney);
    browseView.classList.toggle('hidden', isJourney);
    journeyView.classList.toggle('hidden', !isJourney);
    if (isJourney) {
        renderJourneySourceList();
        renderJourneyItems();
    }
}

// Video nav state
let currentVideoList = [];
let currentVideoIndex = 0;

// Unified media gallery: [{type:'photo'|'video', url, caption, embedUrl}]
let currentMediaItems = [];
let currentMediaIndex = 0;

// Song text state
let currentSongTexts = [];

// Plane model
let planeEntity = null;
let planeScale = parseFloat(localStorage.getItem('planeScale')) || 500;
let showPlane = localStorage.getItem('showPlane') !== 'false';
let planeHeading = parseFloat(localStorage.getItem('planeHeading')) || 0; // degrees
let planePitch = parseFloat(localStorage.getItem('planePitch')) || 0;
let planeRoll = parseFloat(localStorage.getItem('planeRoll')) || 0;
const PLANE_MODEL_URL = 'https://docs.mapbox.com/mapbox-gl-js/assets/airplane.glb';

// Extended typography controls — normal mode
let bannerTitleSize = parseFloat(localStorage.getItem('bannerTitleSize')) || 14;
let bannerDescSize = parseFloat(localStorage.getItem('bannerDescSize')) || 10;
let contextTitleSize = parseFloat(localStorage.getItem('contextTitleSize')) || 12;
let contextBodySize = parseFloat(localStorage.getItem('contextBodySize')) || 10;
let cardNameSize = parseFloat(localStorage.getItem('cardNameSize')) || 10;
let cardOverlayBlur = parseFloat(localStorage.getItem('cardOverlayBlur')) || 10;
let createTextSize = parseFloat(localStorage.getItem('createTextSize')) || 12;
let carouselCardNameSize = parseFloat(localStorage.getItem('carouselCardNameSize')) || 9;
let cardLocationSize = parseFloat(localStorage.getItem('cardLocationSize')) || 8;
let cardCommunitySize = parseFloat(localStorage.getItem('cardCommunitySize')) || 8;
let cardCreatorSize = parseFloat(localStorage.getItem('cardCreatorSize')) || 8;
let stageInstrumentScale = parseFloat(localStorage.getItem('stageInstrumentScale'));
stageInstrumentScale = Number.isFinite(stageInstrumentScale) ? Math.max(0.6, Math.min(12, stageInstrumentScale)) : 1.0;
let stageLabelScale = parseFloat(localStorage.getItem('stageLabelScale'));
stageLabelScale = Number.isFinite(stageLabelScale) ? Math.max(0.6, Math.min(2.2, stageLabelScale)) : 1.0;
let stageUiTextScale = parseFloat(localStorage.getItem('stageUiTextScale'));
stageUiTextScale = Number.isFinite(stageUiTextScale) ? Math.max(0.7, Math.min(3.2, stageUiTextScale)) : 1.0;
function clampStageBoundsOffsetPx(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(-80, Math.min(80, num));
}
let stageBoundsOffsetXPx = clampStageBoundsOffsetPx(parseFloat(localStorage.getItem('stageBoundsOffsetXPx')));
let stageBoundsOffsetYPx = clampStageBoundsOffsetPx(parseFloat(localStorage.getItem('stageBoundsOffsetYPx')));
function clampStageMinVelocity(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0.1;
    return Math.max(0.05, Math.min(0.95, num));
}
let stageMinVelocity = clampStageMinVelocity(parseFloat(localStorage.getItem('stageMinVelocity')));
function clampStageMaxVelocity(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.max(0.2, Math.min(1, num));
}
let stageMaxVelocity = clampStageMaxVelocity(parseFloat(localStorage.getItem('stageMaxVelocity')));
function clampStageMinVelocityRange(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0.1;
    return Math.max(0.05, Math.min(0.8, num));
}
let stageMinVelocityRange = clampStageMinVelocityRange(parseFloat(localStorage.getItem('stageMinVelocityRange')));
const STAGE_PANEL_MIN_WIDTH = 300;
function enforceStageVelocityRange() {
    stageMinVelocity = clampStageMinVelocity(stageMinVelocity);
    stageMaxVelocity = clampStageMaxVelocity(stageMaxVelocity);
    stageMinVelocityRange = clampStageMinVelocityRange(stageMinVelocityRange);
    const requiredMax = Math.min(1, stageMinVelocity + stageMinVelocityRange);
    if (stageMaxVelocity < requiredMax) stageMaxVelocity = requiredMax;
    if (stageMaxVelocity > 1) {
        stageMaxVelocity = 1;
        stageMinVelocity = Math.max(0.05, stageMaxVelocity - stageMinVelocityRange);
    }
}
enforceStageVelocityRange();
if (!Number.isFinite(parseFloat(localStorage.getItem('stageMinVelocityPreset')))) {
    localStorage.setItem('stageMinVelocityPreset', String(stageMinVelocity));
}
if (!Number.isFinite(parseFloat(localStorage.getItem('stageMaxVelocityPreset')))) {
    localStorage.setItem('stageMaxVelocityPreset', String(stageMaxVelocity));
}
let stageLiveUpdateThresholdPx = parseFloat(localStorage.getItem('stageLiveUpdateThresholdPx'));
stageLiveUpdateThresholdPx = Number.isFinite(stageLiveUpdateThresholdPx) ? Math.max(0, Math.min(40, stageLiveUpdateThresholdPx)) : 4;
let domeLabelSize = parseFloat(localStorage.getItem('domeLabelSize')) || 14;
let navLabelSize = parseFloat(localStorage.getItem('navLabelSize')) || 9;

function applyStageMinPanelWidth(options = {}) {
    const panel = document.getElementById('stage-panel');
    if (!panel) return;
    const minW = STAGE_PANEL_MIN_WIDTH;
    panel.dataset.windowMinW = String(minW);
    panel.style.minWidth = `${minW}px`;
    const currentWidth = panel.offsetWidth || parseFloat(panel.style.width) || 0;
    if (currentWidth > 0 && currentWidth < minW) {
        panel.style.width = `${minW}px`;
    }
    if (options.clampPosition) {
        const left = parseFloat(panel.style.left);
        if (Number.isFinite(left)) {
            const maxLeft = Math.max(8, window.innerWidth - minW - 8);
            panel.style.left = `${Math.max(8, Math.min(maxLeft, left))}px`;
        }
    }
    if (typeof window._refreshFloatingWindowScales === 'function') {
        window._refreshFloatingWindowScales();
    }
}

// Extended typography controls — focus mode (separate values)
let focusBannerTitleSize = parseFloat(localStorage.getItem('focusBannerTitleSize')) || 22;
let focusBannerDescSize = parseFloat(localStorage.getItem('focusBannerDescSize')) || 14;
let focusContextTitleSize = parseFloat(localStorage.getItem('focusContextTitleSize')) || 16;
let focusContextBodySize = parseFloat(localStorage.getItem('focusContextBodySize')) || 14;

// Debug panel scale
let debugScale = parseFloat(localStorage.getItem('debugScale')) || 1;

// Color mode
let useRainbowColors = localStorage.getItem('useRainbowColors') !== 'false'; // default true = rainbow

// Notation state
let notationVisible = false;
let notationPlaybackActive = false;
const SESSION_STORAGE_KEY = 'rrcSessionPanelStateV2';
const SESSION_CHANNEL_PREFIX = 'rrc-session-';
const SESSION_DIRECTORY_CHANNEL = 'rrc-session-directory-v1';
const SESSION_DIRECTORY_HEARTBEAT_MS = 3000;
const SESSION_DIRECTORY_TTL_MS = 12000;
const SESSION_START_DELAY_MS = 3000;
const SESSION_LOOKAHEAD_REMOTE_MS = 250;
const SESSION_LOOKAHEAD_LOCAL_MS = 200;
const SESSION_PROOF_SYNC_MIN_INTERVAL_MS = 35;
const SESSION_PROOF_SYNC_MAX_INTERVAL_MS = 600;
const SESSION_PROOF_SYNC_DEFAULT_INTERVAL_MS = 95;
const SESSION_SYNC_REMOTE_INTERVAL_MS = 5000;
const SESSION_SYNC_LOCAL_STEADY_MS = 2000;
const SESSION_SYNC_LOCAL_WARMUP_MS = 1000;
const SESSION_LOCAL_WARMUP_DURATION_MS = 15000;
const SESSION_LOCAL_BOOST_DURATION_MS = 8000;
const SESSION_DRIFT_IGNORE_MS_REMOTE = 60;
const SESSION_DRIFT_SOFT_MS_REMOTE = 120;
const SESSION_DRIFT_IGNORE_MS_LOCAL = 15;
const SESSION_DRIFT_SOFT_MS_LOCAL = 40;
const SESSION_DRIFT_HARD_MS_LOCAL = 120;
const SESSION_PING_INTERVAL_REMOTE_MS = 4500;
const SESSION_PING_INTERVAL_LOCAL_MS = 2200;
const SESSION_PING_TIMEOUT_MS = 6500;
const SESSION_MAX_PENDING_PINGS = 6;
const SESSION_MEMBER_FALLBACK_ICONS = [
    'instrumentIcons/DjembeOne.png',
    'instrumentIcons/DjembeTwo.png',
    'instrumentIcons/DjembeThree.png',
    'instrumentIcons/Kenkeni.png',
    'instrumentIcons/Sangban.png',
    'instrumentIcons/Doundoun.png',
    'instrumentIcons/Shekere.png',
    'instrumentIcons/Call.png'
];
const SESSION_AVATAR_SIGNED_URL_TTL = 60 * 60;
const sessionAvatarUrlCache = new Map();
let sessionAutoReconnectKey = '';
function getOrCreateSessionClientId() {
    const key = 'rrcSessionClientId';
    try {
        const existing = String(sessionStorage.getItem(key) || '').trim();
        if (existing) return existing;
        const next = `c_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
        sessionStorage.setItem(key, next);
        return next;
    } catch {
        return `c_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
    }
}
const sessionClientId = getOrCreateSessionClientId();
let sessionState = {
    active: false,
    sessionId: '',
    sessionVersion: 1,
    role: '',
    leaderUserId: '',
    leaderName: '',
    userId: '',
    userName: '',
    userAvatarPath: '',
    userAvatarUrl: '',
    clientId: sessionClientId,
    channel: null,
    lobbyChannel: null,
    supabaseClient: null,
    tempo: 100,
    syncMode: 'remote',
    freeMode: false,
    rhythmKey: '',
    transportState: 'stopped',
    transportBaseLeaderTime: 0,
    transportBaseBeat: 0,
    transportTimeSigNum: 4,
    transportTimeSigDen: 4,
    sessionMode: 'remote',
    leaderClockOffsetMs: 0,
    leaderClockRttMs: 0,
    leaderClockLastUpdatedAt: 0,
    pendingPingMap: {},
    pingIntervalTimer: 0,
    syncCheckTimer: 0,
    syncCheckTimerIntervalMs: 0,
    syncIntervalMs: SESSION_PROOF_SYNC_DEFAULT_INTERVAL_MS,
    syncWarmupUntil: 0,
    syncBoostUntil: 0,
    lastSyncCorrectionAt: 0,
    lastSyncCheckAt: 0,
    lastSyncCheckBeat: 0,
    lastSyncCheckLeaderTime: 0,
    suppressTransportReplayUntil: 0,
    pendingStartAt: 0,
    pendingStartAction: 'play',
    pendingStartLeaderTime: 0,
    allowPlaybackUntil: 0,
    suppressLeaderInterceptUntil: 0,
    pendingStartTimer: 0,
    countdownTimer: 0,
    callOutTimer: 0,
    lastSnapshotKey: '',
    lastTickBroadcastAt: 0,
    lastTickBroadcastStep: null,
    lastTickBroadcastEpoch: 0,
    directoryHeartbeatTimer: 0,
    directoryPruneTimer: 0,
    publicSessions: {},
    members: []
};

// Background audio state (hidden iframe playing video audio)
let bgAudioIframe = null;
let bgAudioActive = false;
let bgAudioFading = false;
let useFirstVideoAsAudio = localStorage.getItem('useFirstVideoAsAudio') !== 'false'; // debug toggle

let currentRhythmSource = 'all';
let viewer;
let userLocation = { lat: 40.7128, lng: -74.0060 };
let currentLocation = { lat: 40.7128, lng: -74.0060 }; // Track current position for point-to-point
let isJourneyActive = false;
let journeyRunToken = 0;
let domeEntities = [];
const domeAnimationIntervals = new Map();
let pathEntity = null;
let selectedRhythm = null; // Track selected rhythm for label sizing
let selectedAnimationInterval = null;
const LAST_SELECTED_RHYTHM_STORAGE_KEY = 'rrcLastSelectedRhythmKey';
let lastRemoteRhythmCatalogRefreshAt = 0;
let lastPadRhythmSwitchKey = '';
let lastPadRhythmSwitchAt = 0;

function clearDomeAnimationIntervals() {
    domeAnimationIntervals.forEach((timerId) => {
        try { clearInterval(timerId); } catch {}
    });
    domeAnimationIntervals.clear();
    if (selectedAnimationInterval) {
        try { clearInterval(selectedAnimationInterval); } catch {}
        selectedAnimationInterval = null;
    }
}

function getDomeRenderProfile(domeCount) {
    const count = Math.max(0, Number(domeCount) || 0);
    if (count >= 220) return { slicePartitions: 8, stackPartitions: 8, animateIdle: false, showLabels: false };
    if (count >= 120) return { slicePartitions: 10, stackPartitions: 10, animateIdle: false, showLabels: false };
    if (count >= 60) return { slicePartitions: 12, stackPartitions: 12, animateIdle: false, showLabels: true };
    if (count >= 24) return { slicePartitions: 16, stackPartitions: 16, animateIdle: true, showLabels: true };
    return { slicePartitions: 24, stackPartitions: 24, animateIdle: true, showLabels: true };
}

function seedLatestNotationRhythmDataFromKey(key) {
    const rhythmKey = String(key || '').trim();
    const rhythm = rhythmKey ? allRhythms[rhythmKey] : null;
    const notation = rhythm && rhythm.notationData && Array.isArray(rhythm.notationData.instruments)
        ? rhythm.notationData
        : null;
    if (!notation) return false;
    latestNotationRhythmData = ensureCallInstrumentInRhythmData({
        rhythmName: String(rhythm?.name || rhythmKey).trim(),
        beats: Math.max(1, parseInt(notation.beats, 10) || 4),
        subdivisions: Math.max(1, parseInt(notation.subdivisions, 10) || 4),
        instruments: notation.instruments
    });
    return true;
}

function ensureCallInstrumentInRhythmData(data) {
    if (!data || typeof data !== 'object') return data;
    const beats = Math.max(1, parseInt(data.beats, 10) || 4);
    const subdivisions = Math.max(1, parseInt(data.subdivisions, 10) || 4);
    const incoming = Array.isArray(data.instruments) ? data.instruments : [];
    const instruments = incoming.map((instrument) => ({ ...instrument }));
    const hasCall = instruments.some((instrument) => {
        const id = String(instrument?.id || '').toLowerCase();
        const isCall = !!instrument?.isCall;
        return isCall || id.startsWith('call');
    });
    if (!hasCall) {
        instruments.unshift({
            id: 'call1',
            name: 'Call',
            type: 'djembe_solo',
            sampleSet: 'Solo',
            pattern: new Array(beats * subdivisions).fill(null),
            visible: false,
            muted: false,
            volume: 1,
            pan: 0,
            focused: false,
            soloed: false,
            isCall: true
        });
    }
    return {
        ...data,
        beats,
        subdivisions,
        instruments
    };
}

function ensureSelectedRhythmBootstrap() {
    const keys = Object.keys(allRhythms || {});
    if (keys.length === 0) return '';
    const storedKey = String(localStorage.getItem(LAST_SELECTED_RHYTHM_STORAGE_KEY) || '').trim();
    const currentKey = String(selectedRhythm || '').trim();
    let resolved = '';
    if (currentKey && allRhythms[currentKey]) {
        resolved = currentKey;
    } else if (storedKey && allRhythms[storedKey]) {
        resolved = storedKey;
    } else {
        resolved = keys[0];
    }
    selectedRhythm = resolved;
    localStorage.setItem(LAST_SELECTED_RHYTHM_STORAGE_KEY, resolved);
    seedLatestNotationRhythmDataFromKey(resolved);
    return resolved;
}

function getPreferredCreatorFromUser(user) {
    if (!user) return '';
    const metadata = user.user_metadata || {};
    const username = String(metadata.username || '').trim();
    if (username) return username;
    const fullName = String(metadata.full_name || metadata.name || '').trim();
    if (fullName) return fullName;
    const email = String(user.email || '').trim();
    if (!email) return '';
    return String(email.split('@')[0] || '').trim();
}

async function getCurrentPreferredCreatorName() {
    let client = window.__rrcSupabaseAuthClient || null;
    if (!client) {
        const hasSupabase = typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function';
        const hasUrl = typeof SUPABASE_URL !== 'undefined' && !!SUPABASE_URL;
        const hasKey = typeof SUPABASE_ANON_KEY !== 'undefined' && !!SUPABASE_ANON_KEY;
        if (hasSupabase && hasUrl && hasKey) {
            try {
                window.__rrcSupabaseAuthClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
                });
                client = window.__rrcSupabaseAuthClient;
            } catch {}
        }
    }
    if (!client || !client.auth || typeof client.auth.getSession !== 'function') return '';
    try {
        const { data } = await client.auth.getSession();
        return getPreferredCreatorFromUser(data?.session?.user || null);
    } catch {
        return '';
    }
}

function ensureInAppUi() {
    if (window.__rrcUi) return window.__rrcUi;

    const root = document.createElement('div');
    root.className = 'rrc-notice-root';
    const stack = document.createElement('div');
    stack.className = 'rrc-notice-stack';
    root.appendChild(stack);
    document.body.appendChild(root);

    const showToast = (message, tone = 'info', timeoutMs = 2600) => {
        const text = String(message || '').trim();
        if (!text) return;
        const toast = document.createElement('div');
        toast.className = `rrc-notice-toast ${tone}`.trim();
        toast.textContent = text;
        stack.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, Math.max(900, timeoutMs));
    };

    const openDialog = ({ mode = 'alert', title = 'Message', message = '', defaultValue = '' } = {}) => {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'rrc-dialog-overlay';

            const card = document.createElement('div');
            card.className = 'rrc-dialog-card';
            overlay.appendChild(card);

            const titleEl = document.createElement('h4');
            titleEl.className = 'rrc-dialog-title';
            titleEl.textContent = title;
            card.appendChild(titleEl);

            const messageEl = document.createElement('div');
            messageEl.className = 'rrc-dialog-message';
            messageEl.textContent = String(message || '');
            card.appendChild(messageEl);

            let inputEl = null;
            if (mode === 'prompt') {
                inputEl = document.createElement('input');
                inputEl.className = 'rrc-dialog-input';
                inputEl.type = 'text';
                inputEl.value = String(defaultValue || '');
                card.appendChild(inputEl);
            }

            const actions = document.createElement('div');
            actions.className = 'rrc-dialog-actions';
            card.appendChild(actions);

            const close = (value) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(value);
            };

            if (mode === 'confirm' || mode === 'prompt') {
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'debug-action-btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', () => close(mode === 'confirm' ? false : ''));
                actions.appendChild(cancelBtn);
            }

            const okBtn = document.createElement('button');
            okBtn.className = 'debug-action-btn';
            okBtn.textContent = mode === 'confirm' ? 'OK' : (mode === 'prompt' ? 'Submit' : 'OK');
            okBtn.addEventListener('click', () => {
                if (mode === 'confirm') return close(true);
                if (mode === 'prompt') return close(String(inputEl?.value || '').trim());
                close(true);
            });
            actions.appendChild(okBtn);

            overlay.addEventListener('click', (e) => {
                if (e.target !== overlay) return;
                if (mode === 'confirm') close(false);
                else if (mode === 'prompt') close('');
                else close(true);
            });

            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    if (mode === 'confirm') close(false);
                    else if (mode === 'prompt') close('');
                    else close(true);
                } else if (e.key === 'Enter') {
                    if (mode === 'confirm') close(true);
                    else if (mode === 'prompt') close(String(inputEl?.value || '').trim());
                    else close(true);
                }
            });

            document.body.appendChild(overlay);
            if (inputEl) inputEl.focus();
            else okBtn.focus();
        });
    };

    window.__rrcUi = {
        toast: showToast,
        alert: (message, title = 'Message') => openDialog({ mode: 'alert', title, message }),
        confirm: (message, title = 'Confirm') => openDialog({ mode: 'confirm', title, message }),
        prompt: (message, defaultValue = '', title = 'Input') => openDialog({ mode: 'prompt', title, message, defaultValue })
    };
    return window.__rrcUi;
}

function setupAutocompletePolicy() {
    const signInEmailId = 'auth-signin-email';
    const signInPasswordId = 'auth-signin-password';

    const allowlist = new Set([signInEmailId, signInPasswordId]);
    const fields = document.querySelectorAll('input, textarea, select');
    fields.forEach((field) => {
        if (!(field instanceof HTMLElement)) return;
        const id = String(field.id || '').trim();
        if (allowlist.has(id)) return;

        if (field instanceof HTMLInputElement) {
            if (field.type === 'password') {
                field.setAttribute('autocomplete', 'new-password');
            } else {
                field.setAttribute('autocomplete', 'off');
            }
        } else {
            field.setAttribute('autocomplete', 'off');
        }
    });

    const signInEmail = document.getElementById(signInEmailId);
    if (signInEmail) signInEmail.setAttribute('autocomplete', 'email');

    const signInPassword = document.getElementById(signInPasswordId);
    if (signInPassword) signInPassword.setAttribute('autocomplete', 'current-password');
}

const HINT_MESSAGES_STORAGE_KEY = 'rrcHintMessagesV1';
const DEFAULT_HINT_MESSAGES = Object.freeze({
    'views-panel': 'Save your favorite window layout, load it later, or export it as JSON.',
    'rhythm-create-panel': 'Build a new rhythm step by step: name, location, context, notation, media, then save to Local or Community.',
    'auth-panel': 'Sign in, set your profile, and save a personal view you can restore anytime.',
    'session-panel': 'Start a room or join one with a Session ID. The leader controls shared rhythm playback.',
    'serve-panel': 'Copy the local server command, run it in terminal, then open the shown URL on this device or your network.',
    'stage-panel': 'Place instruments on stage. Left/right changes pan, front/back changes loudness.',
    'rhythm-panel': 'Pick a rhythm to begin the journey, or switch sources to browse more.',
    'info-banner': 'Shows the current rhythm title and where it comes from.',
    'history-box': 'Read cultural background and learning notes for the selected rhythm.',
    'image-window': 'View images, videos, and lyrics connected to the selected rhythm.',
    'notation-overlay': 'Main rhythm player and editor. Use this for transport, instruments, and notation controls.',
    'notation-circular-overlay': 'Circular rhythm view synced to the same playback as the main notation window.',
    'trigger-pad': 'Choose a rhythm and instrument, then tap to play. Great for practice and teaching.',
    'debug-controls': 'Customize app behavior, visuals, and performance settings in one place.',
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
const HINT_MESSAGE_FIELDS = Object.freeze([
    { key: 'views-panel', label: 'Views Help' },
    { key: 'rhythm-create-panel', label: 'Create Help' },
    { key: 'auth-panel', label: 'User Help' },
    { key: 'session-panel', label: 'Session Help' },
    { key: 'serve-panel', label: 'Serve Help' },
    { key: 'stage-panel', label: 'Stage Help' },
    { key: 'rhythm-panel', label: 'Rhythms Help' },
    { key: 'info-banner', label: 'Title Help' },
    { key: 'history-box', label: 'Context Help' },
    { key: 'image-window', label: 'Media Help' },
    { key: 'notation-overlay', label: 'Notation Help' },
    { key: 'notation-circular-overlay', label: 'Circular Help' },
    { key: 'trigger-pad', label: 'Pads Help' },
    { key: 'debug-controls', label: 'Settings Help' },
    { key: 'notation-cycle-help', label: 'Notation Grid Input Help' },
    { key: 'notation-grid-help', label: 'Notation Grid Size Help' }
]);
const PANEL_HINT_KEY_MAP = Object.freeze({
    'views-panel': 'views-panel',
    'rhythm-create-panel': 'rhythm-create-panel',
    'auth-panel': 'auth-panel',
    'session-panel': 'session-panel',
    'serve-panel': 'serve-panel',
    'stage-panel': 'stage-panel',
    'rhythm-panel': 'rhythm-panel',
    'info-banner': 'info-banner',
    'history-box': 'history-box',
    'image-window': 'image-window',
    'notation-overlay': 'notation-overlay',
    'notation-circular-overlay': 'notation-circular-overlay',
    'trigger-pad-1': 'trigger-pad',
    'trigger-pad-2': 'trigger-pad',
    'trigger-pad-3': 'trigger-pad',
    'trigger-pad-4': 'trigger-pad',
    'trigger-pad-5': 'trigger-pad',
    'trigger-pad-6': 'trigger-pad',
    'debug-controls': 'debug-controls'
});

function normalizeHintMessages(candidate) {
    const next = { ...DEFAULT_HINT_MESSAGES };
    if (!candidate || typeof candidate !== 'object') return next;
    Object.keys(DEFAULT_HINT_MESSAGES).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) return;
        const raw = String(candidate[key] || '');
        next[key] = raw.trim().length > 0 ? raw : DEFAULT_HINT_MESSAGES[key];
    });
    return next;
}

function loadHintMessagesFromStorage() {
    try {
        const raw = localStorage.getItem(HINT_MESSAGES_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_HINT_MESSAGES };
        return normalizeHintMessages(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_HINT_MESSAGES };
    }
}

let hintMessages = loadHintMessagesFromStorage();

function persistHintMessages() {
    try {
        localStorage.setItem(HINT_MESSAGES_STORAGE_KEY, JSON.stringify(hintMessages));
    } catch {}
    window._rrcHintMessages = { ...hintMessages };
}

function setHintMessages(nextMessages, options = {}) {
    hintMessages = normalizeHintMessages(nextMessages);
    if (options.persist !== false) persistHintMessages();
}

function getHintMessage(key, fallback = '') {
    const text = hintMessages && typeof hintMessages === 'object' ? hintMessages[key] : '';
    if (typeof text === 'string' && text.trim().length > 0) return text;
    const defaultText = DEFAULT_HINT_MESSAGES[key];
    if (typeof defaultText === 'string' && defaultText.trim().length > 0) return defaultText;
    return String(fallback || '');
}

function renderHintTextSettingsEditor() {
    const container = document.getElementById('hintTextSettings');
    if (!container) return;
    container.innerHTML = '';
    HINT_MESSAGE_FIELDS.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'control-row hint-text-row';
        row.setAttribute('data-hint-key', entry.key);

        const label = document.createElement('label');
        label.setAttribute('for', `hintText-${entry.key}`);
        label.textContent = entry.label;
        row.appendChild(label);

        const input = document.createElement('textarea');
        input.id = `hintText-${entry.key}`;
        input.className = 'ctrl-input hint-text-input';
        input.rows = 3;
        input.value = getHintMessage(entry.key);
        input.addEventListener('input', () => {
            const next = { ...hintMessages, [entry.key]: String(input.value || '') };
            setHintMessages(next, { persist: true });
        });
        row.appendChild(input);
        container.appendChild(row);
    });
}

persistHintMessages();

function setupPanelTooltips() {
    if (window._rrcTooltipReady) return;
    window._rrcTooltipReady = true;

    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'rrc-typed-tooltip';
    document.body.appendChild(tooltipEl);
    let typerTimer = 0;
    let hoverTimer = 0;
    let activeAnchor = null;
    let activeMessage = '';
    const isTouchLike = () => {
        try {
            return window.matchMedia('(hover: none), (pointer: coarse)').matches || ('ontouchstart' in window);
        } catch {
            return true;
        }
    };
    window._rrcTooltipTypeSpeed = tooltipTypeSpeed;
    window._rrcTooltipHoverDelayMs = tooltipHoverDelayMs;
    window._rrcTooltipWindowScale = tooltipWindowScale;
    window._rrcTooltipTextScale = tooltipTextScale;
    window._rrcTooltipHideOnUnhover = tooltipHideOnUnhover;

    const stopTyping = () => {
        if (typerTimer) {
            clearInterval(typerTimer);
            typerTimer = 0;
        }
    };

    const stopHoverTimer = () => {
        if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = 0;
        }
    };

    const showTooltip = (anchor, text) => {
        stopHoverTimer();
        stopTyping();
        const message = String(text || '').trim();
        if (!anchor || !message) return;
        activeAnchor = anchor;
        activeMessage = message;
        const rect = anchor.getBoundingClientRect();
        const panel = anchor.closest('.app-panel');
        const panelScaleRaw = panel ? parseFloat(getComputedStyle(panel).getPropertyValue('--window-scale')) : 1;
        const panelScale = Number.isFinite(panelScaleRaw) ? panelScaleRaw : 1;
        const popupScale = Math.max(0.6, Math.min(2.6, (parseFloat(window._rrcTooltipWindowScale) || 1.15) * Math.max(0.65, panelScale)));
        const textScale = Math.max(0.6, Math.min(2.6, parseFloat(window._rrcTooltipTextScale) || 1.15));
        tooltipEl.style.setProperty('--tooltip-window-scale', popupScale.toFixed(3));
        tooltipEl.style.setProperty('--tooltip-text-scale', textScale.toFixed(3));
        tooltipEl.style.display = 'block';
        tooltipEl.textContent = '';
        const maxWidth = Math.min(560, Math.max(180, Math.round(360 * popupScale), window.innerWidth - 24));
        const left = Math.max(8, Math.min(window.innerWidth - maxWidth - 8, rect.left - 6));
        const preferredTop = rect.top - 12;
        const belowTop = rect.bottom + 8;
        const measuredHeight = Math.max(46, tooltipEl.getBoundingClientRect().height || 0);
        const useAbove = preferredTop - measuredHeight > 8;
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${Math.max(8, useAbove ? preferredTop - measuredHeight : belowTop)}px`;
        let idx = 0;
        typerTimer = setInterval(() => {
            idx += 1;
            tooltipEl.textContent = message.slice(0, idx);
            if (idx >= message.length) stopTyping();
        }, Math.max(4, Math.min(80, parseInt(window._rrcTooltipTypeSpeed, 10) || 11)));
    };

    const hideTooltip = () => {
        stopHoverTimer();
        stopTyping();
        tooltipEl.style.display = 'none';
        tooltipEl.textContent = '';
        activeAnchor = null;
        activeMessage = '';
    };

    tooltipEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideTooltip();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideTooltip();
    });

    Object.entries(PANEL_HINT_KEY_MAP).forEach(([panelId, hintKey]) => {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        const host = panel;
        if (!host || host.querySelector('.panel-help-dock .panel-help-icon')) return;
        let dock = host.querySelector('.panel-help-dock');
        if (!dock) {
            dock = document.createElement('div');
            dock.className = 'panel-help-dock';
            dock.setAttribute('data-floating-interactive', 'true');
            if (panelId === 'rhythm-panel') {
                dock.classList.add('panel-help-dock-top-left');
            }
            host.appendChild(dock);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'panel-help-icon';
        btn.textContent = '?';
        btn.setAttribute('data-floating-interactive', 'true');
        btn.title = 'Help';
        dock.appendChild(btn);
        const showCurrentHint = () => showTooltip(btn, getHintMessage(hintKey));
        const showHintAfterHoverDelay = () => {
            stopHoverTimer();
            const delay = Math.max(0, Math.min(3000, parseInt(window._rrcTooltipHoverDelayMs, 10) || 0));
            if (delay <= 0) {
                showCurrentHint();
                return;
            }
            hoverTimer = window.setTimeout(() => {
                hoverTimer = 0;
                showCurrentHint();
            }, delay);
        };
        btn.addEventListener('mouseenter', showHintAfterHoverDelay);
        btn.addEventListener('mouseleave', () => {
            stopHoverTimer();
            if (isTouchLike()) return;
            if (!window._rrcTooltipHideOnUnhover) return;
            hideTooltip();
        });
        btn.addEventListener('blur', () => {
            stopHoverTimer();
            if (isTouchLike()) return;
            if (!window._rrcTooltipHideOnUnhover) return;
            hideTooltip();
        });
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stopHoverTimer();
            const isSameAnchor = activeAnchor === btn;
            const isVisible = tooltipEl.style.display === 'block';
            if (isVisible && isSameAnchor) {
                hideTooltip();
                return;
            }
            showCurrentHint();
        });
        btn.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            stopHoverTimer();
            const isSameAnchor = activeAnchor === btn;
            const isVisible = tooltipEl.style.display === 'block';
            if (isVisible && isSameAnchor) {
                hideTooltip();
                return;
            }
            showCurrentHint();
        });
    });
}

function setupUnityBridge() {
    if (window._rrcUnityBridgeReady) return;
    window._rrcUnityBridgeReady = true;

    const emitBridgeEvent = (event, payload = {}) => {
        const packet = {
            source: 'RRC',
            event: String(event || '').trim(),
            payload: payload && typeof payload === 'object' ? payload : { value: payload },
            ts: Date.now()
        };
        try {
            if (window.vuplex && typeof window.vuplex.postMessage === 'function') {
                window.vuplex.postMessage(JSON.stringify(packet));
            }
        } catch {}
        try {
            if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
                window.chrome.webview.postMessage(packet);
            }
        } catch {}
        try {
            window.parent.postMessage({ type: 'rrcBridgeEvent', ...packet }, '*');
        } catch {}
    };

    const normalizeWindowId = (id) => String(id || '').trim();
    const normalizeBridgeKey = (value) => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '')
        .replace(/[^a-z0-9-]/g, '');
    const panelToToggleId = {
        'rhythm-panel': 'rhythm-toggle',
        'notation-overlay': 'notation-toggle',
        'notation-circular-overlay': 'circular-toggle',
        'info-banner': 'info-toggle',
        'history-box': 'history-toggle',
        'image-window': 'media-toggle',
        'nav-toolbar': 'nav-toggle',
        'views-panel': 'views-toggle',
        'auth-panel': 'auth-toggle',
        'session-panel': 'session-toggle',
        'qr-panel': 'qr-toggle',
        'stage-panel': 'stage-toggle',
        'debug-controls': 'debug-toggle',
        'serve-panel': 'serve-local-toggle',
        'circular-panel': 'circular-toggle',
        'cesiumContainer': 'map-toggle'
    };
    const toggleToPanelId = Object.fromEntries(
        Object.entries(panelToToggleId).map(([panelId, toggleId]) => [toggleId, panelId])
    );
    const windowAliasToPanelId = {
        rhythm: 'rhythm-panel',
        rhythms: 'rhythm-panel',
        browser: 'rhythm-panel',
        notation: 'notation-overlay',
        compactnotation: 'notation-overlay',
        circular: 'notation-circular-overlay',
        title: 'info-banner',
        info: 'info-banner',
        context: 'history-box',
        history: 'history-box',
        media: 'image-window',
        nav: 'nav-toolbar',
        navigation: 'nav-toolbar',
        views: 'views-panel',
        user: 'auth-panel',
        auth: 'auth-panel',
        session: 'session-panel',
        qr: 'qr-panel',
        qrcode: 'qr-panel',
        shareqr: 'qr-panel',
        stage: 'stage-panel',
        settings: 'debug-controls',
        debug: 'debug-controls',
        serve: 'serve-panel',
        map: 'cesiumContainer'
    };
    const buildBridgeCatalog = () => {
        const topButtons = [];
        const topPanel = document.getElementById('top-panel-toggles');
        if (topPanel) {
            topPanel.querySelectorAll('button[id]').forEach((btn) => {
                const label = String(btn.textContent || '').replace(/\s+/g, ' ').trim();
                topButtons.push({
                    id: btn.id,
                    label,
                    key: normalizeBridgeKey(btn.id),
                    visible: !(btn.classList.contains('hidden') || btn.style.display === 'none')
                });
            });
        }
        const windows = [];
        document.querySelectorAll('[data-floating-window="true"]').forEach((el) => {
            if (!el.id) return;
            const toggleId = panelToToggleId[el.id] || (el.classList.contains('trigger-pad-window') ? 'trigger-pad-toggle' : '');
            windows.push({
                id: el.id,
                key: normalizeBridgeKey(el.id),
                label: String(el.getAttribute('aria-label') || el.id),
                visible: !(el.classList.contains('hidden') || el.classList.contains('panel-hidden')),
                toggleButtonId: toggleId
            });
        });
        return { topButtons, windows };
    };
    const resolveTopButtonId = (payload = {}) => {
        const candidates = [
            payload.buttonId,
            payload.topButtonId,
            payload.button,
            payload.commandValue,
            payload.value,
            payload.alias,
            payload.name
        ];
        for (let i = 0; i < candidates.length; i++) {
            const raw = String(candidates[i] || '').trim();
            if (!raw) continue;
            if (document.getElementById(raw)) return raw;
            const key = normalizeBridgeKey(raw);
            const topPanel = document.getElementById('top-panel-toggles');
            if (!topPanel) continue;
            const matched = Array.from(topPanel.querySelectorAll('button[id]')).find((btn) => {
                const labelKey = normalizeBridgeKey(btn.textContent || '');
                return key === normalizeBridgeKey(btn.id) || key === labelKey;
            });
            if (matched) return matched.id;
        }
        return '';
    };
    const resolveWindowId = (payload = {}) => {
        const candidates = [
            payload.windowId,
            payload.windowKey,
            payload.window,
            payload.windowName,
            payload.alias,
            payload.value,
            payload.name
        ];
        for (let i = 0; i < candidates.length; i++) {
            const raw = String(candidates[i] || '').trim();
            if (!raw) continue;
            if (document.getElementById(raw)) return raw;
            const key = normalizeBridgeKey(raw);
            if (windowAliasToPanelId[key]) return windowAliasToPanelId[key];
            if (toggleToPanelId[raw]) return toggleToPanelId[raw];
            const topBtnId = resolveTopButtonId({ buttonId: raw });
            if (topBtnId && toggleToPanelId[topBtnId]) return toggleToPanelId[topBtnId];
        }
        return '';
    };
    const togglePanelById = (id, forceVisible = null) => {
        const panel = document.getElementById(normalizeWindowId(id));
        if (!panel) return false;
        const currentlyVisible = !(panel.classList.contains('hidden') || panel.classList.contains('panel-hidden'));
        const nextVisible = forceVisible === null ? !currentlyVisible : !!forceVisible;
        panel.classList.toggle('hidden', !nextVisible);
        panel.classList.toggle('panel-hidden', false);
        if (nextVisible && typeof window._bringFloatingWindowToFront === 'function') {
            window._bringFloatingWindowToFront(panel);
        }
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        emitBridgeEvent('window_visibility_changed', {
            windowId: panel.id,
            visible: nextVisible
        });
        return true;
    };

    const clickTopButton = (buttonId) => {
        const btn = document.getElementById(String(buttonId || '').trim());
        if (!btn) return false;
        btn.click();
        return true;
    };

    const parseAlphaPayload = (payload, keys = ['alpha', 'value']) => {
        if (!payload || typeof payload !== 'object') return null;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const raw = payload[key];
            const num = Number(raw);
            if (Number.isFinite(num)) return clampAlpha01(num, 1);
        }
        return null;
    };

    const getState = () => {
        const windows = {};
        document.querySelectorAll('[data-floating-window="true"]').forEach((el) => {
            if (!el.id) return;
            windows[el.id] = {
                visible: !(el.classList.contains('hidden') || el.classList.contains('panel-hidden')),
                active: el.classList.contains('active')
            };
        });
        return {
            selectedRhythm: selectedRhythm || '',
            playback: {
                notation: !!notationPlaybackActive,
                tempo: Number(latestNotationPlaybackTempo) || 100,
                step: Number(latestNotationPlaybackStep) || 0
            },
            alpha: {
                windows: unityWindowsAlpha,
                fullscreenMap: unityFullscreenMapAlpha,
                effectivePanelOpacity: getEffectivePanelOpacity()
            },
            catalog: buildBridgeCatalog(),
            windows
        };
    };

    const applyCommand = async (command, payload = {}) => {
        const cmd = String(command || '').trim();
        if (!cmd) return { ok: false, error: 'missing_command' };
        if (cmd === 'toggleWindow') {
            const resolvedWindowId = resolveWindowId(payload);
            if (resolvedWindowId) return { ok: togglePanelById(resolvedWindowId), windowId: resolvedWindowId };
            const resolvedTopButtonId = resolveTopButtonId(payload);
            if (resolvedTopButtonId) return { ok: clickTopButton(resolvedTopButtonId), buttonId: resolvedTopButtonId };
            return { ok: false, error: 'invalid_window' };
        }
        if (cmd === 'showWindow') {
            const resolvedWindowId = resolveWindowId(payload);
            if (resolvedWindowId) return { ok: togglePanelById(resolvedWindowId, true), windowId: resolvedWindowId };
            const resolvedTopButtonId = resolveTopButtonId(payload);
            if (resolvedTopButtonId) return { ok: clickTopButton(resolvedTopButtonId), buttonId: resolvedTopButtonId };
            return { ok: false, error: 'invalid_window' };
        }
        if (cmd === 'hideWindow') {
            const resolvedWindowId = resolveWindowId(payload);
            if (resolvedWindowId) return { ok: togglePanelById(resolvedWindowId, false), windowId: resolvedWindowId };
            return { ok: false, error: 'invalid_window' };
        }
        if (cmd === 'clickTopButton') {
            const resolvedTopButtonId = resolveTopButtonId(payload);
            if (!resolvedTopButtonId) return { ok: false, error: 'invalid_button' };
            return { ok: clickTopButton(resolvedTopButtonId), buttonId: resolvedTopButtonId };
        }
        if (cmd === 'getCatalog') return { ok: true, catalog: buildBridgeCatalog() };
        if (cmd === 'setRhythm') {
            const key = String(payload.rhythmKey || '').trim();
            if (!key || !allRhythms[key]) return { ok: false, error: 'invalid_rhythm' };
            await startJourney(key, { noSessionBroadcast: true });
            return { ok: true };
        }
        if (cmd === 'playNotation') {
            const bridge = window._notationBridge;
            if (bridge && typeof bridge.postMain === 'function') {
                bridge.postMain({ type: 'startPlayback' });
                return { ok: true };
            }
            return { ok: false, error: 'notation_not_ready' };
        }
        if (cmd === 'stopNotation') {
            const bridge = window._notationBridge;
            if (bridge && typeof bridge.postMain === 'function') {
                bridge.postMain({ type: 'stopPlayback' });
                return { ok: true };
            }
            return { ok: false, error: 'notation_not_ready' };
        }
        if (cmd === 'setWindowsAlpha') {
            const alpha = parseAlphaPayload(payload, ['alpha', 'value']);
            if (alpha === null) return { ok: false, error: 'invalid_alpha' };
            const next = setUnityWindowsAlpha(alpha, { persist: true });
            return { ok: true, alpha: next };
        }
        if (cmd === 'setFullscreenMapAlpha') {
            const alpha = parseAlphaPayload(payload, ['alpha', 'value', 'mapAlpha', 'fullscreenMapAlpha']);
            if (alpha === null) return { ok: false, error: 'invalid_alpha' };
            const next = setUnityFullscreenMapAlpha(alpha, { persist: true });
            return { ok: true, alpha: next };
        }
        if (cmd === 'setUiAlpha') {
            const windowAlpha = parseAlphaPayload(payload, ['windowsAlpha', 'windowAlpha', 'alpha']);
            const mapAlpha = parseAlphaPayload(payload, ['mapAlpha', 'fullscreenMapAlpha']);
            if (windowAlpha === null && mapAlpha === null) return { ok: false, error: 'invalid_alpha' };
            if (windowAlpha !== null) setUnityWindowsAlpha(windowAlpha, { persist: true });
            if (mapAlpha !== null) setUnityFullscreenMapAlpha(mapAlpha, { persist: true });
            return {
                ok: true,
                windowsAlpha: unityWindowsAlpha,
                fullscreenMapAlpha: unityFullscreenMapAlpha
            };
        }
        if (cmd === 'getState') return { ok: true, state: getState() };
        return { ok: false, error: 'unknown_command' };
    };

    window.RRCBridge = {
        emit: emitBridgeEvent,
        getState,
        applyCommand,
        toggleWindow: (windowId) => togglePanelById(windowId),
        showWindow: (windowId) => togglePanelById(windowId, true),
        hideWindow: (windowId) => togglePanelById(windowId, false),
        clickTopButton,
        setWindowsAlpha: (alpha) => applyCommand('setWindowsAlpha', { alpha }),
        setFullscreenMapAlpha: (alpha) => applyCommand('setFullscreenMapAlpha', { alpha }),
        setUiAlpha: (windowsAlpha, fullscreenMapAlpha) => applyCommand('setUiAlpha', { windowsAlpha, mapAlpha: fullscreenMapAlpha })
    };

    window.addEventListener('message', async (event) => {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type !== 'rrcExternalControl') return;
        const result = await applyCommand(data.command, data.payload || {});
        emitBridgeEvent('command_result', {
            requestId: data.requestId || '',
            command: data.command || '',
            result
        });
    });

    const topButtons = document.getElementById('top-panel-toggles');
    if (topButtons) {
        topButtons.addEventListener('click', (event) => {
            const target = event.target instanceof HTMLElement ? event.target.closest('button') : null;
            if (!target) return;
            emitBridgeEvent('top_button_clicked', {
                buttonId: target.id || '',
                label: target.textContent || ''
            });
        });
    }

    emitBridgeEvent('bridge_ready', {
        topButtons: getCurrentTopPanelButtonOrder(),
        catalog: buildBridgeCatalog()
    });
}

function normalizeJourneyAltitudeMeters(rawValue, fallbackMeters) {
    let value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) value = Number(fallbackMeters);
    // Legacy migration: older profiles could store km values directly.
    // If altitude is suspiciously small, treat it as km and convert.
    if (Number.isFinite(value) && value > 0 && value <= 50000) value *= 1000;
    if (!Number.isFinite(value) || value <= 0) value = Number(fallbackMeters) || 1;
    return Math.max(1000, Math.min(100000000, value));
}

function normalizeJourneyDurationSeconds(rawValue, fallbackSeconds) {
    let value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) value = Number(fallbackSeconds);
    if (!Number.isFinite(value) || value <= 0) value = Number(fallbackSeconds) || 1;
    return Math.max(0.1, Math.min(30, value));
}

// Load debug settings from localStorage or use defaults
let zoomOutAltitude = normalizeJourneyAltitudeMeters(localStorage.getItem('zoomOutAltitude'), 20000000);
let zoomInAltitude = normalizeJourneyAltitudeMeters(localStorage.getItem('zoomInAltitude'), 600000);
let domeSize = parseFloat(localStorage.getItem('domeSize')) || 15000;
let wireframeMode = localStorage.getItem('wireframeMode') === 'true'; // defaults to false (hologram mode)
let pathWidth = parseFloat(localStorage.getItem('pathWidth')) || 12;
let pathSpeed = parseFloat(localStorage.getItem('pathSpeed')) || 0.008;
let pathLength = parseFloat(localStorage.getItem('pathLength')) || 0.15;
let arcHeightFactor = parseFloat(localStorage.getItem('arcHeightFactor')) || 0.15; // Arc height as fraction of distance
let selectedImagery = localStorage.getItem('selectedImagery') || 'default';
function normalizeMapSceneMode(mode) {
    const value = String(mode || '').toLowerCase();
    if (value === '2d') return '2d';
    if (value === 'columbus' || value === 'cv' || value === '2.5d') return 'columbus';
    return '3d';
}
let mapWindowedMode = localStorage.getItem('mapWindowedMode') === 'true';
let mapSceneMode = normalizeMapSceneMode(localStorage.getItem('mapSceneMode'));
let mapWindowRect = null;
let mapResizeRaf = 0;
let zoomOutDuration = normalizeJourneyDurationSeconds(localStorage.getItem('zoomOutDuration'), 2.0);
let zoomPauseDuration = normalizeJourneyDurationSeconds(localStorage.getItem('zoomPauseDuration'), 0.5);
let zoomInDuration = normalizeJourneyDurationSeconds(localStorage.getItem('zoomInDuration'), 2.5);

// Persist normalized values so broken legacy values (e.g. km or NaN) self-heal.
localStorage.setItem('zoomOutAltitude', String(zoomOutAltitude));
localStorage.setItem('zoomInAltitude', String(zoomInAltitude));
localStorage.setItem('zoomOutDuration', String(zoomOutDuration));
localStorage.setItem('zoomPauseDuration', String(zoomPauseDuration));
localStorage.setItem('zoomInDuration', String(zoomInDuration));
let showWireframeOutline = localStorage.getItem('showWireframeOutline') === 'true';
let sphereOpacity = parseFloat(localStorage.getItem('sphereOpacity')) || 0.5;
let sphereHeightOffset = parseFloat(localStorage.getItem('sphereHeightOffset')) || 0.5;
let textScale = parseFloat(localStorage.getItem('textScale')) || 1.0;
let focusTextScale = parseFloat(localStorage.getItem('focusTextScale')) || 0.8;
let panelOpacity = parseFloat(localStorage.getItem('panelOpacity')) || 1;
let frostIntensity = parseFloat(localStorage.getItem('frostIntensity')) || 20; // blur in pixels
let topButtonsAlpha = parseFloat(localStorage.getItem('topButtonsAlpha'));
topButtonsAlpha = Number.isFinite(topButtonsAlpha) ? Math.max(0.1, Math.min(1, topButtonsAlpha)) : panelOpacity;
let topButtonsBlur = parseFloat(localStorage.getItem('topButtonsBlur'));
topButtonsBlur = Number.isFinite(topButtonsBlur) ? Math.max(0, Math.min(50, topButtonsBlur)) : frostIntensity;
let carouselSpeed = parseFloat(localStorage.getItem('carouselSpeed')) || 30; // seconds for full scroll
let carouselRowAddThreshold = parseFloat(localStorage.getItem('carouselRowAddThreshold'));
carouselRowAddThreshold = Number.isFinite(carouselRowAddThreshold) ? Math.max(0, Math.min(240, carouselRowAddThreshold)) : 0;
let padPreviewStepGap = parseFloat(localStorage.getItem('padPreviewStepGap'));
padPreviewStepGap = Number.isFinite(padPreviewStepGap) ? Math.max(0, Math.min(12, padPreviewStepGap)) : 1;
let padBeatStartGap = parseFloat(localStorage.getItem('padBeatStartGap'));
padBeatStartGap = Number.isFinite(padBeatStartGap) ? Math.max(0, Math.min(12, padBeatStartGap)) : 5;
let padBeatIndicatorHeight = parseFloat(localStorage.getItem('padBeatIndicatorHeight'));
padBeatIndicatorHeight = Number.isFinite(padBeatIndicatorHeight) ? Math.max(1, Math.min(10, padBeatIndicatorHeight)) : 3;
let padBeatIndicatorOffset = parseFloat(localStorage.getItem('padBeatIndicatorOffset'));
padBeatIndicatorOffset = Number.isFinite(padBeatIndicatorOffset) ? Math.max(-12, Math.min(18, padBeatIndicatorOffset)) : 6;
let padPlayVisualScale = parseFloat(localStorage.getItem('padPlayVisualScale'));
padPlayVisualScale = Number.isFinite(padPlayVisualScale) ? Math.max(0.7, Math.min(2.2, padPlayVisualScale)) : 1;
let padBeatArrowArcEnabled = true;
{
    const storedPadBeatArc = localStorage.getItem('padBeatArrowArcEnabled');
    // Default ON unless explicitly disabled by persisted setting.
    padBeatArrowArcEnabled = storedPadBeatArc === null ? true : storedPadBeatArc === 'true';
}
let notationBeatArcHeight = parseFloat(localStorage.getItem('notationBeatArcHeight'));
notationBeatArcHeight = Number.isFinite(notationBeatArcHeight) ? Math.max(1, Math.min(40, notationBeatArcHeight)) : 7;
let windowScaleMin = parseFloat(localStorage.getItem('windowScaleMin')) || 0.72;
let floatingSnapEnabled = localStorage.getItem('floatingSnapEnabled') !== 'false';
let floatingSnapDistance = parseFloat(localStorage.getItem('floatingSnapDistance'));
floatingSnapDistance = Number.isFinite(floatingSnapDistance) ? Math.max(4, Math.min(64, floatingSnapDistance)) : 14;
let floatingSnapToWindows = localStorage.getItem('floatingSnapToWindows') !== 'false';
let floatingSnapToViewport = localStorage.getItem('floatingSnapToViewport') !== 'false';
let floatingMagneticDock = localStorage.getItem('floatingMagneticDock') !== 'false';
let topButtonsUseEmoji = localStorage.getItem('topButtonsUseEmoji') !== 'false';
let topButtonsCompactMode = localStorage.getItem('topButtonsCompactMode') === 'true';
let topButtonsSideMode = localStorage.getItem('topButtonsSideMode') === 'true';
let topButtonEmojiScale = parseFloat(localStorage.getItem('topButtonEmojiScale'));
topButtonEmojiScale = Number.isFinite(topButtonEmojiScale) ? Math.max(0.8, Math.min(2.6, topButtonEmojiScale)) : 1;
let topTogglePhoneEmojiScale = parseFloat(localStorage.getItem('topTogglePhoneEmojiScale'));
topTogglePhoneEmojiScale = Number.isFinite(topTogglePhoneEmojiScale) ? Math.max(0.8, Math.min(3.2, topTogglePhoneEmojiScale)) : 1;
let topToggleLaptopEmojiScale = parseFloat(localStorage.getItem('topToggleLaptopEmojiScale'));
topToggleLaptopEmojiScale = Number.isFinite(topToggleLaptopEmojiScale) ? Math.max(0.8, Math.min(3.2, topToggleLaptopEmojiScale)) : 1;
const NAV_TOOLBAR_LEGACY_ENABLED = false;
let showNavTopButton = NAV_TOOLBAR_LEGACY_ENABLED && localStorage.getItem('showNavTopButton') === 'true';
let rhythmCardContainImages = localStorage.getItem('rhythmCardContainImages') === 'true';
let tooltipTypeSpeed = parseFloat(localStorage.getItem('tooltipTypeSpeed'));
tooltipTypeSpeed = Number.isFinite(tooltipTypeSpeed) ? Math.max(4, Math.min(80, tooltipTypeSpeed)) : 11;
let tooltipHoverDelayMs = parseFloat(localStorage.getItem('tooltipHoverDelayMs'));
tooltipHoverDelayMs = Number.isFinite(tooltipHoverDelayMs) ? Math.max(0, Math.min(3000, tooltipHoverDelayMs)) : 500;
let tooltipWindowScale = parseFloat(localStorage.getItem('tooltipWindowScale'));
tooltipWindowScale = Number.isFinite(tooltipWindowScale) ? Math.max(0.6, Math.min(2.6, tooltipWindowScale)) : 1.15;
let tooltipTextScale = parseFloat(localStorage.getItem('tooltipTextScale'));
tooltipTextScale = Number.isFinite(tooltipTextScale) ? Math.max(0.6, Math.min(2.6, tooltipTextScale)) : 1.15;
let tooltipHideOnUnhover = localStorage.getItem('tooltipHideOnUnhover') === 'true';
let stopTransportOnRhythmSelect = localStorage.getItem('stopTransportOnRhythmSelect') !== 'false';
let restoreRhythmPanelAfterJourney = localStorage.getItem('restoreRhythmPanelAfterJourney') !== 'false';
let notationPrimeLeadMs = parseFloat(localStorage.getItem('notationPrimeLeadMs'));
notationPrimeLeadMs = Number.isFinite(notationPrimeLeadMs) ? Math.max(0, Math.min(300, notationPrimeLeadMs)) : 50;
let unityWindowsAlpha = clampAlpha01(localStorage.getItem('rrcUnityWindowsAlpha'), 1);
let unityFullscreenMapAlpha = clampAlpha01(localStorage.getItem('rrcUnityFullscreenMapAlpha'), 1);
if (localStorage.getItem('rrcUnityWindowsAlpha') === null) {
    localStorage.setItem('rrcUnityWindowsAlpha', '1');
}
if (localStorage.getItem('rrcUnityFullscreenMapAlpha') === null) {
    localStorage.setItem('rrcUnityFullscreenMapAlpha', '1');
}

function clampAlpha01(value, fallback = 1) {
    const next = Number(value);
    if (!Number.isFinite(next)) return Math.max(0, Math.min(1, Number(fallback) || 1));
    return Math.max(0, Math.min(1, next));
}

function isEmbeddedWebViewHost() {
    try {
        if (window.vuplex && typeof window.vuplex.postMessage === 'function') return true;
    } catch {}
    try {
        if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') return true;
    } catch {}
    return false;
}

function getEffectivePanelOpacity() {
    const base = Number.isFinite(Number(panelOpacity)) ? Number(panelOpacity) : 0.85;
    return clampAlpha01(base * unityWindowsAlpha, 0.85);
}

function applyUnifiedPanelOpacity() {
    const effective = getEffectivePanelOpacity();
    document.body.style.setProperty('--panel-opacity', effective.toFixed(3));
}

function applyTopButtonsPanelAppearance() {
    const alpha = clampAlpha01(topButtonsAlpha, panelOpacity);
    const blur = Number.isFinite(Number(topButtonsBlur))
        ? Math.max(0, Math.min(50, Number(topButtonsBlur)))
        : Math.max(0, Math.min(50, Number(frostIntensity) || 20));
    topButtonsAlpha = alpha;
    topButtonsBlur = blur;
    document.body.style.setProperty('--top-buttons-alpha', alpha.toFixed(3));
    document.body.style.setProperty('--top-buttons-blur', `${blur}px`);
}

function applyFullscreenMapAlpha() {
    const container = document.getElementById('cesiumContainer');
    if (!container) return;
    const alpha = mapWindowedMode ? 1 : unityFullscreenMapAlpha;
    container.style.opacity = clampAlpha01(alpha, 1).toFixed(3);
}

function setUnityWindowsAlpha(alpha, options = {}) {
    unityWindowsAlpha = clampAlpha01(alpha, unityWindowsAlpha);
    if (options.persist !== false) {
        localStorage.setItem('rrcUnityWindowsAlpha', String(unityWindowsAlpha));
    }
    applyUnifiedPanelOpacity();
    return unityWindowsAlpha;
}

function setUnityFullscreenMapAlpha(alpha, options = {}) {
    unityFullscreenMapAlpha = clampAlpha01(alpha, unityFullscreenMapAlpha);
    if (options.persist !== false) {
        localStorage.setItem('rrcUnityFullscreenMapAlpha', String(unityFullscreenMapAlpha));
    }
    applyFullscreenMapAlpha();
    return unityFullscreenMapAlpha;
}

function ensureMapPrimaryVisibility() {
    const container = document.getElementById('cesiumContainer');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const opacity = Number.parseFloat(container.style.opacity || '1');
    const hiddenByClass = container.classList.contains('hidden') || container.classList.contains('panel-hidden');
    const hiddenBySize = !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 220 || rect.height < 140;
    const hiddenByOpacity = Number.isFinite(opacity) && opacity <= 0.05;

    if (!(hiddenByClass || hiddenBySize || hiddenByOpacity)) return;

    // Self-heal: ensure the globe returns as the primary backdrop.
    mapWindowedMode = false;
    localStorage.setItem('mapWindowedMode', 'false');
    if (mapWindowedToggle) mapWindowedToggle.checked = false;
    setUnityFullscreenMapAlpha(1, { persist: true });
    applyMapWindowMode(false);
    queueCesiumResize();
    console.warn('[RRC] Auto-recovered invisible map to fullscreen mode.');
}

function applyRhythmCardImageMode() {
    document.body.classList.toggle('rhythm-card-images-contain', !!rhythmCardContainImages);
}
function enforceLegacyNavDisabled() {
    if (NAV_TOOLBAR_LEGACY_ENABLED) return;
    showNavTopButton = false;
    try { localStorage.setItem('showNavTopButton', 'false'); } catch {}
    const navToggle = document.getElementById('nav-toggle');
    if (navToggle) {
        navToggle.style.display = 'none';
        navToggle.classList.remove('active');
        navToggle.setAttribute('aria-hidden', 'true');
    }
    const navToolbar = document.getElementById('nav-toolbar');
    if (navToolbar) {
        navToolbar.classList.add('hidden', 'panel-hidden');
        navToolbar.classList.remove('active');
    }
}
function normalizeSessionEcoGranularity(value) {
    const mode = String(value || '').toLowerCase();
    if (mode === 'bar') return 'bar';
    if (mode === 'step') return 'step';
    return 'beat';
}
function normalizeSessionSyncMode(value) {
    return String(value || '').toLowerCase() === 'local' ? 'local' : 'remote';
}
function normalizeSessionStartAction(value) {
    const mode = String(value || '').toLowerCase();
    if (mode === 'call_in' || mode === 'callin' || mode === 'call-in') return 'call_in';
    return 'play';
}
function clampSessionSyncIntervalMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return SESSION_PROOF_SYNC_DEFAULT_INTERVAL_MS;
    return Math.max(SESSION_PROOF_SYNC_MIN_INTERVAL_MS, Math.min(SESSION_PROOF_SYNC_MAX_INTERVAL_MS, Math.round(n)));
}
function sessionMonotonicNowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}
function sessionBeatsPerMs(tempo) {
    const safeTempo = Math.max(1, Number(tempo) || 100);
    return safeTempo / 60000;
}
function computeSessionLookaheadMs() {
    return normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode) === 'local'
        ? SESSION_LOOKAHEAD_LOCAL_MS
        : SESSION_LOOKAHEAD_REMOTE_MS;
}
function computeSessionSyncIntervalMs() {
    // Proof mode: prioritize tight sync over message cost.
    return clampSessionSyncIntervalMs(sessionState.syncIntervalMs);
}
function computeSessionPingIntervalMs() {
    return normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode) === 'local'
        ? SESSION_PING_INTERVAL_LOCAL_MS
        : SESSION_PING_INTERVAL_REMOTE_MS;
}
function computeSessionDriftThresholdsMs() {
    if (normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode) === 'local') {
        return {
            ignore: SESSION_DRIFT_IGNORE_MS_LOCAL,
            soft: SESSION_DRIFT_SOFT_MS_LOCAL,
            hard: SESSION_DRIFT_HARD_MS_LOCAL
        };
    }
    return {
        ignore: SESSION_DRIFT_IGNORE_MS_REMOTE,
        soft: SESSION_DRIFT_SOFT_MS_REMOTE,
        hard: SESSION_DRIFT_SOFT_MS_REMOTE * 1.6
    };
}
function sessionLeaderTimeFromLocal(localNowMs = sessionMonotonicNowMs()) {
    return localNowMs + Number(sessionState.leaderClockOffsetMs || 0);
}
let followerNudgeMs = Math.min(250, Math.max(-250, Number(localStorage.getItem('rrcFollowerNudgeMs')) || 0));
window._rrcFollowerTiming = {
    get offset() { return followerNudgeMs; },
    set(value) {
        if (!Number.isFinite(value)) return;
        const next = Math.min(250, Math.max(-250, Math.round(value)));
        const deltaMs = next - followerNudgeMs;
        followerNudgeMs = next;
        localStorage.setItem('rrcFollowerNudgeMs', String(next));
        if (deltaMs && isSessionFollower() && notationPlaybackActive) {
            postToNotation({ type: 'shiftFollowerTiming', deltaMs });
        }
    }
};
function sessionLocalTimeFromLeader(leaderTimeMs) {
    return Number(leaderTimeMs || 0) - Number(sessionState.leaderClockOffsetMs || 0) + (isSessionFollower() ? followerNudgeMs : 0);
}
function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}
let sessionEcoSyncMode = localStorage.getItem('sessionEcoSyncMode') !== 'false';
let sessionEcoTickGranularity = normalizeSessionEcoGranularity(localStorage.getItem('sessionEcoTickGranularity'));
let sessionEcoMinTickIntervalMs = parseFloat(localStorage.getItem('sessionEcoMinTickIntervalMs'));
sessionEcoMinTickIntervalMs = Number.isFinite(sessionEcoMinTickIntervalMs) ? Math.max(0, Math.min(2000, sessionEcoMinTickIntervalMs)) : 0;
let sessionEcoMaxSilenceMs = parseFloat(localStorage.getItem('sessionEcoMaxSilenceMs'));
sessionEcoMaxSilenceMs = Number.isFinite(sessionEcoMaxSilenceMs) ? Math.max(250, Math.min(5000, sessionEcoMaxSilenceMs)) : 1400;
// Always the tight "local" sync for now (devices in one room), whatever was saved before.
let sessionDefaultSyncMode = 'local';
sessionState.syncMode = sessionDefaultSyncMode;
sessionState.syncIntervalMs = clampSessionSyncIntervalMs(localStorage.getItem('sessionSyncIntervalMs'));
let windowSelectManualMode = localStorage.getItem('windowSelectManualMode') === 'true';
let loadDatabaseOnStartup = localStorage.getItem('rrcLoadDatabaseOnStartup') !== 'false';
const TOP_BUTTON_ORDER_STORAGE_KEY = 'topPanelButtonOrder';
let rhythmPanelWidth = parseFloat(localStorage.getItem('rhythmPanelWidth')) || 220; // pixels
let rhythmPanelHeight = parseFloat(localStorage.getItem('rhythmPanelHeight')) || 75; // vh
let uiHidden = false;
let rhythmPanelTab = localStorage.getItem('rhythmPanelTab') === 'journeys' ? 'journeys' : 'browse';

const TOP_PANEL_BUTTON_LABELS = [
    { id: 'hide-ui-toggle', emoji: '👁️', text: 'Hide UI' },
    { id: 'mute-all-audio-btn', emoji: '🔇', text: 'Mute' },
    { id: 'notation-toggle', emoji: '🎵', text: 'Notation' },
    { id: 'rhythm-toggle', emoji: '🥁', text: 'Rhythms' },
    { id: 'info-toggle', emoji: '🏷️', text: 'Title' },
    { id: 'history-toggle', emoji: '📜', text: 'Context' },
    { id: 'media-toggle', emoji: '🎬', text: 'Media' },
    { id: 'nav-toggle', emoji: '🧭', text: 'Nav' },
    { id: 'map-toggle', emoji: '🗺️', text: 'Map' },
    { id: 'serve-local-toggle', emoji: '🚀', text: 'Serve' },
    { id: 'window-select-toggle', emoji: '🧲', text: 'Select' },
    { id: 'views-toggle', emoji: '🖥️', text: 'Views' },
    { id: 'auth-toggle', emoji: '👤', text: 'User' },
    { id: 'session-toggle', emoji: '🤝', text: 'Session' },
    { id: 'stage-toggle', emoji: '🎛️', text: 'Stage' },
    { id: 'circular-toggle', emoji: '⭕', text: 'Circular' },
    { id: 'trigger-pad-toggle', emoji: '🎚️', text: 'Pads' },
    { id: 'qr-toggle', emoji: '🔳', text: 'QR' },
    { id: 'tidy-toggle', emoji: '🧹', text: 'Tidy' },
    { id: 'debug-toggle', emoji: '🛠️', text: 'Settings' }
];

const TRIGGER_PAD_IDS = ['trigger-pad-1', 'trigger-pad-2', 'trigger-pad-3', 'trigger-pad-4', 'trigger-pad-5', 'trigger-pad-6'];
const TRIGGER_PAD_STORAGE_KEY = 'rrcTriggerPadStateV1';
const TRIGGER_PAD_SOUND_META = {
    slap: { label: 'Slap', symbol: 'X', className: 'slap' },
    tone: { label: 'Open', symbol: '', className: 'tone', openCircle: true },
    bass: { label: 'Bass', symbol: 'B', className: 'bass' },
    mute: { label: 'Mute', symbol: 'M', className: 'mute' },
    bell: { label: 'Bell', symbol: 'X', className: 'bell' }
};
const TRIGGER_PAD_ARTICULATIONS = {
    djembe: ['slap', 'tone', 'bass', 'mute'],
    djembe_solo: ['slap', 'tone', 'bass', 'mute'],
    kenkeni: ['tone', 'mute', 'bell'],
    sangban: ['tone', 'mute', 'bell'],
    doundoun: ['tone', 'mute', 'bell'],
    kenkeni_bell: ['bell'],
    sangban_bell: ['bell'],
    doundoun_bell: ['bell'],
    shekere: ['slap']
};
const TRIGGER_PAD_VELOCITY_MIN = 0.05;
const TRIGGER_PAD_VELOCITY_MAX = 1;
const TRIGGER_PAD_VELOCITY_CENTER_DEADZONE = 0.2;
const TRIGGER_PAD_VELOCITY_CURVE = 3.8;
const TRIGGER_PAD_SOUND_TO_TOKEN = {
    slap: 's',
    tone: 't',
    bass: 'b',
    mute: 'm',
    bell: 'l'
};
const TRIGGER_PAD_TOKEN_TO_SOUND = {
    s: 'slap',
    t: 'tone',
    b: 'bass',
    m: 'mute',
    l: 'bell',
    o: 'tone',
    x: 'mute'
};
const DEFAULT_BEAT_COLORS = [
    '#ce1126', '#ff8c00', '#fcd116', '#006b3f',
    '#2196f3', '#9c27b0', '#e91e63', '#00bcd4',
    '#009688', '#cddc39', '#673ab7', '#03a9f4'
];
let latestNotationRhythmData = null;
let latestNotationBeatColors = DEFAULT_BEAT_COLORS.slice();
let latestNotationUseCircularToneSymbol = false;
let latestNotationUseNeonArticulationStyle = true;
let latestNotationPlaybackStep = 0;
// The most recent step the player scheduled and the wall-clock time it sounds: the follower's exact position.
let latestScheduledNotationStep = { step: -1, epoch: 0 };
let latestNotationPlaybackTempo = 100;
let latestNotationPlaybackPlaying = false;
let latestNotationPlaybackStepEpoch = 0;
let latestNotationPlaybackBeatColor = DEFAULT_BEAT_COLORS[0];
let latestNotationMasterVolume = Math.max(0, Math.min(1, Number(localStorage.getItem('triggerPadPlaybackVolume') || '1') || 1));
let latestNotationCallState = {
    callLabel: 'Call In',
    callTitle: '',
    showCallOut: false,
    callPending: false,
    callActive: false,
    callInActive: false,
    callOutActive: false,
    playing: false,
    callInStepOffset: 1,
    callInStepMax: 16
};
let stagePanelStateById = {};

function getDefaultTopPanelButtonOrder() {
    return TOP_PANEL_BUTTON_LABELS.map(({ id }) => id);
}

function sanitizeTopPanelButtonOrder(order) {
    const allIds = getDefaultTopPanelButtonOrder();
    const normalized = Array.isArray(order)
        ? order.filter((id) => typeof id === 'string' && allIds.includes(id))
        : [];
    allIds.forEach((id) => {
        if (!normalized.includes(id)) normalized.push(id);
    });
    const settingsIndex = normalized.indexOf('debug-toggle');
    if (settingsIndex >= 0) {
        normalized.splice(settingsIndex, 1);
        normalized.push('debug-toggle');
    }
    return normalized;
}

function readTopPanelButtonOrder() {
    try {
        const raw = JSON.parse(localStorage.getItem(TOP_BUTTON_ORDER_STORAGE_KEY) || '[]');
        return sanitizeTopPanelButtonOrder(raw);
    } catch {
        return getDefaultTopPanelButtonOrder();
    }
}

function saveTopPanelButtonOrder(order) {
    const normalized = sanitizeTopPanelButtonOrder(order);
    localStorage.setItem(TOP_BUTTON_ORDER_STORAGE_KEY, JSON.stringify(normalized));
}

function getCurrentTopPanelButtonOrder() {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi) return getDefaultTopPanelButtonOrder();
    const ids = Array.from(topUi.querySelectorAll('button[data-top-button-id]'))
        .map((btn) => btn.getAttribute('data-top-button-id'))
        .filter((id) => typeof id === 'string' && id.length > 0);
    return sanitizeTopPanelButtonOrder(ids);
}

function getTopUiClearanceForTidy() {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi) return 60;
    const topUiStyle = window.getComputedStyle(topUi);
    if (topUiStyle.display === 'none' || topUiStyle.visibility === 'hidden') return 60;
    if (topUi.classList.contains('top-buttons-side')) return 60;
    return Math.max(60, Math.ceil(topUi.getBoundingClientRect().bottom + 10));
}

function getTidyCandidatePanels() {
    return Array.from(document.querySelectorAll('[data-floating-window="true"]')).filter((panel) => {
        if (!(panel instanceof HTMLElement)) return false;
        if (panel.classList.contains('hidden') || panel.classList.contains('panel-hidden')) return false;
        const style = window.getComputedStyle(panel);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (panel.id === 'cesiumContainer' && !mapWindowedMode) return false;
        if (panel.dataset.floatingLocked === '1') return false;
        return true;
    });
}

function tidyFloatingWindowsLayout() {
    const panels = getTidyCandidatePanels();
    if (!panels.length) return;

    const gap = 10;
    const viewportWidth = Math.max(320, window.innerWidth);
    const viewportHeight = Math.max(320, window.innerHeight);
    const topClearance = getTopUiClearanceForTidy();
    const maxUsableWidth = Math.max(240, viewportWidth - (gap * 2));
    const maxUsableHeight = Math.max(160, viewportHeight - topClearance - gap);
    const maxBottom = viewportHeight - gap;
    const maxRight = viewportWidth - gap;
    const step = 24;
    const intersects = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const overlapArea = (a, b) => {
        const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return w * h;
    };
    const clampRect = (left, top, width, height) => ({
        left: Math.max(gap, Math.min(left, maxRight - width)),
        top: Math.max(topClearance, Math.min(top, maxBottom - height)),
        right: 0,
        bottom: 0
    });
    const finalizeRect = (rect, width, height) => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + width,
        bottom: rect.top + height
    });
    const findNearestFreeSpot = (width, height, occupiedRects, originLeft, originTop) => {
        const maxX = Math.max(gap, Math.floor(maxRight - width));
        const maxY = Math.max(topClearance, Math.floor(maxBottom - height));
        const clampedOriginLeft = Math.max(gap, Math.min(originLeft, maxX));
        const clampedOriginTop = Math.max(topClearance, Math.min(originTop, maxY));
        let best = null;
        let bestDistSq = Number.POSITIVE_INFINITY;
        for (let y = topClearance; y <= maxY; y += step) {
            for (let x = gap; x <= maxX; x += step) {
                const candidate = { left: x, top: y, right: x + width, bottom: y + height };
                if (occupiedRects.some((occ) => intersects(candidate, occ))) continue;
                const dx = x - clampedOriginLeft;
                const dy = y - clampedOriginTop;
                const distSq = (dx * dx) + (dy * dy);
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    best = candidate;
                }
            }
        }
        return best;
    };

    const panelMeta = panels.map((panel) => {
        const rect = panel.getBoundingClientRect();
        const style = window.getComputedStyle(panel);
        const minW = parseInt(panel.dataset.windowMinW, 10) || parseInt(style.minWidth, 10) || 220;
        const minH = parseInt(panel.dataset.windowMinH, 10) || parseInt(style.minHeight, 10) || 140;
        const width = Math.min(Math.max(Math.max(140, minW), rect.width || minW), maxUsableWidth);
        const height = Math.min(Math.max(Math.max(100, minH), rect.height || minH), maxUsableHeight);
        const zInline = parseInt(panel.style.zIndex, 10);
        const zComputed = parseInt(style.zIndex, 10);
        const z = Number.isFinite(zInline) ? zInline : (Number.isFinite(zComputed) ? zComputed : 2600);
        return { panel, rect, width, height, z };
    });

    // Determine which windows are problematic: off-screen or significantly covered by higher-z windows.
    const problematic = new Set();
    panelMeta.forEach((meta, idx) => {
        const r = meta.rect;
        const offscreen = r.left < gap || r.top < topClearance || r.right > maxRight || r.bottom > maxBottom;
        if (offscreen) {
            problematic.add(idx);
            return;
        }
        const area = Math.max(1, meta.width * meta.height);
        const coveredByHigher = panelMeta.some((other, otherIdx) => {
            if (otherIdx === idx) return false;
            if (other.z <= meta.z) return false;
            const otherRect = { left: other.rect.left, top: other.rect.top, right: other.rect.right, bottom: other.rect.bottom };
            const thisRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            const coveredRatio = overlapArea(thisRect, otherRect) / area;
            return coveredRatio >= 0.22;
        });
        if (coveredByHigher) problematic.add(idx);
    });

    if (!problematic.size) return;

    const moveList = panelMeta
        .map((meta, idx) => ({ ...meta, idx }))
        .filter((meta) => problematic.has(meta.idx))
        .sort((a, b) => b.z - a.z || a.idx - b.idx);

    const currentRectsByIdx = new Map(panelMeta.map((meta, idx) => {
        const clamped = finalizeRect(clampRect(meta.rect.left, meta.rect.top, meta.width, meta.height), meta.width, meta.height);
        return [idx, clamped];
    }));

    moveList.forEach((meta) => {
        const clamped = finalizeRect(clampRect(meta.rect.left, meta.rect.top, meta.width, meta.height), meta.width, meta.height);
        const occupiedByOthers = panelMeta
            .map((_, idx) => idx)
            .filter((idx) => idx !== meta.idx)
            .map((idx) => currentRectsByIdx.get(idx))
            .filter(Boolean);
        const keepCurrent = !occupiedByOthers.some((occ) => intersects(clamped, occ));
        const target = keepCurrent
            ? clamped
            : (findNearestFreeSpot(meta.width, meta.height, occupiedByOthers, clamped.left, clamped.top) || clamped);
        currentRectsByIdx.set(meta.idx, target);

        const panel = meta.panel;
        panel.style.position = 'fixed';
        panel.style.left = Math.round(target.left) + 'px';
        panel.style.top = Math.round(target.top) + 'px';
        panel.style.width = Math.round(meta.width) + 'px';
        panel.style.height = Math.round(meta.height) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.dataset.windowPinned = '1';
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(panel);
        }
    });

    if (typeof window._syncTopPanelToggleStates === 'function') {
        window._syncTopPanelToggleStates();
    }
}

function closeAllFloatingWindows() {
    document.querySelectorAll('[data-floating-window="true"]').forEach((panel) => {
        if (!(panel instanceof HTMLElement)) return;
        const id = String(panel.id || '').trim();
        // Keep the Cesium container mounted as the base workspace backdrop.
        if (id === 'cesiumContainer') {
            panel.classList.remove('hidden', 'panel-hidden');
            return;
        }
        panel.classList.add('hidden', 'panel-hidden');
        panel.classList.remove('active');
    });
    if (typeof window._syncTopPanelToggleStates === 'function') {
        window._syncTopPanelToggleStates();
    }
    if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
        window._syncNotationWindowVisibilityFromDom();
    }
    if (typeof window._saveSystemAutosaveState === 'function') {
        try { window._saveSystemAutosaveState(); } catch {}
    }
}

function applyTopPanelButtonOrder(order, persist = true) {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi) return;
    const normalized = sanitizeTopPanelButtonOrder(order);
    const compactToggle = document.getElementById('top-buttons-compact-toggle');
    if (compactToggle && compactToggle.parentElement === topUi) {
        topUi.insertBefore(compactToggle, topUi.firstChild);
    }
    normalized.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn || btn.parentElement !== topUi) return;
        btn.dataset.topButtonId = id;
        topUi.appendChild(btn);
    });
    const padAnchor = document.getElementById('trigger-pad-toggle');
    const padToggles = Array.from(topUi.querySelectorAll('.trigger-pad-window-toggle'))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (padAnchor && padAnchor.parentElement === topUi) {
        let insertAfter = padAnchor.nextSibling;
        padToggles.forEach((btn) => {
            topUi.insertBefore(btn, insertAfter);
            insertAfter = btn.nextSibling;
        });
    }
    if (persist) saveTopPanelButtonOrder(normalized);
}

function setupTopPanelReorder() {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi || topUi.dataset.reorderReady === '1') return;
    topUi.dataset.reorderReady = '1';

    const draggableIds = getDefaultTopPanelButtonOrder();
    draggableIds.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.dataset.topButtonId = id;
        btn.draggable = true;
    });

    let draggingId = null;

    topUi.addEventListener('dragstart', (e) => {
        const target = e.target instanceof HTMLElement ? e.target.closest('button[data-top-button-id]') : null;
        if (!target) return;
        draggingId = target.dataset.topButtonId || null;
        target.classList.add('top-button-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggingId || '');
        }
    });

    topUi.addEventListener('dragend', () => {
        topUi.querySelectorAll('.top-button-dragging').forEach((el) => el.classList.remove('top-button-dragging'));
        if (draggingId) saveTopPanelButtonOrder(getCurrentTopPanelButtonOrder());
        draggingId = null;
    });

    topUi.addEventListener('dragover', (e) => {
        if (!draggingId) return;
        e.preventDefault();
        const target = e.target instanceof HTMLElement ? e.target.closest('button[data-top-button-id]') : null;
        if (!target) return;
        const targetId = target.dataset.topButtonId || '';
        if (!targetId || targetId === draggingId) return;
        const draggingEl = document.getElementById(draggingId);
        if (!draggingEl || draggingEl.parentElement !== topUi) return;
        const rect = target.getBoundingClientRect();
        const before = e.clientX < rect.left + (rect.width / 2);
        if (before) topUi.insertBefore(draggingEl, target);
        else topUi.insertBefore(draggingEl, target.nextSibling);
    });

    topUi.addEventListener('drop', (e) => {
        if (!draggingId) return;
        e.preventDefault();
        saveTopPanelButtonOrder(getCurrentTopPanelButtonOrder());
    });
}

function applyTopPanelButtonLabels() {
    const buildLabelHtml = (emoji, text) => `<span class="top-btn-emoji">${emoji}</span><span class="top-btn-label">${text}</span>`;
    TOP_PANEL_BUTTON_LABELS.forEach(({ id, emoji, text }) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        let resolvedEmoji = String(emoji || '').trim();
        if (id === 'map-toggle') {
            resolvedEmoji = normalizeMapSceneMode(mapSceneMode) === '2d' ? '🗺️' : '🌍';
        } else if (id === 'window-select-toggle') {
            resolvedEmoji = (mapWindowedMode || windowSelectManualMode) ? '🧲' : '🖱️';
        } else if (id === 'hide-ui-toggle') {
            resolvedEmoji = uiHidden ? '🪟' : '👁️';
        }
        const safeEmoji = resolvedEmoji;
        const dynamicText = id === 'hide-ui-toggle'
            ? (uiHidden ? 'Show UI' : 'Hide UI')
            : (id === 'window-select-toggle'
                ? (mapWindowedMode ? 'Select Auto' : ((mapWindowedMode || windowSelectManualMode) ? 'Select On' : 'Select Off'))
                : text);
        const safeText = String(dynamicText || '').trim() || id.replace(/-toggle$/, '').toUpperCase();
        btn.dataset.iconMode = '';
        if (topButtonsCompactMode) {
            if (safeEmoji) btn.innerHTML = `<span class="top-btn-emoji">${safeEmoji}</span>`;
            else btn.textContent = safeText;
            return;
        }
        if (topButtonsUseEmoji && safeEmoji) {
            btn.innerHTML = buildLabelHtml(safeEmoji, safeText);
        } else {
            btn.textContent = safeText;
        }
    });
    const compactToggle = document.getElementById('top-buttons-compact-toggle');
    if (compactToggle) {
        const compactEmoji = topButtonsCompactMode ? '💻' : '📱';
        compactToggle.dataset.iconMode = topButtonsCompactMode ? 'laptop' : 'phone';
        compactToggle.innerHTML = `<span class="top-btn-emoji">${compactEmoji}</span>`;
        compactToggle.title = topButtonsCompactMode
            ? 'Click: Expand Top Buttons | Hold: Switch Top/Side Layout'
            : 'Click: Compact Top Buttons | Hold: Switch Top/Side Layout';
        compactToggle.classList.toggle('active', topButtonsCompactMode);
    }
    const navToggle = document.getElementById('nav-toggle');
    if (navToggle) navToggle.style.display = (NAV_TOOLBAR_LEGACY_ENABLED && showNavTopButton) ? '' : 'none';
}

function applyTopPanelLayoutMode() {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi) return;
    topUi.classList.toggle('top-buttons-side', !!topButtonsSideMode);
}

const JOURNEY_STORAGE_KEY = 'rrcJourneyPresets';
const JOURNEY_EXPORT_VERSION = 1;
let journeyDraft = {
    id: null,
    name: '',
    items: []
};
let journeyPlaybackAbort = false;

// Unsplash image cache (stored in localStorage)
const UNSPLASH_CACHE_MAX_ENTRIES = 600;
let unsplashImageCache = (() => {
    try {
        const raw = localStorage.getItem('unsplashImageCache');
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
})();

function normalizeUnsplashImageCache(cacheObj) {
    const cache = (cacheObj && typeof cacheObj === 'object') ? cacheObj : {};
    const entries = Object.entries(cache)
        .filter(([k, v]) => !!String(k || '').trim() && typeof v === 'string' && v.trim().length > 0)
        .slice(-UNSPLASH_CACHE_MAX_ENTRIES);
    return Object.fromEntries(entries);
}

function saveUnsplashImageCache() {
    try {
        unsplashImageCache = normalizeUnsplashImageCache(unsplashImageCache);
        localStorage.setItem('unsplashImageCache', JSON.stringify(unsplashImageCache));
    } catch {}
}
const BUNDLED_FALLBACK_IMAGE_COUNT = 50;
const BUNDLED_FALLBACK_VERSION = '2026-02-11-curated-v1';
const BUNDLED_FALLBACK_IMAGES = Array.from({ length: BUNDLED_FALLBACK_IMAGE_COUNT }, (_, idx) =>
    `assets/fallback-photos/fallback-${String(idx + 1).padStart(3, '0')}.jpg?v=${BUNDLED_FALLBACK_VERSION}`
);
const RHYTHM_IMAGE_INSTRUMENT_ONLY = true;
const INSTRUMENT_ONLY_RHYTHM_IMAGES = [
    'instrumentIcons/DjembeOne.png',
    'instrumentIcons/DjembeTwo.png',
    'instrumentIcons/DjembeThree.png',
    // Keep a 4-slot djembe cycle for rhythm cards.
    // Fourth slot intentionally reuses DjembeOne until a dedicated fourth djembe icon is added.
    'instrumentIcons/DjembeOne.png'
];

function getBundledFallbackImage(seed = '') {
    const key = String(seed || 'fallback').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) - hash) + key.charCodeAt(i);
        hash |= 0;
    }
    const index = Math.abs(hash) % BUNDLED_FALLBACK_IMAGES.length;
    return BUNDLED_FALLBACK_IMAGES[index] || BUNDLED_FALLBACK_IMAGES[0];
}

function getInstrumentOnlyRhythmImage(seed = '') {
    const key = String(seed || 'instrument').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) - hash) + key.charCodeAt(i);
        hash |= 0;
    }
    const index = Math.abs(hash) % INSTRUMENT_ONLY_RHYTHM_IMAGES.length;
    return INSTRUMENT_ONLY_RHYTHM_IMAGES[index] || INSTRUMENT_ONLY_RHYTHM_IMAGES[0];
}

function isInstrumentOnlyRhythmImageUrl(url) {
    const value = String(url || '').trim().toLowerCase();
    return value.startsWith('instrumenticons/') || value.includes('/instrumenticons/');
}

function unsplashResultLooksLikePerson(result) {
    const tags = Array.isArray(result?.tags)
        ? result.tags.map((tag) => String(tag?.title || '').trim())
        : [];
    const text = [
        result?.alt_description,
        result?.description,
        ...tags
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    if (!text) return false;
    const personTerms = [
        'person', 'people', 'portrait', 'face', 'human',
        'man', 'woman', 'boy', 'girl', 'child', 'children',
        'singer', 'performer', 'dancer', 'audience', 'crowd'
    ];
    return personTerms.some((term) => text.includes(term));
}

// 12-color spectrum matching button colors
const colorSpectrum = [
    '#FF0000', '#FF8800', '#FFD700', '#88FF00',
    '#00FF00', '#00FF88', '#00FFFF', '#0088FF',
    '#0000FF', '#8800FF', '#FF00FF', '#FF0088'
];

// Map rhythm colors to spectrum
let rhythmColorMap = {};

function getMapTopClearance() {
    const topUi = document.getElementById('top-panel-toggles');
    if (!topUi) return 60;
    const style = window.getComputedStyle(topUi);
    if (style.display === 'none' || style.visibility === 'hidden') return 60;
    if (topUi.classList.contains('top-buttons-side')) return 60;
    const rect = topUi.getBoundingClientRect();
    return Math.max(60, Math.ceil(rect.bottom + 8));
}

function clampMapWindowRect(rect) {
    const gap = 8;
    const topClearance = getMapTopClearance();
    // Keep map window flexible on smaller/mobile layouts.
    const minW = Math.min(220, Math.max(180, window.innerWidth - gap * 2));
    const minH = Math.min(200, Math.max(150, window.innerHeight - topClearance - gap));
    const width = Math.min(
        Math.max(minW, Number(rect?.width) || Math.min(window.innerWidth * 0.78, 1200)),
        Math.max(120, window.innerWidth - gap * 2)
    );
    const height = Math.min(
        Math.max(minH, Number(rect?.height) || Math.min(window.innerHeight * 0.76, 820)),
        Math.max(120, window.innerHeight - topClearance - gap)
    );
    const maxLeft = Math.max(gap, window.innerWidth - width - gap);
    const maxTop = Math.max(topClearance, window.innerHeight - height - gap);
    const left = Math.max(gap, Math.min(Number(rect?.left) || gap, maxLeft));
    const top = Math.max(topClearance, Math.min(Number(rect?.top) || topClearance, maxTop));
    return { left, top, width, height };
}

function readStoredMapWindowRect() {
    if (mapWindowRect && Number.isFinite(mapWindowRect.left) && Number.isFinite(mapWindowRect.top)) {
        return mapWindowRect;
    }
    try {
        const parsed = JSON.parse(localStorage.getItem('mapWindowRect') || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
        if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
        mapWindowRect = parsed;
        return parsed;
    } catch {
        return null;
    }
}

function saveMapWindowRect(rect) {
    if (!rect) return;
    mapWindowRect = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
    };
    localStorage.setItem('mapWindowRect', JSON.stringify(mapWindowRect));
}

function queueCesiumResize() {
    if (!viewer) return;
    if (mapResizeRaf) return;
    mapResizeRaf = requestAnimationFrame(() => {
        mapResizeRaf = 0;
        try {
            viewer.resize();
            viewer.scene.requestRender();
        } catch (err) {
            console.warn('Cesium resize failed:', err);
        }
    });
}

function syncWindowSelectModeUi() {
    const btn = document.getElementById('window-select-toggle');
    const effectiveEnabled = !!(mapWindowedMode || windowSelectManualMode);
    if (typeof window._setFloatingWindowMultiselectMode === 'function') {
        window._setFloatingWindowMultiselectMode(effectiveEnabled);
    }
    const mapLock = !mapWindowedMode && effectiveEnabled;
    document.body.classList.toggle('window-select-map-lock', mapLock);
    if (!mapWindowedMode && viewer && viewer.scene && viewer.scene.screenSpaceCameraController) {
        viewer.scene.screenSpaceCameraController.enableInputs = !effectiveEnabled;
    } else if (viewer && viewer.scene && viewer.scene.screenSpaceCameraController) {
        viewer.scene.screenSpaceCameraController.enableInputs = true;
    }
    if (!btn) return;
    btn.classList.toggle('active', effectiveEnabled);
    if (mapWindowedMode) {
        btn.title = 'Window select is on while map is windowed';
        btn.dataset.state = 'auto';
    } else if (effectiveEnabled) {
        btn.title = 'Selection mode on: globe interaction is paused';
        btn.dataset.state = 'on';
    } else {
        btn.title = 'Selection mode off: click to select multiple windows';
        btn.dataset.state = 'off';
    }
    applyTopPanelButtonLabels();
}

function syncMapWindowDragBarUi() {
    const scene = normalizeMapSceneMode(mapSceneMode);
    const sceneLabel = scene === '2d' ? 'Flat' : (scene === 'columbus' ? 'Columbus' : 'Globe');

    const mapToggle = document.getElementById('map-toggle');
    if (mapToggle) {
        mapToggle.classList.toggle('active', scene === '2d');
        mapToggle.title = scene === '2d'
            ? 'Tap: Switch to Globe (3D) | Hold: Toggle Map Window'
            : 'Tap: Switch to Flat (2D) | Hold: Toggle Map Window';
    }

    const bar = document.querySelector('#cesiumContainer .map-window-drag-bar');
    if (!bar) return;
    const label = bar.querySelector('.map-window-drag-label');
    const modeBtn = bar.querySelector('.map-window-mode-btn');
    if (label) label.textContent = `Drag Map Window (${sceneLabel})`;
    if (modeBtn) {
        const isWindowed = !!mapWindowedMode;
        modeBtn.textContent = isWindowed ? 'Full' : 'Window';
        modeBtn.title = isWindowed ? 'Switch map to fullscreen' : 'Switch map to window mode';
        modeBtn.classList.toggle('is-windowed', isWindowed);
        modeBtn.classList.toggle('is-fullscreen', !isWindowed);
        modeBtn.setAttribute('aria-pressed', isWindowed ? 'true' : 'false');
    }
}

function applyMapWindowMode(forceMode, options = {}) {
    const persist = options && options.persist !== false;
    if (typeof forceMode === 'boolean') {
        mapWindowedMode = forceMode;
    }
    if (persist) {
        localStorage.setItem('mapWindowedMode', mapWindowedMode ? 'true' : 'false');
    }

    const container = document.getElementById('cesiumContainer');
    if (!container) return;

    if (mapWindowedMode) {
        const targetRect = clampMapWindowRect(readStoredMapWindowRect() || null);
        container.dataset.floatingLocked = '0';
        container.classList.remove('hidden', 'panel-hidden', 'pad-remote-mobile-hidden');
        container.classList.add('cesium-windowed');
        container.style.display = 'block';
        container.style.visibility = 'visible';
        container.style.position = 'fixed';
        container.style.left = Math.round(targetRect.left) + 'px';
        container.style.top = Math.round(targetRect.top) + 'px';
        container.style.width = Math.round(targetRect.width) + 'px';
        container.style.height = Math.round(targetRect.height) + 'px';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
        container.style.transform = 'none';
        container.dataset.windowPinned = '1';
        saveMapWindowRect(targetRect);
    } else {
        const rect = container.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40 && rect.width < window.innerWidth - 2) {
            saveMapWindowRect(rect);
        }
        container.dataset.floatingLocked = '1';
        container.classList.remove('hidden', 'panel-hidden', 'pad-remote-mobile-hidden');
        container.classList.remove('cesium-windowed');
        container.style.display = 'block';
        container.style.visibility = 'visible';
        container.style.position = 'fixed';
        container.style.left = '0px';
        container.style.top = '0px';
        container.style.width = '100vw';
        container.style.height = '100vh';
        container.style.maxWidth = '100vw';
        container.style.maxHeight = '100vh';
        container.style.minWidth = '0';
        container.style.minHeight = '0';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
        container.style.transform = 'none';
        // Keep map behind floating windows but above page background.
        container.style.zIndex = '1';
    }

    if (typeof window._updateFloatingWindowScale === 'function') {
        window._updateFloatingWindowScale(container);
    }
    applyFullscreenMapAlpha();
    syncWindowSelectModeUi();
    syncMapWindowDragBarUi();
    queueCesiumResize();
}

function applyMapSceneMode(mode, options = {}) {
    const persist = options && options.persist !== false;
    mapSceneMode = normalizeMapSceneMode(mode);
    if (persist) {
        localStorage.setItem('mapSceneMode', mapSceneMode);
    }
    applyTopPanelButtonLabels();
    const mapSceneModeSelect = document.getElementById('mapSceneModeSelect');
    if (mapSceneModeSelect) mapSceneModeSelect.value = mapSceneMode;
    syncMapWindowDragBarUi();
    if (!viewer || !viewer.scene) return;
    try {
        if (mapSceneMode === '2d') viewer.scene.morphTo2D(0.9);
        else if (mapSceneMode === 'columbus') viewer.scene.morphToColumbusView(0.9);
        else viewer.scene.morphTo3D(0.9);
    } catch (err) {
        console.warn('Could not change map scene mode:', err);
    }
    queueCesiumResize();
}
window._toggleMapWindowMode = (forceMode) => {
    if (typeof forceMode === 'boolean') applyMapWindowMode(forceMode);
    else applyMapWindowMode(!mapWindowedMode);
    const mapWindowedToggle = document.getElementById('mapWindowedToggle');
    if (mapWindowedToggle) mapWindowedToggle.checked = mapWindowedMode;
};
window.toggleMapWindowMode = window._toggleMapWindowMode;
window._syncMapWindowDragBarUi = syncMapWindowDragBarUi;

function getServePathHint(projectRootName = '') {
    const pathnameRaw = String(window.location.pathname || '').trim();
    if (!pathnameRaw || pathnameRaw === '/') return '/index.html';
    let pathname = pathnameRaw.replace(/\\/g, '/');

    // If the page is served by an IDE/dev server from /<projectName>/..., strip that
    // prefix so copied URLs match a python http.server started at the project root.
    const root = String(projectRootName || '').trim();
    if (root) {
        const rootPrefix = `/${root}/`;
        if (pathname === `/${root}` || pathname === `/${root}/`) {
            pathname = '/';
        } else if (pathname.startsWith(rootPrefix)) {
            pathname = `/${pathname.slice(rootPrefix.length)}`;
        }
    }

    if (pathname.includes('/Users/') || pathname.includes(':/')) return '/index.html';
    if (/\.html?$/i.test(pathname)) return pathname;
    if (pathname.endsWith('/')) return '/index.html';
    if (/\.[a-z0-9]+$/i.test(pathname)) return '/index.html';
    return '/index.html';
}

function getServeLocalInfo() {
    const command = 'python3 -m http.server 5500 --bind 0.0.0.0';
    const cwdHint = '/Users/teairis/WebstormProjects/RhythmsReconnectedMap';
    const projectRootName = cwdHint.split('/').filter(Boolean).pop() || '';
    const isAlreadyServed = String(window.location.protocol || '').toLowerCase().startsWith('http')
        && String(window.location.port || '') === '5500';
    const path = getServePathHint(projectRootName);
    const localUrl = `http://localhost:5500${path}`;
    const lanHost = isLoopbackHost(window.location.hostname) ? 'YOUR-LAN-IP' : String(window.location.hostname || 'localhost');
    const lanUrl = `http://${lanHost}:5500${path}`;
    return {
        command,
        cwdHint,
        isAlreadyServed,
        localUrl,
        lanUrl
    };
}

async function copyTextToClipboard(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {}
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.focus();
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        return !!copied;
    } catch {
        return false;
    }
}

function setupServePanel() {
    const panel = document.getElementById('serve-panel');
    if (!panel || panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const commandEl = document.getElementById('serve-panel-command');
    const cwdEl = document.getElementById('serve-panel-cwd');
    const urlEl = document.getElementById('serve-panel-url');
    const statusEl = document.getElementById('serve-panel-status');
    const copyCommandBtn = document.getElementById('serve-panel-copy-command');
    const copyUrlBtn = document.getElementById('serve-panel-copy-url');
    const refreshBtn = document.getElementById('serve-panel-refresh');

    const setStatus = (message, tone = 'info') => {
        if (!statusEl) return;
        statusEl.textContent = String(message || '');
        statusEl.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
        if (tone === 'success') statusEl.classList.add('panel-status-success');
        if (tone === 'warn') statusEl.classList.add('panel-status-warn');
        if (tone === 'error') statusEl.classList.add('panel-status-error');
    };

    const update = () => {
        const info = getServeLocalInfo();
        if (commandEl) commandEl.textContent = info.command;
        if (cwdEl) cwdEl.textContent = `Run from: ${info.cwdHint}`;
        if (urlEl) urlEl.textContent = `Open: ${info.localUrl}  |  LAN: ${info.lanUrl}`;
        setStatus(
            info.isAlreadyServed
                ? 'Server appears active on port 5500 for this page.'
                : 'Copy command, run it in terminal, then open the URL.',
            info.isAlreadyServed ? 'success' : 'info'
        );

        if (window.RRCBridge && typeof window.RRCBridge.emit === 'function') {
            window.RRCBridge.emit('serve_local_requested', {
                command: info.command,
                cwd: info.cwdHint,
                alreadyServed: info.isAlreadyServed,
                localUrl: info.localUrl,
                lanUrl: info.lanUrl
            });
        }
    };

    if (copyCommandBtn) {
        copyCommandBtn.addEventListener('click', async () => {
            const info = getServeLocalInfo();
            setStatus('This will be copied to your clipboard.', 'info');
            const ok = await copyTextToClipboard(info.command);
            setStatus(ok ? 'Copied to clipboard.' : 'Clipboard copy failed in this browser context.', ok ? 'success' : 'error');
        });
    }

    if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', async () => {
            const info = getServeLocalInfo();
            const target = isLoopbackHost(window.location.hostname) ? info.localUrl : info.lanUrl;
            setStatus('This will be copied to your clipboard.', 'info');
            const ok = await copyTextToClipboard(target);
            setStatus(ok ? 'Copied to clipboard.' : 'Clipboard copy failed in this browser context.', ok ? 'success' : 'error');
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', update);
    }

    const observer = new MutationObserver(() => {
        const hidden = panel.classList.contains('hidden') || panel.classList.contains('panel-hidden');
        if (!hidden) update();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    panel._servePanelObserver = observer;

    window.addEventListener('focus', () => {
        const hidden = panel.classList.contains('hidden') || panel.classList.contains('panel-hidden');
        if (!hidden) update();
    });

    window._refreshServePanel = update;
    update();
}

window._onCesiumContainerLayoutChange = () => {
    if (!mapWindowedMode) return;
    const container = document.getElementById('cesiumContainer');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    saveMapWindowRect(rect);
    queueCesiumResize();
};

window.addEventListener('resize', () => {
    if (mapWindowedMode) {
        applyMapWindowMode(true);
    } else {
        queueCesiumResize();
    }
});

let cesiumLowMemoryFallbackApplied = false;

function isMobileUrlModeEnabled() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (!params.has('mobile')) return false;
        const value = String(params.get('mobile') || '').trim().toLowerCase();
        return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    } catch {
        return false;
    }
}

function isPadRemoteUrlModeEnabled() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (params.get('padRemote') === '1') return true;
        return isMobileUrlModeEnabled();
    } catch {
        return false;
    }
}

function shouldPreferLowMemoryCesium() {
    const mobileQuery = isMobileUrlModeEnabled();
    const padRemote = isPadRemoteUrlModeEnabled();
    const deviceMemory = Number(navigator.deviceMemory || 0);
    const dpr = Number(window.devicePixelRatio || 1);
    if (mobileQuery || padRemote) return true;
    if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4) return true;
    return dpr >= 3.0;
}

function isCesiumMemoryError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return (
        msg.includes('array buffer allocation failed') ||
        msg.includes('out of memory') ||
        msg.includes('insufficient memory')
    );
}

function applyCesiumPerformanceProfile(lowMemory = false) {
    if (!viewer || !viewer.scene) return;
    const dpr = Math.max(1, Number(window.devicePixelRatio || 1));
    const targetScale = lowMemory
        ? Math.max(0.45, Math.min(1, 1.3 / dpr))
        : Math.max(0.7, Math.min(1, 1.6 / dpr));
    try { viewer.resolutionScale = targetScale; } catch {}
    try {
        viewer.scene.fxaa = true;
        if (viewer.scene.postProcessStages?.fxaa) viewer.scene.postProcessStages.fxaa.enabled = true;
    } catch {}
    try {
        if (viewer.scene.globe) {
            viewer.scene.globe.maximumScreenSpaceError = lowMemory ? 4 : 2;
            if (typeof viewer.scene.globe.tileCacheSize !== 'undefined') {
                viewer.scene.globe.tileCacheSize = lowMemory ? 80 : 160;
            }
        }
    } catch {}
}

function attachCesiumRenderRecovery() {
    if (!viewer || !viewer.scene || !viewer.scene.renderError) return;
    try {
        viewer.scene.renderError.addEventListener((scene, error) => {
            if (!isCesiumMemoryError(error)) return;
            console.warn('[RRC] Cesium memory render error detected, applying fallback:', error);
            try { scene.rethrowRenderErrors = false; } catch {}
            if (!cesiumLowMemoryFallbackApplied) {
                cesiumLowMemoryFallbackApplied = true;
                try {
                    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
                } catch {}
                applyCesiumPerformanceProfile(true);
            }
            try {
                viewer.useDefaultRenderLoop = true;
                scene.requestRender();
            } catch {}
        });
    } catch (err) {
        console.warn('[RRC] Could not attach Cesium render recovery:', err);
    }
}

async function initCesium() {
    try {
        console.log('Initializing Cesium...');

        // ── Load rhythm data (Supabase → fallback) ──
        const shouldLoadDatabaseAtStartup = loadDatabaseOnStartup || isPadRemoteUrlModeEnabled() || isMobileUrlModeEnabled();
        const supabaseData = shouldLoadDatabaseAtStartup
            ? await fetchRhythmsFromSupabase()
            : null;
        if (supabaseData && Object.keys(supabaseData).length > 0) {
            allRhythms = supabaseData;
        } else {
            console.log('Using fallback rhythm data');
            allRhythms = {
                ...normaliseFallback(FALLBACK_rhythmData, 'Local'),
                ...normaliseFallback(FALLBACK_communityRhythmData, 'Community')
            };
        }
        resetDemoRhythmsState();
        await applyLocalTranscribedNotations(allRhythms);
        mergeLocalCustomRhythmsIntoAllRhythms();
        await mergeLibraryRhythms();
        console.log(`${Object.keys(allRhythms).length} rhythms loaded`);
        ensureSelectedRhythmBootstrap();

        const container = document.getElementById('cesiumContainer');
        if (!container) {
            throw new Error('Cesium container not found');
        }
        // Ensure stale persisted map window geometry cannot create an oversized
        // WebGL canvas before the viewer is initialized.
        applyMapWindowMode(mapWindowedMode, { persist: false });

        // Configure Cesium to use CDN resources to avoid worker redirect issues
        window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.137/Build/Cesium/';

        const preferLowMemoryCesium = shouldPreferLowMemoryCesium();
        const hideNativeCesiumMobileButtons = isMobileUrlModeEnabled() || isPadRemoteUrlModeEnabled();
        viewer = new Cesium.Viewer(container, {
            terrain: preferLowMemoryCesium ? undefined : Cesium.Terrain.fromWorldTerrain(),
            baseLayerPicker: !hideNativeCesiumMobileButtons,
            geocoder: false,
            homeButton: !hideNativeCesiumMobileButtons,
            sceneModePicker: false,
            navigationHelpButton: false,
            animation: false,
            timeline: false,
            fullscreenButton: false,
            shouldAnimate: true,
            requestRenderMode: false,
            maximumRenderTimeChange: Infinity,
            selectionIndicator: false,
            infoBox: false,
            contextOptions: {
                webgl: {
                    antialias: false,
                    powerPreference: preferLowMemoryCesium ? 'low-power' : 'high-performance',
                    preserveDrawingBuffer: false
                }
            }
        });

        console.log('Viewer created');
        applyCesiumPerformanceProfile(preferLowMemoryCesium);
        attachCesiumRenderRecovery();
        if (hideNativeCesiumMobileButtons) {
            const hideNativeControls = () => {
                try {
                    container.querySelectorAll('.cesium-home-button, .cesium-baseLayerPicker-wrapper, .cesium-baseLayerPicker-button').forEach((el) => {
                        if (el instanceof HTMLElement) el.style.display = 'none';
                    });
                } catch {}
            };
            hideNativeControls();
            setTimeout(hideNativeControls, 120);
            setTimeout(hideNativeControls, 420);
        }

        viewer.scene.globe.enableLighting = false;

        // Wait a bit for terrain to initialize, then render
        await new Promise(resolve => setTimeout(resolve, 100));
        viewer.scene.requestRender();
        const applyStartupImagery = () => changeImagery(selectedImagery);
        applyStartupImagery();
        // Cesium's default base layer can finish wiring slightly later; re-apply once.
        setTimeout(applyStartupImagery, 300);
        applyMapWindowMode(mapWindowedMode);
        // Run a second pass after initial layout settles to avoid stale persisted
        // style states leaving fullscreen map in a broken size/visibility mode.
        setTimeout(() => applyMapWindowMode(mapWindowedMode), 120);
        setTimeout(() => ensureMapPrimaryVisibility(), 180);
        setTimeout(() => ensureMapPrimaryVisibility(), 520);
        applyMapSceneMode(mapSceneMode);

        ensureInAppUi();
        setupPanelTooltips();
        setupUnityBridge();
        enforceLegacyNavDisabled();

        // Setup debug controls
        setupDebugControls();
        console.log('Debug controls setup');

        // Setup navigation toolbar (legacy-disabled by default)
        setupNavigationToolbar();
        console.log(NAV_TOOLBAR_LEGACY_ENABLED ? 'Navigation toolbar setup' : 'Navigation toolbar disabled (legacy)');

        // Setup new features
        setupMediaGallery();
        setupLyrics();
        setupNotation();
        setupTriggerPadWindows();
        setupExtendedDebug();
        setupBackgroundAudio();
        setupGlobalAudioStopButton();
        console.log('Media gallery/lyrics/notation/debug/audio setup');

        // Load cached Unsplash images (and fetch missing ones)
        await loadCachedImages();
        console.log('Cached images loaded');

        populateRhythmPanel('all');
        console.log('Rhythm panel populated');

        // Populate carousel after images are loaded
        populateCarousel();
        console.log('Carousel populated');

        // Restore last selected rhythm content without camera traversal.
        restoreLastSelectedRhythmOnLoad();

        addUserMarker();
        console.log('User marker added');

        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(-5, 10, 5000000),
            orientation: {
                heading: 0.0,
                pitch: -Cesium.Math.PI_OVER_TWO * 0.7,
                roll: 0.0
            }
        });

        console.log('Camera positioned');

        // Hide loading screen
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.style.display = 'none';
        }

        console.log('Initialization complete');

        // Add domes after a short delay to ensure scene is ready
        setTimeout(() => {
            console.log('Scene should be ready, adding domes now...');
            populateAllRhythmColors(); // Must be called before addHolographicDomes
            addHolographicDomes();
            viewer.scene.requestRender();
        }, 1000);

    } catch (error) {
        console.error('Error initializing Cesium:', error);
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.innerHTML = `
                <div class="loading-spinner"></div>
                <div class="loading-text" style="max-width: 400px; font-size: 13px; color: #ff0000;">
                    Error: ${error.message}<br>
                    <span style="font-size: 10px;">Check console for details</span>
                </div>
            `;
        }
    }
}

async function refreshRhythmDatabaseAndUi(options = {}) {
    const skipStatus = !!options.silent;
    if (!skipStatus) console.log('Refreshing rhythm database and UI...');
    localStorage.removeItem('rrc_db_fingerprint');
    localStorage.removeItem('rrc_rhythm_cache');
    const fresh = await fetchRhythmsFromSupabase();
    if (fresh && Object.keys(fresh).length > 0) {
        allRhythms = fresh;
    }
    resetDemoRhythmsState();
    await applyLocalTranscribedNotations(allRhythms);
    mergeLocalCustomRhythmsIntoAllRhythms();
    await mergeLibraryRhythms();
    await loadCachedImages();
    if (currentRhythmSource === DEMO_SOURCE) {
        await ensureDemoRhythmsLoaded();
    }
    populateAllRhythmColors();
    populateRhythmPanel(currentRhythmSource);
    populateCarousel();
    updateDomesForSource(currentRhythmSource);
    renderJourneySourceList();
    if (typeof window._refreshRhythmSourceAfterCollectionsChanged === 'function') {
        window._refreshRhythmSourceAfterCollectionsChanged();
    }
    return fresh;
}

function setupDebugControls() {
    try {
        applyTopPanelButtonOrder(readTopPanelButtonOrder(), false);
        setupTopPanelReorder();
        applyTopPanelLayoutMode();
        applyTopPanelButtonLabels();
        const topButtonsCompactToggle = document.getElementById('top-buttons-compact-toggle');
        if (topButtonsCompactToggle) {
            let holdTimer = null;
            let holdTriggered = false;
            let holdStartX = 0;
            let holdStartY = 0;
            const HOLD_MS = 430;
            const MOVE_CANCEL_PX = 10;
            const clearHold = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
            };
            const maybeCancelHoldFromMove = (event) => {
                if (!holdTimer) return;
                const x = Number.isFinite(event?.clientX) ? event.clientX : holdStartX;
                const y = Number.isFinite(event?.clientY) ? event.clientY : holdStartY;
                if (Math.abs(x - holdStartX) > MOVE_CANCEL_PX || Math.abs(y - holdStartY) > MOVE_CANCEL_PX) {
                    clearHold();
                }
            };
            topButtonsCompactToggle.addEventListener('pointerdown', (event) => {
                if (event.pointerType !== 'touch' && event.button !== 0) return;
                holdTriggered = false;
                holdStartX = Number.isFinite(event.clientX) ? event.clientX : 0;
                holdStartY = Number.isFinite(event.clientY) ? event.clientY : 0;
                clearHold();
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    holdTriggered = true;
                    topButtonsSideMode = !topButtonsSideMode;
                    localStorage.setItem('topButtonsSideMode', topButtonsSideMode ? 'true' : 'false');
                    applyTopPanelLayoutMode();
                }, HOLD_MS);
            });
            topButtonsCompactToggle.addEventListener('pointermove', maybeCancelHoldFromMove);
            topButtonsCompactToggle.addEventListener('pointerup', clearHold);
            topButtonsCompactToggle.addEventListener('pointercancel', clearHold);
            topButtonsCompactToggle.addEventListener('pointerleave', clearHold);
            topButtonsCompactToggle.addEventListener('dragstart', clearHold);
            topButtonsCompactToggle.addEventListener('click', () => {
                if (holdTriggered) {
                    holdTriggered = false;
                    return;
                }
                topButtonsCompactMode = !topButtonsCompactMode;
                if (topButtonsCompactMode && !topButtonsUseEmoji) {
                    topButtonsUseEmoji = true;
                    localStorage.setItem('topButtonsUseEmoji', 'true');
                    const topButtonsEmojiToggle = document.getElementById('topButtonsEmojiToggle');
                    if (topButtonsEmojiToggle) topButtonsEmojiToggle.checked = true;
                }
                localStorage.setItem('topButtonsCompactMode', topButtonsCompactMode ? 'true' : 'false');
                applyTopPanelButtonLabels();
            });
        }
        const mapToggle = document.getElementById('map-toggle');
        if (mapToggle) {
            let holdTimer = null;
            let holdStartX = 0;
            let holdStartY = 0;
            let holdTriggered = false;
            let suppressClickUntil = 0;
            const HOLD_MS = 430;
            const MOVE_CANCEL_PX = 10;
            const clearHoldTimer = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
            };
            const startHold = (event) => {
                clearHoldTimer();
                holdTriggered = false;
                holdStartX = Number.isFinite(event?.clientX) ? event.clientX : 0;
                holdStartY = Number.isFinite(event?.clientY) ? event.clientY : 0;
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    holdTriggered = true;
                    suppressClickUntil = Date.now() + 700;
                    applyMapWindowMode(!mapWindowedMode);
                    const mapWindowedToggle = document.getElementById('mapWindowedToggle');
                    if (mapWindowedToggle) mapWindowedToggle.checked = mapWindowedMode;
                }, HOLD_MS);
            };
            const maybeCancelHoldFromMove = (event) => {
                if (!holdTimer) return;
                const x = Number.isFinite(event?.clientX) ? event.clientX : holdStartX;
                const y = Number.isFinite(event?.clientY) ? event.clientY : holdStartY;
                const dx = Math.abs(x - holdStartX);
                const dy = Math.abs(y - holdStartY);
                if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) clearHoldTimer();
            };
            mapToggle.addEventListener('pointerdown', (event) => {
                if (event.pointerType !== 'touch' && event.button !== 0) return;
                startHold(event);
            });
            mapToggle.addEventListener('pointermove', maybeCancelHoldFromMove);
            mapToggle.addEventListener('pointerup', clearHoldTimer);
            mapToggle.addEventListener('pointercancel', clearHoldTimer);
            mapToggle.addEventListener('pointerleave', clearHoldTimer);
            mapToggle.addEventListener('dragstart', clearHoldTimer);
            mapToggle.addEventListener('click', () => {
                if (holdTriggered || Date.now() < suppressClickUntil) {
                    holdTriggered = false;
                    return;
                }
                const nextMode = normalizeMapSceneMode(mapSceneMode) === '2d' ? '3d' : '2d';
                applyMapSceneMode(nextMode);
            });
            syncMapWindowDragBarUi();
        }
        const tidyToggle = document.getElementById('tidy-toggle');
        if (tidyToggle) {
            let holdTimer = null;
            let holdStartX = 0;
            let holdStartY = 0;
            let holdTriggered = false;
            let suppressClickUntil = 0;
            const HOLD_MS = 520;
            const MOVE_CANCEL_PX = 10;
            const clearHoldTimer = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
            };
            const startHold = (event) => {
                clearHoldTimer();
                holdTriggered = false;
                holdStartX = Number.isFinite(event?.clientX) ? event.clientX : 0;
                holdStartY = Number.isFinite(event?.clientY) ? event.clientY : 0;
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    holdTriggered = true;
                    suppressClickUntil = Date.now() + 700;
                    closeAllFloatingWindows();
                }, HOLD_MS);
            };
            const maybeCancelHoldFromMove = (event) => {
                if (!holdTimer) return;
                const x = Number.isFinite(event?.clientX) ? event.clientX : holdStartX;
                const y = Number.isFinite(event?.clientY) ? event.clientY : holdStartY;
                const dx = Math.abs(x - holdStartX);
                const dy = Math.abs(y - holdStartY);
                if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
                    clearHoldTimer();
                }
            };
            tidyToggle.title = 'Click: Tidy windows | Hold: Close all windows';
            tidyToggle.addEventListener('pointerdown', (event) => {
                if (event.pointerType !== 'touch' && event.button !== 0) return;
                startHold(event);
            });
            tidyToggle.addEventListener('pointermove', maybeCancelHoldFromMove);
            tidyToggle.addEventListener('pointerup', clearHoldTimer);
            tidyToggle.addEventListener('pointercancel', clearHoldTimer);
            tidyToggle.addEventListener('pointerleave', clearHoldTimer);
            tidyToggle.addEventListener('dragstart', clearHoldTimer);
            tidyToggle.addEventListener('click', () => {
                if (holdTriggered || Date.now() < suppressClickUntil) {
                    holdTriggered = false;
                    return;
                }
                tidyFloatingWindowsLayout();
            });
        }
        const windowSelectToggle = document.getElementById('window-select-toggle');
        if (windowSelectToggle) {
            windowSelectToggle.addEventListener('click', () => {
                if (mapWindowedMode) {
                    // In windowed map mode this behavior stays auto-enabled by design.
                    syncWindowSelectModeUi();
                    return;
                }
                windowSelectManualMode = !windowSelectManualMode;
                localStorage.setItem('windowSelectManualMode', windowSelectManualMode ? 'true' : 'false');
                syncWindowSelectModeUi();
            });
            syncWindowSelectModeUi();
        }
        // Toggle button
        const debugToggle = document.getElementById('debug-toggle');
        const debugControls = document.getElementById('debug-controls');
        if (debugToggle && debugControls) {
            debugToggle.addEventListener('click', () => {
                const willShow = debugControls.classList.contains('hidden') || debugControls.classList.contains('panel-hidden');
                debugControls.classList.toggle('hidden', !willShow);
                if (willShow) {
                    debugControls.classList.remove('panel-hidden');
                    debugControls.style.zIndex = '5200';
                    clampFloatingPanelOnOpen(debugControls);
                    if (typeof window._updateFloatingWindowScale === 'function') {
                        window._updateFloatingWindowScale(debugControls);
                    }
                }
            });
        } else {
            console.warn('setupDebugControls: debugToggle or debugControls element not found');
        }

        // Hide UI toggle
        const hideUIToggle = document.getElementById('hide-ui-toggle');
        if (hideUIToggle) {
            hideUIToggle.addEventListener('click', () => {
                uiHidden = !uiHidden;
                document.body.classList.toggle('ui-hidden', uiHidden);
                applyTopPanelButtonLabels();
            });
        } else {
            console.warn('setupDebugControls: hide-ui-toggle element not found');
        }

        // ── Production mode: hide both debug buttons ──
        let debugVisible = localStorage.getItem('debugVisible') !== 'false';
        function setDebugVisibility(show) {
            debugVisible = show;
            localStorage.setItem('debugVisible', show);
            if (debugToggle) debugToggle.style.display = show ? '' : 'none';
            if (hideUIToggle) hideUIToggle.style.display = show ? '' : 'none';
            if (show && debugControls) debugControls.style.zIndex = '5200';
            if (!show && debugControls) debugControls.classList.add('hidden');
        }
        if (!debugVisible) setDebugVisibility(false);

        // Cmd+Opt+Shift+D (Mac) or Ctrl+Alt+Shift+D (Win) to toggle debug
        document.addEventListener('keydown', (e) => {
            if (e.key === 'd' || e.key === 'D') {
                if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey) {
                    e.preventDefault();
                    setDebugVisibility(!debugVisible);
                }
            }
        });

        // Vuplex message to toggle debug
        window.addEventListener('message', (e) => {
            if (e.data?.type === 'toggleDebug') setDebugVisibility(!debugVisible);
            if (e.data?.type === 'hideDebug') setDebugVisibility(false);
            if (e.data?.type === 'showDebug') setDebugVisibility(true);
        });

        // Expose for console access
        window.toggleDebug = () => setDebugVisibility(!debugVisible);

        // Source toggle buttons (All/Local/Community/Demo/User Collections)
        const allBtn = document.getElementById('all-btn');
        const localBtn = document.getElementById('local-btn');
        const communityBtn = document.getElementById('community-btn');
        const demoBtn = document.getElementById('demo-btn');
        const createCollectionBtn = document.getElementById('journey-btn');
        const sourceToggleWrap = document.querySelector('#rhythm-browse-view .rhythm-source-toggle');

        const clearSourceButtons = () => {
            if (!sourceToggleWrap) return;
            sourceToggleWrap.querySelectorAll('.source-btn').forEach((btn) => btn.classList.remove('active'));
        };

        const markActiveSourceButton = () => {
            clearSourceButtons();
            if (currentRhythmSource === 'Local') {
                if (localBtn) localBtn.classList.add('active');
                return;
            }
            if (currentRhythmSource === 'Community') {
                if (communityBtn) communityBtn.classList.add('active');
                return;
            }
            if (currentRhythmSource === DEMO_SOURCE) {
                if (demoBtn) demoBtn.classList.add('active');
                return;
            }
            if (isUserCollectionSource(currentRhythmSource) && sourceToggleWrap) {
                const activeBtn = sourceToggleWrap.querySelector(`.source-btn.user-category[data-source="${currentRhythmSource}"]`);
                if (activeBtn) {
                    activeBtn.classList.add('active');
                    return;
                }
            }
            currentRhythmSource = 'all';
            if (allBtn) allBtn.classList.add('active');
        };

        const setSource = async (source) => {
            let next = source;
            if (next === 'Journey') next = 'all';
            if (isUserCollectionSource(next)) {
                const preset = getUserCollectionPresetById(getUserCollectionIdFromSource(next));
                if (!preset) next = 'all';
            }
            currentRhythmSource = next;
            markActiveSourceButton();
            if (next === DEMO_SOURCE) {
                const ok = await ensureDemoRhythmsLoaded({ force: true });
                if (!ok) {
                    currentRhythmSource = 'all';
                    markActiveSourceButton();
                }
            }
            populateRhythmPanel(currentRhythmSource);
            populateCarousel();
            renderJourneySourceList();
            updateDomesForSource(currentRhythmSource);
        };

        const renderUserCollectionCategoryButtons = () => {
            if (!sourceToggleWrap) return;
            sourceToggleWrap.querySelectorAll('.source-btn.user-category').forEach((btn) => btn.remove());
            const presets = readJourneyPresets();
            presets.forEach((preset) => {
                const sourceValue = USER_COLLECTION_SOURCE_PREFIX + preset.id;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'source-btn user-category';
                btn.dataset.source = sourceValue;
                btn.title = `${preset.name} (User Collection)`;
                btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2l3 6 7 .9-5 4.8 1.3 7.1L12 18l-6.3 2.8L7 13.7 2 8.9 9 8z"/></svg>';
                const span = document.createElement('span');
                span.textContent = preset.name;
                btn.appendChild(span);
                btn.addEventListener('click', () => { void setSource(sourceValue); });
                if (createCollectionBtn && createCollectionBtn.parentElement === sourceToggleWrap) {
                    sourceToggleWrap.insertBefore(btn, createCollectionBtn);
                } else {
                    sourceToggleWrap.appendChild(btn);
                }
            });
            markActiveSourceButton();
        };

        window._renderUserCollectionCategoryButtons = renderUserCollectionCategoryButtons;
        window._refreshRhythmSourceAfterCollectionsChanged = () => {
            renderUserCollectionCategoryButtons();
            void setSource(currentRhythmSource);
        };

        if (allBtn) allBtn.addEventListener('click', () => { void setSource('all'); });
        if (localBtn) localBtn.addEventListener('click', () => { void setSource('Local'); });
        if (communityBtn) communityBtn.addEventListener('click', () => { void setSource('Community'); });
        if (demoBtn) demoBtn.addEventListener('click', () => { void setSource(DEMO_SOURCE); });
        if (createCollectionBtn) {
            createCollectionBtn.addEventListener('click', () => {
                setRhythmBrowserTab('journeys');
            });
        }
        renderUserCollectionCategoryButtons();
        void setSource(currentRhythmSource);

        // Rhythm panel list/carousel mode
        const rhythmPanel = document.getElementById('rhythm-panel');
        const rhythmOpenCreateBtn = document.getElementById('rhythm-open-create-btn');
        const rhythmRefreshBtn = document.getElementById('rhythm-refresh-btn');
        const rhythmViewToggle = document.getElementById('rhythm-view-toggle');
        const getPanelMode = () => (
            rhythmPanel && rhythmPanel.classList.contains('carousel-mode') ? 'carousel' : 'cards'
        );
        const saveRhythmPanelModeSize = (mode) => {
            if (!rhythmPanel) return;
            const rect = rhythmPanel.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) return;
            localStorage.setItem(`rhythmPanelSize_${mode}`, JSON.stringify({
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            }));
        };
        const applyRhythmPanelModeSize = (mode) => {
            if (!rhythmPanel) return;
            const raw = localStorage.getItem(`rhythmPanelSize_${mode}`);
            if (!raw) return;
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || !parsed.width || !parsed.height) return;
                rhythmPanel.style.width = parsed.width + 'px';
                rhythmPanel.style.height = parsed.height + 'px';
                rhythmPanel.style.maxHeight = 'none';
                rhythmPanel.style.left = rhythmPanel.getBoundingClientRect().left + 'px';
                rhythmPanel.style.top = rhythmPanel.getBoundingClientRect().top + 'px';
                rhythmPanel.style.transform = 'none';
                rhythmPanel.style.right = 'auto';
                rhythmPanel.style.bottom = 'auto';
                rhythmPanel.dataset.windowPinned = '1';
                if (typeof window._updateFloatingWindowScale === 'function') {
                    window._updateFloatingWindowScale(rhythmPanel);
                }
            } catch {}
        };
        const setRhythmPanelMode = (mode, options = {}) => {
            if (!rhythmPanel || !rhythmViewToggle) return;
            const saveCurrent = options.saveCurrent !== false;
            const restoreTarget = options.restoreTarget !== false;
            if (saveCurrent) saveRhythmPanelModeSize(getPanelMode());
            const isCarousel = mode === 'carousel';
            rhythmPanel.classList.toggle('carousel-mode', isCarousel);
            rhythmViewToggle.textContent = isCarousel ? 'Card View' : 'Carousel View';
            localStorage.setItem('rhythmPanelViewMode', isCarousel ? 'carousel' : 'cards');
            if (restoreTarget) applyRhythmPanelModeSize(isCarousel ? 'carousel' : 'cards');
            if (isCarousel) populateCarousel();
        };
        if (rhythmPanel && rhythmViewToggle) {
            rhythmViewToggle.addEventListener('click', () => {
                const toCarousel = !rhythmPanel.classList.contains('carousel-mode');
                setRhythmPanelMode(toCarousel ? 'carousel' : 'cards', { saveCurrent: true, restoreTarget: true });
            });
            const savedMode = localStorage.getItem('rhythmPanelViewMode');
            setRhythmPanelMode(savedMode === 'carousel' ? 'carousel' : 'cards', { saveCurrent: false, restoreTarget: true });
            window._setRhythmPanelMode = setRhythmPanelMode;
            window.addEventListener('beforeunload', () => {
                saveRhythmPanelModeSize(getPanelMode());
            });
        }
        const rhythmCreateInlineRoot = document.getElementById('rhythm-create-inline');
        const rhythmInlineStatus = document.getElementById('rhythm-inline-status');
        let rhythmCreateModePreviousState = null;

        const setInlineStatus = (text, tone = '') => {
            if (!rhythmInlineStatus) return;
            rhythmInlineStatus.textContent = text;
            rhythmInlineStatus.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
            if (tone === 'success') rhythmInlineStatus.classList.add('panel-status-success');
            if (tone === 'warn') rhythmInlineStatus.classList.add('panel-status-warn');
            if (tone === 'error') rhythmInlineStatus.classList.add('panel-status-error');
        };

        const getInlineValue = (id) => {
            const el = document.getElementById(id);
            return el ? String(el.value || '').trim() : '';
        };

        const splitLines = (raw) => String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean);

        const captureWindowStateForCreateMode = () => {
            const snapshot = {};
            document.querySelectorAll('[data-floating-window="true"]').forEach((panel) => {
                if (!(panel instanceof HTMLElement)) return;
                if (!panel.id) return;
                snapshot[panel.id] = {
                    hidden: panel.classList.contains('hidden'),
                    panelHidden: panel.classList.contains('panel-hidden'),
                    active: panel.classList.contains('active')
                };
            });
            return snapshot;
        };

        const restoreWindowStateForCreateMode = (snapshot) => {
            if (!snapshot || typeof snapshot !== 'object') return;
            Object.entries(snapshot).forEach(([id, state]) => {
                const panel = document.getElementById(id);
                if (!(panel instanceof HTMLElement)) return;
                panel.classList.toggle('hidden', !!state.hidden);
                panel.classList.toggle('panel-hidden', !!state.panelHidden);
                panel.classList.toggle('active', !!state.active);
            });
            if (typeof window._syncTopPanelToggleStates === 'function') {
                window._syncTopPanelToggleStates();
            }
            if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
                window._syncNotationWindowVisibilityFromDom();
            }
        };

        const showOnlyCreateReceivers = () => {
            const visibleIds = new Set(['cesiumContainer', 'rhythm-panel', 'info-banner', 'history-box', 'image-window']);
            document.querySelectorAll('[data-floating-window="true"]').forEach((panel) => {
                if (!(panel instanceof HTMLElement)) return;
                const keep = visibleIds.has(panel.id);
                panel.classList.toggle('hidden', !keep);
                panel.classList.toggle('panel-hidden', !keep);
                if (!keep) panel.classList.remove('active');
            });
            ['info-banner', 'history-box', 'image-window'].forEach((id) => {
                const panel = document.getElementById(id);
                if (!(panel instanceof HTMLElement)) return;
                panel.classList.add('active');
            });
            if (typeof window._syncTopPanelToggleStates === 'function') {
                window._syncTopPanelToggleStates();
            }
            if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
                window._syncNotationWindowVisibilityFromDom();
            }
        };

        const applyInlineCreatePreview = () => {
            if (!rhythmPanel || !rhythmPanel.classList.contains('create-mode')) return;
            const name = getInlineValue('rhythm-inline-name') || 'New Rhythm';
            const subtitle = getInlineValue('rhythm-inline-subtitle');
            const region = getInlineValue('rhythm-inline-region');
            const context = getInlineValue('rhythm-inline-context');
            const color = getInlineValue('rhythm-inline-color') || '#00ffff';
            const videos = splitLines(getInlineValue('rhythm-inline-videos'));
            const pictures = splitLines(getInlineValue('rhythm-inline-pictures'));
            const lyrics = getInlineValue('rhythm-inline-lyrics');

            const infoBanner = document.getElementById('info-banner');
            const historyBox = document.getElementById('history-box');
            const imageWindow = document.getElementById('image-window');
            const infoTitle = document.getElementById('info-title');
            const infoDescription = document.getElementById('info-description');
            const infoDistance = document.getElementById('info-distance');
            const historyText = document.getElementById('history-text');
            const contextImage = document.getElementById('context-image');

            if (infoTitle) infoTitle.textContent = `${name}${region ? ' - ' + region : ''}`;
            if (infoDescription) infoDescription.textContent = subtitle || 'Live creation preview';
            if (infoDistance) infoDistance.textContent = 'Creation Preview';
            if (historyText) historyText.textContent = context || 'Type cultural context to preview it here.';
            if (contextImage) {
                const fallbackImage = getBundledFallbackImage(name || region || 'create-preview');
                contextImage.onerror = () => {
                    contextImage.onerror = null;
                    contextImage.src = fallbackImage;
                };
                contextImage.src = pictures[0] || fallbackImage;
            }

            if (infoBanner) {
                infoBanner.style.borderColor = `${color}80`;
                infoBanner.style.boxShadow = `0 0 30px ${color}55, inset 0 0 20px ${color}18`;
                infoBanner.classList.add('active');
            }
            if (historyBox) {
                historyBox.style.borderColor = `${color}66`;
                historyBox.style.boxShadow = `0 0 30px ${color}40, inset 0 0 20px ${color}10`;
                historyBox.classList.add('active');
            }
            if (imageWindow) {
                imageWindow.style.borderColor = `${color}66`;
                imageWindow.style.boxShadow = `0 0 30px ${color}40, inset 0 0 20px ${color}10`;
                imageWindow.classList.add('active');
            }

            const previewMedia = [];
            if (pictures[0]) previewMedia.push({ type: 'photo', url: pictures[0], embedUrl: '', caption: name });
            videos.forEach((url) => {
                if (!url) return;
                previewMedia.push({ type: 'video', url, embedUrl: toEmbedUrl(url), caption: '' });
            });
            if (previewMedia.length > 0) {
                currentMediaItems = previewMedia;
                currentMediaIndex = 0;
                if (typeof window._updateMediaGallery === 'function') window._updateMediaGallery();
            }
            currentSongTexts = lyrics
                ? [{
                    id: `preview_${Date.now()}`,
                    language: getInlineValue('rhythm-inline-lyrics-language') || 'unknown',
                    role: getInlineValue('rhythm-inline-lyrics-role') || 'lyrics',
                    lyrics
                }]
                : [];

            showOnlyCreateReceivers();
            scheduleFitInfoText();
            scheduleFitHistoryText();
        };

        const prefillInlineCreateFromCurrent = () => {
            const rhythm = selectedRhythm && allRhythms[selectedRhythm] ? allRhythms[selectedRhythm] : null;
            if (!rhythm) return;
            const write = (id, val) => {
                const el = document.getElementById(id);
                if (el && !String(el.value || '').trim()) el.value = String(val || '');
            };
            write('rhythm-inline-name', rhythm.name || '');
            write('rhythm-inline-subtitle', rhythm.subtitle || rhythm.summary || '');
            write('rhythm-inline-region', rhythm.region || '');
            write('rhythm-inline-community', rhythm.community || '');
            const prefilledCreator = String(rhythm.creator || '').trim();
            write('rhythm-inline-creator', prefilledCreator);
            write('rhythm-inline-library', rhythm.library || 'Local');
            write('rhythm-inline-color', rhythm.color || '#00ffff');
            write('rhythm-inline-lat', Number.isFinite(rhythm.lat) ? rhythm.lat : '');
            write('rhythm-inline-lon', Number.isFinite(rhythm.lon) ? rhythm.lon : '');
            write('rhythm-inline-context', rhythm.culturalContext || rhythm.summary || '');
            const videoUrls = Array.isArray(rhythm.listeningExamples)
                ? rhythm.listeningExamples.map((entry) => String(entry?.url || '').trim()).filter(Boolean)
                : (rhythm.videoUrl ? [rhythm.videoUrl] : []);
            write('rhythm-inline-videos', videoUrls.join('\n'));
            write('rhythm-inline-pictures', rhythm.cachedImageUrl || '');
            const creatorEl = document.getElementById('rhythm-inline-creator');
            if (creatorEl) {
                void getCurrentPreferredCreatorName().then((name) => {
                    if (!name) return;
                    const current = String(creatorEl.value || '').trim();
                    if (!current || (prefilledCreator && current === prefilledCreator)) {
                        creatorEl.value = name;
                    }
                });
            }
        };

        const setCreateModeActive = (enabled) => {
            if (!rhythmPanel || !rhythmCreateInlineRoot) return;
            if (enabled) {
                if (!rhythmCreateModePreviousState) {
                    rhythmCreateModePreviousState = captureWindowStateForCreateMode();
                }
                rhythmPanel.classList.add('create-mode');
                rhythmCreateInlineRoot.classList.remove('hidden');
                if (rhythmOpenCreateBtn) rhythmOpenCreateBtn.textContent = 'Close Creator';
                setRhythmBrowserTab('browse');
                prefillInlineCreateFromCurrent();
                const creatorEl = document.getElementById('rhythm-inline-creator');
                if (creatorEl && !String(creatorEl.value || '').trim()) {
                    void getCurrentPreferredCreatorName().then((name) => {
                        if (!name) return;
                        if (!String(creatorEl.value || '').trim()) creatorEl.value = name;
                    });
                }
                applyInlineCreatePreview();
                setInlineStatus('Creation mode is live. Edit fields and preview in title/context/media.', 'success');
                return;
            }
            rhythmPanel.classList.remove('create-mode');
            rhythmCreateInlineRoot.classList.add('hidden');
            if (rhythmOpenCreateBtn) rhythmOpenCreateBtn.textContent = 'Create';
            restoreWindowStateForCreateMode(rhythmCreateModePreviousState);
            rhythmCreateModePreviousState = null;
            setInlineStatus('Create mode closed.', 'warn');
        };

        const copyInlineFormToLegacyCreator = () => {
            const copyText = (fromId, toId) => {
                const fromEl = document.getElementById(fromId);
                const toEl = document.getElementById(toId);
                if (!fromEl || !toEl) return;
                toEl.value = fromEl.value;
            };
            copyText('rhythm-inline-name', 'rhythm-create-name');
            copyText('rhythm-inline-subtitle', 'rhythm-create-subtitle');
            copyText('rhythm-inline-region', 'rhythm-create-region');
            copyText('rhythm-inline-community', 'rhythm-create-community');
            copyText('rhythm-inline-creator', 'rhythm-create-creator');
            copyText('rhythm-inline-library', 'rhythm-create-library');
            copyText('rhythm-inline-color', 'rhythm-create-color');
            copyText('rhythm-inline-lat', 'rhythm-create-lat');
            copyText('rhythm-inline-lon', 'rhythm-create-lon');
            copyText('rhythm-inline-context', 'rhythm-create-context');
            copyText('rhythm-inline-lyrics', 'rhythm-create-lyrics');
            copyText('rhythm-inline-lyrics-language', 'rhythm-create-lyrics-language');
            copyText('rhythm-inline-lyrics-role', 'rhythm-create-lyrics-role');
            copyText('rhythm-inline-tags', 'rhythm-create-tags');
            copyText('rhythm-inline-videos', 'rhythm-create-videos');
            copyText('rhythm-inline-pictures', 'rhythm-create-pictures');

            const inlineNotationFile = document.getElementById('rhythm-inline-notation-file');
            const legacyNotationFile = document.getElementById('rhythm-create-notation-file');
            const useCurrentNotation = document.getElementById('rhythm-inline-use-current-notation');
            const notationJson = document.getElementById('rhythm-create-notation-json');
            const notationPath = document.getElementById('rhythm-create-notation-path');
            const uploadNotation = document.getElementById('rhythm-create-upload-notation');
            const hasInlineNotationFile = !!(inlineNotationFile && inlineNotationFile.files && inlineNotationFile.files.length > 0);
            if (uploadNotation) uploadNotation.checked = hasInlineNotationFile || !!(useCurrentNotation && useCurrentNotation.checked);
            if (hasInlineNotationFile && legacyNotationFile) {
                const dt = new DataTransfer();
                Array.from(inlineNotationFile.files).forEach((file) => dt.items.add(file));
                legacyNotationFile.files = dt.files;
                legacyNotationFile.dispatchEvent(new Event('change'));
            } else if (useCurrentNotation && useCurrentNotation.checked && notationJson) {
                const currentData = latestNotationRhythmData && typeof latestNotationRhythmData === 'object'
                    ? latestNotationRhythmData
                    : null;
                if (currentData && Array.isArray(currentData.instruments)) {
                    notationJson.value = JSON.stringify(currentData, null, 2);
                }
                if (notationPath && !String(notationPath.value || '').trim()) {
                    const baseName = getInlineValue('rhythm-inline-name') || 'rhythm';
                    notationPath.value = `Notation/notations/${slugifyRhythmKey(baseName)}.json`;
                }
            }

            const inlinePictures = document.getElementById('rhythm-inline-picture-files');
            const legacyPictures = document.getElementById('rhythm-create-picture-files');
            if (inlinePictures && legacyPictures && inlinePictures.files && inlinePictures.files.length > 0) {
                const dt = new DataTransfer();
                Array.from(inlinePictures.files).forEach((file) => dt.items.add(file));
                legacyPictures.files = dt.files;
            }
        };

        if (rhythmOpenCreateBtn) {
            rhythmOpenCreateBtn.addEventListener('click', () => {
                const next = !rhythmPanel.classList.contains('create-mode');
                setCreateModeActive(next);
            });
        }
        if (rhythmCreateInlineRoot) {
            const previewInputs = [
                'rhythm-inline-name',
                'rhythm-inline-subtitle',
                'rhythm-inline-region',
                'rhythm-inline-community',
                'rhythm-inline-color',
                'rhythm-inline-context',
                'rhythm-inline-lyrics',
                'rhythm-inline-lyrics-language',
                'rhythm-inline-lyrics-role',
                'rhythm-inline-videos',
                'rhythm-inline-pictures'
            ];
            previewInputs.forEach((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener('input', applyInlineCreatePreview);
                el.addEventListener('change', applyInlineCreatePreview);
            });
            const inlinePictureFiles = document.getElementById('rhythm-inline-picture-files');
            if (inlinePictureFiles) {
                inlinePictureFiles.addEventListener('change', () => {
                    const files = inlinePictureFiles.files ? Array.from(inlinePictureFiles.files) : [];
                    if (files.length > 0) {
                        const url = URL.createObjectURL(files[0]);
                        const pictureLinks = document.getElementById('rhythm-inline-pictures');
                        if (pictureLinks && !String(pictureLinks.value || '').trim()) {
                            pictureLinks.value = url;
                        }
                    }
                    applyInlineCreatePreview();
                });
            }
            const previewLocationBtn = document.getElementById('rhythm-inline-preview-location');
            if (previewLocationBtn) {
                previewLocationBtn.addEventListener('click', () => {
                    const lat = parseFloat(getInlineValue('rhythm-inline-lat'));
                    const lon = parseFloat(getInlineValue('rhythm-inline-lon'));
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                        setInlineStatus('Enter valid latitude and longitude first.', 'warn');
                        return;
                    }
                    try {
                        viewer.camera.flyTo({
                            destination: Cesium.Cartesian3.fromDegrees(
                                lon,
                                lat,
                                normalizeJourneyAltitudeMeters(zoomInAltitude, 600000)
                            ),
                            duration: 1.6,
                            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
                        });
                        setInlineStatus('Previewed map location.', 'success');
                    } catch (err) {
                        setInlineStatus(`Map preview failed: ${err?.message || err}`, 'error');
                    }
                });
            }
            const cancelBtn = document.getElementById('rhythm-inline-cancel');
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => setCreateModeActive(false));
            }
            const saveBtn = document.getElementById('rhythm-inline-save');
            if (saveBtn) {
                saveBtn.addEventListener('click', async () => {
                    const legacySubmit = document.getElementById('rhythm-create-submit');
                    const legacyStatus = document.getElementById('rhythm-create-status');
                    if (!legacySubmit || !legacyStatus) {
                        setInlineStatus('Save pipeline is not ready.', 'error');
                        return;
                    }
                    copyInlineFormToLegacyCreator();
                    legacySubmit.click();
                    const targetLibrary = getInlineValue('rhythm-inline-library') || 'Local';
                    setInlineStatus(
                        String(targetLibrary).toLowerCase() === 'community'
                            ? 'Saving rhythm to community library...'
                            : 'Saving rhythm locally...',
                        'warn'
                    );
                    const started = Date.now();
                    const waitForResult = () => new Promise((resolve) => {
                        const timer = setInterval(() => {
                            const success = legacyStatus.classList.contains('panel-status-success');
                            const error = legacyStatus.classList.contains('panel-status-error');
                            const text = String(legacyStatus.textContent || '').trim();
                            if (success || error || Date.now() - started > 20000) {
                                clearInterval(timer);
                                resolve({ success, error, text });
                            }
                        }, 250);
                    });
                    const result = await waitForResult();
                    if (result.success) {
                        setInlineStatus(result.text || 'Saved successfully.', 'success');
                        setCreateModeActive(false);
                    } else {
                        setInlineStatus(result.text || 'Save failed. Check your fields and connection.', 'error');
                    }
                });
            }
        }
        if (rhythmRefreshBtn) {
            rhythmRefreshBtn.addEventListener('click', async () => {
                const oldText = rhythmRefreshBtn.textContent || 'Refresh DB';
                rhythmRefreshBtn.textContent = 'Refreshing...';
                rhythmRefreshBtn.disabled = true;
                try {
                    await refreshRhythmDatabaseAndUi();
                    rhythmRefreshBtn.textContent = 'Done';
                } catch (err) {
                    console.error('Rhythm refresh failed:', err);
                    rhythmRefreshBtn.textContent = 'Failed';
                } finally {
                    setTimeout(() => {
                        rhythmRefreshBtn.textContent = oldText;
                        rhythmRefreshBtn.disabled = false;
                    }, 1200);
                }
            });
        }

        const rhythmTabBrowse = document.getElementById('rhythm-tab-browse');
        const rhythmTabJourneys = document.getElementById('rhythm-tab-journeys');
        if (rhythmTabBrowse) {
            rhythmTabBrowse.addEventListener('click', () => setRhythmBrowserTab('browse'));
        }
        if (rhythmTabJourneys) {
            rhythmTabJourneys.addEventListener('click', () => setRhythmBrowserTab('journeys'));
        }
        setupJourneyBuilder();
        setRhythmBrowserTab(rhythmPanelTab);
        window._setRhythmBrowserTab = setRhythmBrowserTab;

        // Panel toggles
        const clampFloatingPanelOnOpen = (panelEl) => {
            if (!panelEl) return;
            const rect = panelEl.getBoundingClientRect();
            const style = window.getComputedStyle(panelEl);
            const minW = parseInt(panelEl.dataset.windowMinW, 10) || parseInt(style.minWidth, 10) || 220;
            const minH = parseInt(panelEl.dataset.windowMinH, 10) || parseInt(style.minHeight, 10) || 120;
            const width = Math.max(minW, rect.width || parseInt(style.width, 10) || minW);
            const height = Math.max(minH, rect.height || parseInt(style.height, 10) || minH);
            const gap = 8;
            const topUi = document.getElementById('top-panel-toggles');
            let topClearance = 60;
            if (topUi) {
                const topUiStyle = window.getComputedStyle(topUi);
                if (topUiStyle.display !== 'none' && topUiStyle.visibility !== 'hidden') {
                    if (!topUi.classList.contains('top-buttons-side')) {
                        topClearance = Math.max(topClearance, Math.ceil(topUi.getBoundingClientRect().bottom + 8));
                    }
                }
            }
            const left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap));
            const top = Math.max(topClearance, Math.min(rect.top, window.innerHeight - height - gap));
            panelEl.style.position = 'fixed';
            panelEl.style.left = Math.round(left) + 'px';
            panelEl.style.top = Math.round(top) + 'px';
            panelEl.style.right = 'auto';
            panelEl.style.bottom = 'auto';
            panelEl.style.transform = 'none';
            panelEl.dataset.windowPinned = '1';
            if (typeof window._updateFloatingWindowScale === 'function') {
                window._updateFloatingWindowScale(panelEl);
            }
        };
        const panelTogglePairs = [
            ['views-toggle', 'views-panel'],
            ['auth-toggle', 'auth-panel'],
            ['session-toggle', 'session-panel'],
            ['serve-local-toggle', 'serve-panel'],
            ['stage-toggle', 'stage-panel']
        ];
        const raisePanel = (panelEl) => {
            if (!panelEl) return;
            if (typeof window._bringFloatingWindowToFront === 'function') {
                window._bringFloatingWindowToFront(panelEl);
                return;
            }
            const z = parseInt(panelEl.style.zIndex, 10);
            panelEl.style.zIndex = String((Number.isFinite(z) ? z : 2600) + 1);
        };
        panelTogglePairs.forEach(([toggleId, panelId]) => {
            const toggleEl = document.getElementById(toggleId);
            const panelEl = document.getElementById(panelId);
            if (!toggleEl || !panelEl) return;
            toggleEl.addEventListener('click', () => {
                const currentlyHidden = panelEl.classList.contains('hidden') || panelEl.classList.contains('panel-hidden');
                const willShow = currentlyHidden;
                panelEl.classList.toggle('hidden', !willShow);
                if (willShow) {
                    // These panels may be persisted with panel-hidden; clear both states on show.
                    panelEl.classList.remove('panel-hidden');
                }
                if (willShow) {
                    clampFloatingPanelOnOpen(panelEl);
                    raisePanel(panelEl);
                }
            });
        });

        // Top-row visibility toggles for floating windows
        const visibilityPairs = [
            ['rhythm-toggle', 'rhythm-panel'],
            ['info-toggle', 'info-banner'],
            ['history-toggle', 'history-box'],
            ['media-toggle', 'image-window'],
            ['nav-toggle', 'nav-toolbar']
        ];
        const syncToggleState = (toggleEl, panelEl) => {
            const hiddenByClass = panelEl.classList.contains('panel-hidden');
            const hiddenByStyle = window.getComputedStyle(panelEl).display === 'none' || window.getComputedStyle(panelEl).visibility === 'hidden';
            toggleEl.classList.toggle('active', !(hiddenByClass || hiddenByStyle));
        };
        window._syncTopPanelToggleStates = () => {
            visibilityPairs.forEach(([toggleId, panelId]) => {
                const toggleEl = document.getElementById(toggleId);
                const panelEl = document.getElementById(panelId);
                if (!toggleEl || !panelEl) return;
                syncToggleState(toggleEl, panelEl);
            });
            const qrToggle = document.getElementById('qr-toggle');
            const qrPanel = document.getElementById('qr-panel');
            if (qrToggle && qrPanel) {
                syncToggleState(qrToggle, qrPanel);
            } else if (typeof window._syncQrTopToggleState === 'function') {
                window._syncQrTopToggleState();
            }
        };
        visibilityPairs.forEach(([toggleId, panelId]) => {
            const toggleEl = document.getElementById(toggleId);
            const panelEl = document.getElementById(panelId);
            if (!toggleEl || !panelEl) return;
            syncToggleState(toggleEl, panelEl);
            toggleEl.addEventListener('click', () => {
                const willHide = window.getComputedStyle(panelEl).display !== 'none'
                    && !panelEl.classList.contains('panel-hidden') && !panelEl.classList.contains('hidden');
                if (panelId === 'rhythm-panel' && document.documentElement.classList.contains('rrc-room')) {
                    document.documentElement.classList.toggle('rrc-room-rhythm-list-open', !willHide);
                }
                panelEl.classList.toggle('panel-hidden', willHide);
                if (!willHide) {
                    panelEl.classList.remove('hidden');
                    clampFloatingPanelOnOpen(panelEl);
                    raisePanel(panelEl);
                }
                syncToggleState(toggleEl, panelEl);
            });
        });

        // Keep debug panel out of the protected top button zone on initial load as well.
        if (debugControls) clampFloatingPanelOnOpen(debugControls);

        setupAutocompletePolicy();
        setupViewsPanel();
        setupRhythmCreatorPanel();
        setupAuthPanel();
        setupSessionPanel();
        setupQrPanel();
        setupServePanel();
        setupStagePanel();

        // ── Data buttons ──
        const regenImagesBtn = document.getElementById('regenImagesBtn');
        if (regenImagesBtn) regenImagesBtn.addEventListener('click', async () => {
            regenImagesBtn.textContent = 'Fetching...'; regenImagesBtn.disabled = true;
            await regenerateAllImages();
            regenImagesBtn.textContent = 'Done!';
            setTimeout(() => { regenImagesBtn.textContent = 'Regenerate'; regenImagesBtn.disabled = false; }, 2000);
        });

        const refreshDbBtn = document.getElementById('refreshDbBtn');
        if (refreshDbBtn) refreshDbBtn.addEventListener('click', async () => {
            refreshDbBtn.textContent = 'Fetching...'; refreshDbBtn.disabled = true;
            await refreshRhythmDatabaseAndUi();
            refreshDbBtn.textContent = 'Done!';
            setTimeout(() => { refreshDbBtn.textContent = 'Refresh DB'; refreshDbBtn.disabled = false; }, 2000);
        });

        // Imagery selector
        const imagerySelect = document.getElementById('imagerySelect');
        if (imagerySelect) { imagerySelect.value = selectedImagery; imagerySelect.addEventListener('change', e => { selectedImagery = e.target.value; localStorage.setItem('selectedImagery', selectedImagery); changeImagery(selectedImagery); }); }

        const mapWindowedToggle = document.getElementById('mapWindowedToggle');
        if (mapWindowedToggle) {
            mapWindowedToggle.checked = mapWindowedMode;
            mapWindowedToggle.addEventListener('change', () => {
                mapWindowedMode = mapWindowedToggle.checked;
                applyMapWindowMode(mapWindowedMode);
            });
        }

        const mapSceneModeSelect = document.getElementById('mapSceneModeSelect');
        if (mapSceneModeSelect) {
            mapSceneModeSelect.value = normalizeMapSceneMode(mapSceneMode);
            mapSceneModeSelect.addEventListener('change', () => {
                applyMapSceneMode(mapSceneModeSelect.value);
            });
        }

        // Color mode toggle
        const colorModeSelect = document.getElementById('colorModeSelect');
        if (colorModeSelect) {
            colorModeSelect.value = useRainbowColors ? 'rainbow' : 'database';
            colorModeSelect.addEventListener('change', e => {
                useRainbowColors = e.target.value === 'rainbow';
                localStorage.setItem('useRainbowColors', useRainbowColors);
                populateAllRhythmColors();
                populateRhythmPanel(currentRhythmSource);
                populateCarousel();
                // Refresh domes
                if (typeof viewer !== 'undefined' && viewer.entities) {
                    viewer.entities.removeAll();
                    addHolographicDomes();
                }
            });
        }

        // Font selectors
        const fontSelect = document.getElementById('fontSelect');
        const secondaryFontSelect = document.getElementById('secondaryFontSelect');
        const uiFontSelect = document.getElementById('uiFontSelect');
        const monoFontSelect = document.getElementById('monoFontSelect');
        const applyFontVars = () => {
            const displayFont = localStorage.getItem('selectedFont') || "'Orbitron', sans-serif";
            const secondaryFont = localStorage.getItem('selectedSecondaryFont') || "'Rajdhani', sans-serif";
            const uiFont = localStorage.getItem('selectedUiFont') || "'Segoe UI', sans-serif";
            const monoFont = localStorage.getItem('selectedMonoFont') || "'Share Tech Mono', monospace";
            document.documentElement.style.setProperty('--font-display', displayFont);
            document.documentElement.style.setProperty('--font-secondary', secondaryFont);
            document.documentElement.style.setProperty('--font-ui', uiFont);
            document.documentElement.style.setProperty('--font-mono', monoFont);
        };
        if (fontSelect) {
            const savedFont = localStorage.getItem('selectedFont') || "'Orbitron', sans-serif";
            fontSelect.value = savedFont;
            fontSelect.addEventListener('change', e => {
                localStorage.setItem('selectedFont', e.target.value);
                applyFontVars();
            });
        }
        if (secondaryFontSelect) {
            const savedSecondaryFont = localStorage.getItem('selectedSecondaryFont') || "'Rajdhani', sans-serif";
            secondaryFontSelect.value = savedSecondaryFont;
            secondaryFontSelect.addEventListener('change', e => {
                localStorage.setItem('selectedSecondaryFont', e.target.value);
                applyFontVars();
            });
        }
        if (uiFontSelect) {
            const savedUiFont = localStorage.getItem('selectedUiFont') || "'Segoe UI', sans-serif";
            uiFontSelect.value = savedUiFont;
            uiFontSelect.addEventListener('change', e => {
                localStorage.setItem('selectedUiFont', e.target.value);
                applyFontVars();
            });
        }
        if (monoFontSelect) {
            const savedMonoFont = localStorage.getItem('selectedMonoFont') || "'Share Tech Mono', monospace";
            monoFontSelect.value = savedMonoFont;
            monoFontSelect.addEventListener('change', e => {
                localStorage.setItem('selectedMonoFont', e.target.value);
                applyFontVars();
            });
        }
        applyFontVars();

    } catch (err) {
        console.warn('setupDebugControls encountered an error:', err);
    }
}

function setupViewsPanel() {
    const panel = document.getElementById('views-panel');
    const nameInput = document.getElementById('view-name-input');
    const saveBtn = document.getElementById('save-view-btn');
    const importBtn = document.getElementById('import-views-btn');
    const importFileInput = document.getElementById('import-views-file');
    const exportBtn = document.getElementById('export-views-btn');
    const listEl = document.getElementById('views-list');
    if (!panel || !nameInput || !saveBtn || !exportBtn || !listEl || !importBtn || !importFileInput) return;
    if (panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const STORAGE_KEY = 'rrcViewPresets';

    const readPresets = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    };

    const writePresets = (presets) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    };

    const normalizeImportedPreset = (preset, fallbackIndex = 0) => {
        if (!preset || typeof preset !== 'object') return null;
        const windows = (preset.windows && typeof preset.windows === 'object') ? preset.windows : null;
        if (!windows) return null;
        const rawName = String(preset.name || '').trim();
        const name = rawName || `imported-view-${fallbackIndex + 1}`;
        const meta = (preset.meta && typeof preset.meta === 'object') ? preset.meta : {};
        return {
            id: `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            windows,
            meta
        };
    };

    const captureView = (name) => {
        const windows = {};
        document.querySelectorAll('[data-floating-window="true"]').forEach((el) => {
            if (!el.id) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) return;
                windows[el.id] = {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    hidden: el.classList.contains('hidden'),
                    panelHidden: el.classList.contains('panel-hidden'),
                    active: el.classList.contains('active')
                };
            });
        const rhythmPanel = document.getElementById('rhythm-panel');
        return {
            id: Date.now().toString(36),
            name,
            windows,
            meta: {
                rhythmPanelView: rhythmPanel && rhythmPanel.classList.contains('carousel-mode') ? 'carousel' : 'cards',
                rhythmPanelTab: localStorage.getItem('rhythmPanelTab') === 'journeys' ? 'journeys' : 'browse',
                topButtonOrder: getCurrentTopPanelButtonOrder(),
                showNavTopButton
            }
        };
    };

    const applyView = (preset) => {
        if (!preset || !preset.windows) return;
        Object.entries(preset.windows).forEach(([id, state]) => {
            const el = document.getElementById(id);
            if (!el || !state) return;
            el.style.position = 'fixed';
            el.style.left = state.left + 'px';
            el.style.top = state.top + 'px';
            el.style.width = state.width + 'px';
            el.style.height = state.height + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.margin = '0';
            el.style.transform = 'none';
            el.dataset.windowPinned = '1';
            if (typeof window._updateFloatingWindowScale === 'function') {
                window._updateFloatingWindowScale(el);
            }
            if (typeof state.hidden === 'boolean') el.classList.toggle('hidden', state.hidden);
            if (typeof state.panelHidden === 'boolean') el.classList.toggle('panel-hidden', state.panelHidden);
            if (typeof state.active === 'boolean') el.classList.toggle('active', state.active);
        });
        if (preset.meta && preset.meta.rhythmPanelView && typeof window._setRhythmPanelMode === 'function') {
            window._setRhythmPanelMode(preset.meta.rhythmPanelView);
        }
        if (preset.meta && preset.meta.rhythmPanelTab && typeof window._setRhythmBrowserTab === 'function') {
            window._setRhythmBrowserTab(preset.meta.rhythmPanelTab);
        }
        if (preset.meta && Array.isArray(preset.meta.topButtonOrder)) {
            applyTopPanelButtonOrder(preset.meta.topButtonOrder, true);
        }
        if (preset.meta && preset.meta.showNavTopButton !== undefined) {
            showNavTopButton = NAV_TOOLBAR_LEGACY_ENABLED && !!preset.meta.showNavTopButton;
            localStorage.setItem('showNavTopButton', showNavTopButton ? 'true' : 'false');
            const showNavTopButtonToggle = document.getElementById('showNavTopButtonToggle');
            if (showNavTopButtonToggle) showNavTopButtonToggle.checked = showNavTopButton;
            applyTopPanelButtonLabels();
            enforceLegacyNavDisabled();
        }
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };

    const render = () => {
        const presets = readPresets();
        listEl.innerHTML = '';
        if (presets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-status';
            empty.textContent = 'No views saved yet';
            listEl.appendChild(empty);
            return;
        }

        presets.forEach((preset) => {
            const row = document.createElement('div');
            row.className = 'view-item';

            const name = document.createElement('span');
            name.className = 'view-item-name';
            name.textContent = preset.name;
            row.appendChild(name);

            const applyBtn = document.createElement('button');
            applyBtn.className = 'debug-action-btn';
            applyBtn.textContent = 'Load';
            applyBtn.addEventListener('click', () => applyView(preset));
            row.appendChild(applyBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'debug-action-btn';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => {
                const next = readPresets().filter((p) => p.id !== preset.id);
                writePresets(next);
                render();
            });
            row.appendChild(deleteBtn);

            listEl.appendChild(row);
        });
    };

    const savePreset = (name, options = {}) => {
        const normalizedName = String(name || '').trim() || `view-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
        const replaceByName = options && options.replaceByName === true;
        let presets = readPresets();
        if (replaceByName) {
            presets = presets.filter((preset) => String(preset?.name || '').trim().toLowerCase() !== normalizedName.toLowerCase());
        }
        const preset = captureView(normalizedName);
        presets.push(preset);
        writePresets(presets);
        render();
        return preset;
    };

    window._rrcSaveViewPreset = (name, options = {}) => {
        return savePreset(name, options);
    };

    saveBtn.addEventListener('click', () => {
        const rawName = (nameInput.value || '').trim();
        savePreset(rawName, { replaceByName: false });
        nameInput.value = '';
    });

    exportBtn.addEventListener('click', () => {
        const payload = {
            exportedAt: new Date().toISOString(),
            version: 1,
            presets: readPresets()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'rrc-views.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
        importFileInput.value = '';
        importFileInput.click();
    });

    importFileInput.addEventListener('change', async () => {
        const file = importFileInput.files && importFileInput.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const importedList = Array.isArray(parsed)
                ? parsed
                : (Array.isArray(parsed?.presets) ? parsed.presets : []);
            if (importedList.length === 0) {
                await ensureInAppUi().alert('No view presets found in this JSON file.', 'Import Views');
                return;
            }
            const existing = readPresets();
            const normalized = importedList
                .map((preset, index) => normalizeImportedPreset(preset, index))
                .filter(Boolean);
            if (normalized.length === 0) {
                await ensureInAppUi().alert('No valid view presets were found in this file.', 'Import Views');
                return;
            }
            writePresets(existing.concat(normalized));
            render();
            ensureInAppUi().toast(`Imported ${normalized.length} view${normalized.length === 1 ? '' : 's'}.`, 'success', 2800);
        } catch (err) {
            await ensureInAppUi().alert(`Could not import views JSON: ${err?.message || err}`, 'Import Error');
        }
    });

    render();
}

function setupRhythmCreatorPanel() {
    const panel = document.getElementById('rhythm-create-panel');
    if (!panel) return;
    if (panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const statusEl = document.getElementById('rhythm-create-status');
    const notationFileInput = document.getElementById('rhythm-create-notation-file');
    const notationPathInput = document.getElementById('rhythm-create-notation-path');
    const notationJsonInput = document.getElementById('rhythm-create-notation-json');
    const uploadNotationToggle = document.getElementById('rhythm-create-upload-notation');
    const notationBucketInput = document.getElementById('rhythm-create-notation-bucket');
    const pictureFilesInput = document.getElementById('rhythm-create-picture-files');
    const imagesBucketInput = document.getElementById('rhythm-create-images-bucket');
    const healthDbEl = document.getElementById('rhythm-create-health-db');
    const healthNotationEl = document.getElementById('rhythm-create-health-notation');
    const healthImagesEl = document.getElementById('rhythm-create-health-images');
    const healthCheckBtn = document.getElementById('rhythm-create-health-check');
    const submitBtn = document.getElementById('rhythm-create-submit');
    const resetBtn = document.getElementById('rhythm-create-reset');
    const refreshBtn = document.getElementById('rhythm-create-refresh');
    const creatorInput = document.getElementById('rhythm-create-creator');

    const setStatus = (text, tone = '') => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
        if (tone === 'success') statusEl.classList.add('panel-status-success');
        if (tone === 'warn') statusEl.classList.add('panel-status-warn');
        if (tone === 'error') statusEl.classList.add('panel-status-error');
    };

    const readValue = (id) => {
        const el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    };

    const parseLinkLines = (raw) => {
        return String(raw || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    };

    const parseNumberOrNull = (value) => {
        const n = parseFloat(String(value || '').trim());
        return Number.isFinite(n) ? n : null;
    };

    const parseTags = (raw) => {
        return String(raw || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .filter((tag, idx, arr) => arr.indexOf(tag) === idx);
    };

    const setHealthPill = (el, state, label, detail = '') => {
        if (!el) return;
        const normalized = state === 'ok' || state === 'warn' || state === 'error' ? state : '';
        el.classList.remove('ok', 'warn', 'error');
        if (normalized) el.classList.add(normalized);
        const safeLabel = String(label || '').trim();
        const safeDetail = String(detail || '').trim();
        el.textContent = safeDetail ? `${safeLabel}: ${safeDetail}` : `${safeLabel}: --`;
    };

    const getErrorShort = (err, fallback = 'Unavailable') => {
        const raw = String(err?.message || err || fallback).trim();
        if (!raw) return fallback;
        return raw.length > 42 ? `${raw.slice(0, 39)}...` : raw;
    };

    const analyzeRhythmTagsError = (err) => {
        const raw = String(err?.message || err || '').toLowerCase();
        if (!raw) return { state: 'warn', detail: 'Unknown issue' };
        if (raw.includes('does not exist') || raw.includes('relation') && raw.includes('rhythm_tags')) {
            return { state: 'warn', detail: 'Setup needed (missing table)' };
        }
        if (
            raw.includes('permission denied')
            || raw.includes('row-level security')
            || raw.includes('rls')
            || raw.includes('not allowed')
        ) {
            return { state: 'warn', detail: 'Setup needed (policy)' };
        }
        return { state: 'warn', detail: getErrorShort(err, 'Unavailable') };
    };

    const checkBucketAccess = async (supabaseClient, bucketName) => {
        const bucket = String(bucketName || '').trim();
        if (!bucket) return { state: 'warn', detail: 'No name' };
        try {
            const { error } = await supabaseClient.storage.from(bucket).list('', { limit: 1 });
            if (error) {
                const msg = getErrorShort(error, 'Error');
                const missing = /not found|no such bucket|bucket/i.test(String(error?.message || ''));
                return { state: missing ? 'error' : 'warn', detail: msg };
            }
            return { state: 'ok', detail: 'OK' };
        } catch (err) {
            return { state: 'warn', detail: getErrorShort(err, 'Error') };
        }
    };

    const runSupabaseHealthCheck = async () => {
        const supabaseClient = getSupabaseClient();
        if (!supabaseClient) {
            setHealthPill(healthDbEl, 'error', 'Database', 'No connection');
            setHealthPill(healthNotationEl, 'error', 'Notation Files', 'No connection');
            setHealthPill(healthImagesEl, 'error', 'Images', 'No connection');
            return;
        }

        setHealthPill(healthDbEl, '', 'Database', 'Checking...');
        setHealthPill(healthNotationEl, '', 'Notation Files', 'Checking...');
        setHealthPill(healthImagesEl, '', 'Images', 'Checking...');

        const [rhythmsResult, tagsResult, notationBucketResult, imagesBucketResult] = await Promise.all([
            supabaseClient.from('rhythms').select('id', { head: true, count: 'exact' }).limit(1),
            supabaseClient.from('rhythm_tags').select('*', { head: true, count: 'exact' }).limit(1),
            checkBucketAccess(supabaseClient, notationBucketInput ? notationBucketInput.value : ''),
            checkBucketAccess(supabaseClient, imagesBucketInput ? imagesBucketInput.value : '')
        ]);

        if (rhythmsResult.error) {
            const detail = `rhythms ${getErrorShort(rhythmsResult.error)}`;
            setHealthPill(healthDbEl, 'error', 'Database', detail);
        } else if (tagsResult.error) {
            const tags = analyzeRhythmTagsError(tagsResult.error);
            setHealthPill(healthDbEl, tags.state, 'Database', `Core ready / Tags ${tags.detail}`);
        } else {
            setHealthPill(healthDbEl, 'ok', 'Database', 'Ready');
        }
        setHealthPill(healthNotationEl, notationBucketResult.state, 'Notation Files', notationBucketResult.detail);
        setHealthPill(healthImagesEl, imagesBucketResult.state, 'Images', imagesBucketResult.detail);
    };

    const sanitizeStoragePath = (value, fallbackName = 'file') => {
        const raw = String(value || '').trim();
        const cleaned = raw
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/[^a-zA-Z0-9._/-]+/g, '_')
            .replace(/^\/+/, '')
            .replace(/\.\.+/g, '.');
        if (cleaned) return cleaned;
        return `${slugifyRhythmKey(fallbackName)}.json`;
    };

    const getSupabaseClient = () => {
        if (window.__rrcSupabaseAuthClient) return window.__rrcSupabaseAuthClient;
        const hasSupabase = typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function';
        const hasUrl = typeof SUPABASE_URL !== 'undefined' && !!SUPABASE_URL;
        const hasKey = typeof SUPABASE_ANON_KEY !== 'undefined' && !!SUPABASE_ANON_KEY;
        if (!hasSupabase || !hasUrl || !hasKey) return null;
        try {
            window.__rrcSupabaseAuthClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
            });
            return window.__rrcSupabaseAuthClient;
        } catch {
            return null;
        }
    };

    const preferredCreatorFromUser = (user) => {
        if (!user) return '';
        const metadata = user.user_metadata || {};
        const username = String(metadata.username || '').trim();
        if (username) return username;
        const fullName = String(metadata.full_name || metadata.name || '').trim();
        if (fullName) return fullName;
        const email = String(user.email || '').trim();
        if (!email) return '';
        const local = email.split('@')[0] || '';
        return String(local).trim();
    };

    const applyCreatorDefault = async (force = false) => {
        if (!creatorInput) return;
        const isUserEdited = creatorInput.dataset.userEdited === '1';
        const isAutoFilled = creatorInput.dataset.autoFilled === '1';
        const current = String(creatorInput.value || '').trim();
        if (!force && isUserEdited && !isAutoFilled) return;
        if (!force && current && !isAutoFilled) return;

        const supabaseClient = getSupabaseClient();
        if (!supabaseClient) return;
        try {
            const { data } = await supabaseClient.auth.getSession();
            const user = data?.session?.user || null;
            const creator = preferredCreatorFromUser(user);
            if (!creator) {
                if (force || isAutoFilled || !current) {
                    creatorInput.value = '';
                    creatorInput.dataset.autoFilled = '0';
                }
                return;
            }
            creatorInput.value = creator;
            creatorInput.dataset.autoFilled = '1';
        } catch {}
    };

    const parseNotationData = () => {
        const raw = notationJsonInput ? notationJsonInput.value : '';
        const trimmed = String(raw || '').trim();
        if (!trimmed) return null;
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Notation JSON must be an object.');
        }
        if (!Array.isArray(parsed.instruments)) {
            throw new Error('Notation JSON must include an instruments array.');
        }
        return parsed;
    };

    const clearForm = () => {
        panel.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach((el) => {
            el.value = '';
        });
        panel.querySelectorAll('input[type="checkbox"]').forEach((el) => {
            el.checked = false;
        });
        const colorInput = document.getElementById('rhythm-create-color');
        if (colorInput) colorInput.value = '#00ffff';
        const libraryInput = document.getElementById('rhythm-create-library');
        if (libraryInput) libraryInput.value = 'Local';
        if (notationBucketInput) notationBucketInput.value = 'rhythm-notations';
        if (imagesBucketInput) imagesBucketInput.value = 'rhythm-images';
        if (notationFileInput) notationFileInput.value = '';
        if (pictureFilesInput) pictureFilesInput.value = '';
        if (creatorInput) {
            creatorInput.dataset.userEdited = '0';
            creatorInput.dataset.autoFilled = '0';
        }
        void applyCreatorDefault(true);
        setStatus('Form cleared.', 'success');
    };

    const refreshRhythmData = async () => {
        setStatus('Refreshing rhythm database...', 'warn');
        await refreshRhythmDatabaseAndUi();
        setStatus('Rhythm DB refreshed. Share this action with collaborators.', 'success');
    };

    const uploadNotationToStorage = async (supabaseClient, notationData, rhythmName) => {
        if (!uploadNotationToggle || !uploadNotationToggle.checked) return readValue('rhythm-create-notation-path');
        const bucket = (notationBucketInput ? notationBucketInput.value : '').trim() || 'rhythm-notations';
        const explicitPath = readValue('rhythm-create-notation-path');
        const fallbackName = `${slugifyRhythmKey(rhythmName || 'rhythm')}.json`;
        const path = sanitizeStoragePath(explicitPath || fallbackName, fallbackName);
        const blob = new Blob([JSON.stringify(notationData, null, 2)], { type: 'application/json' });
        const { error } = await supabaseClient.storage
            .from(bucket)
            .upload(path, blob, {
                contentType: 'application/json',
                upsert: true,
                cacheControl: '3600'
            });
        if (error) throw new Error(`Notation upload failed: ${error.message || error}`);
        return path;
    };

    const uploadPicturesToStorage = async (supabaseClient, rhythmName) => {
        const files = pictureFilesInput?.files ? Array.from(pictureFilesInput.files) : [];
        if (files.length === 0) return [];
        const bucket = (imagesBucketInput ? imagesBucketInput.value : '').trim() || 'rhythm-images';
        const prefix = `${slugifyRhythmKey(rhythmName || 'rhythm')}_${Date.now()}`;
        const uploadedUrls = [];
        for (let i = 0; i < files.length; i += 1) {
            const file = files[i];
            if (!String(file.type || '').toLowerCase().startsWith('image/')) continue;
            const safeName = String(file.name || `image_${i + 1}`).replace(/[^a-zA-Z0-9._-]+/g, '_');
            const path = `${prefix}/${safeName}`;
            const { error } = await supabaseClient.storage
                .from(bucket)
                .upload(path, file, {
                    cacheControl: '3600',
                    upsert: true,
                    contentType: file.type || 'image/*'
                });
            if (error) throw new Error(`Image upload failed: ${error.message || error}`);
            const { data: pub } = supabaseClient.storage.from(bucket).getPublicUrl(path);
            const publicUrl = String(pub?.publicUrl || '').trim();
            if (publicUrl) uploadedUrls.push(publicUrl);
        }
        return uploadedUrls;
    };

    if (notationFileInput && notationJsonInput) {
        notationFileInput.addEventListener('change', async () => {
            const file = notationFileInput.files && notationFileInput.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                if (!parsed || !Array.isArray(parsed.instruments)) {
                    throw new Error('Invalid notation file: missing instruments array.');
                }
                notationJsonInput.value = JSON.stringify(parsed, null, 2);
                if (notationPathInput && !String(notationPathInput.value || '').trim()) {
                    const safeName = slugifyRhythmKey(file.name.replace(/\.json$/i, ''));
                    notationPathInput.value = `Notation/notations/${safeName}.json`;
                }
                setStatus('Notation JSON loaded from file.', 'success');
            } catch (err) {
                setStatus(`Notation file error: ${err?.message || err}`, 'error');
            }
        });
    }

    if (notationBucketInput && !notationBucketInput.value.trim()) notationBucketInput.value = 'rhythm-notations';
    if (imagesBucketInput && !imagesBucketInput.value.trim()) imagesBucketInput.value = 'rhythm-images';

    if (healthCheckBtn) {
        healthCheckBtn.addEventListener('click', async () => {
            healthCheckBtn.disabled = true;
            try {
                await runSupabaseHealthCheck();
            } finally {
                healthCheckBtn.disabled = false;
            }
        });
    }
    if (notationBucketInput) {
        notationBucketInput.addEventListener('change', () => { void runSupabaseHealthCheck(); });
        notationBucketInput.addEventListener('blur', () => { void runSupabaseHealthCheck(); });
    }
    if (imagesBucketInput) {
        imagesBucketInput.addEventListener('change', () => { void runSupabaseHealthCheck(); });
        imagesBucketInput.addEventListener('blur', () => { void runSupabaseHealthCheck(); });
    }
    void runSupabaseHealthCheck();

    if (resetBtn) {
        resetBtn.addEventListener('click', clearForm);
    }

    if (creatorInput) {
        creatorInput.addEventListener('input', () => {
            creatorInput.dataset.userEdited = '1';
            creatorInput.dataset.autoFilled = '0';
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            try {
                await refreshRhythmData();
            } catch (err) {
                setStatus(`Refresh failed: ${err?.message || err}`, 'error');
            } finally {
                refreshBtn.disabled = false;
            }
        });
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
            const name = readValue('rhythm-create-name');
            if (!name) {
                setStatus('Name is required.', 'error');
                return;
            }

            const lat = parseNumberOrNull(readValue('rhythm-create-lat'));
            const lon = parseNumberOrNull(readValue('rhythm-create-lon'));
            let notationData = null;
            try {
                notationData = parseNotationData();
            } catch (err) {
                setStatus(`Notation JSON error: ${err?.message || err}`, 'error');
                return;
            }

            const videos = parseLinkLines(readValue('rhythm-create-videos'));
            const pictureLinks = parseLinkLines(readValue('rhythm-create-pictures'));
            const tags = parseTags(readValue('rhythm-create-tags'));
            const lyricsText = readValue('rhythm-create-lyrics');
            const lyricsLanguage = readValue('rhythm-create-lyrics-language') || 'unknown';
            const lyricsRole = readValue('rhythm-create-lyrics-role') || 'lyrics';

            const songTexts = lyricsText
                ? [{
                    id: `lyrics_${Date.now().toString(36)}`,
                    language: lyricsLanguage,
                    role: lyricsRole,
                    lyrics: lyricsText
                }]
                : [];

            const payload = {
                name,
                subtitle: readValue('rhythm-create-subtitle'),
                region: readValue('rhythm-create-region'),
                community: readValue('rhythm-create-community'),
                summary: readValue('rhythm-create-context'),
                notation_path: readValue('rhythm-create-notation-path'),
                notation_data: notationData,
                lat,
                lon,
                library: readValue('rhythm-create-library') || 'Local',
                creator: readValue('rhythm-create-creator') || 'RRC Creator',
                color: readValue('rhythm-create-color') || '#00ffff',
                song_texts: songTexts,
                listening_examples: []
            };
            const saveLibrary = String(payload.library || 'Local').trim();
            const isCommunitySave = saveLibrary.toLowerCase() === 'community';

            submitBtn.disabled = true;
            setStatus(isCommunitySave ? 'Saving rhythm to Supabase...' : 'Saving rhythm locally...', 'warn');
            try {
                if (!isCommunitySave) {
                    const allPictureUrls = Array.from(new Set(pictureLinks));
                    const notationPath = readValue('rhythm-create-notation-path')
                        || (notationData ? `Notation/notations/${slugifyRhythmKey(name)}.json` : '');
                    const listeningExamples = (videos.length > 0 || allPictureUrls.length > 0)
                        ? [{
                            id: `custom_${Date.now().toString(36)}`,
                            title: 'Creator Media',
                            description: '',
                            videos: videos.map((url, idx) => ({
                                id: `video_${idx + 1}`,
                                title: `Video ${idx + 1}`,
                                url: toEmbedUrl(url),
                                video_type: 'reference'
                            })),
                            images: allPictureUrls.map((url, idx) => ({
                                id: `image_${idx + 1}`,
                                url
                            }))
                        }]
                        : [];

                    const localRow = {
                        id: `local_${Date.now().toString(36)}`,
                        ...payload,
                        notation_path: notationPath,
                        listening_examples: listeningExamples,
                        rhythm_tagsCollection: { edges: tags.map((tag) => ({ node: tag })) }
                    };
                    const normalized = normaliseRhythm(localRow);
                    normalized.library = 'Local';
                    const newKey = buildUniqueRhythmKey(normalized, new Set(Object.keys(allRhythms || {})));
                    const localCustom = readLocalCustomRhythms();
                    localCustom[newKey] = normalized;
                    writeLocalCustomRhythms(localCustom);
                    allRhythms = { ...(allRhythms || {}), [newKey]: normalized };
                    await loadCachedImages();
                    populateAllRhythmColors();
                    populateRhythmPanel(currentRhythmSource);
                    populateCarousel();
                    updateDomesForSource(currentRhythmSource);
                    renderJourneySourceList();
                    setStatus(`Saved "${name}" locally.${pictureFilesInput?.files?.length ? ' (Local save uses image links; uploaded files are ignored.)' : ''}`, 'success');
                    return;
                }

                const supabaseClient = getSupabaseClient();
                if (!supabaseClient) {
                    throw new Error('Supabase client unavailable. Check SUPABASE_URL and SUPABASE_ANON_KEY.');
                }

                const uploadedPictures = await uploadPicturesToStorage(supabaseClient, name);
                const allPictureUrls = Array.from(new Set([...pictureLinks, ...uploadedPictures]));
                const notationPath = notationData
                    ? await uploadNotationToStorage(supabaseClient, notationData, name)
                    : readValue('rhythm-create-notation-path');

                const listeningExamples = (videos.length > 0 || allPictureUrls.length > 0)
                    ? [{
                        id: `custom_${Date.now().toString(36)}`,
                        title: 'Creator Media',
                        description: '',
                        videos: videos.map((url, idx) => ({
                            id: `video_${idx + 1}`,
                            title: `Video ${idx + 1}`,
                            url: toEmbedUrl(url),
                            video_type: 'reference'
                        })),
                        images: allPictureUrls.map((url, idx) => ({
                            id: `image_${idx + 1}`,
                            url
                        }))
                    }]
                    : [];

                const { data: inserted, error: insertError } = await supabaseClient
                    .from('rhythms')
                    .insert([{
                        ...payload,
                        notation_path: notationPath,
                        listening_examples: listeningExamples
                    }])
                    .select('id, name')
                    .single();
                if (insertError) throw insertError;

                let tagWarning = '';
                if (inserted && inserted.id && tags.length > 0) {
                    const tagRows = tags.map((tag) => ({ rhythm_id: inserted.id, tag }));
                    const { error: tagError } = await supabaseClient.from('rhythm_tags').insert(tagRows);
                    if (tagError) {
                        tagWarning = ` Saved rhythm, but tag insert failed (${tagError.message}).`;
                    }
                }

                await refreshRhythmData();
                setStatus(`Saved "${inserted?.name || name}".${tagWarning}`, tagWarning ? 'warn' : 'success');
            } catch (err) {
                setStatus(`Save failed: ${err?.message || err}`, 'error');
            } finally {
                submitBtn.disabled = false;
            }
        });
    }

    void applyCreatorDefault(false);
    const creatorSupabaseClient = getSupabaseClient();
    if (creatorSupabaseClient && creatorSupabaseClient.auth && typeof creatorSupabaseClient.auth.onAuthStateChange === 'function') {
        creatorSupabaseClient.auth.onAuthStateChange(() => {
            void applyCreatorDefault(false);
        });
    }
}

function setupStagePanel() {
    const panel = document.getElementById('stage-panel');
    const area = document.getElementById('stage-panel-area');
    const statusEl = document.getElementById('stage-panel-status');
    const stageBackValueEl = document.getElementById('stage-back-velocity-val');
    const stageFrontValueEl = document.getElementById('stage-front-velocity-val');
    const ceilingLine = area ? area.querySelector('.stage-panel-ceiling') : null;
    const floorLine = area ? area.querySelector('.stage-panel-floor') : null;
    const stageResetLayoutBtn = document.getElementById('stage-reset-layout-btn');
    const stageSaveLayoutBtn = document.getElementById('stage-save-layout-btn');
    const stageExportLayoutBtn = document.getElementById('stage-export-layout-btn');
    const stageImportLayoutBtn = document.getElementById('stage-import-layout-btn');
    const stageImportLayoutFile = document.getElementById('stage-import-layout-file');
    if (!panel || !area || !statusEl || !stageBackValueEl || !stageFrontValueEl || !ceilingLine || !floorLine) return;
    applyStageMinPanelWidth({ clampPosition: false });
    if (panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const STAGE_LAYOUTS_STORAGE_KEY = 'rrcStageLayoutsV1';
    const STAGE_LAYOUT_EXPORT_VERSION = 1;

    const normalizeStageRhythmKey = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (typeof normalizeRhythmLookupText === 'function') {
            const normalized = String(normalizeRhythmLookupText(raw) || '').trim();
            if (normalized) return normalized;
        }
        return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    };

    const parseStageLayoutsStore = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(STAGE_LAYOUTS_STORAGE_KEY) || '{}');
            if (!parsed || typeof parsed !== 'object') return { version: STAGE_LAYOUT_EXPORT_VERSION, byRhythm: {} };
            const byRhythm = (parsed.byRhythm && typeof parsed.byRhythm === 'object') ? parsed.byRhythm : {};
            return { version: STAGE_LAYOUT_EXPORT_VERSION, byRhythm: { ...byRhythm } };
        } catch {
            return { version: STAGE_LAYOUT_EXPORT_VERSION, byRhythm: {} };
        }
    };

    let stageLayoutsStore = parseStageLayoutsStore();

    const persistStageLayoutsStore = () => {
        try {
            localStorage.setItem(STAGE_LAYOUTS_STORAGE_KEY, JSON.stringify(stageLayoutsStore));
        } catch {}
    };

    let stageBackLabel = area.querySelector('.stage-bound-label.back');
    if (!stageBackLabel) {
        stageBackLabel = document.createElement('span');
        stageBackLabel.className = 'stage-bound-label back';
        stageBackLabel.textContent = 'BACK STAGE';
        area.appendChild(stageBackLabel);
    }
    let stageFrontLabel = area.querySelector('.stage-bound-label.front');
    if (!stageFrontLabel) {
        stageFrontLabel = document.createElement('span');
        stageFrontLabel.className = 'stage-bound-label front';
        stageFrontLabel.textContent = 'FRONT STAGE';
        area.appendChild(stageFrontLabel);
    }

    const iconForInstrument = (instrument) => {
        const key = String(instrument?.type || '').toLowerCase();
        const id = String(instrument?.id || '').toLowerCase();
        const sampleSet = String(instrument?.sampleSet || '').toLowerCase();
        const name = String(instrument?.name || '').toLowerCase();

        if (id.startsWith('call') || key === 'djembe_solo' || name.includes('call')) return 'instrumentIcons/Call.png';
        if (id === 'djembe1' || sampleSet === 'one') return 'instrumentIcons/DjembeOne.png';
        if (id === 'djembe2' || sampleSet === 'two') return 'instrumentIcons/DjembeTwo.png';
        if (id === 'djembe3' || sampleSet === 'three') return 'instrumentIcons/DjembeThree.png';
        if (key === 'djembe') return 'instrumentIcons/DjembeOne.png';
        if (key === 'kenkeni') return 'instrumentIcons/Kenkeni.png';
        if (key === 'kenkeni_bell') return 'instrumentIcons/Kenkeni_Bell.png';
        if (key === 'sangban') return 'instrumentIcons/Sangban.png';
        if (key === 'sangban_bell') return 'instrumentIcons/Sangban_Bell.png';
        if (key === 'doundoun') return 'instrumentIcons/Doundoun.png';
        if (key === 'doundoun_bell') return 'instrumentIcons/DoundounBell.png';
        if (key === 'shekere') return 'instrumentIcons/Shekere.png';
        return '';
    };

    const getStageRhythmData = () => {
        if (latestNotationRhythmData && Array.isArray(latestNotationRhythmData.instruments)) {
            latestNotationRhythmData = ensureCallInstrumentInRhythmData(latestNotationRhythmData);
            return latestNotationRhythmData;
        }
        const key = selectedRhythm && allRhythms[selectedRhythm] ? selectedRhythm : '';
        const notationData = key ? allRhythms[key]?.notationData : null;
        if (notationData && Array.isArray(notationData.instruments)) {
            return ensureCallInstrumentInRhythmData({
                rhythmName: String(allRhythms[key]?.name || key).trim(),
                beats: Math.max(1, parseInt(notationData.beats, 10) || 4),
                subdivisions: Math.max(1, parseInt(notationData.subdivisions, 10) || 4),
                instruments: notationData.instruments
            });
        }
        return null;
    };

    const getStageLayoutKeysForRhythmData = (data) => {
        const keys = [];
        if (selectedRhythm && allRhythms[selectedRhythm]) {
            keys.push(`key:${String(selectedRhythm).trim().toLowerCase()}`);
        }
        const rhythmName = String(data?.rhythmName || '').trim();
        const byName = normalizeStageRhythmKey(rhythmName);
        if (byName) keys.push(`name:${byName}`);
        if (keys.length === 0) keys.push('name:unknown');
        return Array.from(new Set(keys));
    };

    const getSavedStageLayoutForRhythmData = (data) => {
        const keys = getStageLayoutKeysForRhythmData(data);
        for (const key of keys) {
            const entry = stageLayoutsStore?.byRhythm?.[key];
            if (entry && typeof entry === 'object' && entry.positions && typeof entry.positions === 'object') {
                return entry;
            }
        }
        return null;
    };

    const saveStageLayoutForRhythmData = (data, layoutEntry) => {
        if (!data || !layoutEntry || typeof layoutEntry !== 'object') return;
        const keys = getStageLayoutKeysForRhythmData(data);
        if (!stageLayoutsStore || typeof stageLayoutsStore !== 'object') {
            stageLayoutsStore = { version: STAGE_LAYOUT_EXPORT_VERSION, byRhythm: {} };
        }
        if (!stageLayoutsStore.byRhythm || typeof stageLayoutsStore.byRhythm !== 'object') {
            stageLayoutsStore.byRhythm = {};
        }
        keys.forEach((key) => {
            stageLayoutsStore.byRhythm[key] = layoutEntry;
        });
        persistStageLayoutsStore();
    };

    const normalizeStageValue = (value, fallback) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(1, num));
    };
    const parseStageNorm = (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return Math.max(0, Math.min(1, num));
    };

    let stageBackLineNorm = normalizeStageValue(parseFloat(localStorage.getItem('stageBackLineNorm')), 0.18);
    let stageFrontLineNorm = normalizeStageValue(parseFloat(localStorage.getItem('stageFrontLineNorm')), 0.88);
    let stageRangeNormMin = Math.max(0.01, Math.min(0.9, stageMinVelocityRange));
    const refreshStageRangeNormMin = () => {
        stageRangeNormMin = Math.max(0.01, Math.min(0.9, stageMinVelocityRange));
    };
    if (stageFrontLineNorm <= stageBackLineNorm + stageRangeNormMin) {
        stageFrontLineNorm = Math.min(0.97, stageBackLineNorm + stageRangeNormMin);
    }
    const clampStageLineNorm = (value, fallback) => normalizeStageValue(value, fallback);
    const syncStageVelocityFromLines = () => {
        stageMinVelocity = clampStageMinVelocity(stageBackLineNorm);
        stageMaxVelocity = clampStageMaxVelocity(stageFrontLineNorm);
        enforceStageVelocityRange();
        refreshStageRangeNormMin();
    };
    syncStageVelocityFromLines();

    const stageYFromVolume = (volumeValue) => {
        const volume = Number(volumeValue);
        const minV = clampStageMinVelocity(stageMinVelocity);
        const maxV = clampStageMaxVelocity(stageMaxVelocity);
        const hi = Math.max(minV + 0.0001, maxV);
        const span = Math.max(0.0001, hi - minV);
        const clampedVolume = Number.isFinite(volume) ? Math.max(minV, Math.min(hi, volume)) : hi;
        return (clampedVolume - minV) / span;
    };

    const mapStageYToAreaY = (stageY) => {
        const yNorm = clampStageLineNorm(stageY, 1);
        return stageBackLineNorm + (yNorm * Math.max(0.0001, stageFrontLineNorm - stageBackLineNorm));
    };

    const mapAreaYToStageY = (areaY) => {
        const yNorm = clampStageLineNorm(areaY, stageFrontLineNorm);
        const span = Math.max(0.0001, stageFrontLineNorm - stageBackLineNorm);
        return Math.max(0, Math.min(1, (yNorm - stageBackLineNorm) / span));
    };

    const syncStageRangeUi = () => {
        stageBackValueEl.textContent = `Back ${Math.round(stageMinVelocity * 100)}%`;
        stageFrontValueEl.textContent = `Front ${Math.round(stageMaxVelocity * 100)}%`;
    };

    const syncStageLinesVisual = () => {
        ceilingLine.style.top = `${(stageBackLineNorm * 100).toFixed(2)}%`;
        floorLine.style.top = `${(stageFrontLineNorm * 100).toFixed(2)}%`;
    };

    const stageFromInstrument = (instrument, index, total) => {
        const fallbackX = (index + 1) / (total + 1);
        const fallbackY = mapStageYToAreaY(stageYFromVolume(instrument?.volume));
        const parsedX = parseStageNorm(instrument?.stageX);
        const parsedStageY = parseStageNorm(instrument?.stageY);
        const x = parsedX === null ? fallbackX : parsedX;
        const stageY = parsedStageY === null ? stageYFromVolume(instrument?.volume) : parsedStageY;
        const y = mapStageYToAreaY(stageY);
        return {
            id: String(instrument?.id || `inst_${index}`),
            name: String(instrument?.name || instrument?.id || `Instrument ${index + 1}`),
            type: String(instrument?.type || ''),
            sampleSet: String(instrument?.sampleSet || ''),
            x,
            y
        };
    };

    const applyDefaultStageLayout = () => {
        const data = getStageRhythmData();
        if (!data || !Array.isArray(data.instruments)) return;
        const instruments = data.instruments.slice();
        if (instruments.length === 0) return;
        if (!area.querySelector('.stage-token')) render();

        instruments.forEach((instrument, index) => {
            const id = String(instrument?.id || `inst_${index}`);
            const ratio = instruments.length <= 1 ? 0.5 : (index / (instruments.length - 1));
            const pan = -0.5 + (ratio * 1.0); // -25..25 on a -50..50 range
            let x = Math.max(0, Math.min(1, (pan + 1) / 2));
            const token = area.querySelector(`.stage-token[data-instrument-id="${id}"]`);
            const areaRect = area.getBoundingClientRect();
            let y = mapStageYToAreaY(1);
            if (token && areaRect.width > 2 && areaRect.height > 2) {
                const minX = getDragMinXNorm(token, areaRect);
                const maxX = getDragMaxXNorm(token, areaRect);
                const minY = getDragMinYNorm(token, areaRect);
                const maxY = getDragMaxYNorm(token, areaRect);
                x = Math.max(minX, Math.min(maxX, x));
                y = Math.max(minY, Math.min(maxY, maxY));
            }
            if (!stagePanelStateById[id]) {
                stagePanelStateById[id] = {
                    id,
                    name: String(instrument?.name || id),
                    type: String(instrument?.type || ''),
                    x,
                    y
                };
            } else {
                stagePanelStateById[id].x = x;
                stagePanelStateById[id].y = y;
            }
            queueStageUpdate(id, x, y, false, false);
        });
        flushStageUpdates();
        render();
        saveCurrentStageLayoutToLocal({ notify: false });
        updateStatus(`Stage reset (${instruments.length} instruments).`);
    };

    const updateStatus = (text) => {
        statusEl.textContent = text;
    };

    const saveCurrentStageLayoutToLocal = (options = {}) => {
        const data = getStageRhythmData();
        if (!data || !Array.isArray(data.instruments) || data.instruments.length === 0) return false;

        const positions = {};
        data.instruments.forEach((instrument, index) => {
            const id = String(instrument?.id || `inst_${index}`);
            const state = stagePanelStateById[id];
            if (!state) return;
            const x = Number(state.x);
            const y = Number(state.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            positions[id] = {
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y))
            };
        });

        const layoutEntry = {
            version: STAGE_LAYOUT_EXPORT_VERSION,
            updatedAt: new Date().toISOString(),
            rhythmName: String(data.rhythmName || ''),
            positions
        };
        saveStageLayoutForRhythmData(data, layoutEntry);

        if (options.notify !== false) {
            updateStatus(`Stage layout saved for ${layoutEntry.rhythmName || 'current rhythm'}.`);
        }
        return true;
    };

    const getStageGlobalSettingsSnapshot = () => ({
        stageBackLineNorm: stageBackLineNorm,
        stageFrontLineNorm: stageFrontLineNorm,
        stageMinVelocity: stageMinVelocity,
        stageMaxVelocity: stageMaxVelocity,
        stageMinVelocityRange: stageMinVelocityRange,
        stageBoundsOffsetXPx: stageBoundsOffsetXPx,
        stageBoundsOffsetYPx: stageBoundsOffsetYPx
    });

    const applyStageGlobalSettingsSnapshot = (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') return;
        if (Number.isFinite(Number(snapshot.stageMinVelocityRange))) {
            stageMinVelocityRange = clampStageMinVelocityRange(Number(snapshot.stageMinVelocityRange));
            localStorage.setItem('stageMinVelocityRange', String(stageMinVelocityRange));
        }
        refreshStageRangeNormMin();

        if (Number.isFinite(Number(snapshot.stageBackLineNorm))) {
            stageBackLineNorm = clampStageLineNorm(Number(snapshot.stageBackLineNorm), stageBackLineNorm);
        }
        if (Number.isFinite(Number(snapshot.stageFrontLineNorm))) {
            stageFrontLineNorm = clampStageLineNorm(Number(snapshot.stageFrontLineNorm), stageFrontLineNorm);
        }
        if (stageFrontLineNorm <= stageBackLineNorm + stageRangeNormMin) {
            stageFrontLineNorm = Math.min(0.97, stageBackLineNorm + stageRangeNormMin);
        }
        syncStageVelocityFromLines();
        syncStageLinesVisual();
        syncStageRangeUi();

        if (Number.isFinite(Number(snapshot.stageBoundsOffsetXPx))) {
            stageBoundsOffsetXPx = clampStageBoundsOffsetPx(Number(snapshot.stageBoundsOffsetXPx));
            localStorage.setItem('stageBoundsOffsetXPx', String(stageBoundsOffsetXPx));
        }
        if (Number.isFinite(Number(snapshot.stageBoundsOffsetYPx))) {
            stageBoundsOffsetYPx = clampStageBoundsOffsetPx(Number(snapshot.stageBoundsOffsetYPx));
            localStorage.setItem('stageBoundsOffsetYPx', String(stageBoundsOffsetYPx));
        }

        localStorage.setItem('stageMinVelocity', String(stageMinVelocity));
        localStorage.setItem('stageMaxVelocity', String(stageMaxVelocity));
        localStorage.setItem('stageBackLineNorm', String(stageBackLineNorm));
        localStorage.setItem('stageFrontLineNorm', String(stageFrontLineNorm));
    };

    const STAGE_SEND_INTERVAL_MS = 24;
    let stageSendTimer = null;
    const pendingStageUpdates = new Map();
    const selectedStageIds = new Set();
    const stageLastLiveSentById = new Map();

    const pushStageUpdate = (instrumentId, x, y, transient = false) => {
        if (!instrumentId) return;
        pendingStageUpdates.set(String(instrumentId), {
            type: 'setInstrumentStagePosition',
            instrumentId: String(instrumentId || ''),
            xNorm: Math.max(0, Math.min(1, Number(x) || 0)),
            yNorm: mapAreaYToStageY(Math.max(0, Math.min(1, Number(y) || 0))),
            transient: !!transient
        });
    };

    const flushStageUpdates = () => {
        stageSendTimer = null;
        if (pendingStageUpdates.size === 0) return;
        const bridge = window._notationBridge;
        if (!(bridge && typeof bridge.postMain === 'function')) return;
        pendingStageUpdates.forEach((payload) => {
            bridge.postMain(payload);
            if (typeof bridge.postCircular === 'function') bridge.postCircular(payload);
        });
        pendingStageUpdates.clear();
    };

    const queueStageUpdate = (instrumentId, x, y, immediate = false, transient = false) => {
        pushStageUpdate(instrumentId, x, y, transient);
        if (immediate) {
            if (stageSendTimer) {
                clearTimeout(stageSendTimer);
                stageSendTimer = null;
            }
            flushStageUpdates();
            return;
        }
        if (!stageSendTimer) {
            stageSendTimer = setTimeout(flushStageUpdates, STAGE_SEND_INTERVAL_MS);
        }
    };

    const fitStageTokenWidth = (token, labelEl) => {
        if (!token || !labelEl || !area) return;
        token.style.width = '';
        token.style.minWidth = '';
        const areaRect = area.getBoundingClientRect();
        const tokenRect = token.getBoundingClientRect();
        const iconEl = token.querySelector('.stage-token-icon');
        const iconRect = iconEl ? iconEl.getBoundingClientRect() : null;
        const labelWidth = Math.ceil(labelEl.scrollWidth || 0);
        const iconWidth = Math.ceil(iconRect?.width || 0);
        const style = window.getComputedStyle(token);
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const extra = Math.max(12, iconWidth + 8);
        const desired = Math.max(Math.ceil(tokenRect.width || 0), labelWidth + padX + extra);
        const maxWidth = Math.max(72, areaRect.width - 12);
        const finalWidth = Math.max(72, Math.min(maxWidth, desired));
        token.style.width = `${finalWidth}px`;
        token.style.minWidth = `${finalWidth}px`;
    };

    const render = () => {
        syncStageLinesVisual();
        syncStageRangeUi();
        const data = getStageRhythmData();
        if (!data || !Array.isArray(data.instruments) || data.instruments.length === 0) {
            stagePanelStateById = {};
            stageLastLiveSentById.clear();
            selectedStageIds.clear();
            area.querySelectorAll('.stage-token').forEach((el) => el.remove());
            updateStatus('Load a rhythm to edit stage mix.');
            return;
        }
        const instruments = data.instruments.slice();
        const savedLayoutEntry = getSavedStageLayoutForRhythmData(data);
        const savedPositions = (savedLayoutEntry && savedLayoutEntry.positions && typeof savedLayoutEntry.positions === 'object')
            ? savedLayoutEntry.positions
            : null;
        const nextState = {};
        instruments.forEach((instrument, index) => {
            const id = String(instrument?.id || `inst_${index}`);
            const fromRhythm = stageFromInstrument(instrument, index, instruments.length);
            const savedPos = savedPositions ? savedPositions[id] : null;
            if (savedPos && Number.isFinite(Number(savedPos.x)) && Number.isFinite(Number(savedPos.y))) {
                fromRhythm.x = Math.max(0, Math.min(1, Number(savedPos.x)));
                fromRhythm.y = Math.max(0, Math.min(1, Number(savedPos.y)));
            }
            nextState[id] = {
                ...fromRhythm
            };
        });
        const collapsedToTopLeft = instruments.length > 1 && Object.values(nextState).every((entry) => {
            const x = Number(entry?.x);
            const y = Number(entry?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
            return x <= 0.001 && Math.abs(y - stageBackLineNorm) <= 0.001;
        });
        if (collapsedToTopLeft) {
            instruments.forEach((instrument, index) => {
                const id = String(instrument?.id || `inst_${index}`);
                const ratio = instruments.length <= 1 ? 0.5 : (index / (instruments.length - 1));
                const pan = -0.5 + (ratio * 1.0);
                const x = Math.max(0, Math.min(1, (pan + 1) / 2));
                const y = mapStageYToAreaY(1);
                nextState[id] = {
                    id,
                    name: String(instrument?.name || id),
                    type: String(instrument?.type || ''),
                    x,
                    y
                };
                queueStageUpdate(id, x, y, false, false);
            });
            flushStageUpdates();
        }
        stagePanelStateById = nextState;
        stageLastLiveSentById.clear();

        area.querySelectorAll('.stage-token').forEach((el) => el.remove());
        const areaRect = area.getBoundingClientRect();
        instruments.forEach((instrument, index) => {
            const id = String(instrument?.id || `inst_${index}`);
            const state = nextState[id];
            if (!state) return;
            const token = document.createElement('button');
            token.type = 'button';
            token.className = 'stage-token';
            token.dataset.instrumentId = id;
            token.dataset.floatingInteractive = 'true';
            token.style.left = `${(state.x * 100).toFixed(2)}%`;
            token.style.top = `${(state.y * 100).toFixed(2)}%`;
            const hue = (index * 47) % 360;
            const tokenColor = `hsl(${hue} 88% 72%)`;
            token.style.setProperty('--stage-token-color', tokenColor);
            token.style.setProperty('--stage-token-border', `hsla(${hue} 90% 72% / 0.78)`);
            token.style.setProperty('--stage-token-bg-1', `hsla(${hue} 78% 42% / 0.42)`);
            token.style.setProperty('--stage-token-bg-2', `hsla(${hue} 52% 12% / 0.9)`);
            token.style.setProperty('--stage-token-glow', `hsla(${hue} 90% 60% / 0.32)`);

            const iconWrap = document.createElement('span');
            iconWrap.className = 'stage-token-icon';
            const iconPath = iconForInstrument(state);
            if (iconPath) {
                const img = document.createElement('img');
                img.src = iconPath;
                img.alt = state.name;
                iconWrap.appendChild(img);
            } else {
                iconWrap.textContent = '🎵';
            }

            const label = document.createElement('span');
            label.className = 'stage-token-label';
            label.textContent = state.name;
            label.style.color = tokenColor;
            token.appendChild(iconWrap);
            token.appendChild(label);
            area.appendChild(token);
            fitStageTokenWidth(token, label);
            // Keep the token visually inside the stage at this window size. The limit is in pixels (icon and
            // label size), so a smaller window would otherwise move saved/imported positions and change the
            // mix: only the drawing moves, the instrument keeps its saved position for sound and saving.
            if (areaRect.width > 2 && areaRect.height > 2) {
                const rawX = Number(state.x);
                const baseX = Number.isFinite(rawX) ? rawX : 0.5;
                const minX = getDragMinXNorm(token, areaRect);
                const maxX = getDragMaxXNorm(token, areaRect);
                const minY = getDragMinYNorm(token, areaRect);
                const maxY = getDragMaxYNorm(token, areaRect);
                const rawY = Number(state.y);
                const baseY = Number.isFinite(rawY) ? rawY : maxY;
                const clampedX = Math.max(minX, Math.min(maxX, baseX));
                const clampedY = Math.max(minY, Math.min(maxY, baseY));
                if (Math.abs(clampedX - baseX) > 0.0001 || Math.abs(clampedY - baseY) > 0.0001) {
                    token.style.left = `${(clampedX * 100).toFixed(2)}%`;
                    token.style.top = `${(clampedY * 100).toFixed(2)}%`;
                }
            }
        });
        Array.from(selectedStageIds).forEach((id) => {
            if (!nextState[id]) selectedStageIds.delete(id);
        });
        area.querySelectorAll('.stage-token').forEach((el) => {
            const id = String(el?.dataset?.instrumentId || '');
            el.classList.toggle('selected', selectedStageIds.has(id));
        });
        updateStatus(`Stage ready (${instruments.length} instruments). Back ${Math.round(stageMinVelocity * 100)}% / Front ${Math.round(stageMaxVelocity * 100)}%.`);
    };

    const setTokenPositionNorm = (token, xNorm, yNorm) => {
        const instrumentId = token?.dataset?.instrumentId;
        if (!instrumentId) return;
        token.style.left = `${(xNorm * 100).toFixed(2)}%`;
        token.style.top = `${(yNorm * 100).toFixed(2)}%`;
        if (!stagePanelStateById[instrumentId]) {
            stagePanelStateById[instrumentId] = { id: instrumentId, name: instrumentId, type: '', x: xNorm, y: yNorm };
        } else {
            stagePanelStateById[instrumentId].x = xNorm;
            stagePanelStateById[instrumentId].y = yNorm;
        }
        // Keep drag interactions local and lightweight. Audio/state updates are committed on release.
    };

    const syncTokenSelectionVisual = () => {
        area.querySelectorAll('.stage-token').forEach((token) => {
            const id = String(token?.dataset?.instrumentId || '');
            token.classList.toggle('selected', selectedStageIds.has(id));
        });
    };

    const clearSelection = () => {
        selectedStageIds.clear();
        syncTokenSelectionVisual();
    };

    const getTokenStageCircleMetrics = (token) => {
        const tokenRect = token?.getBoundingClientRect?.();
        const iconEl = token?.querySelector?.('.stage-token-icon');
        const iconRect = iconEl?.getBoundingClientRect?.();
        if (!tokenRect || !iconRect) return { radiusPx: 0, centerOffsetPx: 0 };
        const scaleRaw = parseFloat(window.getComputedStyle(token).getPropertyValue('--stage-token-scale'));
        const tokenScale = Number.isFinite(scaleRaw) ? Math.max(0.6, scaleRaw) : 1;
        const isDragging = token?.classList?.contains('dragging');
        const isSelected = token?.classList?.contains('selected');
        // Keep this aligned with .stage-token-icon::after:
        // inset = -3px * scale, border width depends on selected/dragging state.
        const insetPx = 3 * tokenScale;
        const borderPx = isDragging
            ? Math.max(1.5, 1.25 * tokenScale)
            : (isSelected ? Math.max(1, 1 * tokenScale) : 0);
        const outerGlowPx = isDragging ? 16 : (isSelected ? 10 : 6); // includes icon drop-shadow baseline
        // Safety margin avoids subpixel crossover at high scales.
        const outlineExtentPx = Math.max(3, insetPx + borderPx + outerGlowPx + 1.5);
        const radiusPx = (iconRect.height * 0.5) + outlineExtentPx;
        const tokenCenterY = tokenRect.top + (tokenRect.height * 0.5);
        const iconCenterY = iconRect.top + (iconRect.height * 0.5);
        const centerOffsetPx = iconCenterY - tokenCenterY;
        return { radiusPx, centerOffsetPx };
    };

    const getDragMinYNorm = (token, areaRect) => {
        if (areaRect.height <= 2) return 0;
        const { radiusPx, centerOffsetPx } = getTokenStageCircleMetrics(token);
        const yOffsetPx = clampStageBoundsOffsetPx(stageBoundsOffsetYPx);
        const minCenterPx = areaRect.top + (stageBackLineNorm * areaRect.height) + radiusPx - centerOffsetPx - yOffsetPx;
        const minNorm = (minCenterPx - areaRect.top) / areaRect.height;
        return Math.max(0, Math.min(1, minNorm));
    };

    const getDragMaxYNorm = (token, areaRect) => {
        if (areaRect.height <= 2) return 1;
        const { radiusPx, centerOffsetPx } = getTokenStageCircleMetrics(token);
        const yOffsetPx = clampStageBoundsOffsetPx(stageBoundsOffsetYPx);
        const maxCenterPx = areaRect.top + (stageFrontLineNorm * areaRect.height) - radiusPx - centerOffsetPx + yOffsetPx;
        const circleMaxNorm = Math.max(0, Math.min(1, (maxCenterPx - areaRect.top) / areaRect.height));

        // Also keep the full token (including label text) above front-stage line.
        const tokenRect = token?.getBoundingClientRect?.();
        if (!tokenRect) return circleMaxNorm;
        const tokenHalfHeight = tokenRect.height * 0.5;
        const tokenMaxCenterPx = areaRect.top + (stageFrontLineNorm * areaRect.height) - tokenHalfHeight + yOffsetPx;
        const tokenMaxNorm = Math.max(0, Math.min(1, (tokenMaxCenterPx - areaRect.top) / areaRect.height));
        return Math.max(0, Math.min(1, Math.min(circleMaxNorm, tokenMaxNorm)));
    };

    const getDragMinXNorm = (token, areaRect) => {
        if (areaRect.width <= 2) return 0;
        const tokenRect = token?.getBoundingClientRect?.();
        if (!tokenRect) return 0;
        const xOffsetPx = clampStageBoundsOffsetPx(stageBoundsOffsetXPx);
        const tokenHalfWidth = tokenRect.width * 0.5;
        const minCenterPx = areaRect.left + tokenHalfWidth - xOffsetPx;
        const minNorm = (minCenterPx - areaRect.left) / areaRect.width;
        return Math.max(0, Math.min(1, minNorm));
    };

    const getDragMaxXNorm = (token, areaRect) => {
        if (areaRect.width <= 2) return 1;
        const tokenRect = token?.getBoundingClientRect?.();
        if (!tokenRect) return 1;
        const xOffsetPx = clampStageBoundsOffsetPx(stageBoundsOffsetXPx);
        const tokenHalfWidth = tokenRect.width * 0.5;
        const maxCenterPx = areaRect.left + areaRect.width - tokenHalfWidth + xOffsetPx;
        const maxNorm = (maxCenterPx - areaRect.left) / areaRect.width;
        return Math.max(0, Math.min(1, maxNorm));
    };

    const moveToken = (token, clientX, clientY) => {
        const instrumentId = token?.dataset?.instrumentId;
        if (!instrumentId) return;
        const rect = area.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2) return;
        const minX = getDragMinXNorm(token, rect);
        const maxX = getDragMaxXNorm(token, rect);
        const xRaw = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const x = Math.max(minX, Math.min(maxX, xRaw));
        const yRaw = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        const minY = getDragMinYNorm(token, rect);
        const maxY = getDragMaxYNorm(token, rect);
        const y = Math.max(minY, Math.min(maxY, yRaw));
        setTokenPositionNorm(token, x, y);
    };

    const tokenVisualHitDistance = (token, clientX, clientY) => {
        if (!token) return Number.POSITIVE_INFINITY;
        const iconEl = token.querySelector('.stage-token-icon');
        const iconRect = iconEl?.getBoundingClientRect?.();
        if (!iconRect) return Number.POSITIVE_INFINITY;
        const cx = iconRect.left + (iconRect.width * 0.5);
        const cy = iconRect.top + (iconRect.height * 0.5);
        const dx = Number(clientX) - cx;
        const dy = Number(clientY) - cy;
        const distance = Math.hypot(dx, dy);
        const radius = Math.max(8, (Math.min(iconRect.width, iconRect.height) * 0.5) + 12);
        if (distance <= radius) return distance;

        const labelEl = token.querySelector('.stage-token-label');
        const labelRect = labelEl?.getBoundingClientRect?.();
        if (labelRect) {
            const padX = 6;
            const padY = 3;
            const inLabel = (Number(clientX) >= (labelRect.left - padX))
                && (Number(clientX) <= (labelRect.right + padX))
                && (Number(clientY) >= (labelRect.top - padY))
                && (Number(clientY) <= (labelRect.bottom + padY));
            if (inLabel) return distance + 1;
        }
        return Number.POSITIVE_INFINITY;
    };

    const getVisualTokenAtPoint = (clientX, clientY) => {
        let bestToken = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        area.querySelectorAll('.stage-token').forEach((tokenEl) => {
            const d = tokenVisualHitDistance(tokenEl, clientX, clientY);
            if (d < bestDistance) {
                bestDistance = d;
                bestToken = tokenEl;
            }
        });
        return Number.isFinite(bestDistance) ? bestToken : null;
    };

    let draggingToken = null;
    let draggingPointerId = null;
    let dragStartNorm = null;
    let dragStartPositions = null;
    let dragInstrumentIds = null;
    let dragTokenEls = null;
    let selectionPointerId = null;
    let selectionStart = null;
    let selectionBox = null;

    const ensureSelectionBox = () => {
        if (selectionBox && selectionBox.isConnected) return selectionBox;
        selectionBox = document.createElement('div');
        selectionBox.className = 'stage-selection-box';
        area.appendChild(selectionBox);
        return selectionBox;
    };

    const hideSelectionBox = () => {
        if (!selectionBox) return;
        selectionBox.remove();
        selectionBox = null;
    };

    const commitStagePositions = (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return;
        ids.forEach((id) => {
            const state = stagePanelStateById[id];
            if (!state) return;
            stageLastLiveSentById.delete(id);
            pushStageUpdate(id, state.x, state.y, false);
        });
        flushStageUpdates();
        saveCurrentStageLayoutToLocal({ notify: false });
    };

    area.addEventListener('pointerdown', (e) => {
        const token = getVisualTokenAtPoint(e.clientX, e.clientY);
        if (e.pointerType !== 'touch' && e.button !== 0) return;
        const areaRect = area.getBoundingClientRect();
        if (!token) {
            draggingToken = null;
            draggingPointerId = null;
            dragStartNorm = null;
            dragStartPositions = null;
            dragInstrumentIds = null;
            selectionPointerId = e.pointerId;
            selectionStart = {
                x: Math.max(0, Math.min(1, (e.clientX - areaRect.left) / Math.max(1, areaRect.width))),
                y: Math.max(0, Math.min(1, (e.clientY - areaRect.top) / Math.max(1, areaRect.height)))
            };
            if (!e.shiftKey) clearSelection();
            const box = ensureSelectionBox();
            box.style.left = `${(selectionStart.x * 100).toFixed(2)}%`;
            box.style.top = `${(selectionStart.y * 100).toFixed(2)}%`;
            box.style.width = '0%';
            box.style.height = '0%';
            e.preventDefault();
            return;
        }

        const tokenId = String(token.dataset.instrumentId || '');
        if (!tokenId) return;
        if (e.shiftKey) {
            if (selectedStageIds.has(tokenId)) selectedStageIds.delete(tokenId);
            else selectedStageIds.add(tokenId);
        } else if (!selectedStageIds.has(tokenId)) {
            selectedStageIds.clear();
            selectedStageIds.add(tokenId);
        }
        syncTokenSelectionVisual();

        draggingToken = token;
        draggingPointerId = e.pointerId;
        dragStartNorm = {
            x: Math.max(0, Math.min(1, (e.clientX - areaRect.left) / Math.max(1, areaRect.width))),
            y: Math.max(0, Math.min(1, (e.clientY - areaRect.top) / Math.max(1, areaRect.height)))
        };
        dragInstrumentIds = Array.from(selectedStageIds);
        if (dragInstrumentIds.length === 0) dragInstrumentIds = [tokenId];
        dragStartPositions = new Map();
        dragTokenEls = new Map();
        dragInstrumentIds.forEach((id) => {
            const state = stagePanelStateById[id];
            if (!state) return;
            dragStartPositions.set(id, { x: state.x, y: state.y });
            const el = area.querySelector(`.stage-token[data-instrument-id="${id}"]`);
            if (el) {
                dragTokenEls.set(id, el);
                el.classList.add('dragging');
            }
        });
        try { token.setPointerCapture(draggingPointerId); } catch {}
        e.preventDefault();
    });
    area.addEventListener('pointermove', (e) => {
        const areaRect = area.getBoundingClientRect();
        if (selectionPointerId === e.pointerId && selectionStart) {
            const current = {
                x: Math.max(0, Math.min(1, (e.clientX - areaRect.left) / Math.max(1, areaRect.width))),
                y: Math.max(0, Math.min(1, (e.clientY - areaRect.top) / Math.max(1, areaRect.height)))
            };
            const minX = Math.min(selectionStart.x, current.x);
            const maxX = Math.max(selectionStart.x, current.x);
            const minY = Math.min(selectionStart.y, current.y);
            const maxY = Math.max(selectionStart.y, current.y);
            const box = ensureSelectionBox();
            box.style.left = `${(minX * 100).toFixed(2)}%`;
            box.style.top = `${(minY * 100).toFixed(2)}%`;
            box.style.width = `${((maxX - minX) * 100).toFixed(2)}%`;
            box.style.height = `${((maxY - minY) * 100).toFixed(2)}%`;

            area.querySelectorAll('.stage-token').forEach((tokenEl) => {
                const id = String(tokenEl.dataset.instrumentId || '');
                const state = stagePanelStateById[id];
                if (!state) return;
                const inside = state.x >= minX && state.x <= maxX && state.y >= minY && state.y <= maxY;
                if (inside) selectedStageIds.add(id);
                else if (!e.shiftKey) selectedStageIds.delete(id);
            });
            syncTokenSelectionVisual();
            e.preventDefault();
            return;
        }

        if (!draggingToken || draggingPointerId !== e.pointerId || !dragStartNorm || !dragStartPositions || !dragInstrumentIds) return;
        const current = {
            x: Math.max(0, Math.min(1, (e.clientX - areaRect.left) / Math.max(1, areaRect.width))),
            y: Math.max(0, Math.min(1, (e.clientY - areaRect.top) / Math.max(1, areaRect.height)))
        };
        const dx = current.x - dragStartNorm.x;
        const dy = current.y - dragStartNorm.y;

        let allowedDyMin = -1;
        let allowedDyMax = 1;
        let allowedDxMin = -1;
        let allowedDxMax = 1;
        dragInstrumentIds.forEach((id) => {
            const start = dragStartPositions.get(id);
            if (!start) return;
            const tokenEl = dragTokenEls ? dragTokenEls.get(id) : null;
            if (!tokenEl) return;
            const minX = getDragMinXNorm(tokenEl, areaRect);
            const maxX = getDragMaxXNorm(tokenEl, areaRect);
            const minY = getDragMinYNorm(tokenEl, areaRect);
            const maxY = getDragMaxYNorm(tokenEl, areaRect);
            allowedDxMin = Math.max(allowedDxMin, minX - start.x);
            allowedDxMax = Math.min(allowedDxMax, maxX - start.x);
            allowedDyMin = Math.max(allowedDyMin, minY - start.y);
            allowedDyMax = Math.min(allowedDyMax, maxY - start.y);
        });
        const dxClamped = Math.max(allowedDxMin, Math.min(allowedDxMax, dx));
        const dyClamped = Math.max(allowedDyMin, Math.min(allowedDyMax, dy));

        dragInstrumentIds.forEach((id) => {
            const start = dragStartPositions.get(id);
            if (!start) return;
            const tokenEl = dragTokenEls ? dragTokenEls.get(id) : null;
            if (!tokenEl) return;
            const minX = getDragMinXNorm(tokenEl, areaRect);
            const maxX = getDragMaxXNorm(tokenEl, areaRect);
            const minY = getDragMinYNorm(tokenEl, areaRect);
            const maxY = getDragMaxYNorm(tokenEl, areaRect);
            const x = Math.max(minX, Math.min(maxX, start.x + dxClamped));
            const y = Math.max(minY, Math.min(maxY, start.y + dyClamped));
            setTokenPositionNorm(tokenEl, x, y);
        });
        e.preventDefault();
    });
    const stopDrag = (e) => {
        if (selectionPointerId === e.pointerId) {
            selectionPointerId = null;
            selectionStart = null;
            hideSelectionBox();
            return;
        }
        if (!draggingToken || draggingPointerId !== e.pointerId) return;
        const commitIds = Array.isArray(dragInstrumentIds) ? dragInstrumentIds.slice() : [];
        area.querySelectorAll('.stage-token.dragging').forEach((tokenEl) => tokenEl.classList.remove('dragging'));
        draggingToken = null;
        draggingPointerId = null;
        dragStartNorm = null;
        dragStartPositions = null;
        dragInstrumentIds = null;
        dragTokenEls = null;
        commitStagePositions(commitIds);
    };
    area.addEventListener('pointerup', stopDrag);
    area.addEventListener('pointercancel', stopDrag);
    area.addEventListener('lostpointercapture', stopDrag);

    const sendStageVolumeRange = () => {
        const bridge = window._notationBridge;
        if (!(bridge && typeof bridge.postMain === 'function')) return;
        const payload = {
            type: 'setStageVolumeRange',
            min: clampStageMinVelocity(stageMinVelocity),
            max: clampStageMaxVelocity(stageMaxVelocity)
        };
        bridge.postMain(payload);
        if (typeof bridge.postCircular === 'function') bridge.postCircular(payload);
    };

    function requestStageState() {
        const bridge = window._notationBridge;
        if (bridge && typeof bridge.postMain === 'function') {
            bridge.postMain({ type: 'requestRhythmState' });
        }
    }

    const applyStageVolumeRange = (nextMin, nextMax, options = {}) => {
        const opts = {
            persist: options.persist !== false,
            broadcast: options.broadcast !== false,
            updateControls: options.updateControls !== false,
            requestState: options.requestState !== false
        };
        stageMinVelocity = clampStageMinVelocity(nextMin);
        stageMaxVelocity = clampStageMaxVelocity(nextMax);
        enforceStageVelocityRange();
        refreshStageRangeNormMin();
        stageBackLineNorm = stageMinVelocity;
        stageFrontLineNorm = stageMaxVelocity;
        if (opts.persist) {
            localStorage.setItem('stageMinVelocity', String(stageMinVelocity));
            localStorage.setItem('stageMaxVelocity', String(stageMaxVelocity));
            localStorage.setItem('stageMinVelocityRange', String(stageMinVelocityRange));
            localStorage.setItem('stageBackLineNorm', String(stageBackLineNorm));
            localStorage.setItem('stageFrontLineNorm', String(stageFrontLineNorm));
        }
        if (opts.updateControls) syncStageRangeUi();
        if (opts.broadcast) sendStageVolumeRange();
        if (opts.requestState) requestStageState();
        if (!panel.classList.contains('hidden')) render();
    };
    window._applyStageMinVelocity = (nextValue, options = {}) => {
        refreshStageRangeNormMin();
        stageBackLineNorm = Math.max(0.04, Math.min(stageFrontLineNorm - stageRangeNormMin, clampStageLineNorm(nextValue, stageBackLineNorm)));
        syncStageVelocityFromLines();
        syncStageLinesVisual();
        applyStageVolumeRange(stageMinVelocity, stageMaxVelocity, options);
    };
    window._applyStageMaxVelocity = (nextValue, options = {}) => {
        refreshStageRangeNormMin();
        stageFrontLineNorm = Math.max(stageBackLineNorm + stageRangeNormMin, Math.min(0.97, clampStageLineNorm(nextValue, stageFrontLineNorm)));
        syncStageVelocityFromLines();
        syncStageLinesVisual();
        applyStageVolumeRange(stageMinVelocity, stageMaxVelocity, options);
    };
    syncStageRangeUi();
    syncStageLinesVisual();

    let lineDragPointerId = null;
    let lineDragType = '';
    const beginLineDrag = (event, type) => {
        if (event.pointerType !== 'touch' && event.button !== 0) return;
        lineDragPointerId = event.pointerId;
        lineDragType = type;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
        event.stopPropagation();
        event.preventDefault();
    };
    const updateLineDrag = (event) => {
        if (!lineDragPointerId || event.pointerId !== lineDragPointerId || !lineDragType) return;
        const areaRect = area.getBoundingClientRect();
        const prevBackLineNorm = stageBackLineNorm;
        const prevFrontLineNorm = stageFrontLineNorm;
        const yNorm = clampStageLineNorm((event.clientY - areaRect.top) / Math.max(1, areaRect.height), 0.5);
        refreshStageRangeNormMin();
        if (lineDragType === 'back') {
            stageBackLineNorm = Math.max(0.04, Math.min(stageFrontLineNorm - stageRangeNormMin, yNorm));
        } else {
            stageFrontLineNorm = Math.max(stageBackLineNorm + stageRangeNormMin, Math.min(0.97, yNorm));
        }
        syncStageVelocityFromLines();
        syncStageLinesVisual();
        syncStageRangeUi();
        // Preserve each instrument's relative depth ratio between back/front
        // bounds so moving stage range shifts all tokens proportionally.
        const prevSpan = Math.max(0.0001, prevFrontLineNorm - prevBackLineNorm);
        const nextSpan = Math.max(0.0001, stageFrontLineNorm - stageBackLineNorm);
        area.querySelectorAll('.stage-token').forEach((tokenEl) => {
            const id = String(tokenEl?.dataset?.instrumentId || '');
            const state = stagePanelStateById[id];
            if (!state) return;
            const rawX = Number(state.x);
            const baseX = Number.isFinite(rawX) ? rawX : 0.5;
            const currentY = Number.isFinite(Number(state.y)) ? Number(state.y) : stageFrontLineNorm;
            const ratio = Math.max(0, Math.min(1, (currentY - prevBackLineNorm) / prevSpan));
            const projectedY = stageBackLineNorm + (ratio * nextSpan);
            const minX = getDragMinXNorm(tokenEl, areaRect);
            const maxX = getDragMaxXNorm(tokenEl, areaRect);
            const minY = getDragMinYNorm(tokenEl, areaRect);
            const maxY = getDragMaxYNorm(tokenEl, areaRect);
            const x = Math.max(minX, Math.min(maxX, baseX));
            const y = Math.max(minY, Math.min(maxY, projectedY));
            if (Math.abs(y - currentY) > 0.0001 || Math.abs(x - baseX) > 0.0001) {
                setTokenPositionNorm(tokenEl, x, y);
            } else {
                queueStageUpdate(id, baseX, currentY, false, true);
            }
        });
        sendStageVolumeRange();
        event.preventDefault();
    };
    const endLineDrag = (event) => {
        if (!lineDragPointerId || event.pointerId !== lineDragPointerId) return;
        lineDragPointerId = null;
        lineDragType = '';
        applyStageVolumeRange(stageMinVelocity, stageMaxVelocity, {
            persist: true,
            broadcast: true,
            updateControls: true,
            requestState: false
        });
        const commitIds = Object.keys(stagePanelStateById);
        commitStagePositions(commitIds);
    };
    ceilingLine.addEventListener('pointerdown', (event) => beginLineDrag(event, 'back'));
    floorLine.addEventListener('pointerdown', (event) => beginLineDrag(event, 'front'));
    area.addEventListener('pointermove', updateLineDrag, { passive: false });
    area.addEventListener('pointerup', endLineDrag);
    area.addEventListener('pointercancel', endLineDrag);

    if (stageResetLayoutBtn) {
        stageResetLayoutBtn.addEventListener('click', () => {
            const presetMinRaw = parseFloat(localStorage.getItem('stageMinVelocityPreset'));
            const presetMaxRaw = parseFloat(localStorage.getItem('stageMaxVelocityPreset'));
            let resetMin = clampStageMinVelocity(
                Number.isFinite(presetMinRaw) ? presetMinRaw : stageMinVelocity
            );
            let resetMax = clampStageMaxVelocity(
                Number.isFinite(presetMaxRaw) ? presetMaxRaw : stageMaxVelocity
            );
            const requiredSpan = Math.max(0.01, Math.min(0.9, stageMinVelocityRange));
            if (resetMax < resetMin + requiredSpan) {
                resetMax = Math.min(1, resetMin + requiredSpan);
            }
            if (resetMax <= resetMin) {
                resetMin = 0.18;
                resetMax = 0.88;
            }
            stageBackLineNorm = resetMin;
            stageFrontLineNorm = resetMax;
            syncStageVelocityFromLines();
            syncStageLinesVisual();
            syncStageRangeUi();
            applyDefaultStageLayout();
            applyStageVolumeRange(stageMinVelocity, stageMaxVelocity, {
                persist: true,
                broadcast: true,
                updateControls: true,
                requestState: false
            });
        });
    }

    if (stageSaveLayoutBtn && stageSaveLayoutBtn.dataset.bound !== '1') {
        stageSaveLayoutBtn.dataset.bound = '1';
        stageSaveLayoutBtn.addEventListener('click', () => {
            const saved = saveCurrentStageLayoutToLocal({ notify: false });
            applyStageGlobalSettingsSnapshot(getStageGlobalSettingsSnapshot());
            if (saved) {
                updateStatus('Stage layout saved locally.');
                ensureInAppUi().toast('Stage layout saved.', 'success', 1800);
            } else {
                updateStatus('Load a rhythm before saving stage layout.');
            }
        });
    }

    if (stageExportLayoutBtn && stageExportLayoutBtn.dataset.bound !== '1') {
        stageExportLayoutBtn.dataset.bound = '1';
        stageExportLayoutBtn.addEventListener('click', () => {
            saveCurrentStageLayoutToLocal({ notify: false });
            const payload = {
                version: STAGE_LAYOUT_EXPORT_VERSION,
                exportedAt: new Date().toISOString(),
                global: getStageGlobalSettingsSnapshot(),
                layouts: (stageLayoutsStore && typeof stageLayoutsStore.byRhythm === 'object')
                    ? stageLayoutsStore.byRhythm
                    : {}
            };
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            a.href = url;
            a.download = `rrc-stage-settings-${stamp}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            updateStatus('Stage settings exported.');
        });
    }

    if (stageImportLayoutBtn && stageImportLayoutFile && stageImportLayoutBtn.dataset.bound !== '1') {
        stageImportLayoutBtn.dataset.bound = '1';
        stageImportLayoutBtn.addEventListener('click', () => {
            stageImportLayoutFile.value = '';
            stageImportLayoutFile.click();
        });
        stageImportLayoutFile.addEventListener('change', async () => {
            const file = stageImportLayoutFile.files && stageImportLayoutFile.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const candidateLayouts = (parsed && typeof parsed.layouts === 'object' && parsed.layouts)
                    || (parsed && typeof parsed.byRhythm === 'object' && parsed.byRhythm)
                    || (parsed && typeof parsed.stageLayouts === 'object' && parsed.stageLayouts)
                    || null;

                const importedByRhythm = {};
                if (candidateLayouts && typeof candidateLayouts === 'object') {
                    Object.entries(candidateLayouts).forEach(([key, entry]) => {
                        if (!entry || typeof entry !== 'object') return;
                        const positionsRaw = entry.positions && typeof entry.positions === 'object' ? entry.positions : null;
                        if (!positionsRaw) return;
                        const positions = {};
                        Object.entries(positionsRaw).forEach(([instrumentId, pos]) => {
                            const x = Number(pos && pos.x);
                            const y = Number(pos && pos.y);
                            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                            positions[String(instrumentId)] = {
                                x: Math.max(0, Math.min(1, x)),
                                y: Math.max(0, Math.min(1, y))
                            };
                        });
                        if (Object.keys(positions).length === 0) return;
                        importedByRhythm[String(key)] = {
                            version: STAGE_LAYOUT_EXPORT_VERSION,
                            updatedAt: String(entry.updatedAt || new Date().toISOString()),
                            rhythmName: String(entry.rhythmName || ''),
                            positions
                        };
                    });
                }

                if (Object.keys(importedByRhythm).length === 0) {
                    await ensureInAppUi().alert('No valid stage layouts were found in this JSON file.', 'Import Stage');
                    return;
                }

                stageLayoutsStore = {
                    version: STAGE_LAYOUT_EXPORT_VERSION,
                    byRhythm: importedByRhythm
                };
                persistStageLayoutsStore();

                const global = (parsed && typeof parsed.global === 'object' && parsed.global)
                    || (parsed && typeof parsed.stageGlobal === 'object' && parsed.stageGlobal)
                    || null;
                if (global) {
                    applyStageGlobalSettingsSnapshot(global);
                }

                render();
                const commitIds = Object.keys(stagePanelStateById || {});
                if (commitIds.length > 0) {
                    commitStagePositions(commitIds);
                }
                updateStatus(`Imported ${Object.keys(importedByRhythm).length} stage layout(s).`);
                ensureInAppUi().toast('Stage settings imported.', 'success', 2200);
            } catch (error) {
                console.error('Stage import failed:', error);
                await ensureInAppUi().alert(`Failed to import stage settings: ${error?.message || error}`, 'Import Stage');
            }
        });
    }

    let stageRenderQueued = false;
    const queueRenderIfVisible = () => {
        if (panel.classList.contains('hidden')) return;
        if (stageRenderQueued) return;
        stageRenderQueued = true;
        requestAnimationFrame(() => {
            stageRenderQueued = false;
            if (!panel.classList.contains('hidden')) render();
        });
    };

    const refreshIfVisible = () => {
        queueRenderIfVisible();
    };

    window._refreshStagePanelLayout = refreshIfVisible;

    window.addEventListener('rrc:notation-rhythm-state', refreshIfVisible);
    const observer = new MutationObserver(() => {
        if (panel.classList.contains('hidden')) {
            hideSelectionBox();
            selectionPointerId = null;
            selectionStart = null;
            return;
        }
        sendStageVolumeRange();
        requestStageState();
        queueRenderIfVisible();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', refreshIfVisible);
    sendStageVolumeRange();
    requestStageState();
    refreshIfVisible();
}

function setupAuthPanel() {
    const panel = document.getElementById('auth-panel');
    if (!panel || panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const userDisplay = document.getElementById('auth-user-display');
    const userAvatar = document.getElementById('auth-user-avatar');
    const profileRow = document.getElementById('auth-profile-row');
    const viewRow = document.getElementById('auth-view-row');
    const profileUsernameInput = document.getElementById('auth-profile-username');
    const profileSaveBtn = document.getElementById('auth-profile-save-btn');
    const saveViewBtn = document.getElementById('auth-save-view-btn');
    const restoreViewBtn = document.getElementById('auth-restore-view-btn');
    const uploadAvatarBtn = document.getElementById('auth-upload-avatar-btn');
    const uploadAvatarFile = document.getElementById('auth-upload-avatar-file');
    const signOutBtn = document.getElementById('auth-signout-btn');
    const signInModeBtn = document.getElementById('auth-mode-signin');
    const signUpModeBtn = document.getElementById('auth-mode-signup');
    const modeRow = signInModeBtn?.parentElement || null;
    const signInForm = document.getElementById('auth-signin-form');
    const signUpForm = document.getElementById('auth-signup-form');
    const signInEmail = document.getElementById('auth-signin-email');
    const signInPassword = document.getElementById('auth-signin-password');
    const signUpUsername = document.getElementById('auth-signup-username');
    const signUpAvatarFile = document.getElementById('auth-signup-avatar-file');
    const signUpEmail = document.getElementById('auth-signup-email');
    const signUpPassword = document.getElementById('auth-signup-password');
    const signInBtn = document.getElementById('auth-signin-btn');
    const signUpBtn = document.getElementById('auth-signup-btn');
    const googleBtn = document.getElementById('auth-google-btn');
    const googleRow = document.getElementById('auth-google-row');
    const status = document.getElementById('auth-status');
    if (!signInModeBtn || !signUpModeBtn || !signInForm || !signUpForm || !status) return;
    const AUTH_ENABLE_GOOGLE = false;
    if (googleRow) googleRow.style.display = AUTH_ENABLE_GOOGLE ? '' : 'none';
    const AVATAR_BUCKET = 'avatars';
    const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
    const AVATAR_SIGNED_URL_TTL = 60 * 60;
    let avatarRenderToken = 0;
    let currentAuthUser = null;

    const hasSupabase = typeof window.supabase !== 'undefined'
        && typeof window.supabase.createClient === 'function'
        && typeof SUPABASE_URL !== 'undefined'
        && !!SUPABASE_URL
        && typeof SUPABASE_ANON_KEY !== 'undefined'
        && !!SUPABASE_ANON_KEY;

    let supabaseClient = null;
    if (hasSupabase) {
        try {
            if (!window.__rrcSupabaseAuthClient) {
                window.__rrcSupabaseAuthClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });
            }
            supabaseClient = window.__rrcSupabaseAuthClient;
        } catch {}
    }

    const setMode = (mode) => {
        const signup = mode === 'signup';
        signInForm.classList.toggle('hidden', signup);
        signUpForm.classList.toggle('hidden', !signup);
        signInModeBtn.classList.toggle('active', !signup);
        signUpModeBtn.classList.toggle('active', signup);
    };

    const setStatus = (message, kind = 'info') => {
        status.textContent = message;
        status.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
        if (kind === 'success') status.classList.add('panel-status-success');
        if (kind === 'warn') status.classList.add('panel-status-warn');
        if (kind === 'error') status.classList.add('panel-status-error');
    };
    const sanitizeFileName = (name) => {
        const raw = String(name || 'avatar').trim().toLowerCase();
        const cleaned = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
        return cleaned || 'avatar';
    };

    const resolveAvatarUrlForUser = async (user) => {
        const avatarPath = String(user?.user_metadata?.avatar_path || '').trim();
        if (avatarPath) {
            const { data, error } = await supabaseClient.storage
                .from(AVATAR_BUCKET)
                .createSignedUrl(avatarPath, AVATAR_SIGNED_URL_TTL);
            if (!error && data?.signedUrl) return String(data.signedUrl).trim();
        }
        const legacyUrl = String(user?.user_metadata?.avatar_url || '').trim();
        return legacyUrl;
    };

    const renderAvatar = async (user) => {
        if (!userAvatar) return;
        const currentToken = ++avatarRenderToken;
        const signedIn = !!user;
        if (!signedIn) {
            userAvatar.removeAttribute('src');
            userAvatar.style.display = 'none';
            return;
        }
        try {
            const avatarUrl = await resolveAvatarUrlForUser(user);
            if (currentToken !== avatarRenderToken) return;
            if (avatarUrl) {
                userAvatar.src = avatarUrl;
                userAvatar.style.display = '';
                return;
            }
        } catch {}
        if (currentToken !== avatarRenderToken) return;
        userAvatar.removeAttribute('src');
        userAvatar.style.display = 'none';
    };

    const uploadAvatarToStorage = async (file, userId) => {
        if (!file || !userId) throw new Error('Missing avatar file or user');
        if (!String(file.type || '').toLowerCase().startsWith('image/')) {
            throw new Error('Please choose an image file.');
        }
        if (Number(file.size || 0) > AVATAR_MAX_BYTES) {
            throw new Error('Image is too large. Max size is 5MB.');
        }

        const safeName = sanitizeFileName(file.name || 'avatar');
        const path = `${userId}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await supabaseClient.storage
            .from(AVATAR_BUCKET)
            .upload(path, file, {
                cacheControl: '3600',
                upsert: true,
                contentType: file.type || 'image/*'
            });
        if (uploadError) throw new Error(uploadError.message || 'Avatar upload failed.');

        const { error: userError } = await supabaseClient.auth.updateUser({
            data: {
                avatar_path: path,
                avatar_url: null
            }
        });
        if (userError) throw new Error(userError.message || 'Could not save avatar on profile.');
        return path;
    };

    const applyUserState = (session) => {
        const user = session?.user || null;
        currentAuthUser = user;
        const signedIn = !!user;
        const email = user?.email || '';
        const displayName = user?.user_metadata?.username
            || user?.user_metadata?.full_name
            || user?.user_metadata?.name
            || email
            || 'Guest';
        const currentUsername = String(user?.user_metadata?.username || '').trim();

        if (userDisplay) userDisplay.textContent = displayName || 'Guest';
        renderAvatar(user).catch(() => {});
        if (uploadAvatarBtn) uploadAvatarBtn.style.display = signedIn ? '' : 'none';
        if (signOutBtn) signOutBtn.style.display = signedIn ? '' : 'none';
        if (profileRow) profileRow.style.display = signedIn ? 'flex' : 'none';
        if (viewRow) viewRow.style.display = signedIn ? 'flex' : 'none';
        if (profileUsernameInput) profileUsernameInput.value = currentUsername;
        if (profileUsernameInput) profileUsernameInput.disabled = !signedIn;
        if (profileSaveBtn) profileSaveBtn.disabled = !signedIn;
        if (saveViewBtn) saveViewBtn.disabled = !signedIn;
        if (restoreViewBtn) restoreViewBtn.disabled = !signedIn;
        if (modeRow) modeRow.style.display = signedIn ? 'none' : '';
        signInForm.style.display = signedIn ? 'none' : '';
        signUpForm.style.display = signedIn ? 'none' : '';
        signInModeBtn.disabled = signedIn;
        signUpModeBtn.disabled = signedIn;
        if (signInBtn) signInBtn.disabled = signedIn;
        if (signUpBtn) signUpBtn.disabled = signedIn;
        if (googleBtn) googleBtn.disabled = signedIn || !AUTH_ENABLE_GOOGLE;
        if (signInEmail) signInEmail.disabled = signedIn;
        if (signInPassword) signInPassword.disabled = signedIn;
        if (signUpUsername) signUpUsername.disabled = signedIn;
        if (signUpAvatarFile) signUpAvatarFile.disabled = signedIn;
        if (signUpEmail) signUpEmail.disabled = signedIn;
        if (signUpPassword) signUpPassword.disabled = signedIn;

        if (signedIn) {
            const identity = displayName && displayName !== email
                ? `${displayName} (${email})`
                : (email || displayName);
            setStatus(`Signed in as ${identity}`, 'success');
            ensureSessionDirectoryChannel().then((ok) => {
                if (!ok) return;
                prunePublicSessions();
                sessionRenderPublicDirectory();
                if (typeof window._attemptSessionAutoReconnect === 'function') {
                    window._attemptSessionAutoReconnect().catch(() => {});
                }
            }).catch(() => {});
        } else {
            sessionAutoReconnectKey = '';
            setStatus('Not connected', 'info');
        }
    };

    signInModeBtn.addEventListener('click', () => setMode('signin'));
    signUpModeBtn.addEventListener('click', () => setMode('signup'));

    if (!supabaseClient) {
        if (googleBtn) googleBtn.disabled = true;
        if (signInBtn) signInBtn.disabled = true;
        if (signUpBtn) signUpBtn.disabled = true;
        setStatus('Supabase auth is not configured. Check tokens.js and Supabase script load.', 'error');
        setMode('signin');
        return;
    }

    if (signInBtn) {
        signInBtn.addEventListener('click', async () => {
            const email = String(signInEmail?.value || '').trim();
            const password = String(signInPassword?.value || '');
            if (!email || !password) {
                setStatus('Enter email and password.', 'warn');
                return;
            }
            setStatus('Signing in...', 'info');
            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) {
                setStatus(error.message || 'Sign in failed.', 'error');
                return;
            }
            setStatus('Signed in.', 'success');
        });
    }

    if (signUpBtn) {
        signUpBtn.addEventListener('click', async () => {
            const username = String(signUpUsername?.value || '').trim();
            const avatarFile = signUpAvatarFile?.files?.[0] || null;
            const email = String(signUpEmail?.value || '').trim();
            const password = String(signUpPassword?.value || '');
            if (!username || !email || !password) {
                setStatus('Enter username, email, and password.', 'warn');
                return;
            }
            if (username.length < 3) {
                setStatus('Username must be at least 3 characters.', 'warn');
                return;
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
                setStatus('Username can only use letters, numbers, _, -, and .', 'warn');
                return;
            }
            if (password.length < 6) {
                setStatus('Password must be at least 6 characters.', 'warn');
                return;
            }
            if (avatarFile) {
                if (!String(avatarFile.type || '').toLowerCase().startsWith('image/')) {
                    setStatus('Profile image must be an image file.', 'warn');
                    return;
                }
                if (Number(avatarFile.size || 0) > AVATAR_MAX_BYTES) {
                    setStatus('Profile image is too large. Max 5MB.', 'warn');
                    return;
                }
            }
            setStatus('Creating user...', 'info');
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        username
                    }
                }
            });
            if (error) {
                setStatus(error.message || 'Sign up failed.', 'error');
                return;
            }
            if (avatarFile && data?.session?.user?.id) {
                try {
                    setStatus('Uploading profile image...', 'info');
                    await uploadAvatarToStorage(avatarFile, data.session.user.id);
                    const sessionResult = await supabaseClient.auth.getSession();
                    applyUserState(sessionResult?.data?.session || null);
                } catch (uploadErr) {
                    setStatus(String(uploadErr?.message || 'User created, but avatar upload failed.'), 'warn');
                    return;
                }
            } else if (avatarFile && !data?.session?.user?.id) {
                setStatus('User created. Sign in first, then use Upload Photo to add an avatar.', 'warn');
                return;
            }
            setStatus('User created. Check email for confirmation if required.', 'success');
        });
    }

    if (googleBtn && AUTH_ENABLE_GOOGLE) {
        googleBtn.addEventListener('click', async () => {
            setStatus('Redirecting to Google...', 'info');
            const redirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
            const { error } = await supabaseClient.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo }
            });
            if (error) setStatus(error.message || 'Google sign in failed.', 'error');
        });
    }

    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            setStatus('Signing out...', 'info');
            const { error } = await supabaseClient.auth.signOut();
            if (error) {
                setStatus(error.message || 'Sign out failed.', 'error');
                return;
            }
            setStatus('Signed out.', 'success');
        });
    }

    if (uploadAvatarBtn && uploadAvatarFile) {
        uploadAvatarBtn.addEventListener('click', () => {
            uploadAvatarFile.value = '';
            uploadAvatarFile.click();
        });
        uploadAvatarFile.addEventListener('change', async () => {
            const file = uploadAvatarFile.files?.[0] || null;
            if (!file) return;
            const { data } = await supabaseClient.auth.getSession();
            const userId = data?.session?.user?.id || '';
            if (!userId) {
                setStatus('Sign in first to upload a profile image.', 'warn');
                return;
            }
            try {
                setStatus('Uploading profile image...', 'info');
                await uploadAvatarToStorage(file, userId);
                const sessionResult = await supabaseClient.auth.getSession();
                applyUserState(sessionResult?.data?.session || null);
                setStatus('Profile image updated.', 'success');
            } catch (err) {
                setStatus(String(err?.message || 'Avatar upload failed.'), 'error');
            }
        });
    }

    if (profileSaveBtn && profileUsernameInput) {
        profileSaveBtn.addEventListener('click', async () => {
            if (!currentAuthUser) {
                setStatus('Sign in first to set a username.', 'warn');
                return;
            }
            const username = String(profileUsernameInput.value || '').trim();
            if (!username) {
                setStatus('Enter a username first.', 'warn');
                return;
            }
            if (username.length < 3) {
                setStatus('Username must be at least 3 characters.', 'warn');
                return;
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
                setStatus('Username can only use letters, numbers, _, -, and .', 'warn');
                return;
            }
            const currentData = currentAuthUser.user_metadata || {};
            setStatus('Saving username...', 'info');
            const { error } = await supabaseClient.auth.updateUser({
                data: {
                    ...currentData,
                    username
                }
            });
            if (error) {
                setStatus(error.message || 'Could not update username.', 'error');
                return;
            }
            setStatus(`Username updated to ${username}.`, 'success');
            const sessionResult = await supabaseClient.auth.getSession();
            applyUserState(sessionResult?.data?.session || null);
        });
    }

    if (saveViewBtn) {
        saveViewBtn.addEventListener('click', async () => {
            if (!currentAuthUser) {
                setStatus('Sign in first to save a view.', 'warn');
                return;
            }
            if (typeof window._captureViewStateForAccount !== 'function') {
                setStatus('View capture is not ready yet.', 'warn');
                return;
            }
            const currentData = currentAuthUser.user_metadata || {};
            const viewState = window._captureViewStateForAccount();
            if (!viewState || typeof viewState !== 'object') {
                setStatus('Could not capture current view state.', 'error');
                return;
            }
            setStatus('Saving current view to account...', 'info');
            const { error } = await supabaseClient.auth.updateUser({
                data: {
                    ...currentData,
                    rrc_view_state: viewState,
                    rrc_view_state_saved_at: new Date().toISOString()
                }
            });
            if (error) {
                setStatus(error.message || 'Could not save view to account.', 'error');
                return;
            }
            try {
                if (typeof window._saveSystemAutosaveState === 'function') {
                    window._saveSystemAutosaveState();
                }
            } catch {}
            const sessionResult = await supabaseClient.auth.getSession();
            applyUserState(sessionResult?.data?.session || null);
            setStatus('Current view saved to your account.', 'success');
        });
    }

    if (restoreViewBtn) {
        restoreViewBtn.addEventListener('click', async () => {
            if (!currentAuthUser) {
                setStatus('Sign in first to restore a view.', 'warn');
                return;
            }
            if (typeof window._applyViewStateForAccount !== 'function') {
                setStatus('View restore is not ready yet.', 'warn');
                return;
            }
            setStatus('Loading saved view...', 'info');
            const sessionResult = await supabaseClient.auth.getSession();
            const latestUser = sessionResult?.data?.session?.user || currentAuthUser;
            const savedView = latestUser?.user_metadata?.rrc_view_state;
            if (!savedView || typeof savedView !== 'object') {
                setStatus('No saved view found on your account yet.', 'warn');
                return;
            }
            window._applyViewStateForAccount(savedView);
            try {
                if (typeof window._saveSystemAutosaveState === 'function') {
                    window._saveSystemAutosaveState();
                }
            } catch {}
            applyUserState(sessionResult?.data?.session || null);
            setStatus('Saved account view restored.', 'success');
        });
    }

    supabaseClient.auth.onAuthStateChange((_event, session) => {
        applyUserState(session || null);
    });

    supabaseClient.auth.getSession().then(({ data }) => {
        applyUserState(data?.session || null);
    }).catch(() => {
        applyUserState(null);
    });

    setMode('signin');
}

function normalizeSessionId(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

function generateSessionId() {
    let rand = '';
    while (rand.length < 5) rand += Math.random().toString(36).slice(2);
    return `re-connected-${rand.slice(0, 5)}`;
}

function hashStringToIndex(seed, modulo) {
    const text = String(seed || '');
    if (!modulo || modulo <= 0) return 0;
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % modulo;
}

function getSessionMemberFallbackIcon(userId = '', userName = '') {
    const seed = String(userId || userName || 'member').trim().toLowerCase();
    const index = hashStringToIndex(seed, SESSION_MEMBER_FALLBACK_ICONS.length);
    return SESSION_MEMBER_FALLBACK_ICONS[index] || SESSION_MEMBER_FALLBACK_ICONS[0];
}

function sessionRenderPublicDirectory() {
    if (typeof window._rrcRenderSessionPublicDirectory === 'function') {
        window._rrcRenderSessionPublicDirectory();
    }
}

function sessionRenderMembers() {
    if (typeof window._rrcRenderSessionMembers === 'function') {
        window._rrcRenderSessionMembers();
    }
}

function getPublicSessionEntries() {
    const now = Date.now();
    const out = [];
    const entries = sessionState.publicSessions && typeof sessionState.publicSessions === 'object'
        ? Object.values(sessionState.publicSessions)
        : [];
    entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const sessionId = normalizeSessionId(entry.sessionId || '');
        if (!sessionId) return;
        const lastSeenAt = Number(entry.lastSeenAt || entry.ts || 0);
        const stale = (now - lastSeenAt) > SESSION_DIRECTORY_TTL_MS;
        if (stale && !(isSessionLeader() && sessionState.sessionId === sessionId)) return;
        out.push({
            sessionId,
            leaderUserId: String(entry.leaderUserId || '').trim(),
            leaderName: String(entry.leaderName || 'Leader').trim() || 'Leader',
            rhythmKey: String(entry.rhythmKey || '').trim(),
            memberCount: Math.max(0, parseInt(entry.memberCount, 10) || 0),
            syncMode: normalizeSessionSyncMode(entry.syncMode || 'remote'),
            freeMode: !!entry.freeMode,
            lastSeenAt
        });
    });
    out.sort((a, b) => {
        if (a.sessionId === sessionState.sessionId && b.sessionId !== sessionState.sessionId) return -1;
        if (b.sessionId === sessionState.sessionId && a.sessionId !== sessionState.sessionId) return 1;
        return b.lastSeenAt - a.lastSeenAt;
    });
    return out;
}

function upsertPublicSessionEntry(payload = {}, options = {}) {
    const sessionId = normalizeSessionId(payload.sessionId || payload.session_id || '');
    if (!sessionId) return;
    const now = Date.now();
    const previous = sessionState.publicSessions[sessionId] || {};
    sessionState.publicSessions[sessionId] = {
        sessionId,
        leaderUserId: String(payload.leaderUserId || payload.leader_user_id || previous.leaderUserId || '').trim(),
        leaderName: String(payload.leaderName || payload.leader_name || previous.leaderName || 'Leader').trim() || 'Leader',
        rhythmKey: String(payload.rhythmKey || payload.rhythm_key || previous.rhythmKey || '').trim(),
        memberCount: Math.max(0, parseInt(payload.memberCount, 10) || parseInt(previous.memberCount, 10) || 0),
        syncMode: normalizeSessionSyncMode(payload.syncMode || previous.syncMode || 'remote'),
        freeMode: payload.freeMode === undefined ? !!previous.freeMode : !!payload.freeMode,
        ts: Number(payload.ts || previous.ts || now),
        lastSeenAt: now
    };
    if (!options.silent) sessionRenderPublicDirectory();
}

function removePublicSessionEntry(sessionIdValue, options = {}) {
    const sessionId = normalizeSessionId(sessionIdValue);
    if (!sessionId) return;
    if (!sessionState.publicSessions[sessionId]) return;
    delete sessionState.publicSessions[sessionId];
    if (!options.silent) sessionRenderPublicDirectory();
}

function prunePublicSessions() {
    const now = Date.now();
    let changed = false;
    const entries = sessionState.publicSessions || {};
    Object.keys(entries).forEach((key) => {
        const entry = entries[key];
        if (!entry) return;
        if (isSessionLeader() && key === sessionState.sessionId) return;
        const lastSeenAt = Number(entry.lastSeenAt || entry.ts || 0);
        if ((now - lastSeenAt) > SESSION_DIRECTORY_TTL_MS) {
            delete entries[key];
            changed = true;
        }
    });
    if (changed) sessionRenderPublicDirectory();
}

function buildSessionDirectoryPayload(extra = {}) {
    return {
        sessionId: sessionState.sessionId || '',
        leaderUserId: sessionState.leaderUserId || sessionState.userId || '',
        leaderName: sessionState.leaderName || sessionState.userName || 'Leader',
        rhythmKey: sessionState.rhythmKey || selectedRhythm || '',
        memberCount: Array.isArray(sessionState.members) && sessionState.members.length > 0
            ? sessionState.members.length
            : (sessionState.active ? 1 : 0),
        syncMode: normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode),
        freeMode: !!sessionState.freeMode,
        ts: Date.now(),
        ...extra
    };
}

async function sendSessionDirectoryEvent(eventName, payload = {}) {
    if (!sessionState.lobbyChannel || !eventName) return false;
    try {
        await sessionState.lobbyChannel.send({
            type: 'broadcast',
            event: String(eventName),
            payload: {
                ...payload,
                fromUserId: sessionState.userId || '',
                fromUserName: sessionState.userName || '',
                ts: Date.now()
            }
        });
        return true;
    } catch {
        return false;
    }
}

async function announceSessionDirectory(force = false) {
    if (!sessionState.active || !isSessionLeader()) return;
    if (!sessionState.sessionId) return;
    if (!sessionState.lobbyChannel) return;
    if (!force) {
        const entry = sessionState.publicSessions[sessionState.sessionId];
        if (entry && (Date.now() - Number(entry.lastSeenAt || 0)) < Math.max(500, SESSION_DIRECTORY_HEARTBEAT_MS - 250)) {
            return;
        }
    }
    const payload = buildSessionDirectoryPayload();
    upsertPublicSessionEntry(payload, { silent: true });
    sessionRenderPublicDirectory();
    await sendSessionDirectoryEvent('session_announce', payload);
}

function stopSessionDirectoryHeartbeat() {
    if (sessionState.directoryHeartbeatTimer) {
        clearInterval(sessionState.directoryHeartbeatTimer);
        sessionState.directoryHeartbeatTimer = 0;
    }
}

function startSessionDirectoryHeartbeat() {
    stopSessionDirectoryHeartbeat();
    if (!sessionState.active || !isSessionLeader()) return;
    sessionState.directoryHeartbeatTimer = setInterval(() => {
        announceSessionDirectory(false).catch(() => {});
    }, SESSION_DIRECTORY_HEARTBEAT_MS);
}

function ensureSessionDirectoryPruner() {
    if (sessionState.directoryPruneTimer) return;
    sessionState.directoryPruneTimer = setInterval(() => {
        prunePublicSessions();
    }, 1200);
}

async function ensureSessionDirectoryChannel(options = {}) {
    const ready = await ensureSessionClientAndUser({ allowGuest: options.allowGuest === true });
    if (!ready || !sessionState.supabaseClient) return false;
    ensureSessionDirectoryPruner();
    if (sessionState.lobbyChannel) return true;
    const channel = sessionState.supabaseClient.channel(SESSION_DIRECTORY_CHANNEL, {
        config: { broadcast: { self: false } }
    });
    channel.on('broadcast', { event: 'session_announce' }, ({ payload }) => {
        upsertPublicSessionEntry(payload || {});
    });
    channel.on('broadcast', { event: 'session_closed' }, ({ payload }) => {
        const sessionId = String(payload?.sessionId || '').trim();
        removePublicSessionEntry(sessionId);
    });
    const subscribed = await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            resolve(ok);
        };
        const timeout = setTimeout(() => finish(false), 6000);
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                finish(true);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(timeout);
                finish(false);
            }
        });
    });
    if (!subscribed) {
        try { await channel.unsubscribe(); } catch {}
        return false;
    }
    sessionState.lobbyChannel = channel;
    return true;
}

async function notifySessionClosed(sessionIdValue) {
    const sessionId = normalizeSessionId(sessionIdValue);
    if (!sessionId) return;
    removePublicSessionEntry(sessionId, { silent: true });
    sessionRenderPublicDirectory();
    await sendSessionDirectoryEvent('session_closed', { sessionId });
}

async function resolveSessionMemberAvatarUrl(member) {
    if (!member || typeof member !== 'object') return getSessionMemberFallbackIcon();
    const directUrl = String(member.avatarUrl || '').trim();
    if (directUrl) return directUrl;
    const avatarPath = String(member.avatarPath || '').trim();
    if (!avatarPath) {
        return getSessionMemberFallbackIcon(member.userId, member.userName);
    }
    const cached = sessionAvatarUrlCache.get(avatarPath);
    const now = Date.now();
    if (cached && cached.url && now < Number(cached.expiresAt || 0)) return cached.url;
    if (!sessionState.supabaseClient) {
        return getSessionMemberFallbackIcon(member.userId, member.userName);
    }
    try {
        const { data, error } = await sessionState.supabaseClient.storage
            .from('avatars')
            .createSignedUrl(avatarPath, SESSION_AVATAR_SIGNED_URL_TTL);
        if (error || !data?.signedUrl) {
            return getSessionMemberFallbackIcon(member.userId, member.userName);
        }
        const signedUrl = String(data.signedUrl).trim();
        if (!signedUrl) return getSessionMemberFallbackIcon(member.userId, member.userName);
        sessionAvatarUrlCache.set(avatarPath, {
            url: signedUrl,
            expiresAt: now + Math.max(1000, (SESSION_AVATAR_SIGNED_URL_TTL * 1000) - 30000)
        });
        return signedUrl;
    } catch {
        return getSessionMemberFallbackIcon(member.userId, member.userName);
    }
}

function syncSessionMembersFromPresence(channel = sessionState.channel) {
    if (!channel || typeof channel.presenceState !== 'function') return;
    const state = channel.presenceState() || {};
    const deduped = new Map();
    Object.values(state).forEach((entryList) => {
        const list = Array.isArray(entryList) ? entryList : [];
        list.forEach((entry) => {
            const userId = String(entry?.userId || entry?.fromUserId || '').trim();
            const userName = String(entry?.userName || entry?.fromUserName || 'User').trim() || 'User';
            const key = userId || String(entry?.presence_ref || '').trim() || `${userName}-${Math.random()}`;
            if (deduped.has(key)) return;
            deduped.set(key, {
                userId,
                userName,
                avatarPath: String(entry?.avatarPath || '').trim(),
                avatarUrl: String(entry?.avatarUrl || '').trim(),
                role: String(entry?.role || '').trim()
            });
        });
    });
    const leaderUserId = String(sessionState.leaderUserId || '').trim();
    const members = Array.from(deduped.values()).map((member) => {
        const isLeader = leaderUserId
            ? member.userId === leaderUserId
            : (isSessionLeader() && member.userId === sessionState.userId);
        return {
            ...member,
            role: isLeader ? 'leader' : (member.role || 'follower')
        };
    }).sort((a, b) => {
        if (a.role === 'leader' && b.role !== 'leader') return -1;
        if (b.role === 'leader' && a.role !== 'leader') return 1;
        return String(a.userName || '').localeCompare(String(b.userName || ''));
    });
    sessionState.members = members;
    sessionRenderMembers();
    if (isSessionLeader()) {
        announceSessionDirectory(true).catch(() => {});
    }
}

async function trackSessionPresence(role = sessionState.role || 'follower') {
    if (!sessionState.channel || typeof sessionState.channel.track !== 'function') return;
    try {
        await sessionState.channel.track({
            userId: sessionState.userId || '',
            userName: sessionState.userName || 'User',
            avatarPath: sessionState.userAvatarPath || '',
            avatarUrl: sessionState.userAvatarUrl || '',
            role: role === 'leader' ? 'leader' : 'follower',
            ts: Date.now()
        });
    } catch {}
}

function isSessionLeader() {
    return !!sessionState.active && sessionState.role === 'leader';
}

function isSessionFollower() {
    return !!sessionState.active && sessionState.role === 'follower';
}

function setSessionTransportState(nextState) {
    const stateValue = String(nextState || '').toLowerCase();
    if (stateValue === 'playing' || stateValue === 'paused' || stateValue === 'stopped') {
        sessionState.transportState = stateValue;
        return sessionState.transportState;
    }
    return sessionState.transportState || 'stopped';
}

function getSessionTransportBeatAt(leaderTimeMs) {
    const stateValue = setSessionTransportState(sessionState.transportState);
    const baseLeaderTime = Number(sessionState.transportBaseLeaderTime || 0);
    const baseBeat = Number(sessionState.transportBaseBeat || 0);
    const tempo = Math.max(1, Number(sessionState.tempo) || 100);
    if (stateValue === 'stopped' || stateValue === 'paused') return baseBeat;
    const dt = Number(leaderTimeMs || 0) - baseLeaderTime;
    return baseBeat + (dt * sessionBeatsPerMs(tempo));
}

function setSessionTransportBaseAt(leaderTimeMs, baseBeat, options = {}) {
    const safeLeaderTime = Number.isFinite(Number(leaderTimeMs)) ? Number(leaderTimeMs) : sessionMonotonicNowMs();
    const safeBeat = Number.isFinite(Number(baseBeat)) ? Number(baseBeat) : 0;
    sessionState.transportBaseLeaderTime = safeLeaderTime;
    sessionState.transportBaseBeat = safeBeat;
    if (options.state) setSessionTransportState(options.state);
}

function setSessionTransportTempoAt(newTempo, leaderTimeMs) {
    const safeTempo = Math.max(40, Math.min(240, parseInt(newTempo, 10) || 100));
    const safeLeaderTime = Number.isFinite(Number(leaderTimeMs)) ? Number(leaderTimeMs) : sessionMonotonicNowMs();
    const beatAtTime = getSessionTransportBeatAt(safeLeaderTime);
    sessionState.tempo = safeTempo;
    setSessionTransportBaseAt(safeLeaderTime, beatAtTime, { state: sessionState.transportState || 'playing' });
}

function triggerSessionSyncBoost(durationMs = SESSION_LOCAL_BOOST_DURATION_MS) {
    if (normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode) !== 'local') return;
    const now = sessionMonotonicNowMs();
    sessionState.syncBoostUntil = Math.max(Number(sessionState.syncBoostUntil || 0), now + Math.max(1000, Number(durationMs) || SESSION_LOCAL_BOOST_DURATION_MS));
}

function clearSessionPingLoop() {
    if (sessionState.pingIntervalTimer) {
        clearInterval(sessionState.pingIntervalTimer);
        sessionState.pingIntervalTimer = 0;
    }
    sessionState.pendingPingMap = {};
}

function clearSessionSyncLoop() {
    if (sessionState.syncCheckTimer) {
        clearInterval(sessionState.syncCheckTimer);
        sessionState.syncCheckTimer = 0;
    }
    sessionState.syncCheckTimerIntervalMs = 0;
}

function getSessionTimingProfile() {
    const key = (selectedRhythm && allRhythms[selectedRhythm])
        ? selectedRhythm
        : ((sessionState.rhythmKey && allRhythms[sessionState.rhythmKey]) ? sessionState.rhythmKey : '');
    const notationData = key ? allRhythms[key]?.notationData : null;
    const beats = Math.max(1, parseInt(notationData?.beats, 10) || 4);
    const subdivisions = Math.max(1, parseInt(notationData?.subdivisions, 10) || 4);
    return {
        beats,
        subdivisions,
        totalSteps: Math.max(1, beats * subdivisions)
    };
}

function resetSessionTickBroadcastState() {
    sessionState.lastTickBroadcastAt = 0;
    sessionState.lastTickBroadcastStep = null;
    sessionState.lastTickBroadcastEpoch = 0;
}

function getSessionSyncModeLabel(mode) {
    return normalizeSessionSyncMode(mode) === 'local'
        ? '🏠 Local'
        : '🛰️ Remote';
}

function getSessionFreeModeLabel(enabled) {
    return enabled ? '🔓 Free' : '🔒 Locked';
}

function setSessionSyncIntervalMs(value, options = {}) {
    const next = clampSessionSyncIntervalMs(value);
    const prev = clampSessionSyncIntervalMs(sessionState.syncIntervalMs);
    sessionState.syncIntervalMs = next;
    if (options.persistDefault !== false) {
        localStorage.setItem('sessionSyncIntervalMs', String(next));
    }
    if (prev !== next && sessionState.active && isSessionLeader() && options.restartLoop !== false) {
        startSessionSyncLoop();
    }
    if (typeof window._rrcSyncSessionButtons === 'function') {
        window._rrcSyncSessionButtons();
    }
    if (options.broadcast && isSessionLeader() && sessionState.active) {
        void sendSessionEvent('sync_rate_update', { syncIntervalMs: next });
        void sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({ syncIntervalMs: next }));
        void announceSessionDirectory(true);
    }
    return next;
}

function applySessionFreeMode(enabled, options = {}) {
    const next = !!enabled;
    const prev = !!sessionState.freeMode;
    sessionState.freeMode = next;
    if (prev !== next) {
        applySessionInteractionLocks();
        sessionSyncButtons();
        if (typeof window._syncNotationSessionRole === 'function') {
            try { window._syncNotationSessionRole(); } catch {}
        }
        if (!next && prev && isSessionFollower() && options.stopFollowerAudio !== false) {
            clearSessionTimers();
            sessionState.allowPlaybackUntil = 0;
            stopAllAudioPlayback();
        }
    }
    if (options.broadcast && isSessionLeader() && sessionState.active) {
        void sendSessionEvent('free_mode_update', { freeMode: next });
        void sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({ freeMode: next }));
        void announceSessionDirectory(true);
    }
    return next;
}

function applySessionSyncMode(mode, options = {}) {
    const next = 'local';                                   // locked to local for now (see sessionDefaultSyncMode)
    void mode;
    const prev = normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode);
    sessionState.syncMode = next;
    sessionState.sessionMode = next;
    if (options.persistDefault) {
        sessionDefaultSyncMode = next;
        localStorage.setItem('sessionDefaultSyncMode', sessionDefaultSyncMode);
        const defaultSelect = document.getElementById('sessionDefaultSyncMode');
        if (defaultSelect) defaultSelect.value = sessionDefaultSyncMode;
    }
    if (prev !== next) {
        resetSessionTickBroadcastState();
        if (next === 'local') {
            sessionState.syncWarmupUntil = sessionMonotonicNowMs() + SESSION_LOCAL_WARMUP_DURATION_MS;
            triggerSessionSyncBoost(SESSION_LOCAL_BOOST_DURATION_MS);
        } else {
            sessionState.syncWarmupUntil = 0;
            sessionState.syncBoostUntil = 0;
        }
        if (sessionState.active) {
            if (isSessionLeader()) startSessionSyncLoop();
            if (isSessionFollower()) startSessionPingLoop();
        }
    }
    if (typeof window._rrcSyncSessionButtons === 'function') {
        window._rrcSyncSessionButtons();
    }
    if (options.broadcast && isSessionLeader() && sessionState.active) {
        void sendSessionEvent('sync_mode_update', { syncMode: next });
        void sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({ syncMode: next }));
        void announceSessionDirectory(true);
    }
    return next;
}

function shouldBroadcastSessionTick(step, stepEpoch) {
    if (normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode) === 'local') return false;
    const stepIndex = Number.isFinite(Number(step)) ? (parseInt(step, 10) || 0) : 0;
    const epoch = Number.isFinite(Number(stepEpoch)) ? (parseInt(stepEpoch, 10) || Date.now()) : Date.now();
    if (!sessionEcoSyncMode) return true;

    const now = Date.now();
    const minInterval = Math.max(0, Math.min(2000, parseInt(sessionEcoMinTickIntervalMs, 10) || 0));
    const silenceLimit = Math.max(250, Math.min(5000, parseInt(sessionEcoMaxSilenceMs, 10) || 1400));
    if (!sessionState.lastTickBroadcastAt) return true;
    if ((now - sessionState.lastTickBroadcastAt) >= silenceLimit) return true;
    if (minInterval > 0 && (now - sessionState.lastTickBroadcastAt) < minInterval) return false;

    const mode = normalizeSessionEcoGranularity(sessionEcoTickGranularity);
    if (mode === 'step') {
        if (
            sessionState.lastTickBroadcastStep === stepIndex
            && Math.abs((sessionState.lastTickBroadcastEpoch || 0) - epoch) <= 1
        ) {
            return false;
        }
        return true;
    }

    const timing = getSessionTimingProfile();
    const boundarySize = mode === 'bar' ? timing.totalSteps : timing.subdivisions;
    const isBoundary = boundarySize <= 1 || stepIndex === 0 || (stepIndex % boundarySize === 0);
    if (!isBoundary) return false;
    if (
        sessionState.lastTickBroadcastStep === stepIndex
        && Math.abs((sessionState.lastTickBroadcastEpoch || 0) - epoch) <= 1
    ) {
        return false;
    }
    return true;
}

function sessionSetStatus(message, kind = 'info') {
    if (typeof window._rrcSetSessionStatus === 'function') {
        window._rrcSetSessionStatus(message, kind);
    }
}

function sessionSyncButtons() {
    if (typeof window._rrcSyncSessionButtons === 'function') {
        window._rrcSyncSessionButtons();
    }
}

function persistSessionPanelState(lastSessionId = '') {
    try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
            lastSessionId: normalizeSessionId(lastSessionId || sessionState.sessionId || ''),
            activeSessionId: sessionState.active ? normalizeSessionId(sessionState.sessionId) : '',
            activeRole: sessionState.active ? sessionState.role : ''
        }));
    } catch {}
}

function clearSessionTimers() {
    if (sessionState.pendingStartTimer) {
        clearTimeout(sessionState.pendingStartTimer);
        sessionState.pendingStartTimer = 0;
    }
    if (sessionState.countdownTimer) {
        clearInterval(sessionState.countdownTimer);
        sessionState.countdownTimer = 0;
    }
    sessionState.pendingStartAt = 0;
    sessionState.pendingStartAction = 'play';
    sessionState.pendingStartLeaderTime = 0;
    clearSessionCallOutTimer();
    resetSessionTickBroadcastState();
}

function clearSessionCallOutTimer() {
    if (sessionState.callOutTimer) {
        clearTimeout(sessionState.callOutTimer);
        sessionState.callOutTimer = 0;
    }
}

function applySessionInteractionLocks() {
    const followerLocked = isSessionFollower() && !sessionState.freeMode;
    const rhythmPanel = document.getElementById('rhythm-panel');
    if (rhythmPanel) {
        if (followerLocked) {
            rhythmPanel.style.pointerEvents = 'none';
            rhythmPanel.style.opacity = '0.62';
        } else {
            rhythmPanel.style.pointerEvents = '';
            rhythmPanel.style.opacity = '';
        }
    }

    const mediaLocked = !!sessionState.active && !sessionState.freeMode;
    const videoBtn = document.getElementById('media-video-btn');
    if (videoBtn) {
        videoBtn.disabled = mediaLocked;
        videoBtn.style.opacity = mediaLocked ? '0.45' : '';
        videoBtn.style.pointerEvents = mediaLocked ? 'none' : '';
    }

    if (mediaLocked) {
        stopBackgroundAudio();
        const player = document.getElementById('video-player');
        const container = document.getElementById('video-player-container');
        const contextImage = document.getElementById('context-image');
        if (player) {
            player.src = '';
            player.dataset.mediaEmbedBase = '';
        }
        if (container) container.classList.remove('active');
        if (contextImage && contextImage.style.display === 'none') contextImage.style.display = '';
    }
}

function getSessionRhythmSyncKey(preferredKey = '') {
    const explicit = String(preferredKey || '').trim();
    if (explicit && allRhythms[explicit]) return explicit;
    const sessionKey = String(sessionState.rhythmKey || '').trim();
    if (sessionKey && allRhythms[sessionKey]) return sessionKey;
    const selected = String(selectedRhythm || '').trim();
    if (selected && allRhythms[selected]) return selected;
    return '';
}

function buildSessionRhythmPayload(preferredKey = '') {
    const key = getSessionRhythmSyncKey(preferredKey);
    if (!key || !allRhythms[key]) return null;
    const rhythm = allRhythms[key];
    const payload = {
        key,
        name: String(rhythm?.name || key).trim()
    };
    const notationPath = String(rhythm?.notationPath || '').trim();
    if (notationPath) payload.notationPath = notationPath;
    const notationData = cloneNotationDataSafe(rhythm?.notationData);
    if (notationData && Array.isArray(notationData.instruments) && notationData.instruments.length > 0) {
        payload.notationData = notationData;
    }
    return payload;
}

function applySessionRhythmPayload(payload = null, fallbackKey = '') {
    const result = { key: '', changed: false };
    const fallback = String(fallbackKey || '').trim();
    if (!payload || typeof payload !== 'object') {
        result.key = fallback;
        return result;
    }
    const key = String(payload.key || fallback || '').trim();
    if (!key) return result;
    result.key = key;
    const existing = (allRhythms[key] && typeof allRhythms[key] === 'object') ? allRhythms[key] : null;
    const next = existing ? { ...existing } : {};
    let changed = !existing;

    const incomingName = String(payload.name || '').trim();
    if (incomingName && incomingName !== String(next.name || '').trim()) {
        next.name = incomingName;
        changed = true;
    }

    const incomingPath = String(payload.notationPath || '').trim();
    if (incomingPath && incomingPath !== String(next.notationPath || '').trim()) {
        next.notationPath = incomingPath;
        changed = true;
    }

    const incomingNotation = cloneNotationDataSafe(payload.notationData);
    if (incomingNotation && Array.isArray(incomingNotation.instruments) && incomingNotation.instruments.length > 0) {
        const previousSerialized = JSON.stringify(next.notationData || null);
        const incomingSerialized = JSON.stringify(incomingNotation);
        if (previousSerialized !== incomingSerialized) {
            next.notationData = incomingNotation;
            changed = true;
        }
    }

    if (!next.name) {
        next.name = incomingName || key;
    }

    if (changed) {
        allRhythms[key] = next;
        if (!rhythmColorMap[key]) {
            const colorIndex = Object.keys(rhythmColorMap).length % 12;
            const hex = colorSpectrum[colorIndex] || '#00ffff';
            rhythmColorMap[key] = {
                hex,
                cesium: Cesium.Color.fromCssColorString(hex),
                index: colorIndex
            };
        }
        try { syncRhythmCatalogToNotationTargets(); } catch {}
        try { populateRhythmPanel(currentRhythmSource); } catch {}
        try { populateCarousel(); } catch {}
        try { renderJourneySourceList(); } catch {}
        try {
            if (typeof window._syncPadRemoteMobileRhythmSelector === 'function') {
                window._syncPadRemoteMobileRhythmSelector();
            }
        } catch {}
    }

    result.changed = changed;
    return result;
}

function buildSessionSnapshot(extra = {}) {
    const tempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || 100));
    const leaderNow = sessionMonotonicNowMs();
    const syncIntervalMs = clampSessionSyncIntervalMs(sessionState.syncIntervalMs);
    const rhythmPayload = buildSessionRhythmPayload(sessionState.rhythmKey || selectedRhythm || '');
    const transportState = setSessionTransportState(
        sessionState.transportState || (notationPlaybackActive ? 'playing' : 'stopped')
    );
    const baseLeaderTime = Number.isFinite(Number(sessionState.transportBaseLeaderTime))
        ? Number(sessionState.transportBaseLeaderTime)
        : leaderNow;
    const baseBeat = Number.isFinite(Number(sessionState.transportBaseBeat))
        ? Number(sessionState.transportBaseBeat)
        : 0;
    return {
        v: 1,
        sid: sessionState.sessionId || '',
        sv: Number(sessionState.sessionVersion) || 1,
        sentLeaderTime: leaderNow,
        leaderUserId: sessionState.leaderUserId || sessionState.userId || '',
        leaderName: sessionState.leaderName || sessionState.userName || '',
        syncMode: normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode),
        syncIntervalMs,
        freeMode: !!sessionState.freeMode,
        rhythmKey: sessionState.rhythmKey || selectedRhythm || '',
        tempo,
        playing: transportState === 'playing',
        transport: {
            state: transportState,
            tempo,
            timeSig: {
                num: Math.max(1, parseInt(sessionState.transportTimeSigNum, 10) || 4),
                den: Math.max(1, parseInt(sessionState.transportTimeSigDen, 10) || 4)
            },
            baseLeaderTime,
            baseBeat,
            loop: {
                enabled: false,
                startBeat: 0,
                endBeat: 0
            }
        },
        appState: {
            rhythmKey: sessionState.rhythmKey || selectedRhythm || '',
            syncMode: normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode),
            syncIntervalMs,
            freeMode: !!sessionState.freeMode
        },
        pendingStartAt: Number(sessionState.pendingStartAt) || 0,
        pendingStartLeaderTime: Number(sessionState.pendingStartLeaderTime) || 0,
        pendingStartAction: normalizeSessionStartAction(sessionState.pendingStartAction || 'play'),
        ...(rhythmPayload ? { rhythmPayload } : {}),
        ...extra
    };
}

// Guest name for anonymous session players, kept per browser.
function sessionGuestName() {
    let name = '';
    try { name = String(localStorage.getItem('rrcGuestName') || '').trim(); } catch {}
    if (!name) {
        name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
        try { localStorage.setItem('rrcGuestName', name); } catch {}
    }
    return name;
}

// options.allowGuest: with no signed-in user, sign in anonymously (Supabase: Authentication → anonymous sign-ins
// must be on). Only used when someone starts or joins a session, so opening the page creates no guests.
async function ensureSessionClientAndUser(options = {}) {
    if (!sessionState.supabaseClient) {
        if (window.__rrcSupabaseAuthClient) {
            sessionState.supabaseClient = window.__rrcSupabaseAuthClient;
        } else {
            const hasSupabase = typeof window.supabase !== 'undefined'
                && typeof window.supabase.createClient === 'function'
                && typeof SUPABASE_URL !== 'undefined'
                && !!SUPABASE_URL
                && typeof SUPABASE_ANON_KEY !== 'undefined'
                && !!SUPABASE_ANON_KEY;
            if (!hasSupabase) return false;
            try {
                sessionState.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });
            } catch {
                return false;
            }
        }
    }

    try {
        const { data } = await sessionState.supabaseClient.auth.getSession();
        let user = data?.session?.user || null;
        if (!user?.id && options.allowGuest && typeof sessionState.supabaseClient.auth.signInAnonymously === 'function') {
            const { data: guest, error } = await sessionState.supabaseClient.auth.signInAnonymously({
                options: { data: { username: sessionGuestName() } }
            });
            if (error) console.warn('[session] guest sign-in unavailable:', error.message);
            user = guest?.user || null;
        }
        if (!user?.id) return false;
        sessionState.userId = String(user.id);
        sessionState.userName = String(
            user.user_metadata?.username
            || user.user_metadata?.full_name
            || user.user_metadata?.name
            || user.email
            || 'User'
        ).trim();
        sessionState.userAvatarPath = String(user.user_metadata?.avatar_path || '').trim();
        sessionState.userAvatarUrl = String(user.user_metadata?.avatar_url || '').trim();
        return true;
    } catch {
        return false;
    }
}

// Sync health of this device, sent to the leader every few seconds while playing, so problems on real
// phones and tablets show up as numbers on the leader's screen (one small message per device per 5 s).
function buildSessionSyncReport() {
    const now = Date.now();
    const drifts = (sessionState.syncDriftLog || []).filter((e) => now - e.at < 20000).map((e) => e.drift);
    const avg = drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;
    const samples = Array.isArray(sessionState.leaderClockSamples) ? sessionState.leaderClockSamples : [];
    const offsets = samples.map((e) => e.offset);
    let stats = null, audio = null, lookahead = 0;
    try {
        const w = document.getElementById('notation-iframe')?.contentWindow;
        if (w && w.__rrcTransportStats) stats = { ...w.__rrcTransportStats };
        const ac = w && w.eval ? w.eval('typeof audioContext !== "undefined" ? audioContext : null') : null;
        if (ac) {
            audio = {
                state: ac.state,
                baseMs: Math.round((ac.baseLatency || 0) * 1000),
                outMs: Math.round((ac.outputLatency || 0) * 1000),
                rate: ac.sampleRate,
                outTs: typeof ac.getOutputTimestamp === 'function'
            };
        }
        lookahead = Math.round((w && w.eval ? w.eval('typeof transportLookaheadMs === "function" ? transportLookaheadMs() : 0') : 0) || 0);
    } catch {}
    const ua = navigator.userAgent || '';
    return {
        device: /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
            : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'other',
        browser: /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : 'other',
        driftAvg: Math.round(avg),
        driftMax: Math.round(drifts.reduce((m, d) => Math.max(m, Math.abs(d)), 0)),
        driftLast: drifts.length ? Math.round(drifts[drifts.length - 1]) : null,
        checks: drifts.length,
        nudges: Number(sessionState.syncNudges) || 0,
        rtt: Math.round(Number(sessionState.leaderClockRttMs) || 0),
        rttMax: Math.round(samples.reduce((m, e) => Math.max(m, e.rtt), 0)),
        offsetSpread: offsets.length ? Math.round(Math.max(...offsets) - Math.min(...offsets)) : null,
        pings: samples.length,
        stats,
        audio,
        lookahead,
        hidden: !!document.hidden
    };
}

function maybeSendSessionSyncReport() {
    if (!isSessionFollower() || !sessionState.active) return;
    const now = Date.now();
    if (now - (Number(sessionState.lastSyncReportAt) || 0) < 5000) return;
    sessionState.lastSyncReportAt = now;
    void sendSessionEvent('SYNC_REPORT', { report: buildSessionSyncReport() });
}

async function sendSessionEvent(eventName, payload = {}) {
    if (!sessionState.channel || !eventName) return false;
    try {
        await sessionState.channel.send({
            type: 'broadcast',
            event: String(eventName),
            payload: {
                v: 1,
                sid: sessionState.sessionId || '',
                sv: Number(sessionState.sessionVersion) || 1,
                sentLeaderTime: sessionMonotonicNowMs(),
                ...payload,
                fromUserId: sessionState.userId || '',
                fromUserName: sessionState.userName || '',
                fromRole: sessionState.role || '',
                fromClientId: sessionState.clientId || sessionClientId || '',
                ts: Date.now()
            }
        });
        return true;
    } catch {
        return false;
    }
}

// Every device's player gets the same absolute start time: the shared start moment plus this lead,
// which covers the player's audio warm-up (its prime lead, 50 ms by default, plus device variation).
// Without it each player started "as soon as it was ready", later than the start the session recorded,
// and the sync nudges then pulled followers that far ahead of the leader.
const SESSION_PLAYER_START_LEAD_MS = 250;

function executeSessionTransportAction(action, tempo, options = {}) {
    const nextAction = normalizeSessionStartAction(action);
    const nextTempo = Math.max(40, Math.min(240, parseInt(tempo, 10) || 100));
    const activeBridge = window._notationBridge;
    if (!activeBridge || typeof activeBridge.postMain !== 'function') return;
    // Wake the player's audio (allowed once any earlier tap unlocked it), so the session is heard from beat 1.
    try { activeBridge.warmupMainAudio?.(); } catch {}
    activeBridge.postMain({ type: 'syncTempo', tempo: nextTempo });
    const scheduledEpoch = Number(options.startAtEpoch);
    const anchorEpoch = (Number.isFinite(scheduledEpoch) && scheduledEpoch > 0 ? scheduledEpoch : Date.now()) + SESSION_PLAYER_START_LEAD_MS;
    const lead = nextAction === 'call_in' ? 0 : SESSION_PLAYER_START_LEAD_MS;
    sessionState.playerAnchorEpoch = nextAction === 'call_in' ? Date.now() : anchorEpoch;
    if (nextAction === 'call_in') {
        activeBridge.postMain({ type: 'callButton' });
    } else {
        activeBridge.postMain({ type: 'startPlayback', anchorEpoch, strictAnchor: true });
    }
    if (options.updateTransportBase !== false) {
        setSessionTransportState('playing');
        setSessionTransportBaseAt(
            (Number.isFinite(Number(options.execLeaderTime))
                ? Number(options.execLeaderTime)
                : sessionLeaderTimeFromLocal()) + lead,
            Number.isFinite(Number(options.startBeat))
                ? Number(options.startBeat)
                : 0,
            { state: 'playing' }
        );
    }
}

function scheduleSessionTransportActionAtLocalTime(execLocalMs, tempo, action = 'play', options = {}) {
    const nextTempo = Math.max(40, Math.min(240, parseInt(tempo, 10) || 100));
    const nextAction = normalizeSessionStartAction(action);
    const nowMono = sessionMonotonicNowMs();
    let localExec = Number(execLocalMs);
    if (!Number.isFinite(localExec) || localExec <= 0) localExec = nowMono + computeSessionLookaheadMs();
    localExec = Math.max(nowMono + 24, localExec);
    const localDelayMs = Math.max(0, localExec - nowMono);
    const startAtEpoch = Date.now() + localDelayMs;
    sessionState.tempo = nextTempo;
    sessionState.pendingStartAction = nextAction;
    sessionState.pendingStartAt = startAtEpoch;
    sessionState.pendingStartLeaderTime = Number.isFinite(Number(options.execLeaderTime))
        ? Number(options.execLeaderTime)
        : sessionLeaderTimeFromLocal(localExec);
    clearSessionTimers();
    sessionState.pendingStartAction = nextAction;
    sessionState.pendingStartAt = startAtEpoch;
    sessionState.pendingStartLeaderTime = Number.isFinite(Number(options.execLeaderTime))
        ? Number(options.execLeaderTime)
        : sessionLeaderTimeFromLocal(localExec);

    const bridge = window._notationBridge;
    if (bridge && typeof bridge.postMain === 'function') {
        bridge.postMain({ type: 'syncTempo', tempo: nextTempo });
        bridge.postMain({ type: 'stopPlayback' });
    }

    const updateCountdown = () => {
        const remainingMs = sessionState.pendingStartAt - Date.now();
        if (remainingMs <= 0) return;
        const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
        const actionLabel = nextAction === 'call_in' ? 'Call In' : 'Playback';
        const prefix = isSessionLeader() ? `Starting ${actionLabel}` : `Leader starting ${actionLabel}`;
        sessionSetStatus(`${prefix} in ${seconds}...`, 'info');
    };
    updateCountdown();
    sessionState.countdownTimer = setInterval(updateCountdown, 180);

    sessionState.pendingStartTimer = setTimeout(() => {
        clearSessionTimers();
        sessionState.allowPlaybackUntil = Date.now() + 10000;
        if (isSessionLeader()) {
            sessionState.suppressLeaderInterceptUntil = Date.now() + 10000;
        }
        sessionState.suppressTransportReplayUntil = Date.now() + 850;
        executeSessionTransportAction(nextAction, nextTempo, {
            startAtEpoch,
            execLeaderTime: Number(options.execLeaderTime),
            startBeat: Number(options.startBeat),
            updateTransportBase: options.updateTransportBase !== false
        });
        const startLeader = nextAction === 'call_in' ? 'Call In started for session.' : 'Playback started for session.';
        const startFollower = nextAction === 'call_in' ? 'Leader started Call In.' : 'Leader started playback.';
        sessionSetStatus(isSessionLeader() ? startLeader : startFollower, 'success');
    }, Math.max(24, startAtEpoch - Date.now()));
}

function scheduleSessionTransportActionAtLeaderTime(execLeaderTimeMs, tempo, action = 'play', options = {}) {
    const leaderExec = Number(execLeaderTimeMs);
    if (!Number.isFinite(leaderExec) || leaderExec <= 0) return;
    const localExec = isSessionLeader()
        ? leaderExec
        : sessionLocalTimeFromLeader(leaderExec);
    scheduleSessionTransportActionAtLocalTime(localExec, tempo, action, {
        ...options,
        execLeaderTime: leaderExec
    });
}

// The session code below runs at the top level, but the notation player's postToNotation() and
// syncRhythmCatalogToNotationTargets() are defined inside setupNotation(). Without these, every call
// from here threw a ReferenceError inside a timer, so followers never got stop, call-out or resync.
function postToNotation(message) {
    const bridge = window._notationBridge;
    return !!(bridge && typeof bridge.postMain === 'function' && bridge.postMain(message));
}
function syncRhythmCatalogToNotationTargets() {
    if (typeof window._rrcSyncRhythmCatalogToNotation === 'function') window._rrcSyncRhythmCatalogToNotation();
}

function scheduleSessionTransportStopAtLeaderTime(execLeaderTimeMs, options = {}) {
    clearSessionTimers();
    const leaderExec = Number(execLeaderTimeMs);
    if (!Number.isFinite(leaderExec) || leaderExec <= 0) {
        postToNotation({ type: 'stopPlayback' });
        return;
    }
    const localExec = isSessionLeader() ? leaderExec : sessionLocalTimeFromLeader(leaderExec);
    const nowMono = sessionMonotonicNowMs();
    const waitMs = Math.max(0, Math.max(nowMono + 24, localExec) - nowMono);
    sessionState.pendingStartTimer = setTimeout(() => {
        sessionState.pendingStartTimer = 0;
        clearSessionCallOutTimer();
        postToNotation({ type: 'stopPlayback' });
        setSessionTransportState('stopped');
        setSessionTransportBaseAt(
            Number.isFinite(leaderExec) ? leaderExec : sessionLeaderTimeFromLocal(),
            Number.isFinite(Number(options.stopBeat)) ? Number(options.stopBeat) : getSessionTransportBeatAt(leaderExec),
            { state: 'stopped' }
        );
    }, waitMs);
}

function scheduleSessionCallOutAtLeaderTime(execLeaderTimeMs) {
    clearSessionCallOutTimer();
    const leaderExec = Number(execLeaderTimeMs);
    if (!Number.isFinite(leaderExec) || leaderExec <= 0) {
        postToNotation({ type: 'callOut' });
        return;
    }
    const localExec = isSessionLeader() ? leaderExec : sessionLocalTimeFromLeader(leaderExec);
    const nowMono = sessionMonotonicNowMs();
    const waitMs = Math.max(0, Math.max(nowMono + 16, localExec) - nowMono);
    sessionState.callOutTimer = setTimeout(() => {
        sessionState.callOutTimer = 0;
        postToNotation({ type: 'callOut' });
    }, waitMs);
}

function scheduleSessionPlayback(startAtEpoch, tempo, action = 'play') {
    // Legacy compatibility: old transport used wall-clock epoch.
    const startAt = Math.max(Date.now() + 120, parseInt(startAtEpoch, 10) || 0);
    if (!Number.isFinite(startAt) || startAt <= 0) return;
    const waitMs = Math.max(0, startAt - Date.now());
    const localExec = sessionMonotonicNowMs() + waitMs;
    scheduleSessionTransportActionAtLocalTime(localExec, tempo, action, {
        execLeaderTime: sessionLeaderTimeFromLocal(localExec)
    });
}

async function sendSessionPing() {
    if (!sessionState.active || !isSessionFollower()) return;
    if (!sessionState.channel) return;
    const pending = sessionState.pendingPingMap && typeof sessionState.pendingPingMap === 'object'
        ? sessionState.pendingPingMap
        : {};
    sessionState.pendingPingMap = pending;
    const ids = Object.keys(pending);
    if (ids.length >= SESSION_MAX_PENDING_PINGS) {
        ids.sort((a, b) => Number(pending[a]?.startedAt || 0) - Number(pending[b]?.startedAt || 0));
        const staleId = ids[0];
        if (staleId) delete pending[staleId];
    }
    const pingId = `p_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
    pending[pingId] = {
        localSentAt: sessionMonotonicNowMs(),
        startedAt: Date.now()
    };
    await sendSessionEvent('PING', {
        pingId,
        fromUserId: sessionState.userId || '',
        clientLocalTime: sessionMonotonicNowMs()
    });
}

function startSessionPingLoop() {
    clearSessionPingLoop();
    if (!sessionState.active || !isSessionFollower()) return;
    void sendSessionPing();
    // A quick burst on join: the clock estimate uses the fastest ping, so more samples early = accurate sooner.
    for (let i = 1; i <= 5; i++) {
        setTimeout(() => { if (sessionState.active && isSessionFollower()) sendSessionPing().catch(() => {}); }, i * 220);
    }
    const intervalMs = computeSessionPingIntervalMs();
    sessionState.pingIntervalTimer = setInterval(() => {
        const pending = sessionState.pendingPingMap || {};
        const now = Date.now();
        Object.keys(pending).forEach((id) => {
            if ((now - Number(pending[id]?.startedAt || 0)) > SESSION_PING_TIMEOUT_MS) {
                delete pending[id];
            }
        });
        sendSessionPing().catch(() => {});
    }, intervalMs);
}

function startSessionSyncLoop() {
    clearSessionSyncLoop();
    if (!sessionState.active || !isSessionLeader()) return;
    const nowMono = sessionMonotonicNowMs();
    sessionState.syncWarmupUntil = nowMono + SESSION_LOCAL_WARMUP_DURATION_MS;
    triggerSessionSyncBoost(SESSION_LOCAL_BOOST_DURATION_MS);
    const tick = () => {
        if (!sessionState.active || !isSessionLeader()) return;
        const leaderTime = sessionMonotonicNowMs();
        const beat = getSessionTransportBeatAt(leaderTime);
        sessionState.lastSyncCheckAt = Date.now();
        sessionState.lastSyncCheckBeat = beat;
        sessionState.lastSyncCheckLeaderTime = leaderTime;
        sendSessionEvent('SYNC_CHECK', {
            leaderTime,
            beat,
            tempo: Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || 100)),
            transportState: setSessionTransportState(sessionState.transportState || (notationPlaybackActive ? 'playing' : 'stopped'))
        }).catch(() => {});
    };
    tick();
    sessionState.syncCheckTimer = setInterval(() => {
        const wanted = computeSessionSyncIntervalMs();
        if (sessionState.syncCheckTimerIntervalMs !== wanted) {
            clearSessionSyncLoop();
            sessionState.syncCheckTimerIntervalMs = wanted;
            startSessionSyncLoop();
            return;
        }
        tick();
    }, computeSessionSyncIntervalMs());
    sessionState.syncCheckTimerIntervalMs = computeSessionSyncIntervalMs();
}

async function leaderBroadcastTransportPlay(action = 'play', options = {}) {
    if (!sessionState.active || !isSessionLeader()) return false;
    const nextAction = normalizeSessionStartAction(action);
    const nextTempo = Math.max(40, Math.min(240, parseInt(options.tempo, 10) || sessionState.tempo || 100));
    const leaderNow = sessionMonotonicNowMs();
    const startupDelayMs = Math.max(250, parseInt(options.startDelayMs, 10) || SESSION_START_DELAY_MS);
    const execLeaderTime = Math.max(
        leaderNow + 24,
        leaderNow + Math.max(computeSessionLookaheadMs(), startupDelayMs)
    );
    const startBeat = Number.isFinite(Number(options.startBeat))
        ? Number(options.startBeat)
        : 0;
    const rhythmPayload = buildSessionRhythmPayload(sessionState.rhythmKey || selectedRhythm || '');

    sessionState.tempo = nextTempo;
    setSessionTransportBaseAt(execLeaderTime, startBeat, { state: 'playing' });
    triggerSessionSyncBoost(SESSION_LOCAL_BOOST_DURATION_MS);

    await sendSessionEvent('TRANSPORT_PLAY', {
        execLeaderTime,
        startBeat,
        tempo: nextTempo,
        action: nextAction,
        rhythmPayload,
        timeSig: {
            num: Math.max(1, parseInt(sessionState.transportTimeSigNum, 10) || 4),
            den: Math.max(1, parseInt(sessionState.transportTimeSigDen, 10) || 4)
        }
    });
    await sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({
        playing: true,
        pendingStartAt: Date.now() + Math.max(0, execLeaderTime - sessionMonotonicNowMs()),
        pendingStartAction: nextAction
    }));
    await announceSessionDirectory(true);

    scheduleSessionTransportActionAtLeaderTime(execLeaderTime, nextTempo, nextAction, {
        execLeaderTime,
        startBeat
    });
    return true;
}

// Call buttons for the 3D room: same paths as the pad header buttons.
// kind: 'call' (Call In when stopped, Call when playing) or 'callOut'.
window._rrcCall = (kind = 'call') => {
    const tempoNow = () => Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || latestNotationPlaybackTempo || 100));
    if (sessionState.active) {
        if (isSessionFollower() && !sessionState.freeMode) {
            sessionSetStatus('Call is controlled by the session leader.', 'warn');
            return false;
        }
        if (isSessionLeader() && !sessionState.freeMode) {
            if (kind === 'callOut') { void leaderBroadcastCallOut({ tempo: tempoNow() }); return true; }
            if (!latestNotationPlaybackPlaying) {
                sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                void leaderBroadcastTransportPlay('call_in', { tempo: tempoNow(), startBeat: 0 });
                return true;
            }
        }
    }
    const bridge = window._notationBridge;
    if (!bridge || typeof bridge.postMain !== 'function') return false;
    bridge.postMain({ type: kind === 'callOut' ? 'callOut' : 'callButton' });
    return true;
};

// Play / stop from the drum circle room, with the same session rules as the app's own Play buttons:
// the leader's Play starts the session countdown for everyone, a follower can't start or stop
// (unless the leader allows free play), and outside a session it just plays here.
window._rrcTogglePlay = () => {
    const tempoNow = () => Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || latestNotationPlaybackTempo || 100));
    if (sessionState.active) {
        if (isSessionFollower() && !sessionState.freeMode) {
            sessionSetStatus('Playback is controlled by the session leader.', 'warn');
            return 'blocked';
        }
        if (isSessionLeader() && !sessionState.freeMode) {
            if (latestNotationPlaybackPlaying) {
                void leaderBroadcastTransportStop({ forceLocalStop: false });
            } else {
                sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                void leaderBroadcastTransportPlay('play', { tempo: tempoNow(), startBeat: 0 });
            }
            return 'session';
        }
    }
    return 'local';
};

async function leaderBroadcastCallOut(options = {}) {
    if (!sessionState.active || !isSessionLeader()) return false;
    const leaderNow = sessionMonotonicNowMs();
    const execLeaderTime = Math.max(
        leaderNow + 24,
        leaderNow + Math.max(computeSessionLookaheadMs(), 380)
    );
    const nextTempo = Math.max(40, Math.min(240, parseInt(options.tempo, 10) || sessionState.tempo || 100));
    await sendSessionEvent('CALL_OUT', {
        execLeaderTime,
        tempo: nextTempo
    });
    scheduleSessionCallOutAtLeaderTime(execLeaderTime);
    return true;
}

async function leaderBroadcastTransportStop(options = {}) {
    if (!sessionState.active || !isSessionLeader()) return false;
    const leaderNow = sessionMonotonicNowMs();
    const execLeaderTime = Math.max(leaderNow + 16, leaderNow + Math.min(80, computeSessionLookaheadMs() * 0.35));
    const stopBeat = getSessionTransportBeatAt(execLeaderTime);
    setSessionTransportBaseAt(execLeaderTime, stopBeat, { state: 'stopped' });
    await sendSessionEvent('TRANSPORT_STOP', {
        execLeaderTime,
        stopBeat
    });
    await sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({
        playing: false,
        pendingStartAt: 0
    }));
    await announceSessionDirectory(true);
    if (options.forceLocalStop === true) {
        postToNotation({ type: 'stopPlayback' });
    } else {
        // Stop here at the same leader time the followers stop at (nothing else stops the leader's player).
        scheduleSessionTransportStopAtLeaderTime(execLeaderTime, { stopBeat });
    }
    return true;
}

function applySessionSnapshot(snapshot = {}) {
    const payloadResult = applySessionRhythmPayload(snapshot.rhythmPayload, snapshot.rhythmKey || '');
    const rhythmKey = String(payloadResult.key || snapshot.rhythmKey || '').trim();
    const nextTempo = Math.max(40, Math.min(240, parseInt(snapshot.tempo, 10) || sessionState.tempo || 100));
    const nextSyncMode = normalizeSessionSyncMode(snapshot.syncMode || sessionState.syncMode || sessionDefaultSyncMode);
    const nextSyncInterval = clampSessionSyncIntervalMs(snapshot.syncIntervalMs || sessionState.syncIntervalMs);
    const nextFreeMode = !!snapshot.freeMode;
    const transport = (snapshot.transport && typeof snapshot.transport === 'object') ? snapshot.transport : null;
    sessionState.tempo = nextTempo;
    applySessionSyncMode(nextSyncMode);
    setSessionSyncIntervalMs(nextSyncInterval, { persistDefault: false, restartLoop: false, broadcast: false });
    applySessionFreeMode(nextFreeMode, { stopFollowerAudio: true });
    if (transport) {
        const transportState = String(transport.state || '').trim().toLowerCase();
        const baseLeaderTime = Number(transport.baseLeaderTime);
        const baseBeat = Number(transport.baseBeat);
        const timeSig = transport.timeSig && typeof transport.timeSig === 'object' ? transport.timeSig : {};
        if (Number.isFinite(baseLeaderTime) && Number.isFinite(baseBeat)) {
            setSessionTransportBaseAt(baseLeaderTime, baseBeat, {
                state: transportState || (sessionState.transportState || 'stopped')
            });
        } else if (transportState) {
            setSessionTransportState(transportState);
        }
        const sigNum = parseInt(timeSig.num, 10);
        const sigDen = parseInt(timeSig.den, 10);
        if (Number.isFinite(sigNum) && sigNum > 0) sessionState.transportTimeSigNum = sigNum;
        if (Number.isFinite(sigDen) && sigDen > 0) sessionState.transportTimeSigDen = sigDen;
    }
    if (rhythmKey && allRhythms[rhythmKey]) {
        const rhythmChanged = sessionState.rhythmKey !== rhythmKey;
        sessionState.rhythmKey = rhythmKey;
        if (rhythmChanged) resetSessionTickBroadcastState();
        if (selectedRhythm !== rhythmKey || payloadResult.changed) {
            startJourney(rhythmKey, {
                fromSession: true,
                noSessionBroadcast: true,
                skipTravel: true,
                preserveWindowVisibility: false,
                suppressAutoAudio: true
            }).catch(() => {});
        }
    }
    if (isSessionFollower()) {
        const bridge = window._notationBridge;
        if (bridge && typeof bridge.postMain === 'function') {
            bridge.postMain({ type: 'syncTempo', tempo: nextTempo });
        }
    }
}

async function leaveRealtimeSession(reasonMessage = '', kind = 'info') {
    const hadPendingStart = (Number(sessionState.pendingStartAt) || 0) > Date.now();
    clearSessionTimers();
    clearSessionCallOutTimer();
    clearSessionPingLoop();
    clearSessionSyncLoop();
    const wasLeader = isSessionLeader();
    const previousId = sessionState.sessionId;
    const channel = sessionState.channel;

    if (wasLeader && previousId) {
        if (notationPlaybackActive || hadPendingStart) {
            const execLeaderTime = sessionMonotonicNowMs() + Math.min(80, computeSessionLookaheadMs() * 0.35);
            await sendSessionEvent('TRANSPORT_STOP', {
                execLeaderTime,
                stopBeat: getSessionTransportBeatAt(execLeaderTime)
            });
        }
        await sendSessionEvent('leader_left', { sessionId: previousId });
        await notifySessionClosed(previousId);
    }
    stopSessionDirectoryHeartbeat();
    sessionState.channel = null;
    if (channel) {
        try { await channel.unsubscribe(); } catch {}
    }

    sessionState.active = false;
    sessionState.role = '';
    sessionState.sessionId = '';
    sessionState.leaderUserId = '';
    sessionState.leaderName = '';
    sessionState.syncMode = sessionDefaultSyncMode;
    sessionState.freeMode = false;
    sessionState.sessionMode = sessionDefaultSyncMode;
    sessionState.rhythmKey = '';
    sessionState.transportState = 'stopped';
    sessionState.transportBaseLeaderTime = 0;
    sessionState.transportBaseBeat = 0;
    sessionState.leaderClockOffsetMs = 0;
    sessionState.leaderClockRttMs = 0;
    sessionState.leaderClockSamples = [];
    sessionState.leaderClockLastUpdatedAt = 0;
    sessionState.pendingStartAction = 'play';
    sessionState.pendingStartLeaderTime = 0;
    sessionState.allowPlaybackUntil = 0;
    sessionState.suppressLeaderInterceptUntil = 0;
    sessionState.suppressTransportReplayUntil = 0;
    sessionState.callOutTimer = 0;
    sessionState.lastSnapshotKey = '';
    sessionState.members = [];
    sessionAutoReconnectKey = '';

    applySessionInteractionLocks();
    sessionSyncButtons();
    sessionRenderMembers();
    sessionRenderPublicDirectory();
    if (typeof window._syncNotationSessionRole === 'function') {
        try { window._syncNotationSessionRole(); } catch {}
    }
    persistSessionPanelState(previousId || '');
    if (reasonMessage) sessionSetStatus(reasonMessage, kind);
}

async function handleSessionBroadcast(eventName, payload = {}) {
    const eventType = String(eventName || '').trim();
    if (!eventType) return;
    const fromUserId = String(payload.fromUserId || '').trim();
    const fromClientId = String(payload.fromClientId || '').trim();
    if (fromClientId && sessionState.clientId && fromClientId === sessionState.clientId) {
        const incomingRole = String(payload.fromRole || '').trim().toLowerCase();
        const localRole = String(sessionState.role || '').trim().toLowerCase();
        // Same-account multi-device/browser flows can occasionally duplicate client ids
        // (for example duplicated tabs). If roles differ, allow cross-role messages.
        const allowCrossRole = !!incomingRole && !!localRole && incomingRole !== localRole;
        if (!allowCrossRole) return;
    }

    const payloadSessionId = normalizeSessionId(payload.sid || payload.sessionId || '');
    if (payloadSessionId && sessionState.sessionId && payloadSessionId !== sessionState.sessionId) return;

    if (eventType === 'PING') {
        if (!isSessionLeader()) return;
        const toUserId = String(payload.fromUserId || '').trim();
        const pingId = String(payload.pingId || '').trim();
        const toClientId = String(payload.fromClientId || '').trim();
        if (!toUserId || !pingId) return;
        await sendSessionEvent('PONG', {
            toUserId,
            pingId,
            ...(toClientId ? { toClientId } : {}),
            leaderTime: sessionMonotonicNowMs()
        });
        return;
    }

    if (eventType === 'PONG') {
        if (!isSessionFollower()) return;
        const toClientId = String(payload.toClientId || '').trim();
        if (toClientId) {
            if (!sessionState.clientId || toClientId !== sessionState.clientId) return;
        }
        const toUserId = String(payload.toUserId || '').trim();
        if (!toClientId && toUserId && toUserId !== sessionState.userId) return;
        const pingId = String(payload.pingId || '').trim();
        if (!pingId) return;
        const pending = sessionState.pendingPingMap && typeof sessionState.pendingPingMap === 'object'
            ? sessionState.pendingPingMap
            : {};
        const sent = pending[pingId];
        if (!sent) return;
        delete pending[pingId];
        const localNow = sessionMonotonicNowMs();
        const leaderTimeAtPong = Number(payload.leaderTime);
        if (!Number.isFinite(leaderTimeAtPong)) return;
        const rtt = Math.max(1, localNow - Number(sent.localSentAt || localNow));
        const estimatedOffset = (leaderTimeAtPong + (rtt * 0.5)) - localNow;
        if (!Number.isFinite(estimatedOffset)) return;
        // Trust the fastest recent ping (NTP-style): a short round trip can't hide much one-way delay,
        // so a slow ping from a busy phone or a Wi-Fi hiccup no longer drags the clock estimate around.
        const now = Date.now();
        const samples = Array.isArray(sessionState.leaderClockSamples) ? sessionState.leaderClockSamples : [];
        const fastest = (list) => list.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        if (samples.length) {
            const best = fastest(samples);
            // The leader's clock jumped (it reloaded or changed): start over from this ping.
            if (Math.abs(estimatedOffset - best.offset) > Math.max(400, best.rtt + rtt)) samples.length = 0;
        }
        samples.push({ rtt, offset: estimatedOffset, at: now });
        while (samples.length > 12 || (samples.length > 1 && now - samples[0].at > 30000)) samples.shift();
        sessionState.leaderClockSamples = samples;
        const best = fastest(samples);
        const previousOffset = Number(sessionState.leaderClockOffsetMs || 0);
        sessionState.leaderClockOffsetMs = (previousOffset === 0 || samples.length === 1)
            ? best.offset
            : previousOffset + ((best.offset - previousOffset) * 0.5);
        sessionState.leaderClockRttMs = best.rtt;
        sessionState.leaderClockLastUpdatedAt = now;
        return;
    }

    if (eventType === 'JOIN_ANNOUNCE') {
        if (!isSessionLeader()) return;
        const targetClientId = String(payload.fromClientId || '').trim();
        await sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({
            targetUserId: String(payload.userId || payload.fromUserId || '').trim() || undefined,
            targetClientId: targetClientId || undefined
        }));
        triggerSessionSyncBoost(SESSION_LOCAL_BOOST_DURATION_MS);
        return;
    }

    if (eventType === 'join_request') {
        // Legacy compatibility: older clients may still send this event.
        if (!isSessionLeader()) return;
        const targetUserId = String(payload.userId || '').trim();
        const snapshotPayload = buildSessionSnapshot({
            targetUserId: targetUserId || undefined
        });
        await sendSessionEvent('SESSION_SNAPSHOT', snapshotPayload);
        return;
    }

    if (eventType === 'join_approved' || eventType === 'join_rejected') {
        // Legacy no-op. Join approval is no longer required.
        return;
    }

    if (eventType === 'leader_announce') {
        if (!sessionState.active) return;
        sessionState.leaderUserId = String(payload.leaderUserId || fromUserId || '').trim();
        sessionState.leaderName = String(payload.leaderName || payload.fromUserName || 'Leader').trim();
        syncSessionMembersFromPresence();
        return;
    }

    if (eventType === 'state_request') {
        if (!isSessionLeader()) return;
        const targetLeaderId = String(payload.targetLeaderId || '').trim();
        if (targetLeaderId && targetLeaderId !== sessionState.userId) return;
        const targetClientId = String(payload.fromClientId || '').trim();
        const snapshotPayload = buildSessionSnapshot({
            targetUserId: String(payload.fromUserId || '').trim() || undefined,
            targetClientId: targetClientId || undefined
        });
        await sendSessionEvent('SESSION_SNAPSHOT', snapshotPayload);
        return;
    }

    if (eventType === 'SESSION_SNAPSHOT' || eventType === 'state_snapshot') {
        if (!isSessionFollower()) return;
        const targetClientId = String(payload.targetClientId || '').trim();
        if (targetClientId && targetClientId !== sessionState.clientId) return;
        const targetUserId = String(payload.targetUserId || '').trim();
        if (targetUserId && targetUserId !== sessionState.userId) return;
        const sentLeaderTime = Number(payload.sentLeaderTime || 0);
        if (sentLeaderTime > 0) {
            const snapshotKey = `${fromUserId || 'leader'}|${Math.round(sentLeaderTime)}|${Math.max(1, parseInt(payload.sv, 10) || 1)}`;
            if (snapshotKey === sessionState.lastSnapshotKey) return;
            sessionState.lastSnapshotKey = snapshotKey;
        }
        sessionState.leaderUserId = String(payload.leaderUserId || fromUserId || sessionState.leaderUserId || '').trim();
        sessionState.leaderName = String(payload.leaderName || payload.fromUserName || sessionState.leaderName || 'Leader').trim();
        if (payload.sv && Number.isFinite(Number(payload.sv))) {
            sessionState.sessionVersion = Math.max(1, parseInt(payload.sv, 10) || sessionState.sessionVersion || 1);
        }
        applySessionSnapshot(payload);
        syncSessionMembersFromPresence();

        const transport = (payload.transport && typeof payload.transport === 'object') ? payload.transport : null;
        const pendingLeaderTime = Number(payload.pendingStartLeaderTime);
        const pendingStartAt = parseInt(payload.pendingStartAt, 10);
        const pendingAction = payload.pendingStartAction || payload.action || (payload.sequence !== false ? 'call_in' : 'play');
        if (Number.isFinite(pendingLeaderTime) && pendingLeaderTime > (sessionLeaderTimeFromLocal() + 24)) {
            scheduleSessionTransportActionAtLeaderTime(
                pendingLeaderTime,
                payload.tempo,
                pendingAction,
                { execLeaderTime: pendingLeaderTime }
            );
        } else if (Number.isFinite(pendingStartAt) && pendingStartAt > Date.now() + 50) {
            scheduleSessionPlayback(
                pendingStartAt,
                payload.tempo,
                pendingAction
            );
        } else if (transport && String(transport.state || '').toLowerCase() === 'playing' && !notationPlaybackActive) {
            const leaderBase = Number(transport.baseLeaderTime);
            const tempo = Math.max(40, Math.min(240, parseInt(transport.tempo, 10) || sessionState.tempo || 100));
            if (Number.isFinite(leaderBase)) {
                const execLeaderTime = Math.max(leaderBase + computeSessionLookaheadMs(), sessionLeaderTimeFromLocal() + computeSessionLookaheadMs());
                scheduleSessionTransportActionAtLeaderTime(execLeaderTime, tempo, 'play', { execLeaderTime });
            }
        } else if (payload.playing === false) {
            postToNotation({ type: 'stopPlayback' });
        }
        return;
    }

    if (eventType === 'rhythm_selected') {
        if (!isSessionFollower()) return;
        const payloadResult = applySessionRhythmPayload(payload.rhythmPayload, payload.rhythmKey || '');
        const rhythmKey = String(payloadResult.key || payload.rhythmKey || '').trim();
        if (!rhythmKey || !allRhythms[rhythmKey]) return;
        sessionState.rhythmKey = rhythmKey;
        resetSessionTickBroadcastState();
        startJourney(rhythmKey, {
            fromSession: true,
            noSessionBroadcast: true,
            skipTravel: true,
            preserveWindowVisibility: false,
            suppressAutoAudio: true
        }).catch(() => {});
        sessionSetStatus(`Leader selected ${allRhythms[rhythmKey].name}.`, 'info');
        return;
    }

    if (eventType === 'TEMPO_CHANGE') {
        if (!isSessionFollower()) return;
        const nextTempo = Math.max(40, Math.min(240, parseInt(payload.tempo, 10) || sessionState.tempo || 100));
        const execLeaderTime = Number(payload.execLeaderTime);
        if (Number.isFinite(execLeaderTime)) {
            const localExec = sessionLocalTimeFromLeader(execLeaderTime);
            const nowMono = sessionMonotonicNowMs();
            const waitMs = Math.max(0, Math.max(nowMono + 16, localExec) - nowMono);
            setTimeout(() => {
                postToNotation({ type: 'syncTempo', tempo: nextTempo });
                setSessionTransportTempoAt(nextTempo, execLeaderTime);
            }, waitMs);
        } else {
            postToNotation({ type: 'syncTempo', tempo: nextTempo });
            setSessionTransportTempoAt(nextTempo, sessionLeaderTimeFromLocal());
        }
        return;
    }

    if (eventType === 'tempo_update') {
        if (!isSessionFollower()) return;
        const nextTempo = Math.max(40, Math.min(240, parseInt(payload.tempo, 10) || sessionState.tempo || 100));
        sessionState.tempo = nextTempo;
        postToNotation({ type: 'syncTempo', tempo: nextTempo });
        return;
    }

    if (eventType === 'sync_mode_update') {
        if (!isSessionFollower()) return;
        const nextMode = applySessionSyncMode(payload.syncMode);
        startSessionPingLoop();
        sessionSetStatus(`Leader set mode to ${getSessionSyncModeLabel(nextMode)}.`, 'info');
        return;
    }

    if (eventType === 'sync_rate_update') {
        if (!isSessionFollower()) return;
        const nextRate = setSessionSyncIntervalMs(payload.syncIntervalMs, {
            persistDefault: false,
            restartLoop: false,
            broadcast: false
        });
        sessionSetStatus(`Leader set sync rate to ${nextRate} ms.`, 'info');
        return;
    }

    if (eventType === 'free_mode_update') {
        if (!isSessionFollower()) return;
        const enabled = applySessionFreeMode(!!payload.freeMode, { stopFollowerAudio: true });
        sessionSetStatus(`Leader set follower playback to ${getSessionFreeModeLabel(enabled)}.`, 'info');
        return;
    }

    if (eventType === 'call_cued') {
        if (!isSessionFollower()) return;
        postToNotation({ type: 'cueCall', fromSession: true });
        sessionSetStatus('Leader cued call.', 'info');
        return;
    }

    if (eventType === 'CALL_OUT') {
        if (!isSessionFollower()) return;
        const execLeaderTime = Number(payload.execLeaderTime);
        if (!Number.isFinite(execLeaderTime) || execLeaderTime <= 0) return;
        scheduleSessionCallOutAtLeaderTime(execLeaderTime);
        return;
    }

    if (eventType === 'SYNC_REPORT') {
        if (!isSessionLeader() || !payload.report || typeof payload.report !== 'object') return;
        const reports = sessionState.syncReports && typeof sessionState.syncReports === 'object' ? sessionState.syncReports : (sessionState.syncReports = {});
        reports[fromClientId || fromUserId || 'unknown'] = { name: String(payload.fromUserName || 'Device'), at: Date.now(), ...payload.report };
        return;
    }

    if (eventType === 'SYNC_CHECK') {
        if (!isSessionFollower()) return;
        const leaderTime = Number(payload.leaderTime);
        const beat = Number(payload.beat);
        const tempo = Math.max(40, Math.min(240, parseInt(payload.tempo, 10) || sessionState.tempo || 100));
        if (!Number.isFinite(leaderTime) || !Number.isFinite(beat)) return;
        const leaderNow = sessionLeaderTimeFromLocal();
        const projectedBeat = beat + ((leaderNow - leaderTime - followerNudgeMs) * sessionBeatsPerMs(tempo));
        sessionState.lastSyncCheckAt = Date.now();
        sessionState.lastSyncCheckBeat = projectedBeat;
        sessionState.lastSyncCheckLeaderTime = leaderNow;
        if (!notationPlaybackActive) return;

        const timing = getSessionTimingProfile();
        const totalSteps = Math.max(1, timing.totalSteps);
        const subs = Math.max(1, timing.subdivisions);
        const beatWithin = ((projectedBeat % Math.max(1, timing.beats)) + Math.max(1, timing.beats)) % Math.max(1, timing.beats);
        const expectedStep = ((Math.floor(beatWithin * subs) % totalSteps) + totalSteps) % totalSteps;
        const stepMs = (60000 / tempo) / subs;
        // Compare positions in time, not whole step numbers: the step counter updates a little after each
        // step sounds, so near a boundary it looked a whole step off and triggered needless nudges.
        const sched = latestScheduledNotationStep;
        const nowEpoch = Date.now();
        let localPos;
        if (sched.step >= 0 && sched.epoch > 0 && Math.abs(nowEpoch - sched.epoch) < stepMs * totalSteps) {
            localPos = sched.step + ((nowEpoch - sched.epoch) / stepMs);
        } else {
            localPos = ((parseInt(latestNotationPlaybackStep, 10) || 0) % totalSteps + totalSteps) % totalSteps;
        }
        let deltaSteps = (beatWithin * subs) - localPos;
        deltaSteps = ((deltaSteps % totalSteps) + totalSteps) % totalSteps;
        if (deltaSteps > totalSteps / 2) deltaSteps -= totalSteps;
        const driftMs = deltaSteps * stepMs;
        // Right after a start the player hasn't reported a step yet: leave it alone for the first beat.
        if (nowEpoch < (Number(sessionState.playerAnchorEpoch) || 0) + (stepMs * subs)) return;
        const driftLog = Array.isArray(sessionState.syncDriftLog) ? sessionState.syncDriftLog : (sessionState.syncDriftLog = []);
        driftLog.push({ at: nowEpoch, drift: driftMs });
        while (driftLog.length > 40) driftLog.shift();
        maybeSendSessionSyncReport();
        const thresholds = computeSessionDriftThresholdsMs();
        if (Math.abs(driftMs) <= thresholds.ignore) return;
        // Small drift: at most one correction every 1.5 s (each one re-anchors the player); large drift at once.
        if (Math.abs(driftMs) < thresholds.hard && (nowEpoch - (Number(sessionState.lastSyncNudgeAt) || 0)) < 1500) return;
        sessionState.lastSyncNudgeAt = nowEpoch;
        // The leader is partway through expectedStep right now: anchor the step at the moment it began,
        // not at "now", or every nudge shifts this follower by up to a whole step.
        sessionState.syncNudges = (Number(sessionState.syncNudges) || 0) + 1;
        const stepFraction = (beatWithin * subs) - Math.floor(beatWithin * subs);
        postToNotation({
            type: 'sessionSyncNudge',
            step: expectedStep,
            stepEpoch: Date.now() - (stepFraction * stepMs),
            tempo
        });
        if (Math.abs(driftMs) >= thresholds.hard) {
            const now = Date.now();
            if ((now - Number(sessionState.lastSyncCorrectionAt || 0)) < 1200) return;
            sessionState.lastSyncCorrectionAt = now;
            // Hard fallback for severe desync: re-arm transport once.
            const severeThreshold = Math.max(thresholds.hard * 2, stepMs * 6);
            if (Math.abs(driftMs) >= severeThreshold) {
                const resyncLeaderTime = leaderNow + computeSessionLookaheadMs();
                scheduleSessionTransportActionAtLeaderTime(resyncLeaderTime, tempo, 'play', {
                    execLeaderTime: resyncLeaderTime
                });
                sessionSetStatus('Resyncing with leader timing…', 'info');
            }
        }
        return;
    }

    if (eventType === 'TRANSPORT_PLAY') {
        if (!isSessionFollower()) return;
        const payloadResult = applySessionRhythmPayload(payload.rhythmPayload, payload.rhythmKey || sessionState.rhythmKey || '');
        const payloadRhythmKey = String(payloadResult.key || payload.rhythmKey || '').trim();
        if (payloadRhythmKey && allRhythms[payloadRhythmKey]) {
            const changed = sessionState.rhythmKey !== payloadRhythmKey;
            sessionState.rhythmKey = payloadRhythmKey;
            if (changed) resetSessionTickBroadcastState();
            // Same rhythm already loaded: don't reload it on Play (that reset solo / mute and did heavy work
            // right at the start, the most timing-sensitive moment).
            if (changed || selectedRhythm !== payloadRhythmKey || payloadResult.changed) startJourney(payloadRhythmKey, {
                fromSession: true,
                noSessionBroadcast: true,
                skipTravel: true,
                preserveWindowVisibility: false,
                suppressAutoAudio: true
            }).catch(() => {});
        }
        const execLeaderTime = Number(payload.execLeaderTime);
        const startBeat = Number(payload.startBeat);
        const nextTempo = Math.max(40, Math.min(240, parseInt(payload.tempo, 10) || sessionState.tempo || 100));
        const nextAction = payload.action || 'play';
        if (!Number.isFinite(execLeaderTime)) return;
        sessionState.tempo = nextTempo;
        setSessionTransportBaseAt(execLeaderTime, Number.isFinite(startBeat) ? startBeat : 0, { state: 'playing' });
        scheduleSessionTransportActionAtLeaderTime(execLeaderTime, nextTempo, nextAction, {
            execLeaderTime,
            startBeat: Number.isFinite(startBeat) ? startBeat : 0
        });
        return;
    }

    if (eventType === 'play_scheduled') {
        if (!isSessionFollower()) return;
        const startAt = parseInt(payload.startAt, 10);
        if (!Number.isFinite(startAt)) return;
        scheduleSessionPlayback(startAt, payload.tempo, payload.action || (payload.sequence !== false ? 'call_in' : 'play'));
        return;
    }

    if (eventType === 'TRANSPORT_STOP' || eventType === 'TRANSPORT_PAUSE') {
        if (!isSessionFollower()) return;
        const execLeaderTime = Number(payload.execLeaderTime);
        scheduleSessionTransportStopAtLeaderTime(execLeaderTime, {
            stopBeat: payload.stopBeat
        });
        sessionSetStatus('Leader stopped playback.', 'warn');
        return;
    }

    if (eventType === 'stop_playback') {
        if (!isSessionFollower()) return;
        clearSessionTimers();
        postToNotation({ type: 'stopPlayback' });
        sessionSetStatus('Leader stopped playback.', 'warn');
        return;
    }

    if (eventType === 'leader_left') {
        if (!isSessionFollower()) return;
        removePublicSessionEntry(String(payload.sessionId || sessionState.sessionId || '').trim());
        await leaveRealtimeSession('Leader left the session.', 'warn');
    }
}

async function connectRealtimeSession(sessionIdValue, role, options = {}) {
    const normalized = normalizeSessionId(sessionIdValue);
    if (!normalized) return false;
    const ready = await ensureSessionClientAndUser({ allowGuest: true });
    if (!ready || !sessionState.supabaseClient) {
        sessionSetStatus('Sign in to use realtime sessions.', 'warn');
        return false;
    }
    await ensureSessionDirectoryChannel();

    await leaveRealtimeSession('', 'info');

    const channel = sessionState.supabaseClient.channel(`${SESSION_CHANNEL_PREFIX}${normalized}`, {
        config: {
            broadcast: { self: false },
            presence: { key: sessionState.userId || undefined }
        }
    });
    channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
        handleSessionBroadcast(String(event || ''), payload || {}).catch(() => {});
    });
    channel.on('presence', { event: 'sync' }, () => {
        syncSessionMembersFromPresence(channel);
    });
    channel.on('presence', { event: 'join' }, () => {
        syncSessionMembersFromPresence(channel);
    });
    channel.on('presence', { event: 'leave' }, () => {
        syncSessionMembersFromPresence(channel);
    });

    const subscribed = await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            resolve(ok);
        };
        const timeout = setTimeout(() => finish(false), 6000);
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                finish(true);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(timeout);
                finish(false);
            }
        });
    });

    if (!subscribed) {
        try { await channel.unsubscribe(); } catch {}
        sessionSetStatus('Realtime channel connection failed.', 'error');
        return false;
    }

    sessionState.channel = channel;
    sessionState.sessionId = normalized;
    sessionState.active = true;
    sessionState.sessionVersion = Math.max(1, parseInt(sessionState.sessionVersion, 10) || 1);
    sessionState.role = role === 'leader' ? 'leader' : 'follower';
    sessionState.transportState = 'stopped';
    sessionState.transportBaseLeaderTime = sessionMonotonicNowMs();
    sessionState.transportBaseBeat = 0;
    sessionState.transportTimeSigNum = 4;
    sessionState.transportTimeSigDen = 4;
    sessionState.syncIntervalMs = clampSessionSyncIntervalMs(sessionState.syncIntervalMs || localStorage.getItem('sessionSyncIntervalMs'));
    sessionState.pendingPingMap = {};
    sessionState.syncWarmupUntil = 0;
    sessionState.syncBoostUntil = 0;
    sessionState.callOutTimer = 0;
    sessionState.lastSnapshotKey = '';
    resetSessionTickBroadcastState();
    if (sessionState.role === 'leader') {
        sessionState.leaderUserId = sessionState.userId;
        sessionState.leaderName = sessionState.userName;
        sessionState.syncMode = sessionDefaultSyncMode;
        sessionState.sessionMode = sessionState.syncMode;
        sessionState.freeMode = false;
        sessionState.rhythmKey = selectedRhythm || '';
        sessionState.leaderClockOffsetMs = 0;
        sessionState.leaderClockRttMs = 0;
        sessionState.leaderClockSamples = [];
        sessionState.leaderClockLastUpdatedAt = Date.now();
        sessionState.syncWarmupUntil = sessionMonotonicNowMs() + SESSION_LOCAL_WARMUP_DURATION_MS;
        upsertPublicSessionEntry(buildSessionDirectoryPayload(), { silent: true });
        startSessionDirectoryHeartbeat();
        startSessionSyncLoop();
        announceSessionDirectory(true).catch(() => {});
    } else {
        sessionState.leaderUserId = String(options.leaderUserId || '').trim();
        sessionState.leaderName = String(options.leaderName || '').trim();
        sessionState.syncMode = sessionDefaultSyncMode;
        sessionState.sessionMode = sessionState.syncMode;
        sessionState.freeMode = false;
        sessionState.leaderClockOffsetMs = 0;
        sessionState.leaderClockRttMs = 0;
        sessionState.leaderClockSamples = [];
        sessionState.leaderClockLastUpdatedAt = 0;
        stopSessionDirectoryHeartbeat();
        startSessionPingLoop();
    }
    await trackSessionPresence(sessionState.role);
    syncSessionMembersFromPresence(channel);
    if (sessionState.role === 'follower') {
        await sendSessionEvent('JOIN_ANNOUNCE', {
            userId: sessionState.userId || '',
            clientMeta: {
                userName: sessionState.userName || '',
                clientId: sessionState.clientId || sessionClientId || '',
                syncMode: normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode)
            }
        });
    }
    applySessionInteractionLocks();
    sessionSyncButtons();
    sessionRenderMembers();
    if (typeof window._syncNotationSessionRole === 'function') {
        try { window._syncNotationSessionRole(); } catch {}
    }
    persistSessionPanelState(normalized);
    return true;
}

function setupQrPanel() {
    const panel = document.getElementById('qr-panel');
    if (!panel || panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const topToggle = document.getElementById('qr-toggle');
    const appImage = document.getElementById('qr-panel-app-image');
    const appLink = document.getElementById('qr-panel-app-link');
    const appCopy = document.getElementById('qr-panel-app-copy');
    const sessionImage = document.getElementById('qr-panel-session-image');
    const sessionLink = document.getElementById('qr-panel-session-link');
    const sessionCopy = document.getElementById('qr-panel-session-copy');
    const status = document.getElementById('qr-panel-status');

    const setStatus = (message, kind = 'info') => {
        if (!status) return;
        status.textContent = String(message || '').trim() || 'Ready.';
        status.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
        if (kind === 'success') status.classList.add('panel-status-success');
        if (kind === 'warn') status.classList.add('panel-status-warn');
        if (kind === 'error') status.classList.add('panel-status-error');
    };

    const syncTopToggleState = () => {
        if (!topToggle) return;
        const hiddenByClass = panel.classList.contains('hidden') || panel.classList.contains('panel-hidden');
        const styles = window.getComputedStyle(panel);
        const hiddenByStyle = styles.display === 'none' || styles.visibility === 'hidden';
        topToggle.classList.toggle('active', !(hiddenByClass || hiddenByStyle));
    };

    const isVisible = () => !(panel.classList.contains('hidden') || panel.classList.contains('panel-hidden'));

    const getSessionIdForQr = () => {
        if (sessionState.active && sessionState.sessionId) return normalizeSessionId(sessionState.sessionId);
        const input = document.getElementById('session-id-input');
        return normalizeSessionId(input ? input.value : '');
    };

    const buildQrBaseParams = () => {
        const params = new URLSearchParams(window.location.search || '');
        const out = new URLSearchParams();
        if (params.has('mobile')) out.set('mobile', params.get('mobile'));
        return out;
    };

    const buildShareUrl = (origin, path, extra = {}) => {
        const baseOrigin = String(origin || '').trim().replace(/\/+$/, '');
        const sharePath = String(path || '/').trim() || '/';
        const url = new URL(sharePath, `${baseOrigin}/`);
        const params = buildQrBaseParams();
        Object.entries(extra || {}).forEach(([key, rawValue]) => {
            const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
            if (!value) {
                params.delete(key);
            } else {
                params.set(key, value);
            }
        });
        const serialized = params.toString();
        url.search = serialized ? `?${serialized}` : '';
        return url.toString();
    };

    const setQrImage = (imgEl, url) => {
        if (!imgEl) return;
        const clean = String(url || '').trim();
        if (!clean) {
            imgEl.removeAttribute('src');
            return;
        }
        imgEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=12&ecc=L&data=${encodeURIComponent(clean)}`;
    };

    const setQrLink = (linkEl, url, fallbackText = '') => {
        if (!linkEl) return;
        const clean = String(url || '').trim();
        if (!clean) {
            linkEl.removeAttribute('href');
            linkEl.textContent = String(fallbackText || '').trim();
            linkEl.style.pointerEvents = 'none';
            return;
        }
        linkEl.href = clean;
        linkEl.textContent = clean;
        linkEl.style.pointerEvents = '';
    };

    const refresh = async (options = {}) => {
        if (!isVisible() && !options.force) {
            syncTopToggleState();
            return;
        }
        try {
            const origin = await resolvePadShareOrigin();
            const sharePath = resolvePadSharePath();
            const appUrl = buildShareUrl(origin, sharePath, {});
            const sessionId = getSessionIdForQr();
            const sessionUrl = sessionId ? buildShareUrl(origin, sharePath, { session: sessionId }) : '';

            setQrImage(appImage, appUrl);
            setQrLink(appLink, appUrl, '');
            if (sessionId) {
                setQrImage(sessionImage, sessionUrl);
                setQrLink(sessionLink, sessionUrl, '');
                if (sessionCopy) sessionCopy.disabled = false;
                setStatus(`Session QR ready for ${sessionId}.`, 'success');
            } else {
                setQrImage(sessionImage, '');
                setQrLink(sessionLink, '', 'Set a session id to generate a join QR.');
                if (sessionCopy) sessionCopy.disabled = true;
                setStatus('Session QR is waiting for an active or typed session id.', 'warn');
            }

            if (appCopy) appCopy.disabled = !appUrl;
            if (options.focus === 'session' && sessionLink) {
                sessionLink.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        } catch (err) {
            setStatus('Unable to build share links right now.', 'error');
            console.warn('QR panel refresh failed:', err);
        }
        syncTopToggleState();
    };

    const show = async (options = {}) => {
        panel.classList.remove('hidden', 'panel-hidden');
        if (typeof window._bringFloatingWindowToFront === 'function') {
            window._bringFloatingWindowToFront(panel);
        }
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(panel);
        }
        await refresh(options);
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        } else {
            syncTopToggleState();
        }
    };

    const hide = () => {
        panel.classList.add('hidden');
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        } else {
            syncTopToggleState();
        }
    };

    if (topToggle && topToggle.dataset.boundQrTopPanel !== '1') {
        topToggle.dataset.boundQrTopPanel = '1';
        topToggle.addEventListener('click', () => {
            if (isVisible()) {
                hide();
                return;
            }
            void show();
        });
    }

    if (appCopy && appCopy.dataset.boundQrCopy !== '1') {
        appCopy.dataset.boundQrCopy = '1';
        appCopy.addEventListener('click', async () => {
            const url = String(appLink?.href || '').trim();
            if (!url) return;
            try {
                setStatus('This will be copied to your clipboard.', 'info');
                await navigator.clipboard.writeText(url);
                setStatus('App link copied.', 'success');
            } catch {
                setStatus('Copy failed in this browser context.', 'error');
            }
        });
    }

    if (sessionCopy && sessionCopy.dataset.boundQrCopy !== '1') {
        sessionCopy.dataset.boundQrCopy = '1';
        sessionCopy.addEventListener('click', async () => {
            const url = String(sessionLink?.href || '').trim();
            if (!url) {
                setStatus('No session id available for QR yet.', 'warn');
                return;
            }
            try {
                setStatus('This will be copied to your clipboard.', 'info');
                await navigator.clipboard.writeText(url);
                setStatus('Session link copied.', 'success');
            } catch {
                setStatus('Copy failed in this browser context.', 'error');
            }
        });
    }

    window._openQrPanel = (options = {}) => {
        void show(options && typeof options === 'object' ? options : {});
    };
    window._closeQrPanel = hide;
    window._refreshQrPanel = () => refresh();
    window._syncQrTopToggleState = syncTopToggleState;

    syncTopToggleState();
}

function setupSessionPanel() {
    const panel = document.getElementById('session-panel');
    if (!panel || panel.dataset.ready === '1') return;
    panel.dataset.ready = '1';

    const sessionIdInput = document.getElementById('session-id-input');
    const createBtn = document.getElementById('session-create-btn');
    const joinBtn = document.getElementById('session-join-btn');
    const leaveBtn = document.getElementById('session-leave-btn');
    const generateBtn = document.getElementById('session-generate-btn');
    const copyBtn = document.getElementById('session-copy-btn');
    const pasteBtn = document.getElementById('session-paste-btn');
    const sessionQrBtn = document.getElementById('session-qr-btn');
    const syncModeBtn = document.getElementById('session-sync-mode-btn');
    const freeModeBtn = document.getElementById('session-free-mode-btn');
    const syncRateSlider = document.getElementById('session-sync-rate');
    const syncRateInput = document.getElementById('session-sync-rate-input');
    const syncRateVal = document.getElementById('session-sync-rate-val');
    const publicList = document.getElementById('session-public-list');
    const membersList = document.getElementById('session-members-list');
    const publicRefreshBtn = document.getElementById('session-public-refresh-btn');
    const status = document.getElementById('session-status');
    if (!sessionIdInput || !createBtn || !joinBtn || !leaveBtn || !status || !publicList || !membersList) return;

    const setStatus = (message, kind = 'info') => {
        status.textContent = message;
        status.classList.remove('panel-status-success', 'panel-status-warn', 'panel-status-error');
        if (kind === 'success') status.classList.add('panel-status-success');
        if (kind === 'warn') status.classList.add('panel-status-warn');
        if (kind === 'error') status.classList.add('panel-status-error');
    };
    const sharedSessionIdFromUrl = (() => {
        try {
            const params = new URLSearchParams(window.location.search || '');
            return normalizeSessionId(params.get('session') || params.get('sid') || '');
        } catch {
            return '';
        }
    })();
    let sessionUrlJoinInFlight = false;
    let sessionUrlJoinCompleted = false;
    let ownSessionAutoJoinInFlight = false;
    let ownSessionAutoJoinedId = '';

    const attemptJoinSessionFromUrl = async () => {
        if (!sharedSessionIdFromUrl || sessionState.active || sessionUrlJoinCompleted || sessionUrlJoinInFlight) return false;
        sessionUrlJoinInFlight = true;
        try {
            // A join link is an explicit invitation: sign in as a guest if nobody is signed in.
            if (!sessionState.userId && !(await ensureSessionClientAndUser({ allowGuest: true }))) {
                setStatus('Sign in to join the shared session.', 'warn');
                return false;
            }
            const ok = await joinSessionById(sharedSessionIdFromUrl);
            if (ok) {
                sessionUrlJoinCompleted = true;
                setStatus(`Joined shared session ${sharedSessionIdFromUrl}.`, 'success');
                return true;
            }
            return false;
        } finally {
            sessionUrlJoinInFlight = false;
        }
    };

    const refreshPublicSessionDirectory = async (options = {}) => {
        const silent = options.silent !== false;
        const announce = options.announce === true;
        // A person asking for the list, or a page opened from a join link, may sign in as a guest.
        const ok = await ensureSessionDirectoryChannel({ allowGuest: !silent || (!!sharedSessionIdFromUrl && !sessionUrlJoinCompleted) });   // a person asking for the list may join as a guest
        if (!ok) {
            if (!silent) setStatus('Sign in to view active sessions.', 'warn');
            return false;
        }
        if (announce && isSessionLeader() && sessionState.active) {
            await announceSessionDirectory(true);
        }
        prunePublicSessions();
        renderPublicSessions();
        if (!sessionState.active) {
            const joinedFromUrl = await attemptJoinSessionFromUrl();
            if (joinedFromUrl) return true;
            await attemptAutoJoinOwnLeaderSession();
        }
        return true;
    };

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    let memberRenderToken = 0;
    const renderPublicSessions = () => {
        const entries = getPublicSessionEntries();
        if (!entries.length) {
            publicList.innerHTML = '<div class="session-list-empty">No active sessions found.</div>';
            return;
        }
        publicList.innerHTML = entries.map((entry) => {
            const sessionId = String(entry.sessionId || '').trim();
            const isActiveSession = sessionState.active && sessionState.sessionId === sessionId;
            const canJoin = !sessionState.active;
            const leader = String(entry.leaderName || 'Leader').trim();
            const memberCount = Math.max(0, parseInt(entry.memberCount, 10) || 0);
            const rhythmName = entry.rhythmKey && allRhythms[entry.rhythmKey]
                ? String(allRhythms[entry.rhythmKey].name || entry.rhythmKey)
                : '';
            const detailText = `${leader}${memberCount ? ` • ${memberCount} member${memberCount === 1 ? '' : 's'}` : ''}${rhythmName ? ` • ${rhythmName}` : ''}`;
            return `
                <div class="session-public-item" data-session-id="${escapeHtml(sessionId)}">
                    <div class="session-public-meta">
                        <div class="session-public-id">${escapeHtml(sessionId)}</div>
                        <div class="session-public-detail">${escapeHtml(detailText)}</div>
                    </div>
                    <button class="debug-action-btn session-public-join" data-session-join="${escapeHtml(sessionId)}" ${canJoin ? '' : 'disabled'}>
                        ${isActiveSession ? 'Active' : 'Join'}
                    </button>
                </div>
            `;
        }).join('');
    };

    const renderSessionMembers = async () => {
        const localToken = ++memberRenderToken;
        if (!sessionState.active) {
            membersList.innerHTML = '<div class="session-list-empty">Join or create a session to view members.</div>';
            return;
        }
        const members = Array.isArray(sessionState.members) ? sessionState.members.slice() : [];
        if (!members.length) {
            membersList.innerHTML = '<div class="session-list-empty">Waiting for member presence...</div>';
            return;
        }
        const viewModels = await Promise.all(members.map(async (member) => ({
            ...member,
            avatarSrc: await resolveSessionMemberAvatarUrl(member)
        })));
        if (localToken !== memberRenderToken) return;
        membersList.innerHTML = viewModels.map((member) => {
            const userName = String(member.userName || 'User').trim() || 'User';
            const role = member.role === 'leader' ? 'Leader' : 'Follower';
            const avatarSrc = String(member.avatarSrc || getSessionMemberFallbackIcon(member.userId, userName)).trim();
            const avatarAlt = `${userName} avatar`;
            return `
                <div class="session-member-item">
                    <img class="session-member-avatar" src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(avatarAlt)}">
                    <div class="session-member-meta">
                        <div class="session-member-name">${escapeHtml(userName)}</div>
                        <div class="session-member-role">${escapeHtml(role)}</div>
                    </div>
                </div>
            `;
        }).join('');
    };

    const syncButtons = () => {
        const typedRaw = String(sessionIdInput.value || '');
        const typed = normalizeSessionId(typedRaw);
        const hasTyped = typed.length > 0;
        const active = !!sessionState.active;
        const leaderActive = active && isSessionLeader();
        createBtn.textContent = 'Start Session';
        joinBtn.textContent = 'Join Session';
        leaveBtn.textContent = leaderActive ? 'End Session' : 'Leave Session';
        createBtn.disabled = active;
        joinBtn.disabled = active || !hasTyped;
        leaveBtn.disabled = !active;
        if (copyBtn) copyBtn.disabled = !(active || hasTyped);
        if (sessionQrBtn) sessionQrBtn.disabled = !(active || hasTyped);
        if (generateBtn) generateBtn.disabled = active;
        sessionIdInput.disabled = active;
        if (syncModeBtn) {
            const label = getSessionSyncModeLabel(sessionState.syncMode || sessionDefaultSyncMode);
            syncModeBtn.textContent = label;
            syncModeBtn.disabled = !leaderActive;
            syncModeBtn.title = leaderActive
                ? 'Leader mode: toggle session sync behavior'
                : 'Leader-only control';
            syncModeBtn.style.opacity = leaderActive ? '' : '0.55';
        }
        if (freeModeBtn) {
            const label = getSessionFreeModeLabel(!!sessionState.freeMode);
            freeModeBtn.textContent = label;
            freeModeBtn.disabled = !leaderActive;
            freeModeBtn.title = leaderActive
                ? 'Leader mode: toggle follower playback permissions'
                : 'Leader-only control';
            freeModeBtn.style.opacity = leaderActive ? '' : '0.55';
        }
        if (syncRateSlider || syncRateInput || syncRateVal) {
            const syncMs = clampSessionSyncIntervalMs(sessionState.syncIntervalMs);
            const canEditSyncRate = !active || leaderActive;
            if (syncRateSlider) {
                syncRateSlider.value = String(syncMs);
                syncRateSlider.disabled = !canEditSyncRate;
            }
            if (syncRateInput) {
                syncRateInput.value = String(syncMs);
                syncRateInput.disabled = !canEditSyncRate;
            }
            if (syncRateVal) {
                syncRateVal.textContent = `${syncMs} ms`;
            }
        }
        if (publicRefreshBtn) {
            publicRefreshBtn.disabled = false;
        }
        if (typeof window._refreshQrPanel === 'function') {
            window._refreshQrPanel().catch(() => {});
        }
    };

    window._rrcSetSessionStatus = setStatus;
    window._rrcSyncSessionButtons = syncButtons;
    window._rrcRenderSessionPublicDirectory = renderPublicSessions;
    window._rrcRenderSessionMembers = () => {
        renderSessionMembers().catch(() => {});
    };

    const applyTypedValue = () => {
        const normalized = normalizeSessionId(sessionIdInput.value);
        persistSessionPanelState(normalized);
        syncButtons();
        return normalized;
    };

    const joinSessionById = async (idValue, options = {}) => {
        if (notationPlaybackActive) {
            setStatus('Stop notation playback before joining a session.', 'warn');
            return false;
        }
        const id = normalizeSessionId(idValue);
        if (!id) {
            setStatus('Enter a session id first.', 'warn');
            return false;
        }
        sessionIdInput.value = id;
        const ok = await connectRealtimeSession(id, options.role === 'leader' ? 'leader' : 'follower', {
            leaderUserId: options.leaderUserId || '',
            leaderName: options.leaderName || ''
        });
        if (!ok) return false;
        const labelMode = getSessionSyncModeLabel(sessionState.syncMode);
        const labelFree = getSessionFreeModeLabel(sessionState.freeMode);
        setStatus(`Joined ${id} as ${sessionState.role === 'leader' ? 'leader' : 'follower'} (${labelMode}, ${labelFree}).`, 'success');
        syncButtons();
        return true;
    };

    async function attemptAutoJoinOwnLeaderSession() {
        if (sessionState.active || ownSessionAutoJoinInFlight) return false;
        const currentUserId = String(sessionState.userId || '').trim();
        if (!currentUserId) return false;

        const ownLeaderSession = getPublicSessionEntries().find((entry) =>
            String(entry?.leaderUserId || '').trim() === currentUserId
        );
        if (!ownLeaderSession || !ownLeaderSession.sessionId) {
            ownSessionAutoJoinedId = '';
            return false;
        }
        if (ownSessionAutoJoinedId === ownLeaderSession.sessionId) return false;

        ownSessionAutoJoinInFlight = true;
        try {
            const ok = await joinSessionById(ownLeaderSession.sessionId, {
                role: 'leader',                                      // your own session: you lead it again
                leaderUserId: ownLeaderSession.leaderUserId || '',
                leaderName: ownLeaderSession.leaderName || ''
            });
            if (!ok) return false;
            ownSessionAutoJoinedId = ownLeaderSession.sessionId;
            setStatus(`Auto-joined your active session ${ownLeaderSession.sessionId}.`, 'success');
            return true;
        } finally {
            ownSessionAutoJoinInFlight = false;
        }
    }

    const readSavedSessionPanelState = () => {
        try {
            const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
            return saved && typeof saved === 'object' ? saved : {};
        } catch {
            return {};
        }
    };

    const attemptSessionAutoReconnect = async () => {
        if (sessionState.active) return false;
        const saved = readSavedSessionPanelState();
        const activeSessionId = normalizeSessionId(saved.activeSessionId || '');
        if (!activeSessionId) return false;
        const savedRole = String(saved.activeRole || '').trim().toLowerCase() === 'leader' ? 'leader' : 'follower';
        const autoKey = `${sessionState.userId || 'guest'}:${activeSessionId}:${savedRole}`;
        if (sessionAutoReconnectKey === autoKey) return false;
        sessionAutoReconnectKey = autoKey;
        try {
            const ready = await ensureSessionClientAndUser();
            if (!ready) {
                sessionAutoReconnectKey = '';
                return false;
            }
            await ensureSessionDirectoryChannel();
            const entry = (sessionState.publicSessions && sessionState.publicSessions[activeSessionId]) || {};

            if (savedRole === 'leader') {
                const ok = await connectRealtimeSession(activeSessionId, 'leader');
                if (!ok) {
                    sessionAutoReconnectKey = '';
                    return false;
                }
                sessionState.tempo = Math.max(40, Math.min(240, parseInt(localStorage.getItem('notationCircularTempo') || '100', 10) || 100));
                await sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot());
                await announceSessionDirectory(true);
                setStatus(`Rejoined ${activeSessionId} as leader.`, 'success');
            } else {
                const ok = await joinSessionById(activeSessionId, {
                    leaderUserId: entry.leaderUserId || '',
                    leaderName: entry.leaderName || ''
                });
                if (!ok) {
                    sessionAutoReconnectKey = '';
                    return false;
                }
                setStatus(`Rejoined ${activeSessionId} as follower.`, 'success');
            }
            renderPublicSessions();
            renderSessionMembers().catch(() => {});
            syncButtons();
            return true;
        } catch {
            sessionAutoReconnectKey = '';
            return false;
        }
    };

    window._attemptSessionAutoReconnect = async () => {
        try {
            return await attemptSessionAutoReconnect();
        } catch {
            return false;
        }
    };

    const startSessionAsLeader = async (id) => {
        if (notationPlaybackActive) {
            setStatus('Stop notation playback before creating a session.', 'warn');
            return false;
        }
        sessionIdInput.value = id;
        const ok = await connectRealtimeSession(id, 'leader');
        if (!ok) return false;
        sessionState.tempo = Math.max(40, Math.min(240, parseInt(localStorage.getItem('notationCircularTempo') || '100', 10) || 100));
        setStatus(`Started ${id} (${getSessionSyncModeLabel(sessionState.syncMode)}, ${getSessionFreeModeLabel(sessionState.freeMode)}). Followers can now join.`, 'success');
        await sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot());
        await announceSessionDirectory(true);
        renderPublicSessions();
        renderSessionMembers().catch(() => {});
        syncButtons();
        return true;
    };
    createBtn.addEventListener('click', async () => {
        await startSessionAsLeader(applyTypedValue() || generateSessionId());
    });

    // Room session sheet. Start: you name it (or get a name) and you lead it; a name that already has
    // another leader is refused so a session never has two leaders. Join: always as a follower.
    window._rrcStartSession = async (name = '') => {
        if (sessionState.active) return { ok: false, reason: 'active' };
        const id = normalizeSessionId(name) || generateSessionId();
        if (!(await ensureSessionClientAndUser({ allowGuest: true }))) return { ok: false, reason: 'signin', id };
        await ensureSessionDirectoryChannel({ allowGuest: true });
        const taken = getPublicSessionEntries().find((e) => e.sessionId === id && e.leaderUserId && e.leaderUserId !== sessionState.userId);
        if (taken) return { ok: false, reason: 'taken', id, leaderName: taken.leaderName };
        if (notationPlaybackActive) return { ok: false, reason: 'playing', id };
        const ok = await startSessionAsLeader(id);
        // Room sessions are devices in one place: use the tight "local" sync (corrects drift above 15 ms,
        // pings every 2.2 s) instead of the remote default (60 ms, 4.5 s). Broadcast so every device agrees.
        if (ok) applySessionSyncMode('local', { broadcast: true });
        return { ok, id };
    };
    window._rrcJoinSession = async (name = '') => {
        if (sessionState.active) return { ok: false, reason: 'active' };
        const id = normalizeSessionId(name);
        if (!id) return { ok: false, reason: 'empty' };
        if (notationPlaybackActive) return { ok: false, reason: 'playing', id };
        const entry = getPublicSessionEntries().find((e) => e.sessionId === id) || {};
        return { ok: await joinSessionById(id, { leaderUserId: entry.leaderUserId || '', leaderName: entry.leaderName || '' }), id };
    };
    window._rrcListSessions = () => getPublicSessionEntries().map((e) => ({ id: e.sessionId, leaderName: e.leaderName, members: e.memberCount, mine: !!sessionState.userId && e.leaderUserId === sessionState.userId }));

    joinBtn.addEventListener('click', async () => {
        const id = applyTypedValue();
        await joinSessionById(id);
    });

    leaveBtn.addEventListener('click', async () => {
        if (!sessionState.active) {
            setStatus('No active session to leave.', 'warn');
            return;
        }
        const prev = sessionState.sessionId;
        const message = isSessionLeader() ? `Ended ${prev}.` : `Left ${prev}.`;
        await leaveRealtimeSession(message, 'warn');
        syncButtons();
    });

    if (generateBtn) {
        generateBtn.addEventListener('click', () => {
            if (sessionState.active) return;
            sessionIdInput.value = generateSessionId();
            applyTypedValue();
            setStatus('Generated a new session id.', 'info');
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const id = sessionState.active ? sessionState.sessionId : applyTypedValue();
            if (!id) {
                setStatus('Nothing to copy yet.', 'warn');
                return;
            }
            try {
                setStatus('This will be copied to your clipboard.', 'info');
                await navigator.clipboard.writeText(id);
                setStatus('Copied to clipboard.', 'success');
            } catch {
                setStatus('Clipboard copy failed in this browser context.', 'error');
            }
        });
    }

    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            if (sessionState.active) return;
            try {
                const text = await navigator.clipboard.readText();
                const normalized = normalizeSessionId(text);
                if (!normalized) {
                    setStatus('Clipboard did not contain a valid session id.', 'warn');
                    return;
                }
                sessionIdInput.value = normalized;
                applyTypedValue();
                setStatus(`Pasted ${normalized}.`, 'success');
            } catch {
                setStatus('Clipboard paste failed in this browser context.', 'error');
            }
        });
    }

    if (sessionQrBtn) {
        sessionQrBtn.addEventListener('click', () => {
            if (typeof window._openQrPanel === 'function') {
                window._openQrPanel({ focus: 'session' });
            } else {
                setStatus('QR panel is not ready yet.', 'warn');
            }
        });
    }

    if (publicList) {
        publicList.addEventListener('click', async (event) => {
            const joinButton = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('[data-session-join]')
                : null;
            if (!joinButton) return;
            const sessionId = String(joinButton.getAttribute('data-session-join') || '').trim();
            if (!sessionId || sessionState.active) return;
            const entry = (sessionState.publicSessions && sessionState.publicSessions[sessionId]) || {};
            await joinSessionById(sessionId, {
                leaderUserId: entry.leaderUserId || '',
                leaderName: entry.leaderName || ''
            });
        });
    }

    if (publicRefreshBtn) {
        publicRefreshBtn.addEventListener('click', async () => {
            const ok = await refreshPublicSessionDirectory({ silent: false, announce: true });
            if (!ok) return;
            setStatus('Session list refreshed.', 'info');
        });
    }

    if (syncModeBtn) {
        syncModeBtn.addEventListener('click', async () => {
            if (!sessionState.active || !isSessionLeader()) {
                setStatus('Only the leader can change session mode.', 'warn');
                return;
            }
            const current = normalizeSessionSyncMode(sessionState.syncMode || sessionDefaultSyncMode);
            const next = current === 'remote' ? 'local' : 'remote';
            applySessionSyncMode(next, { broadcast: true });
            setStatus(`Session mode set to ${getSessionSyncModeLabel(next)}.`, 'success');
        });
    }

    if (freeModeBtn) {
        freeModeBtn.addEventListener('click', async () => {
            if (!sessionState.active || !isSessionLeader()) {
                setStatus('Only the leader can change follower playback mode.', 'warn');
                return;
            }
            const next = !sessionState.freeMode;
            applySessionFreeMode(next, { broadcast: true });
            setStatus(`Follower playback is now ${getSessionFreeModeLabel(next)}.`, 'success');
        });
    }

    const applySyncRateUiChange = (rawValue) => {
        if (sessionState.active && !isSessionLeader()) {
            syncButtons();
            setStatus('Only the leader can change sync rate during a session.', 'warn');
            return;
        }
        const next = setSessionSyncIntervalMs(rawValue, {
            persistDefault: true,
            restartLoop: true,
            broadcast: !!(sessionState.active && isSessionLeader())
        });
        if (syncRateSlider && syncRateSlider.value !== String(next)) syncRateSlider.value = String(next);
        if (syncRateInput && syncRateInput.value !== String(next)) syncRateInput.value = String(next);
        if (syncRateVal) syncRateVal.textContent = `${next} ms`;
        setStatus(`Sync rate set to ${next} ms.`, 'success');
    };
    if (syncRateSlider) {
        syncRateSlider.addEventListener('input', () => applySyncRateUiChange(syncRateSlider.value));
        syncRateSlider.addEventListener('change', () => applySyncRateUiChange(syncRateSlider.value));
    }
    if (syncRateInput) {
        syncRateInput.addEventListener('change', () => applySyncRateUiChange(syncRateInput.value));
    }

    sessionIdInput.addEventListener('input', () => {
        if (sessionState.active) return;
        applyTypedValue();
    });

    sessionIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!joinBtn.disabled) joinBtn.click();
        }
    });

    const savedPanelState = readSavedSessionPanelState();
    const savedLast = normalizeSessionId(savedPanelState.lastSessionId || '');
    sessionIdInput.value = sharedSessionIdFromUrl || savedLast || '';

    applySessionInteractionLocks();
    setStatus('No active session', 'info');
    syncButtons();
    renderPublicSessions();
    renderSessionMembers().catch(() => {});
    refreshPublicSessionDirectory({ silent: true, announce: false }).then(async (ok) => {
        if (!ok) return;
        // A join link wins over reconnecting to the last session.
        if (sharedSessionIdFromUrl && await attemptJoinSessionFromUrl().catch(() => false)) return;
        attemptSessionAutoReconnect().then((reconnected) => {
            if (reconnected) return;
            attemptJoinSessionFromUrl().then((joinedFromUrl) => {
                if (joinedFromUrl) return;
                attemptAutoJoinOwnLeaderSession().catch(() => {});
            }).catch(() => {
                attemptAutoJoinOwnLeaderSession().catch(() => {});
            });
        }).catch(() => {
            attemptJoinSessionFromUrl().then((joinedFromUrl) => {
                if (joinedFromUrl) return;
                attemptAutoJoinOwnLeaderSession().catch(() => {});
            }).catch(() => {
                attemptAutoJoinOwnLeaderSession().catch(() => {});
            });
        });
    }).catch(() => {});
    window._rrcRefreshSessionDirectory = async (opts = {}) => {
        return refreshPublicSessionDirectory({
            silent: opts.silent !== false,
            announce: !!opts.announce
        });
    };
    if (!window._rrcSessionDirectoryRefreshTimer) {
        window._rrcSessionDirectoryRefreshTimer = setInterval(() => {
            if (!sessionState.userId) return;
            refreshPublicSessionDirectory({ silent: true, announce: false }).catch(() => {});
        }, 3500);
    }
}

function readTriggerPadState() {
    try {
        const parsed = JSON.parse(localStorage.getItem(TRIGGER_PAD_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeTriggerPadState(state) {
    try {
        localStorage.setItem(TRIGGER_PAD_STORAGE_KEY, JSON.stringify(state && typeof state === 'object' ? state : {}));
    } catch {}
}

function normalizeTriggerPadVelocity(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0.05, Math.min(1, n));
}

function normalizeTriggerPadVolume(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(1, n));
}

function normalizeTriggerPadReverb(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function clampTriggerPadVelocityUnit(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function encodeTriggerPadPattern(pattern, totalSteps) {
    const steps = Math.max(1, parseInt(totalSteps, 10) || 1);
    const source = Array.isArray(pattern) ? pattern : [];
    let out = '';
    for (let i = 0; i < steps; i++) {
        const sound = String(source[i] || '').trim().toLowerCase();
        out += TRIGGER_PAD_SOUND_TO_TOKEN[sound] || '.';
    }
    return out;
}

function decodeTriggerPadPattern(encoded, totalSteps) {
    const steps = Math.max(1, parseInt(totalSteps, 10) || 1);
    const text = String(encoded || '');
    const out = new Array(steps).fill(null);
    for (let i = 0; i < steps; i++) {
        const token = text[i] || '.';
        out[i] = TRIGGER_PAD_TOKEN_TO_SOUND[token] || null;
    }
    return out;
}

function buildTriggerPadRhythmSnapshot(rhythmData) {
    if (!rhythmData || !Array.isArray(rhythmData.instruments)) return null;
    const beats = Math.max(1, parseInt(rhythmData.beats, 10) || 4);
    const subdivisions = Math.max(1, parseInt(rhythmData.subdivisions, 10) || 4);
    const totalSteps = beats * subdivisions;
    const instruments = rhythmData.instruments
        .filter((instrument) => instrument && typeof instrument === 'object')
        .map((instrument) => ({
            id: String(instrument.id || '').trim(),
            n: String(instrument.name || '').trim(),
            t: String(instrument.type || 'djembe').trim(),
            x: String(instrument.icon || '').trim(),
            p: encodeTriggerPadPattern(instrument.pattern, totalSteps)
        }))
        .filter((instrument) => instrument.id);
    if (instruments.length === 0) return null;
    return {
        b: beats,
        s: subdivisions,
        n: String(rhythmData.rhythmName || '').trim(),
        i: instruments
    };
}

function expandTriggerPadRhythmSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const beats = Math.max(1, parseInt(snapshot.b, 10) || 4);
    const subdivisions = Math.max(1, parseInt(snapshot.s, 10) || 4);
    const totalSteps = beats * subdivisions;
    const instrumentsRaw = Array.isArray(snapshot.i) ? snapshot.i : [];
    const instruments = instrumentsRaw
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const id = String(entry.id || '').trim();
            if (!id) return null;
            return {
                id,
                name: String(entry.n || entry.name || id).trim(),
                type: String(entry.t || entry.type || 'djembe').trim(),
                icon: String(entry.x || entry.icon || '🥁').trim() || '🥁',
                pattern: decodeTriggerPadPattern(entry.p, totalSteps)
            };
        })
        .filter(Boolean);
    if (instruments.length === 0) return null;
    return {
        rhythmName: String(snapshot.n || '').trim(),
        beats,
        subdivisions,
        instruments
    };
}

const PAD_SHARE_LAN_HOST_STORAGE_KEY = 'rrcPadShareLanHost';
const PAD_SHARE_QUERY_KEY = 'padShare';
const PAD_REMOTE_UI_VERSION = '2026-02-09-unlock-sync-v2';

function encodePadSharePayload(payload) {
    try {
        const json = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
        let binary = '';
        if (typeof TextEncoder !== 'undefined') {
            const bytes = new TextEncoder().encode(json);
            bytes.forEach((b) => { binary += String.fromCharCode(b); });
        } else {
            binary = unescape(encodeURIComponent(json));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch {
        return '';
    }
}

function decodePadSharePayload(raw) {
    const token = String(raw || '').trim();
    if (!token) return null;
    try {
        let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        const binary = atob(base64);
        let text = '';
        if (typeof TextDecoder !== 'undefined') {
            const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
            text = new TextDecoder().decode(bytes);
        } else {
            text = decodeURIComponent(escape(binary));
        }
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function readPadSharePayloadFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        const encoded = params.get(PAD_SHARE_QUERY_KEY);
        const decoded = decodePadSharePayload(encoded);
        if (decoded && typeof decoded === 'object') return decoded;

        // Plain-query fallback for scanners/browsers that mangle long payload tokens.
        const rk = String(params.get('rk') || '').trim();
        const rn = String(params.get('rn') || '').trim();
        const instrumentId = String(params.get('pi') || '').trim();
        const reverbRaw = params.get('pr');
        const hasReverb = reverbRaw !== null && reverbRaw !== '';
        const fallback = {};
        if (rk) fallback.rk = rk;
        if (rn) fallback.rn = rn;
        if (instrumentId) fallback.instrumentId = instrumentId;
        if (hasReverb) fallback.reverb = normalizeTriggerPadReverb(reverbRaw);
        return Object.keys(fallback).length > 0 ? fallback : null;
    } catch {
        return null;
    }
}

function isLoopbackHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
}

function isPrivateIpv4(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
    return parts[0] === 10
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
}

function normalizePadShareHost(rawHost) {
    let host = String(rawHost || '').trim();
    if (!host) return '';
    host = host.replace(/^[a-z]+:\/\//i, '');
    host = host.split('/')[0].split('?')[0].split('#')[0].trim();
    return host;
}

function ensurePadShareHostPort(host) {
    const normalized = normalizePadShareHost(host);
    if (!normalized) return '';
    if (normalized.includes(':')) return normalized;
    const currentPort = String(window.location.port || '').trim();
    if (!currentPort) return normalized;
    return `${normalized}:${currentPort}`;
}

function resolvePadSharePath() {
    const protocol = String(window.location.protocol || '').toLowerCase();
    const path = String(window.location.pathname || '').trim();
    if (protocol === 'file:') return '/index.html';
    if (!path || path === '/') return '/';
    // When opened from a local file and then shared over LAN, browser path can be absolute FS.
    if (path.includes('/Users/') || path.includes('\\')) return '/index.html';
    if (/\.html?$/i.test(path)) return path;
    if (path.endsWith('/')) return path;
    if (/\.[a-z0-9]+$/i.test(path)) return '/';
    return path;
}

function discoverLanIpv4Address(timeoutMs = 1400) {
    return new Promise((resolve) => {
        if (!window.RTCPeerConnection) {
            resolve('');
            return;
        }
        let finished = false;
        const finish = (value) => {
            if (finished) return;
            finished = true;
            try { pc.close(); } catch {}
            resolve(value || '');
        };
        const pc = new RTCPeerConnection({ iceServers: [] });
        try { pc.createDataChannel('rrc-pad-share'); } catch {}
        pc.onicecandidate = (event) => {
            const candidate = String(event?.candidate?.candidate || '');
            const match = candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
            if (!match) return;
            const ip = match[1];
            if (isPrivateIpv4(ip)) finish(ip);
        };
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => finish(''));
        setTimeout(() => finish(''), timeoutMs);
    });
}

let padShareLanPromptPending = null;
let padShareLanPromptDeclined = false;
async function resolvePadShareOrigin(options = {}) {
    const rawProtocol = String(window.location.protocol || '').toLowerCase();
    const protocol = rawProtocol && rawProtocol !== 'file:' ? rawProtocol : 'http:';
    const currentHost = normalizePadShareHost(window.location.host);
    const currentOrigin = (window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : `${protocol}//${currentHost || 'localhost'}`;
    if (!isLoopbackHost(window.location.hostname)) return currentOrigin;

    const savedHostRaw = localStorage.getItem(PAD_SHARE_LAN_HOST_STORAGE_KEY) || '';
    const savedHost = ensurePadShareHostPort(savedHostRaw);
    if (savedHost) {
        const savedHostname = savedHost.split(':')[0].trim();
        if (!isLoopbackHost(savedHostname)) {
            if (savedHost !== savedHostRaw) localStorage.setItem(PAD_SHARE_LAN_HOST_STORAGE_KEY, savedHost);
            return `${protocol}//${savedHost}`;
        }
        localStorage.removeItem(PAD_SHARE_LAN_HOST_STORAGE_KEY);
    }

    const discoveredIp = options.ask ? '' : await discoverLanIpv4Address();
    if (discoveredIp) {
        const host = ensurePadShareHostPort(discoveredIp);
        localStorage.setItem(PAD_SHARE_LAN_HOST_STORAGE_KEY, host);
        return `${protocol}//${host}`;
    }

    // Ask at most once per page load: a Cancel is remembered, and calls that overlap share one question.
    if (padShareLanPromptDeclined) return currentOrigin;
    if (!padShareLanPromptPending) {
        const ui = ensureInAppUi();
        padShareLanPromptPending = Promise.resolve(ui.prompt(
            'Enter LAN host for mobile pad share (host[:port], example: 192.168.1.20:5500)',
            '',
            'LAN Host'
        )).finally(() => { padShareLanPromptPending = null; });
    }
    const manual = await padShareLanPromptPending;
    const manualHost = ensurePadShareHostPort(manual);
    if (!manualHost) padShareLanPromptDeclined = true;
    if (manualHost) {
        const manualHostname = manualHost.split(':')[0].trim();
        if (!isLoopbackHost(manualHostname)) {
            localStorage.setItem(PAD_SHARE_LAN_HOST_STORAGE_KEY, manualHost);
            return `${protocol}//${manualHost}`;
        }
    }
    return currentOrigin;
}

function setupTriggerPadWindows() {
    const toggleBtn = document.getElementById('trigger-pad-toggle');
    const topUi = document.getElementById('top-panel-toggles');
    const debugToggle = document.getElementById('debug-toggle');
    const panels = TRIGGER_PAD_IDS.map((id) => document.getElementById(id)).filter(Boolean);
    if (!toggleBtn || panels.length === 0) return;
    if (toggleBtn.dataset.ready === '1') return;
    toggleBtn.dataset.ready = '1';

    const urlParams = new URLSearchParams(window.location.search || '');
    const mobileMode = (() => {
        if (!urlParams.has('mobile')) return false;
        const value = String(urlParams.get('mobile') || '').trim().toLowerCase();
        return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    })();
    const padRemoteMode = urlParams.get('padRemote') === '1' || mobileMode;
    // QR handoff mode runs full app UI, but still needs live rhythm sync hooks.
    const padRemoteFullSiteMode = padRemoteMode;
    if (topUi) {
        topUi.classList.toggle('pad-remote-force-hidden', !!padRemoteMode);
    }
    if (!padRemoteMode) {
        document.documentElement.classList.remove('rrc-padremote-boot');
    }
    const isPadRemotePhoneViewport = () => {
        const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
        const longSide = Math.max(window.innerWidth || 0, window.innerHeight || 0);
        return shortSide <= 430 || (shortSide <= 460 && longSide <= 940);
    };
    const syncPadRemoteViewportClass = () => {
        document.body.classList.toggle('pad-remote-phone', !!padRemoteMode && isPadRemotePhoneViewport());
        document.body.classList.toggle('pad-remote-tablet', !!padRemoteMode && !isPadRemotePhoneViewport());
    };
    syncPadRemoteViewportClass();
    const padSharePayload = readPadSharePayloadFromUrl();
    const normalizeRhythmLookupText = (value) => String(value || '').trim().toLowerCase();
    const findRhythmKeyByName = (name) => {
        const target = normalizeRhythmLookupText(name);
        if (!target) return '';
        const entries = Object.entries(allRhythms || {});
        for (const [key, rhythm] of entries) {
            if (normalizeRhythmLookupText(key) === target) return key;
            if (normalizeRhythmLookupText(rhythm?.name) === target) return key;
        }
        return '';
    };
    const resolveSharedRhythmKey = () => {
        const payloadKey = String(padSharePayload?.rk || '').trim();
        if (payloadKey && allRhythms[payloadKey]) return payloadKey;
        const payloadName = String(padSharePayload?.rn || '').trim();
        const byPayloadName = findRhythmKeyByName(payloadName);
        if (byPayloadName) return byPayloadName;
        const snapshotName = String(padSharePayload?.rh?.n || '').trim();
        const bySnapshotName = findRhythmKeyByName(snapshotName);
        if (bySnapshotName) return bySnapshotName;
        if (selectedRhythm && allRhythms[selectedRhythm]) return selectedRhythm;
        if (allRhythms.toro) return 'toro';
        const toroByName = findRhythmKeyByName('toro');
        if (toroByName) return toroByName;
        const firstKey = Object.keys(allRhythms || {})[0];
        return firstKey || '';
    };
    const sharedRhythmKey = padRemoteMode ? resolveSharedRhythmKey() : '';
    const sharedRhythmName = (() => {
        if (sharedRhythmKey && allRhythms[sharedRhythmKey]) {
            return String(allRhythms[sharedRhythmKey].name || sharedRhythmKey).trim();
        }
        return String(padSharePayload?.rn || '').trim();
    })();
    let activeRemoteRhythmKey = sharedRhythmKey;
    let activeRemoteRhythmName = sharedRhythmName;
    const sharedRhythmData = expandTriggerPadRhythmSnapshot(padSharePayload && padSharePayload.rh);
    // Always allow live remote rhythm loading and selection. Snapshot data is only a temporary fallback.
    const lockSharedRhythmData = false;
    // Keep sync enabled even in full-site mobile mode so remote pads and notation
    // stay aligned with the current shared rhythm/catalog state.
    const remoteRhythmSyncEnabled = padRemoteMode && !lockSharedRhythmData;
    if (!selectedRhythm || !allRhythms[selectedRhythm]) {
        ensureSelectedRhythmBootstrap();
    }
    if (!latestNotationRhythmData || !Array.isArray(latestNotationRhythmData.instruments) || latestNotationRhythmData.instruments.length === 0) {
        seedLatestNotationRhythmDataFromKey(selectedRhythm);
    }
    if (padRemoteMode && sharedRhythmKey && allRhythms[sharedRhythmKey]) selectedRhythm = sharedRhythmKey;
    if (padRemoteMode && sharedRhythmKey && allRhythms[sharedRhythmKey]?.notationData?.instruments) {
        // Bootstrap remote instrument list immediately from DB notation data.
        latestNotationRhythmData = ensureCallInstrumentInRhythmData({
            rhythmName: String(allRhythms[sharedRhythmKey].name || sharedRhythmName || '').trim(),
            beats: Math.max(1, parseInt(allRhythms[sharedRhythmKey].notationData.beats, 10) || 4),
            subdivisions: Math.max(1, parseInt(allRhythms[sharedRhythmKey].notationData.subdivisions, 10) || 4),
            instruments: Array.isArray(allRhythms[sharedRhythmKey].notationData.instruments)
                ? allRhythms[sharedRhythmKey].notationData.instruments
                : []
        });
    }
    if (sharedRhythmData && !latestNotationRhythmData) {
        latestNotationRhythmData = ensureCallInstrumentInRhythmData(sharedRhythmData);
    }
    const isPadRemoteUi = () => padRemoteMode;
    let triggerPadBridgeEnsured = false;
    let triggerPadAudioWarmupSent = false;

    let remoteWelcomeUnlocked = !padRemoteMode;
    let remoteAudioPrepared = false;

    const warmupPadRemoteAudio = () => {
        if (!padRemoteMode) return;
        if (!triggerPadAudioWarmupSent) triggerPadAudioWarmupSent = true;

        if (typeof MobileAudioEngine !== 'undefined') {
            try { MobileAudioEngine.warmup(); } catch {}
        }
        const bridge = window._notationBridge;
        if (bridge) {
            try {
                const mainWindow = typeof bridge.getMainWindow === 'function' ? bridge.getMainWindow() : null;
                if (mainWindow && typeof mainWindow.__rrcWarmupAudio === 'function') {
                    mainWindow.__rrcWarmupAudio();
                } else if (typeof bridge.warmupMainAudio === 'function') {
                    bridge.warmupMainAudio();
                }
            } catch {}
        }
    };

    const preparePadRemoteAudio = () => {
        if (!padRemoteMode || remoteAudioPrepared) return;
        if (typeof MobileAudioEngine !== 'undefined') {
            try {
                remoteAudioPrepared = MobileAudioEngine.init() === true;
            } catch {
                remoteAudioPrepared = false;
            }
        } else {
            remoteAudioPrepared = false;
        }
    };

    const fallbackInstruments = [
        { id: 'djembe1', name: 'Djembe 1', type: 'djembe', icon: '🥁' },
        { id: 'djembe2', name: 'Djembe 2', type: 'djembe', icon: '🥁' },
        { id: 'djembe3', name: 'Djembe 3', type: 'djembe', icon: '🥁' },
        { id: 'kenkeni1', name: 'Kenkeni', type: 'kenkeni', icon: '🪘' },
        { id: 'sangban1', name: 'Sangban', type: 'sangban', icon: '🪘' },
        { id: 'doundoun1', name: 'Doundoun', type: 'doundoun', icon: '🪘' },
        { id: 'shekere1', name: 'Shekere', type: 'shekere', icon: '🎶' }
    ];
    let state = readTriggerPadState();
    let padPlaybackVolume = Math.max(0, Math.min(1, Number(localStorage.getItem('triggerPadPlaybackVolume') || latestNotationMasterVolume || 1) || 1));
    const PAD_REMOTE_MOBILE_HIDE_CLASS = 'pad-remote-mobile-hidden';
    const PAD_REMOTE_MOBILE_FOCUS_CLASS = 'pad-remote-mobile-focus';
    const PAD_REMOTE_MOBILE_VIEWS = [
        { key: 'pads', icon: '🎚️', label: 'Pads', title: 'Pads' },
        { key: 'rhythms', icon: '🥁', label: 'Rhythms', title: 'Rhythms' },
        { key: 'journeys', icon: '📁', label: 'Collections', title: 'Collections' },
        { key: 'journey', icon: '🧭', label: 'Journey', title: 'Title + Media + Context' },
        { key: 'media', icon: '🎬', label: 'Media', title: 'Media' },
        { key: 'context', icon: '📜', label: 'Context', title: 'Context' },
        { key: 'notation', icon: '🎵', label: 'Notation', title: 'Notation' },
        { key: 'circular', icon: '⭕', label: 'Circular', title: 'Circular' },
        { key: 'map', icon: '🗺️', label: 'Map', title: 'Map View' },
        { key: 'views', icon: '🖥️', label: 'Views', title: 'Saved Views' },
        { key: 'stage', icon: '🎛️', label: 'Stage', title: 'Stage Mix' },
        { key: 'user', icon: '👤', label: 'User', title: 'User' },
        { key: 'session', icon: '🤝', label: 'Session', title: 'Session' },
        { key: 'settings', icon: '🛠️', label: 'Settings', title: 'Settings' }
    ];
    const PAD_REMOTE_MOBILE_TRANSPORT_VIEWS = new Set([
        'pads',
        'journey',
        'media',
        'context',
        'notation',
        'circular'
    ]);
    const padRemoteMobileButtons = new Map();
    const padRemoteMobilePanelIds = [
        'rhythm-panel',
        'info-banner',
        'image-window',
        'history-box',
        'nav-toolbar',
        'views-panel',
        'stage-panel',
        'serve-panel',
        'auth-panel',
        'session-panel',
        'debug-controls',
        'notation-overlay',
        'notation-circular-overlay'
    ];
    let padRemoteMobileToolbar = null;
    let padRemoteMobileRhythmSelect = null;
    let padRemoteMobileCurrentView = localStorage.getItem('padRemoteMobileView') || 'pads';
    let padRemoteMapDefaultsApplied = false;
    const getPadRemoteMobileViewIcon = (viewKey) => {
        const key = String(viewKey || '').trim().toLowerCase();
        if (key === 'map') {
            return normalizeMapSceneMode(mapSceneMode) === '2d' ? '🗺️' : '🌍';
        }
        const view = PAD_REMOTE_MOBILE_VIEWS.find((entry) => entry.key === key);
        return view && view.icon ? view.icon : '•';
    };
    const getPadRemoteMobileViewTitle = (viewKey) => {
        const key = String(viewKey || '').trim().toLowerCase();
        if (key === 'map') {
            return normalizeMapSceneMode(mapSceneMode) === '2d'
                ? 'Map (Flat 2D). Tap again to switch to Globe 3D.'
                : 'Map (Globe 3D). Tap again to switch to Flat 2D.';
        }
        const view = PAD_REMOTE_MOBILE_VIEWS.find((entry) => entry.key === key);
        return view && view.title ? view.title : key;
    };
    const syncPadRemoteMobileToolbarIcons = () => {
        padRemoteMobileButtons.forEach((btn, key) => {
            btn.textContent = getPadRemoteMobileViewIcon(key);
            btn.title = getPadRemoteMobileViewTitle(key);
        });
    };
    const syncPadRemoteMobileRhythmSelector = () => {
        if (!padRemoteMode) return;
        const toolbar = padRemoteMobileToolbar || document.getElementById('pad-remote-mobile-toolbar');
        if (!toolbar) return;
        if (!padRemoteMobileRhythmSelect || !padRemoteMobileRhythmSelect.isConnected) {
            const select = document.createElement('select');
            select.className = 'pad-remote-mobile-rhythm-select';
            select.dataset.floatingInteractive = 'true';
            select.title = 'Change Rhythm';
            select.setAttribute('aria-label', 'Change Rhythm');
            select.addEventListener('change', () => {
                const selectedKey = String(select.value || '').trim();
                if (!selectedKey) return;
                void applyGlobalRhythmSelectionFromPad(selectedKey, getPadRemoteActivePanel(), {
                    force: true,
                    suppressAutoAudio: true
                });
            });
            toolbar.appendChild(select);
            padRemoteMobileRhythmSelect = select;
        }

        const shouldShow = PAD_REMOTE_MOBILE_TRANSPORT_VIEWS.has(padRemoteMobileCurrentView || 'pads');
        padRemoteMobileRhythmSelect.style.display = shouldShow ? '' : 'none';
        if (!shouldShow) return;

        const entries = getAvailableRhythmEntries();
        const desired = String(activeRemoteRhythmKey || selectedRhythm || '').trim();
        const current = String(padRemoteMobileRhythmSelect.value || '').trim();
        const next = entries.some(([key]) => key === desired) ? desired : (entries[0]?.[0] || '');
        if (entries.length === 0) {
            padRemoteMobileRhythmSelect.innerHTML = '<option value="">No rhythms</option>';
            padRemoteMobileRhythmSelect.value = '';
            padRemoteMobileRhythmSelect.disabled = true;
            return;
        }
        if (padRemoteMobileRhythmSelect.options.length !== entries.length) {
            padRemoteMobileRhythmSelect.innerHTML = '';
            entries.forEach(([key, rhythm]) => {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = String(rhythm?.name || key);
                padRemoteMobileRhythmSelect.appendChild(opt);
            });
        } else {
            // Keep option list current if names changed.
            entries.forEach(([key, rhythm], idx) => {
                const opt = padRemoteMobileRhythmSelect.options[idx];
                if (!opt) return;
                opt.value = key;
                opt.textContent = String(rhythm?.name || key);
            });
        }
        padRemoteMobileRhythmSelect.disabled = false;
        if (next && current !== next) {
            padRemoteMobileRhythmSelect.value = next;
        } else if (!next && current) {
            padRemoteMobileRhythmSelect.value = '';
        }
    };
    window._syncPadRemoteMobileRhythmSelector = syncPadRemoteMobileRhythmSelector;
    const getTopUiClearance = () => {
        const topUi = document.getElementById('top-panel-toggles');
        if (!topUi) return 60;
        const style = window.getComputedStyle(topUi);
        if (style.display === 'none' || style.visibility === 'hidden') return 60;
        if (topUi.classList.contains('top-buttons-side')) return 60;
        return Math.max(60, Math.ceil(topUi.getBoundingClientRect().bottom + 8));
    };

    const getPadRemoteMobileViewportTop = () => {
        const toolbar = padRemoteMobileToolbar || document.getElementById('pad-remote-mobile-toolbar');
        if (!toolbar || toolbar.classList.contains('hidden')) return 8;
        const rect = toolbar.getBoundingClientRect();
        if (!rect || rect.height <= 0) return 8;
        return Math.max(8, Math.ceil(rect.bottom + 8));
    };

    const clampPanelOnOpen = (panel) => {
        if (!panel) return;
        let rect = panel.getBoundingClientRect();
        const gap = 8;
        const viewportTop = getPadRemoteMobileViewportTop();
        const minW = Math.max(220, parseFloat(panel.dataset.windowMinW || panel.getAttribute('data-window-min-w') || '220') || 220);
        const minH = Math.max(140, parseFloat(panel.dataset.windowMinH || panel.getAttribute('data-window-min-h') || '140') || 140);

        if (rect.width < 20 || rect.height < 20) {
            const fallbackW = Math.max(minW, Math.min(window.innerWidth - (gap * 2), Math.round(window.innerWidth * 0.78)));
            const fallbackH = Math.max(minH, Math.min(window.innerHeight - viewportTop - gap, Math.round(window.innerHeight * 0.66)));
            panel.style.position = 'fixed';
            panel.style.left = `${gap}px`;
            panel.style.top = `${viewportTop}px`;
            panel.style.width = `${Math.round(fallbackW)}px`;
            panel.style.height = `${Math.round(fallbackH)}px`;
            panel.style.maxHeight = `${Math.round(fallbackH)}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
            panel.dataset.windowPinned = '1';
            rect = panel.getBoundingClientRect();
        }

        const left = Math.max(gap, Math.min(rect.left, window.innerWidth - rect.width - gap));
        const top = Math.max(viewportTop, Math.min(rect.top, window.innerHeight - rect.height - gap));
        panel.style.position = 'fixed';
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.dataset.windowPinned = '1';
    };

    const setMobilePanelVisibility = (panel, visible) => {
        if (!panel) return;
        panel.classList.toggle(PAD_REMOTE_MOBILE_HIDE_CLASS, !visible);
        if (!visible) {
            panel.classList.remove(PAD_REMOTE_MOBILE_FOCUS_CLASS);
            panel.classList.remove('active');
        }
    };

    const applyMobileFocusLayout = (panel) => {
        if (!panel) return;
        // With the drum circle room behind it, the pad docks across the bottom and leaves the room visible.
        const overRoom = document.documentElement.classList.contains('rrc-room-pads');
        const gap = overRoom ? 0 : 8;
        const width = Math.max(300, Math.floor(window.innerWidth - (gap * 2)));
        const height = overRoom
            ? Math.max(220, Math.floor(window.innerHeight * 0.46))
            : Math.max(220, Math.floor(window.innerHeight - getPadRemoteMobileViewportTop() - gap));
        const top = overRoom ? window.innerHeight - height : getPadRemoteMobileViewportTop();
        panel.classList.add(PAD_REMOTE_MOBILE_FOCUS_CLASS);
        panel.style.setProperty('position', 'fixed', 'important');
        panel.style.setProperty('left', `${gap}px`, 'important');
        panel.style.setProperty('top', `${top}px`, 'important');
        panel.style.setProperty('width', `${width}px`, 'important');
        panel.style.setProperty('height', `${height}px`, 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('max-height', `${height}px`, 'important');
        panel.style.transform = 'none';
        panel.dataset.windowPinned = '1';
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(panel);
        }
    };

    const getMobileJourneyGeometry = () => {
        const gap = 8;
        const top = getPadRemoteMobileViewportTop();
        const width = Math.max(280, Math.floor(window.innerWidth - (gap * 2)));
        const availableHeight = Math.max(280, Math.floor(window.innerHeight - top - gap));
        const isPhone = document.body.classList.contains('pad-remote-phone') || isPadRemotePhoneViewport();
        if (isPhone) {
            const titleHeight = Math.max(40, Math.floor(availableHeight * 0.1));
            const mediaHeight = Math.max(110, Math.floor(availableHeight * 0.28));
            const contextHeight = Math.max(90, Math.floor(availableHeight * 0.2));
            const mapTop = top + titleHeight + mediaHeight + contextHeight + (gap * 3);
            const mapHeight = Math.max(120, availableHeight - titleHeight - mediaHeight - contextHeight - (gap * 3));
            return {
                gap,
                top,
                width,
                availableHeight,
                topHeight: titleHeight + mediaHeight + contextHeight + (gap * 2),
                bottomHeight: mapHeight,
                titleRect: {
                    left: gap,
                    top,
                    width,
                    height: titleHeight
                },
                contextRect: {
                    left: gap,
                    top: top + titleHeight + mediaHeight + (gap * 2),
                    width,
                    height: contextHeight
                },
                mediaRect: {
                    left: gap,
                    top: top + titleHeight + gap,
                    width,
                    height: mediaHeight
                },
                mapRect: {
                    left: gap,
                    top: mapTop,
                    width,
                    height: mapHeight
                }
            };
        }
        const topHeight = Math.max(180, Math.floor((availableHeight - gap) * 0.5));
        const bottomHeight = Math.max(180, availableHeight - topHeight - gap);
        const leftWidth = Math.max(150, Math.floor((width - gap) * 0.5));
        const rightWidth = Math.max(150, width - leftWidth - gap);
        const titleHeight = Math.max(56, Math.floor(topHeight * 0.25));
        const contextHeight = Math.max(96, topHeight - titleHeight - gap);
        return {
            gap,
            top,
            width,
            availableHeight,
            topHeight,
            bottomHeight,
            titleRect: {
                left: gap,
                top,
                width: leftWidth,
                height: titleHeight
            },
            contextRect: {
                left: gap,
                top: top + titleHeight + gap,
                width: leftWidth,
                height: contextHeight
            },
            mediaRect: {
                left: gap + leftWidth + gap,
                top,
                width: rightWidth,
                height: topHeight
            },
            mapRect: {
                left: gap,
                top: top + topHeight + gap,
                width,
                height: bottomHeight
            }
        };
    };

    const applyMobileJourneyLayout = (titlePanel, mediaPanel, contextPanel) => {
        const panels = [titlePanel, mediaPanel, contextPanel].filter(Boolean);
        if (panels.length === 0) return;
        const layout = getMobileJourneyGeometry();
        const applyRect = (panel, rect) => {
            if (!panel || !rect) return;
            panel.classList.remove(PAD_REMOTE_MOBILE_FOCUS_CLASS);
            panel.style.setProperty('position', 'fixed', 'important');
            panel.style.setProperty('left', `${rect.left}px`, 'important');
            panel.style.setProperty('top', `${rect.top}px`, 'important');
            panel.style.setProperty('width', `${rect.width}px`, 'important');
            panel.style.setProperty('height', `${rect.height}px`, 'important');
            panel.style.setProperty('max-height', `${rect.height}px`, 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
            panel.style.transform = 'none';
            panel.dataset.windowPinned = '1';
            if (typeof window._updateFloatingWindowScale === 'function') {
                window._updateFloatingWindowScale(panel);
            }
        };
        applyRect(titlePanel, layout.titleRect);
        applyRect(contextPanel, layout.contextRect);
        applyRect(mediaPanel, layout.mediaRect);
    };

    const getPadRemoteJourneyMapRect = () => {
        const layout = getMobileJourneyGeometry();
        return clampMapWindowRect(layout.mapRect);
    };

    const ensurePadRemoteMapDefaults = () => {
        if (!padRemoteMode || padRemoteMapDefaultsApplied) return;
        padRemoteMapDefaultsApplied = true;
        if (normalizeMapSceneMode(mapSceneMode) !== '3d') {
            // Mobile-remote defaults should not overwrite desktop map scene preference.
            applyMapSceneMode('3d', { persist: false });
        }
    };

    const showPadRemoteJourneyMapWindow = () => {
        ensurePadRemoteMapDefaults();
        const mapContainer = document.getElementById('cesiumContainer');
        if (!mapContainer) return;
        const rect = getPadRemoteJourneyMapRect();
        saveMapWindowRect(rect);
        // Mobile-remote layout should not persist map window mode to shared storage.
        applyMapWindowMode(true, { persist: false });
        mapContainer.classList.remove(PAD_REMOTE_MOBILE_HIDE_CLASS);
        if (viewer && viewer.scene && viewer.scene.screenSpaceCameraController) {
            viewer.scene.screenSpaceCameraController.enableInputs = true;
        }
    };

    const applyPadRemoteJourneyNotationOverlay = (options = {}) => {
        if (!padRemoteMode) return false;
        if (document.documentElement.classList.contains('rrc-room-pads')) return false;   // the room shows the notation
        if (options.ensureJourneyView !== false) {
            setPadRemoteMobileView('journey', { persist: false });
        }
        const notationOverlay = document.getElementById('notation-overlay');
        if (!notationOverlay) return false;
        const layout = getMobileJourneyGeometry();
        const rect = layout.mapRect;
        notationOverlay.classList.remove('hidden', 'panel-hidden');
        notationOverlay.classList.add('active');
        setMobilePanelVisibility(notationOverlay, true);
        notationOverlay.classList.remove(PAD_REMOTE_MOBILE_FOCUS_CLASS);
        notationOverlay.style.setProperty('position', 'fixed', 'important');
        notationOverlay.style.setProperty('left', `${Math.round(rect.left)}px`, 'important');
        notationOverlay.style.setProperty('top', `${Math.round(rect.top)}px`, 'important');
        notationOverlay.style.setProperty('width', `${Math.round(rect.width)}px`, 'important');
        notationOverlay.style.setProperty('height', `${Math.round(rect.height)}px`, 'important');
        notationOverlay.style.setProperty('max-height', `${Math.round(rect.height)}px`, 'important');
        notationOverlay.style.setProperty('right', 'auto', 'important');
        notationOverlay.style.setProperty('bottom', 'auto', 'important');
        notationOverlay.style.transform = 'none';
        notationOverlay.dataset.windowPinned = '1';
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(notationOverlay);
        }
        bringToFront(notationOverlay);
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
        return true;
    };

    const showPadRemoteMapBackdrop = () => {
        ensurePadRemoteMapDefaults();
        const mapContainer = document.getElementById('cesiumContainer');
        // Mobile-remote layout should not persist map window mode to shared storage.
        applyMapWindowMode(false, { persist: false });
        if (!mapContainer) return;
        mapContainer.classList.remove(PAD_REMOTE_MOBILE_HIDE_CLASS);
        if (viewer && viewer.scene && viewer.scene.screenSpaceCameraController) {
            viewer.scene.screenSpaceCameraController.enableInputs = true;
        }
    };

    const expandPadRemoteWindow = (panel) => {
        if (!panel) return;
        const gap = 8;
        const targetW = Math.max(320, Math.min(window.innerWidth - (gap * 2), Math.round(window.innerWidth * 0.94)));
        const targetH = Math.max(260, Math.min(window.innerHeight - (gap * 2), Math.round(window.innerHeight * 0.9)));
        panel.style.position = 'fixed';
        panel.style.left = `${gap}px`;
        panel.style.top = `${gap}px`;
        panel.style.width = `${targetW}px`;
        panel.style.height = `${targetH}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.dataset.windowPinned = '1';
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(panel);
        }
    };

    const rhythmToPadRhythmData = (rhythm, fallbackName = '') => {
        const notation = rhythm && rhythm.notationData && Array.isArray(rhythm.notationData.instruments)
            ? rhythm.notationData
            : null;
        if (!notation) return null;
        const payload = ensureCallInstrumentInRhythmData({
            rhythmName: String(rhythm?.name || fallbackName || '').trim(),
            beats: Math.max(1, parseInt(notation.beats, 10) || 4),
            subdivisions: Math.max(1, parseInt(notation.subdivisions, 10) || 4),
            instruments: Array.isArray(notation.instruments) ? notation.instruments : []
        });
        const wrapAfterBeats = parseInt(notation.wrapAfterBeats, 10);
        if (Number.isFinite(wrapAfterBeats) && wrapAfterBeats > 0) {
            payload.wrapAfterBeats = Math.max(1, Math.min(16, wrapAfterBeats));
        }
        if (typeof notation.wrapNotationRows === 'boolean') {
            payload.wrapNotationRows = notation.wrapNotationRows;
        }
        return payload;
    };

    const getCurrentRhythmData = () => {
        if (lockSharedRhythmData && sharedRhythmData && Array.isArray(sharedRhythmData.instruments)) return sharedRhythmData;
        if (latestNotationRhythmData && Array.isArray(latestNotationRhythmData.instruments)) return latestNotationRhythmData;
        if (sharedRhythmData && Array.isArray(sharedRhythmData.instruments)) return sharedRhythmData;
        const fallbackKey = String(
            (isPadRemoteUi() ? (activeRemoteRhythmKey || sharedRhythmKey) : '')
            || selectedRhythm
            || ''
        ).trim();
        if (!fallbackKey || !allRhythms[fallbackKey]) return null;
        return rhythmToPadRhythmData(allRhythms[fallbackKey], activeRemoteRhythmName || sharedRhythmName || '');
    };

    const getAvailableRhythmEntries = () => {
        return Object.entries(allRhythms || {})
            .filter(([key, rhythm]) => key && rhythm && typeof rhythm === 'object')
            .sort((a, b) => String(a[1].name || a[0]).localeCompare(String(b[1].name || b[0])));
    };
    let remoteRhythmRefreshPromise = null;
    const refreshRemoteRhythmsFromSupabase = async () => {
        if (!padRemoteMode) return false;
        const now = Date.now();
        if ((now - lastRemoteRhythmCatalogRefreshAt) < 20000 && Object.keys(allRhythms || {}).length > 0) {
            return true;
        }
        if (remoteRhythmRefreshPromise) return remoteRhythmRefreshPromise;
        remoteRhythmRefreshPromise = (async () => {
            try {
                let fresh = null;
                // Prefer live REST data in remote mode so mobile does not depend on stale local caches.
                if (typeof fetchRhythmsViaREST === 'function') {
                    fresh = await fetchRhythmsViaREST();
                }
                if ((!fresh || Object.keys(fresh).length === 0) && typeof fetchRhythmsFromSupabase === 'function') {
                    fresh = await fetchRhythmsFromSupabase();
                }
                if (!fresh || Object.keys(fresh).length === 0) return false;

                // Use the same canonical rhythm-pipeline as desktop init:
                // assign fetched catalog, normalize media embeds, apply local
                // transcribed overrides, and merge local custom rhythms.
                allRhythms = normalizeRhythmMediaEmbeds(fresh);
                resetDemoRhythmsState();
                await applyLocalTranscribedNotations(allRhythms);
                mergeLocalCustomRhythmsIntoAllRhythms();
                await mergeLibraryRhythms();
                try { syncRhythmCatalogToNotationTargets(); } catch {}
                lastRemoteRhythmCatalogRefreshAt = Date.now();

                const desiredKey = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
                const resolvedKey = desiredKey && allRhythms[desiredKey]
                    ? desiredKey
                    : (findRhythmKeyByName(activeRemoteRhythmName || sharedRhythmName) || Object.keys(allRhythms)[0] || '');
                if (resolvedKey) {
                    activeRemoteRhythmKey = resolvedKey;
                    selectedRhythm = resolvedKey;
                    activeRemoteRhythmName = String(allRhythms[resolvedKey]?.name || resolvedKey).trim();
                    const liveData = rhythmToPadRhythmData(allRhythms[resolvedKey], activeRemoteRhythmName);
                    if (liveData) latestNotationRhythmData = liveData;
                }
                panels.forEach((panel) => {
                    if (!panel || !panel._triggerPadRefs) return;
                    populateRhythmSelect(panel, activeRemoteRhythmKey || selectedRhythm || '');
                    populateInstrumentSelect(panel, panel._triggerPadRefs.instrumentSelect.value || '');
                    renderPadGrid(panel);
                });
                syncPadRemoteMobileRhythmSelector();
                return true;
            } catch {
                return false;
            } finally {
                remoteRhythmRefreshPromise = null;
            }
        })();
        return remoteRhythmRefreshPromise;
    };

    const padToggleIdForPanel = (panel) => `trigger-pad-window-toggle-${panel.dataset.padIndex || panel.id}`;

    const familyRank = (instrument) => {
        const id = String(instrument?.id || '').toLowerCase();
        const type = String(instrument?.type || '').toLowerCase();
        if (id.startsWith('call') || type === 'djembe_solo') return 0;
        if (type.startsWith('djembe')) return 1;
        if (type.startsWith('kenkeni')) return 2;
        if (type.startsWith('sangban')) return 3;
        if (type.startsWith('doundoun')) return 4;
        if (type.startsWith('shekere')) return 5;
        return 9;
    };
    const instrumentIndex = (instrument) => {
        const id = String(instrument?.id || '');
        const match = id.match(/(\d+)$/);
        return match ? parseInt(match[1], 10) : 1;
    };
    const isBellInstrument = (instrument) => String(instrument?.type || '').toLowerCase().includes('_bell');
    const sortPadInstruments = (instruments) => {
        return (Array.isArray(instruments) ? instruments.slice() : []).sort((a, b) => {
            const famDiff = familyRank(a) - familyRank(b);
            if (famDiff !== 0) return famDiff;
            const idxDiff = instrumentIndex(a) - instrumentIndex(b);
            if (idxDiff !== 0) return idxDiff;
            const bellDiff = Number(isBellInstrument(a)) - Number(isBellInstrument(b));
            if (bellDiff !== 0) return bellDiff;
            return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
    };

    const normalizePadInstrument = (instrument, index) => {
        const rawType = String(instrument?.type || 'djembe').trim();
        const isBellType = rawType.endsWith('_bell');
        const baseType = isBellType ? rawType.slice(0, -5) : rawType;
        const rawId = String(instrument?.id || `${rawType}_${index + 1}`).trim();
        const baseId = isBellType ? rawId.replace(/_bell(?=\d*$|$)/i, '') : rawId;
        const rawName = String(instrument?.name || instrument?.id || `Instrument ${index + 1}`).trim();
        const baseName = isBellType ? rawName.replace(/\s*bell$/i, '').trim() : rawName;
        const icon = isBellType ? '🪘' : (instrument?.icon || '🥁');
        return {
            id: baseId || `${baseType}_${index + 1}`,
            name: baseName || `Instrument ${index + 1}`,
            type: baseType || 'djembe',
            icon
        };
    };

    const collapseBellInstruments = (instruments) => {
        const out = [];
        const byId = new Map();
        (Array.isArray(instruments) ? instruments : []).forEach((instrument, index) => {
            const normalized = normalizePadInstrument(instrument, index);
            const key = normalized.id;
            const existing = byId.get(key);
            if (existing) {
                if ((!existing.name || /bell$/i.test(existing.name)) && normalized.name) existing.name = normalized.name;
                if ((!existing.icon || existing.icon === '🔔') && normalized.icon) existing.icon = normalized.icon;
                if ((!existing.type || existing.type.endsWith('_bell')) && normalized.type) existing.type = normalized.type;
                return;
            }
            byId.set(key, normalized);
            out.push(normalized);
        });
        return out;
    };

    const getCurrentInstruments = () => {
        const rhythmData = getCurrentRhythmData();
        const fromNotation = rhythmData && Array.isArray(rhythmData.instruments)
            ? rhythmData.instruments
            : [];
        if (fromNotation.length > 0) {
            const sourceInstruments = isPadRemoteUi()
                ? fromNotation
                : collapseBellInstruments(fromNotation);
            const withoutCall = sourceInstruments.filter((instrument) => {
                const type = String(instrument?.type || '').toLowerCase();
                const id = String(instrument?.id || '').toLowerCase();
                return type !== 'djembe_solo' && !id.startsWith('call');
            });
            return sortPadInstruments(withoutCall);
        }
        return sortPadInstruments(fallbackInstruments);
    };

    const findInstrumentById = (instruments, id) => {
        if (!Array.isArray(instruments) || instruments.length === 0) return null;
        const target = String(id || '').trim();
        if (!target) return instruments[0];
        const direct = instruments.find((instrument) => instrument.id === target);
        if (direct) return direct;
        const bellCollapsed = target.replace(/_bell(?=\d*$|$)/i, '');
        if (bellCollapsed !== target) {
            const merged = instruments.find((instrument) => instrument.id === bellCollapsed);
            if (merged) return merged;
        }
        return instruments[0];
    };

    const getArticulationsForType = (type) => {
        const key = String(type || '').trim();
        if (TRIGGER_PAD_ARTICULATIONS[key]) return TRIGGER_PAD_ARTICULATIONS[key];
        return ['slap', 'tone', 'bass', 'mute'];
    };

    const persistState = () => {
        const next = {};
        panels.forEach((panel) => {
            const refs = panel._triggerPadRefs;
            if (!refs) return;
            const reverb = normalizeTriggerPadReverb(refs.reverbInput ? refs.reverbInput.value : 0.1);
            next[panel.id] = {
                instrumentId: refs.instrumentSelect.value || '',
                reverb,
                controlsCollapsed: panel.classList.contains('pad-controls-collapsed'),
                created: panel.dataset.padCreated === '1'
            };
        });
        state = next;
        writeTriggerPadState(state);
    };

    const updateToggleState = () => {
        const anyVisible = panels.some((panel) => !panel.classList.contains('hidden'));
        toggleBtn.classList.toggle('active', anyVisible);
        panels.forEach((panel) => {
            const topToggle = document.getElementById(padToggleIdForPanel(panel));
            if (!topToggle) return;
            const created = panel.dataset.padCreated === '1';
            topToggle.style.display = created ? '' : 'none';
            topToggle.classList.toggle('active', created && !panel.classList.contains('hidden'));
        });
    };

    const bringToFront = (panel) => {
        if (!panel) return;
        if (typeof window._bringFloatingWindowToFront === 'function') {
            window._bringFloatingWindowToFront(panel);
            return;
        }
        const z = parseInt(panel.style.zIndex, 10);
        panel.style.zIndex = String((Number.isFinite(z) ? z : 2600) + 1);
    };

    const syncPadPlaybackVolumeUi = () => {
        panels.forEach((panel) => {
            const refs = panel && panel._triggerPadRefs;
            if (!refs || !refs.playbackVolumeInput || !refs.playbackVolumeValue) return;
            refs.playbackVolumeInput.value = String(Math.round(padPlaybackVolume * 100) / 100);
            refs.playbackVolumeInput.style.setProperty('--slider-fill', `${Math.round(padPlaybackVolume * 100)}%`);
            refs.playbackVolumeValue.textContent = `${Math.round(padPlaybackVolume * 100)}%`;
        });
    };

    const applyPadPlaybackVolume = (value, options = {}) => {
        const next = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(next)) return;
        padPlaybackVolume = next;
        latestNotationMasterVolume = next;
        if (options.persist !== false) {
            localStorage.setItem('triggerPadPlaybackVolume', String(next));
        }
        syncPadPlaybackVolumeUi();
        const bridge = window._notationBridge;
        if (bridge && typeof bridge.postMain === 'function' && options.broadcast !== false) {
            bridge.postMain({ type: 'setMasterVolume', value: next });
        }
    };

    const getPadRemoteActivePanel = () => {
        const remoteActive = panels.find((panel) => panel.classList.contains('remote-active') && !panel.classList.contains('hidden'));
        if (remoteActive) return remoteActive;
        const createdVisible = panels.find((panel) => panel.dataset.padCreated === '1' && !panel.classList.contains('hidden'));
        if (createdVisible) return createdVisible;
        return panels[0] || null;
    };

    const setPadRemoteMobileView = (viewKey, options = {}) => {
        if (!padRemoteMode) return;
        let requestedView = String(viewKey || 'pads').trim().toLowerCase();
        if (requestedView === 'mapmode') requestedView = 'map';
        if (requestedView === 'title') requestedView = 'journey';
        if (requestedView === 'compact') requestedView = 'notation';
        if (requestedView === 'nav') requestedView = 'map';
        // With the drum circle room behind them, phones only ever show the pads: rhythm loads, session
        // play and saved views must not bring back the old windows over the room.
        if (document.documentElement.classList.contains('rrc-room-pads')) requestedView = 'pads';
        const validView = PAD_REMOTE_MOBILE_VIEWS.some((entry) => entry.key === requestedView) ? requestedView : 'pads';
        ensurePadRemoteMapDefaults();
        padRemoteMobileCurrentView = validView;
        if (options.persist !== false) {
            localStorage.setItem('padRemoteMobileView', validView);
        }
        padRemoteMobileButtons.forEach((btn, key) => {
            btn.classList.toggle('active', key === validView);
        });
        syncPadRemoteMobileRhythmSelector();

        // Hide all mobile-focusable windows first.
        panels.forEach((panel) => {
            setMobilePanelVisibility(panel, false);
            panel.classList.remove('remote-active');
        });
        padRemoteMobilePanelIds.forEach((id) => {
            const panel = document.getElementById(id);
            setMobilePanelVisibility(panel, false);
        });
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }

        const revealPanel = (panel, options = {}) => {
            if (!panel) return;
            const useFocusLayout = options.focusLayout !== false;
            const ensureActive = options.ensureActive === true;
            panel.classList.remove('hidden', 'panel-hidden');
            if (ensureActive) panel.classList.add('active');
            setMobilePanelVisibility(panel, true);
            if (useFocusLayout) {
                applyMobileFocusLayout(panel);
            } else {
                panel.classList.remove(PAD_REMOTE_MOBILE_FOCUS_CLASS);
                clampPanelOnOpen(panel);
            }
            bringToFront(panel);
        };

        if (validView === 'pads') {
            showPadRemoteMapBackdrop();
            const panel = getPadRemoteActivePanel();
            if (panel) {
                panel.dataset.padCreated = '1';
                panel.classList.add('remote-active');
                revealPanel(panel);
                ensurePadRemoteWelcomeGate(panel);
            }
            return;
        }

        if (validView === 'rhythms' || validView === 'journeys') {
            showPadRemoteMapBackdrop();
            const rhythmPanel = document.getElementById('rhythm-panel');
            if (typeof window._setRhythmBrowserTab === 'function') {
                window._setRhythmBrowserTab(validView === 'journeys' ? 'journeys' : 'browse');
            }
            // Mobile rhythm browser defaults to carousel for fast visual scanning.
            if (validView === 'rhythms' && typeof window._setRhythmPanelMode === 'function') {
                window._setRhythmPanelMode('carousel', { saveCurrent: false, restoreTarget: false });
            } else if (validView === 'rhythms') {
                rhythmPanel.classList.add('carousel-mode');
                localStorage.setItem('rhythmPanelViewMode', 'carousel');
                populateRhythmPanel(currentRhythmSource || 'all');
            }
            // Mobile rhythm browser should open near full-screen, but still remain resizable.
            revealPanel(rhythmPanel, { focusLayout: false });
            if (validView === 'rhythms' && rhythmPanel) {
                expandPadRemoteWindow(rhythmPanel);
                clampPanelOnOpen(rhythmPanel);
                bringToFront(rhythmPanel);
            }
            syncPadRemoteMobileRhythmSelector();
            return;
        }

        if (validView === 'map') {
            // Map view is fullscreen backdrop in mobile mode.
            showPadRemoteMapBackdrop();
            if (!mapWindowedMode && windowSelectManualMode) {
                windowSelectManualMode = false;
                localStorage.setItem('windowSelectManualMode', 'false');
                syncWindowSelectModeUi();
            }
            const mapContainer = document.getElementById('cesiumContainer');
            if (mapContainer) {
                mapContainer.classList.remove(PAD_REMOTE_MOBILE_HIDE_CLASS);
                if (viewer && viewer.scene && viewer.scene.screenSpaceCameraController) {
                    viewer.scene.screenSpaceCameraController.enableInputs = true;
                }
            }
            syncPadRemoteMobileToolbarIcons();
            syncPadRemoteMobileRhythmSelector();
            return;
        }

        if (validView === 'nav') {
            revealPanel(document.getElementById('nav-toolbar'), { focusLayout: false });
            return;
        }

        if (validView === 'views') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('views-panel'), { focusLayout: false, ensureActive: true });
            return;
        }

        if (validView === 'stage') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('stage-panel'));
            return;
        }

        if (validView === 'title') {
            revealPanel(document.getElementById('info-banner'), { ensureActive: true });
            return;
        }

        if (validView === 'journey') {
            const titlePanel = document.getElementById('info-banner');
            const mediaPanel = document.getElementById('image-window');
            const contextPanel = document.getElementById('history-box');
            [titlePanel, mediaPanel, contextPanel].forEach((panel) => {
                if (!panel) return;
                panel.classList.remove('hidden', 'panel-hidden');
                panel.classList.add('active');
                setMobilePanelVisibility(panel, true);
            });
            applyMobileJourneyLayout(titlePanel, mediaPanel, contextPanel);
            showPadRemoteJourneyMapWindow();
            bringToFront(titlePanel);
            bringToFront(mediaPanel);
            bringToFront(contextPanel);
            if (notationVisible) {
                applyPadRemoteJourneyNotationOverlay({ ensureJourneyView: false });
            }
            return;
        }

        if (validView === 'media') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('image-window'), { ensureActive: true });
            return;
        }

        if (validView === 'context') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('history-box'), { ensureActive: true });
            return;
        }

        if (validView === 'user') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('auth-panel'));
            return;
        }

        if (validView === 'session') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('session-panel'));
            if (typeof window._rrcRefreshSessionDirectory === 'function') {
                window._rrcRefreshSessionDirectory({ silent: true, announce: false }).catch(() => {});
            }
            return;
        }

        if (validView === 'settings') {
            showPadRemoteMapBackdrop();
            revealPanel(document.getElementById('debug-controls'), { focusLayout: false, ensureActive: true });
            return;
        }

        if (validView === 'notation' || validView === 'compact') {
            showPadRemoteMapBackdrop();
            const notationOverlay = document.getElementById('notation-overlay');
            if (notationOverlay) {
                notationOverlay.classList.remove('hidden', 'panel-hidden');
                notationOverlay.classList.add('active');
            }
            if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
                window._syncNotationWindowVisibilityFromDom();
            }
            revealPanel(notationOverlay);
            const bridge = window._notationBridge;
            if (bridge && typeof bridge.postMain === 'function') {
                bridge.postMain({ type: 'setCompactMode', enabled: validView === 'compact' });
            }
            return;
        }

        if (validView === 'circular') {
            showPadRemoteMapBackdrop();
            const circularOverlay = document.getElementById('notation-circular-overlay');
            if (circularOverlay) {
                circularOverlay.classList.remove('hidden', 'panel-hidden');
                circularOverlay.classList.add('active');
            }
            if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
                window._syncNotationWindowVisibilityFromDom();
            }
            revealPanel(circularOverlay, { focusLayout: false, ensureActive: true });
        }
        syncPadRemoteMobileRhythmSelector();
    };
    window._setPadRemoteMobileView = setPadRemoteMobileView;
    window._getPadRemoteMobileView = () => padRemoteMobileCurrentView;
    window._isPadRemoteMode = () => padRemoteMode;
    window._openPadRemoteJourneyCompactNotation = (options = {}) => applyPadRemoteJourneyNotationOverlay(options);

    const ensurePadRemoteMobileToolbar = () => {
        if (!padRemoteMode) return;
        if (padRemoteMobileToolbar && padRemoteMobileToolbar.isConnected) return;
        let toolbar = document.getElementById('pad-remote-mobile-toolbar');
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.id = 'pad-remote-mobile-toolbar';
            toolbar.setAttribute('role', 'toolbar');
            document.body.appendChild(toolbar);
        }
        toolbar.innerHTML = '';
        padRemoteMobileButtons.clear();
        PAD_REMOTE_MOBILE_VIEWS.forEach((view) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pad-remote-mobile-btn';
            btn.dataset.view = view.key;
            btn.title = getPadRemoteMobileViewTitle(view.key);
            btn.setAttribute('aria-label', view.label);
            btn.textContent = getPadRemoteMobileViewIcon(view.key);
            let holdTimer = null;
            let holdTriggered = false;
            let holdStartX = 0;
            let holdStartY = 0;
            const HOLD_MS = 420;
            const HOLD_MOVE_CANCEL = 14;
            const clearHoldTimer = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
            };
            if (view.key === 'map') {
                const onHold = () => {
                    holdTriggered = true;
                    setPadRemoteMobileView('journey');
                };
                btn.addEventListener('pointerdown', (event) => {
                    holdTriggered = false;
                    holdStartX = Number.isFinite(event.clientX) ? event.clientX : 0;
                    holdStartY = Number.isFinite(event.clientY) ? event.clientY : 0;
                    clearHoldTimer();
                    holdTimer = setTimeout(() => {
                        holdTimer = null;
                        onHold();
                    }, HOLD_MS);
                });
                btn.addEventListener('pointermove', (event) => {
                    if (!holdTimer) return;
                    const x = Number.isFinite(event.clientX) ? event.clientX : holdStartX;
                    const y = Number.isFinite(event.clientY) ? event.clientY : holdStartY;
                    if (Math.abs(x - holdStartX) > HOLD_MOVE_CANCEL || Math.abs(y - holdStartY) > HOLD_MOVE_CANCEL) {
                        clearHoldTimer();
                    }
                });
                btn.addEventListener('pointerup', () => {
                    clearHoldTimer();
                });
                btn.addEventListener('pointercancel', clearHoldTimer);
                btn.addEventListener('pointerleave', clearHoldTimer);
            }
            btn.addEventListener('click', () => {
                if (view.key === 'map' && holdTriggered) {
                    holdTriggered = false;
                    return;
                }
                if (view.key === 'map' && padRemoteMobileCurrentView === 'map') {
                    const nextMode = normalizeMapSceneMode(mapSceneMode) === '2d' ? '3d' : '2d';
                    applyMapSceneMode(nextMode);
                    syncPadRemoteMobileToolbarIcons();
                    return;
                }
                setPadRemoteMobileView(view.key);
            });
            toolbar.appendChild(btn);
            padRemoteMobileButtons.set(view.key, btn);
        });
        padRemoteMobileToolbar = toolbar;
        syncPadRemoteMobileToolbarIcons();
        syncPadRemoteMobileRhythmSelector();
        setPadRemoteMobileView(padRemoteMobileCurrentView || 'pads');
    };

    const updatePadStatus = (panel, message) => {
        if (padRemoteMode) return;
        const refs = panel && panel._triggerPadRefs;
        if (!refs || !refs.statusEl) return;
        refs.statusEl.textContent = message || '';
    };

    const setPadControlsCollapsed = (panel, collapsed, persist = true) => {
        if (!panel) return;
        const next = !!collapsed;
        panel.classList.toggle('pad-controls-collapsed', next);
        const refs = panel._triggerPadRefs;
        if (refs && refs.preview) {
            refs.preview.dataset.compact = next ? '1' : '0';
        }
        queuePadGridLayout(panel);
        if (persist) persistState();
    };

    const togglePadControlsCollapsed = (panel, persist = true) => {
        if (!panel) return;
        setPadControlsCollapsed(panel, !panel.classList.contains('pad-controls-collapsed'), persist);
    };

    const ensurePadQrOverlay = (panel) => {
        if (!panel) return null;
        let overlay = panel.querySelector('.trigger-pad-qr-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'trigger-pad-qr-overlay hidden';
            overlay.dataset.floatingInteractive = 'true';
            overlay.innerHTML = `
                <button type="button" class="trigger-pad-qr-close-btn" title="Close QR">✕</button>
                <div class="trigger-pad-qr-title">Scan On Mobile</div>
                <img class="trigger-pad-qr-image" alt="Pad QR code">
                <a class="trigger-pad-qr-link" href="#" target="_blank" rel="noopener noreferrer"></a>
                <button type="button" class="debug-action-btn trigger-pad-qr-copy-btn">Copy Link</button>
                <div class="trigger-pad-qr-note">Use center for softer hits and edges for harder hits.</div>
            `;
            panel.appendChild(overlay);
        }
        return {
            overlay,
            closeBtn: overlay.querySelector('.trigger-pad-qr-close-btn'),
            imageEl: overlay.querySelector('.trigger-pad-qr-image'),
            linkEl: overlay.querySelector('.trigger-pad-qr-link'),
            copyBtn: overlay.querySelector('.trigger-pad-qr-copy-btn')
        };
    };

    const closePadQrOverlay = (panel) => {
        const overlay = panel?.querySelector('.trigger-pad-qr-overlay');
        if (overlay) overlay.classList.add('hidden');
    };

    const getShareRhythmIdentityForPayload = () => {
        let key = selectedRhythm && allRhythms[selectedRhythm] ? selectedRhythm : '';
        if (!key) {
            const liveRhythmName = String(latestNotationRhythmData?.rhythmName || '').trim();
            key = findRhythmKeyByName(liveRhythmName);
        }
        if (!key) key = sharedRhythmKey || '';
        if (!key && allRhythms.toro) key = 'toro';
        if (!key) key = findRhythmKeyByName('toro');
        const name = key && allRhythms[key]
            ? String(allRhythms[key].name || key).trim()
            : (String(latestNotationRhythmData?.rhythmName || '').trim() || 'Toro');
        return {
            key: String(key || '').trim(),
            name
        };
    };

    const buildPadSharePayload = (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs) return null;
        const rhythmIdentity = getShareRhythmIdentityForPayload();
        return {
            v: 6,
            instrumentId: refs.instrumentSelect.value || '',
            reverb: normalizeTriggerPadReverb(refs.reverbInput ? refs.reverbInput.value : 0.1),
            rk: rhythmIdentity.key || undefined,
            rn: rhythmIdentity.name || undefined
        };
    };

    const buildPadShareUrl = async (panel) => {
        const payload = buildPadSharePayload(panel);
        if (!payload) return '';
        const origin = await resolvePadShareOrigin();
        const sharePath = resolvePadSharePath();
        const params = new URLSearchParams();
        params.set('uv', PAD_REMOTE_UI_VERSION);
        params.set('padRemote', '1');
        if (payload.rk) params.set('rk', String(payload.rk));
        if (payload.rn) params.set('rn', String(payload.rn));
        if (payload.instrumentId) params.set('pi', String(payload.instrumentId));
        params.set('pr', String(normalizeTriggerPadReverb(payload.reverb)));
        return `${origin}${sharePath}?${params.toString()}`;
    };

    // Join link for the room's session sheet. On localhost it uses the network address, like the pad QR.
    window._rrcBuildSessionJoinUrl = async (sessionId = '') => {
        const origin = await resolvePadShareOrigin();
        const url = new URL(resolvePadSharePath(), `${String(origin).replace(/\/+$/, '')}/`);
        if (sessionId) url.searchParams.set('session', String(sessionId));
        return url.toString();
    };
    // Ask again for the network address (after a Cancel, or when the Mac's address changed).
    window._rrcAskLanHost = async () => {
        padShareLanPromptDeclined = false;
        try { localStorage.removeItem(PAD_SHARE_LAN_HOST_STORAGE_KEY); } catch {}
        return resolvePadShareOrigin({ ask: true });
    };

    // Phone pad link for the room's session sheet: same link as the pad QR, for a chosen instrument.
    window._rrcBuildPhonePadUrl = async (instrumentId = '', sessionId = '') => {
        const rhythmIdentity = getShareRhythmIdentityForPayload();
        const origin = await resolvePadShareOrigin();
        const params = new URLSearchParams();
        params.set('uv', PAD_REMOTE_UI_VERSION);
        params.set('padRemote', '1');
        if (rhythmIdentity.key) params.set('rk', String(rhythmIdentity.key));
        if (rhythmIdentity.name) params.set('rn', String(rhythmIdentity.name));
        if (instrumentId) params.set('pi', String(instrumentId));
        if (sessionId) params.set('session', String(sessionId));
        return `${origin}${resolvePadSharePath()}?${params.toString()}`;
    };

    const showPadQrOverlay = async (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs) return;
        const ui = ensurePadQrOverlay(panel);
        if (!ui || !ui.overlay || !ui.imageEl || !ui.linkEl) return;
        const shareUrl = await buildPadShareUrl(panel);
        if (!shareUrl) {
            updatePadStatus(panel, 'Unable to build pad share link');
            return;
        }
        ui.imageEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=12&ecc=L&data=${encodeURIComponent(shareUrl)}`;
        ui.linkEl.href = shareUrl;
        ui.linkEl.textContent = shareUrl;
        ui.overlay.classList.remove('hidden');
        bringToFront(panel);
        updatePadStatus(panel, 'QR ready');

        if (ui.closeBtn && ui.closeBtn.dataset.bound !== '1') {
            ui.closeBtn.dataset.bound = '1';
            ui.closeBtn.addEventListener('click', () => closePadQrOverlay(panel));
        }
        if (ui.copyBtn && ui.copyBtn.dataset.bound !== '1') {
            ui.copyBtn.dataset.bound = '1';
            ui.copyBtn.addEventListener('click', async () => {
                try {
                    updatePadStatus(panel, 'This will be copied to your clipboard.');
                    await navigator.clipboard.writeText(ui.linkEl.href || '');
                    updatePadStatus(panel, 'Copied to clipboard');
                } catch {
                    updatePadStatus(panel, 'Copy failed');
                }
            });
        }
    };
    const showActivePadQrOverlay = () => {
        let target = panels.find((panel) => panel.classList.contains('remote-active') && !panel.classList.contains('hidden'));
        if (!target) {
            target = panels.find((panel) => panel.dataset.padCreated === '1' && !panel.classList.contains('hidden'));
        }
        if (!target) {
            target = panels.find((panel) => panel.dataset.padCreated === '1');
        }
        if (!target) return false;
        if (target.classList.contains('hidden')) {
            showPanel(target, null, true);
        }
        void showPadQrOverlay(target);
        return true;
    };
    window._rrcShowActivePadQr = showActivePadQrOverlay;

    const ensurePadRemoteWelcomeGate = (panel) => {
        if (!padRemoteMode || !panel) return;
        if (panel.dataset.padRemoteUnlocked === '1') return;
        let gate = panel.querySelector('.trigger-pad-remote-welcome');
        if (!gate) {
            gate = document.createElement('div');
            gate.className = 'trigger-pad-remote-welcome hidden';
            gate.dataset.floatingInteractive = 'true';
            gate.innerHTML = `
                <div class="trigger-pad-remote-welcome-title">Welcome</div>
                <div class="trigger-pad-remote-welcome-copy">Preparing low-latency audio. This can take a few seconds on first load.</div>
                <div class="trigger-pad-remote-welcome-status">Loading audio engine...</div>
                <div class="trigger-pad-remote-welcome-progress"><div class="trigger-pad-remote-welcome-progress-fill"></div></div>
                <button type="button" class="trigger-pad-remote-continue-btn" disabled>Loading...</button>
            `;
            panel.appendChild(gate);
        }

        const statusEl = gate.querySelector('.trigger-pad-remote-welcome-status');
        const progressFillEl = gate.querySelector('.trigger-pad-remote-welcome-progress-fill');
        const continueBtn = gate.querySelector('.trigger-pad-remote-continue-btn');
        if (typeof gate._readyForContinue !== 'boolean') gate._readyForContinue = false;
        if (typeof gate._prepPromise === 'undefined') gate._prepPromise = null;
        if (typeof gate._backgroundSyncPromise === 'undefined') gate._backgroundSyncPromise = null;
        if (typeof gate._lastProgressPercent !== 'number') gate._lastProgressPercent = 0;

        const setGateStatus = (text) => {
            if (statusEl) statusEl.textContent = String(text || '').trim();
        };
        const setGateProgress = (percent) => {
            const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
            gate._lastProgressPercent = clamped;
            if (progressFillEl) progressFillEl.style.width = `${clamped}%`;
        };
        const setContinueState = (enabled, label) => {
            if (!continueBtn) return;
            continueBtn.disabled = !enabled;
            continueBtn.textContent = String(label || (enabled ? 'Continue' : 'Loading...')).trim();
        };
        const applyProgressState = (state) => {
            if (!state || typeof state !== 'object') return;
            const total = Math.max(0, Number(state.total) || 0);
            const completed = Math.max(0, Number(state.completed) || 0);
            const failed = Math.max(0, Number(state.failed) || 0);
            const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
            setGateProgress(percent);
            if (state.phase === 'error') {
                setGateStatus('Audio load failed. Tap Retry.');
                return;
            }
            if (total > 0) {
                const okCount = Math.max(0, completed - failed);
                setGateStatus(`Loading audio ${percent}% (${okCount}/${total})`);
            } else if (state.label) {
                setGateStatus(String(state.label));
            }
        };

        const beginBackgroundRhythmSync = () => {
            if (gate._backgroundSyncPromise) return gate._backgroundSyncPromise;
            gate._backgroundSyncPromise = (async () => {
                try {
                    setGateStatus('Syncing rhythm data...');
                    await refreshRemoteRhythmsFromSupabase();
                    const targetKey = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
                    const fallback = targetKey && allRhythms[targetKey] ? targetKey : (Object.keys(allRhythms || {})[0] || '');
                    if (fallback) {
                        await applyGlobalRhythmSelectionFromPad(fallback, panel, {
                            force: true,
                            suppressAutoAudio: true
                        });
                    }
                } catch {
                    // Keep gate usable even if rhythm sync stalls.
                } finally {
                    if (gate.dataset.unlocked !== '1') setGateStatus('Ready. Tap Continue.');
                    gate._backgroundSyncPromise = null;
                }
            })();
            return gate._backgroundSyncPromise;
        };

        const beginRemotePreparation = () => {
            if (gate._readyForContinue) {
                beginBackgroundRhythmSync();
                return Promise.resolve(true);
            }
            if (gate._prepPromise) return gate._prepPromise;
            gate._prepPromise = (async () => {
                try {
                    setGateStatus('Preparing audio context...');
                    setContinueState(false, 'Loading...');
                    setGateProgress(0);
                    preparePadRemoteAudio();
                    warmupPadRemoteAudio();

                    if (typeof MobileAudioEngine !== 'undefined') {
                        try {
                            await MobileAudioEngine.loadSamples({ onProgress: applyProgressState });
                        } catch {}
                        remoteAudioPrepared = !!(MobileAudioEngine.isReady && MobileAudioEngine.isReady());
                    } else {
                        remoteAudioPrepared = true;
                    }
                    if (!remoteAudioPrepared) throw new Error('Audio not ready');

                    gate._readyForContinue = true;
                    setGateProgress(100);
                    setGateStatus('Ready. Tap Continue.');
                    setContinueState(true, 'Continue');
                    beginBackgroundRhythmSync();
                    updatePadStatus(panel, 'Audio ready');
                    return true;
                } catch {
                    gate._readyForContinue = false;
                    setGateStatus('Audio load failed. Tap Retry.');
                    setContinueState(true, 'Retry');
                    updatePadStatus(panel, 'Audio load failed - retry');
                    return false;
                } finally {
                    gate._prepPromise = null;
                }
            })();
            return gate._prepPromise;
        };

        const unlockRemoteWelcome = () => {
            if (gate.dataset.unlocked === '1') return;
            gate.dataset.unlocked = '1';
            remoteWelcomeUnlocked = true;
            panel.dataset.padRemoteUnlocked = '1';
            gate.classList.add('hidden');
            gate.style.pointerEvents = 'none';
            expandPadRemoteWindow(panel);
            setTimeout(() => {
                if (gate && gate.parentElement) gate.parentElement.removeChild(gate);
            }, 0);
            updatePadStatus(panel, 'Audio unlocked - ready');
            ensurePadRemoteMobileToolbar();
            setPadRemoteMobileView(padRemoteMobileCurrentView || 'pads');
        };

        if (continueBtn && continueBtn.dataset.bound !== '1') {
            continueBtn.dataset.bound = '1';
            continueBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!gate._readyForContinue) {
                    void beginRemotePreparation();
                    return;
                }
                unlockRemoteWelcome();
            }, { passive: false });
        }

        if (gate.dataset.bound !== '1') {
            gate.dataset.bound = '1';
            const onGateInteract = (e) => {
                const target = e && e.target instanceof Element ? e.target : null;
                if (target && target.closest('.trigger-pad-remote-continue-btn')) return;
                if (gate._readyForContinue) return;
                void beginRemotePreparation();
            };
            gate.addEventListener('pointerdown', onGateInteract, { passive: true });
            gate.addEventListener('click', onGateInteract);
        }

        if (remoteWelcomeUnlocked) {
            gate.dataset.unlocked = '1';
            panel.dataset.padRemoteUnlocked = '1';
            gate.classList.add('hidden');
            gate.style.pointerEvents = 'none';
            expandPadRemoteWindow(panel);
            return;
        }

        gate.dataset.unlocked = '0';
        gate.classList.remove('hidden');
        if (gate._readyForContinue) {
            setGateProgress(100);
            setGateStatus('Ready. Tap Continue.');
            setContinueState(true, 'Continue');
        } else {
            setGateStatus('Loading audio engine...');
            setContinueState(false, 'Loading...');
            setGateProgress(gate._lastProgressPercent || 0);
        }
        updatePadStatus(panel, 'Preparing audio...');
        void beginRemotePreparation();
    };

    const activatePadRemoteMode = (panel) => {
        if (!padRemoteMode || !panel) return;
        document.documentElement.classList.remove('rrc-padremote-boot');
        preparePadRemoteAudio();
        document.body.classList.add('pad-remote-mode');
        if (document.body.classList.contains('ui-hidden')) {
            uiHidden = false;
            document.body.classList.remove('ui-hidden');
            applyTopPanelButtonLabels();
        }
        ensurePadRemoteMobileToolbar();
        // Mobile remote startup should begin clean: hide all floating windows,
        // then reveal only the active pad (welcome gate handles onboarding).
        document.querySelectorAll('[data-floating-window="true"]').forEach((entry) => {
            if (!(entry instanceof HTMLElement)) return;
            if (entry.id === 'cesiumContainer') return;
            if (entry === panel) return;
            entry.classList.add('hidden', 'panel-hidden');
            entry.classList.remove('active');
        });
        panels.forEach((entry) => {
            entry.classList.remove('remote-active');
            entry.dataset.padRemoteReadonly = '';
        });
        panel.classList.remove('hidden');
        panel.classList.add('remote-active');
        panel.dataset.padRemoteReadonly = '1';
        panel.dataset.padCreated = '1';

        const headerActions = panel.querySelector('.trigger-pad-header-actions');
        if (headerActions) {
            headerActions.style.display = 'flex';
            headerActions.style.visibility = 'visible';
        }

        // Ensure all controls and dropdowns are visible in remote mode
        panel.querySelectorAll('.trigger-pad-controls').forEach((el) => {
            el.style.display = 'flex';
            el.style.visibility = 'visible';
        });
        panel.querySelectorAll('.trigger-pad-rhythm-row').forEach((el) => {
            el.style.display = 'flex';
            el.style.visibility = 'visible';
        });
        panel.querySelectorAll('.trigger-pad-instrument-select, .trigger-pad-rhythm-select').forEach((el) => {
            el.style.display = 'block';
            el.style.visibility = 'visible';
            el.style.pointerEvents = 'auto';
            el.style.opacity = '1';
            el.disabled = false;
            el.removeAttribute('disabled');
            el.removeAttribute('readonly');
        });
        expandPadRemoteWindow(panel);
        // Kick off an early catalog refresh so mobile rhythm selectors are aligned
        // before/while the welcome gate completes audio preparation.
        void refreshRemoteRhythmsFromSupabase();
        if (remoteWelcomeUnlocked) {
            warmupPadRemoteAudio();
        }
        ensurePadRemoteWelcomeGate(panel);
        closePadQrOverlay(panel);
        if (remoteWelcomeUnlocked) {
            setPadRemoteMobileView(padRemoteMobileCurrentView || 'pads');
        }
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };

    const ensureTopToggleForPanel = (panel) => {
        if (!panel || !topUi) return null;
        const id = padToggleIdForPanel(panel);
        let btn = document.getElementById(id);
        if (!btn) {
            btn = document.createElement('button');
            btn.id = id;
            btn.type = 'button';
            btn.className = 'trigger-pad-window-toggle';
            btn.textContent = `🎚️ Pad ${panel.dataset.padIndex || ''}`;
            btn.title = `Show/Hide Trigger Pad ${panel.dataset.padIndex || ''}`;
            if (debugToggle && debugToggle.parentElement === topUi) {
                topUi.insertBefore(btn, debugToggle);
            } else {
                topUi.appendChild(btn);
            }
            btn.addEventListener('click', () => {
                if (panel.classList.contains('hidden')) showPanel(panel, null, true);
                else hidePanel(panel);
            });
            applyTopPanelButtonOrder(getCurrentTopPanelButtonOrder(), false);
        }
        return btn;
    };

    let lastSharedRhythmRequestAt = 0;
    let remoteRhythmLoadRetryTimer = 0;
    let remoteRhythmLoadAttempts = 0;
    let remoteExpectedRhythmName = '';

    const clearRemoteRhythmLoadRetry = () => {
        if (remoteRhythmLoadRetryTimer) {
            clearTimeout(remoteRhythmLoadRetryTimer);
            remoteRhythmLoadRetryTimer = 0;
        }
        remoteRhythmLoadAttempts = 0;
    };

    const scheduleRemoteRhythmLoadRetry = () => {
        if (!remoteRhythmSyncEnabled) return;
        if (remoteRhythmLoadAttempts >= 8) return;
        if (remoteRhythmLoadRetryTimer) return;
        remoteRhythmLoadRetryTimer = setTimeout(() => {
            remoteRhythmLoadRetryTimer = 0;
            requestSharedRhythmFromNotation(true);
        }, 420);
    };

    const requestSharedRhythmFromNotation = (force = false) => {
        if (!remoteRhythmSyncEnabled) return;
        // In a session the leader's rhythm wins over the one in this phone's link; otherwise the phone kept
        // reloading the link's rhythm and fought every rhythm change from the leader.
        const sessionKey = sessionState && sessionState.active ? String(sessionState.rhythmKey || '').trim() : '';
        if (sessionKey && allRhythms[sessionKey] && sessionKey !== activeRemoteRhythmKey) {
            activeRemoteRhythmKey = sessionKey;
            activeRemoteRhythmName = String(allRhythms[sessionKey].name || sessionKey).trim();
            remoteRhythmLoadAttempts = 0;
        }
        const name = String(activeRemoteRhythmName || sharedRhythmName || '').trim();
        if (!name) return;
        const now = Date.now();
        if (!force && (now - lastSharedRhythmRequestAt) < 220) return;
        lastSharedRhythmRequestAt = now;
        const bridge = window._notationBridge;
        if (!bridge) return;
        if (typeof bridge.ensureLoaded === 'function') bridge.ensureLoaded();
        let selectedKey = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
        if (!selectedKey) {
            const fromName = findRhythmKeyByName(name);
            if (fromName) {
                selectedKey = fromName;
                activeRemoteRhythmKey = fromName;
            }
        }
        const rhythm = selectedKey && allRhythms[selectedKey] ? allRhythms[selectedKey] : null;
        const lookupKey = selectedKey;
        const notationPath = String(rhythm?.notationPath || '').trim();

        const liveRhythmData = latestNotationRhythmData && Array.isArray(latestNotationRhythmData.instruments)
            ? latestNotationRhythmData
            : null;
        const dbRhythmData = rhythm?.notationData && Array.isArray(rhythm.notationData.instruments)
            ? rhythm.notationData
            : null;
        const liveRhythmName = String(liveRhythmData?.rhythmName || '').trim().toLowerCase();
        const targetName = String(name || '').trim().toLowerCase();
        const liveMatchesTarget = !!liveRhythmData && !!liveRhythmName && !!targetName && liveRhythmName === targetName;
        const liveCount = Array.isArray(liveRhythmData?.instruments) ? liveRhythmData.instruments.length : 0;
        const dbCount = Array.isArray(dbRhythmData?.instruments) ? dbRhythmData.instruments.length : 0;
        const notationDataToSend = (() => {
            if (dbRhythmData && dbCount > liveCount) return dbRhythmData;
            if (liveMatchesTarget && liveRhythmData) return liveRhythmData;
            if (dbRhythmData) return dbRhythmData;
            return null;
        })();

        remoteExpectedRhythmName = String((rhythm && rhythm.name) || name || '').trim().toLowerCase();
        remoteRhythmLoadAttempts += 1;

        if (notationDataToSend && typeof bridge.postMain === 'function') {
            bridge.postMain({
                type: 'loadRhythm',
                name: String(rhythm.name || name).trim(),
                lookupKey,
                notationPath,
                notationData: notationDataToSend
            });
        } else if (typeof bridge.postMain === 'function') {
            bridge.postMain({
                type: 'loadRhythm',
                name,
                lookupKey,
                notationPath
            });
        } else if (typeof bridge.loadRhythmByName === 'function') {
            bridge.loadRhythmByName(name);
        }
        if (typeof bridge.requestRhythmState === 'function') {
            setTimeout(() => bridge.requestRhythmState(), 90);
            setTimeout(() => bridge.requestRhythmState(), 420);
        }
        if (typeof bridge.requestNotationState === 'function') {
            setTimeout(() => bridge.requestNotationState(), 140);
        }
        scheduleRemoteRhythmLoadRetry();
    };

    const ensureNotationBridgeReady = () => {
        const bridge = window._notationBridge;
        if (!bridge) return;
        if (typeof bridge.ensureLoaded === 'function') bridge.ensureLoaded();
        if (typeof bridge.postMain === 'function') {
            bridge.postMain({ type: 'setMasterVolume', value: padPlaybackVolume });
        }
        if (!lockSharedRhythmData && typeof bridge.requestRhythmState === 'function') bridge.requestRhythmState();
        if (remoteRhythmSyncEnabled) requestSharedRhythmFromNotation();
        triggerPadBridgeEnsured = true;
    };

    const sendTriggerHit = ({ instrumentId, instrumentType, sound, velocity, triggerLane = 0, reverbMix = 0.1 }) => {
        const normalizedVelocity = clampTriggerPadVelocityUnit(velocity);
        const normalizedReverb = normalizeTriggerPadReverb(reverbMix);

        // ═══════════════════════════════════════════════════════════════════════
        // PAD-REMOTE MODE: Use direct mobile audio engine (bypasses iframe issues)
        // ═══════════════════════════════════════════════════════════════════════
        if (padRemoteMode && typeof MobileAudioEngine !== 'undefined') {
            // Warmup on first hit
            if (!triggerPadAudioWarmupSent) {
                triggerPadAudioWarmupSent = true;
                MobileAudioEngine.warmup();
            }
            // Play directly through mobile audio engine
            const played = MobileAudioEngine.playSound(
                instrumentType || 'djembe',
                instrumentId || 'djembe1',
                sound || 'tone',
                normalizedVelocity,
                normalizedReverb
            );
            if (played) return true;
            // Fall through to iframe method if mobile audio not ready
        }

        // ═══════════════════════════════════════════════════════════════════════
        // DESKTOP MODE: Use notation iframe for audio playback
        // ═══════════════════════════════════════════════════════════════════════
        const bridge = window._notationBridge;
        if (!bridge) return false;

        // Ensure notation iframe is loaded before sending any hits
        if (!triggerPadBridgeEnsured && typeof bridge.ensureLoaded === 'function') {
            bridge.ensureLoaded();
            triggerPadBridgeEnsured = true;
        }

        // Warmup audio context on first hit
        if (!triggerPadAudioWarmupSent) {
            triggerPadAudioWarmupSent = true;
            try {
                const mainWindow = typeof bridge.getMainWindow === 'function' ? bridge.getMainWindow() : null;
                if (mainWindow && typeof mainWindow.__rrcWarmupAudio === 'function') {
                    mainWindow.__rrcWarmupAudio();
                } else if (typeof bridge.warmupMainAudio === 'function') {
                    bridge.warmupMainAudio();
                } else if (typeof bridge.postMain === 'function') {
                    bridge.postMain({ type: 'warmupAudio' });
                }
            } catch {}
        }

        const payload = {
            type: 'triggerPadHit',
            instrumentId: instrumentId || '',
            instrumentType: instrumentType || '',
            sound: sound || 'tone',
            velocity: normalizedVelocity,
            triggerLane: triggerLane === 1 ? 1 : 0,
            reverbMix: normalizedReverb
        };

        // Fast path for rapid taps: direct same-origin call avoids message queue overhead.
        const mainWindow = typeof bridge.getMainWindow === 'function' ? bridge.getMainWindow() : null;
        if (mainWindow && typeof mainWindow.__rrcTriggerPadHit === 'function') {
            try {
                mainWindow.__rrcTriggerPadHit(payload);
                return true;
            } catch {}
        }

        if (typeof bridge.isMainReady === 'function' && bridge.isMainReady() !== true) {
            return false;
        }
        if (typeof bridge.postMain !== 'function') return false;
        return bridge.postMain(payload) === true;
    };

    const applyReverbLabel = (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs || !refs.reverbInput || !refs.reverbValue) return;
        const reverb = normalizeTriggerPadReverb(refs.reverbInput.value);
        refs.reverbInput.value = String(reverb);
        refs.reverbValue.textContent = `${Math.round(reverb * 100)}%`;
    };

    const populateInstrumentSelect = (panel, preferredId) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs) return null;
        const instruments = getCurrentInstruments();
        const selected = findInstrumentById(instruments, preferredId || refs.instrumentSelect.value);
        refs.instrumentSelect.innerHTML = '';
        instruments.forEach((instrument) => {
            const option = document.createElement('option');
            option.value = instrument.id;
            option.textContent = `${instrument.icon || '🎵'} ${instrument.name}`;
            refs.instrumentSelect.appendChild(option);
        });
        if (selected) refs.instrumentSelect.value = selected.id;
        return selected || null;
    };

    const populateRhythmSelect = (panel, preferredKey = '') => {
        const refs = panel && panel._triggerPadRefs;
        const select = refs && refs.rhythmSelect;
        if (!select) return '';
        const entries = getAvailableRhythmEntries();
        select.innerHTML = '';
        if (entries.length === 0) {
            const fallback = document.createElement('option');
            fallback.value = '';
            fallback.textContent = String(activeRemoteRhythmName || sharedRhythmName || 'Current Rhythm');
            select.appendChild(fallback);
            select.value = '';
            return '';
        }
        entries.forEach(([key, rhythm]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = String(rhythm?.name || key);
            select.appendChild(option);
        });
        const fallbackKey = entries.length > 0 ? entries[0][0] : '';
        const desired = String(preferredKey || activeRemoteRhythmKey || selectedRhythm || '').trim();
        const selectedKey = entries.some(([key]) => key === desired) ? desired : fallbackKey;
        if (selectedKey) select.value = selectedKey;
        return selectedKey;
    };

    const computeVelocityFromPointer = (button, pointerEvent) => {
        if (!button || !pointerEvent || !Number.isFinite(Number(pointerEvent.clientX))) {
            return (TRIGGER_PAD_VELOCITY_MIN + TRIGGER_PAD_VELOCITY_MAX) * 0.5;
        }
        const rect = button.getBoundingClientRect();
        if (!rect || rect.width <= 1) return (TRIGGER_PAD_VELOCITY_MIN + TRIGGER_PAD_VELOCITY_MAX) * 0.5;
        const x = Number(pointerEvent.clientX);
        const centerX = rect.left + (rect.width * 0.5);
        const halfWidth = Math.max(1, rect.width * 0.5);
        const t = Math.max(0, Math.min(1, Math.abs((x - centerX) / halfWidth)));
        const normalized = Math.max(0, Math.min(1, (t - TRIGGER_PAD_VELOCITY_CENTER_DEADZONE) / (1 - TRIGGER_PAD_VELOCITY_CENTER_DEADZONE)));
        const curved = Math.pow(normalized, TRIGGER_PAD_VELOCITY_CURVE);
        const centerWeighted = 1 - curved;
        return TRIGGER_PAD_VELOCITY_MIN + ((TRIGGER_PAD_VELOCITY_MAX - TRIGGER_PAD_VELOCITY_MIN) * centerWeighted);
    };

    const computeVelocityFromSplitZone = (zone, pointerEvent, lane) => {
        if (!zone || !pointerEvent || !Number.isFinite(Number(pointerEvent.clientX))) {
            return (TRIGGER_PAD_VELOCITY_MIN + TRIGGER_PAD_VELOCITY_MAX) * 0.5;
        }
        const rect = zone.getBoundingClientRect();
        if (!rect || rect.width <= 1) return (TRIGGER_PAD_VELOCITY_MIN + TRIGGER_PAD_VELOCITY_MAX) * 0.5;
        const x = Number(pointerEvent.clientX);
        const t = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        // Outer edge = lower velocity, center split = higher velocity.
        const directional = lane === 0 ? t : (1 - t);
        const curved = Math.pow(Math.max(0, Math.min(1, directional)), TRIGGER_PAD_VELOCITY_CURVE);
        return TRIGGER_PAD_VELOCITY_MIN + ((TRIGGER_PAD_VELOCITY_MAX - TRIGGER_PAD_VELOCITY_MIN) * curved);
    };

    const getRhythmInstrumentById = (rhythmData, instrumentId, instrumentType) => {
        const instruments = Array.isArray(rhythmData?.instruments) ? rhythmData.instruments : [];
        if (instruments.length === 0) return null;
        const targetId = String(instrumentId || '').trim();
        if (targetId) {
            const byId = instruments.find((instrument) => String(instrument?.id || '').trim() === targetId);
            if (byId) return byId;
            const bellCollapsed = targetId.replace(/_bell(?=\d*$|$)/i, '');
            if (bellCollapsed !== targetId) {
                const collapsed = instruments.find((instrument) => String(instrument?.id || '').trim() === bellCollapsed);
                if (collapsed) return collapsed;
            }
        }
        const targetType = String(instrumentType || '').trim();
        if (targetType) {
            const byType = instruments.find((instrument) => String(instrument?.type || '').trim() === targetType);
            if (byType) return byType;
        }
        return instruments[0] || null;
    };

    const resolveBellPartner = (rhythmData, instrument) => {
        if (!instrument) return null;
        const instruments = Array.isArray(rhythmData?.instruments) ? rhythmData.instruments : [];
        if (instruments.length === 0) return null;
        const baseType = String(instrument.type || '').replace(/_bell$/i, '');
        if (!['kenkeni', 'sangban', 'doundoun'].includes(baseType)) return null;
        const baseId = String(instrument.id || '').replace(/_bell(?=\d*$|$)/i, '');
        const index = (baseId.match(/(\d+)$/) || [])[1] || '';
        const candidateId = `${baseType}_bell${index}`;
        const byId = instruments.find((entry) => String(entry?.id || '').trim() === candidateId);
        if (byId) return byId;
        const byType = instruments.find((entry) => String(entry?.type || '').trim() === `${baseType}_bell`);
        return byType || null;
    };

    const getPadBeatColorPalette = () => {
        const source = Array.isArray(latestNotationBeatColors) && latestNotationBeatColors.length > 0
            ? latestNotationBeatColors
            : DEFAULT_BEAT_COLORS;
        return source.map((value) => String(value || '').trim()).filter(Boolean);
    };

    const getPadPlaybackBeatColor = (step, subdivisions) => {
        const safeSubs = Math.max(1, parseInt(subdivisions, 10) || 1);
        const beatIndex = Math.floor((parseInt(step, 10) || 0) / safeSubs);
        const palette = getPadBeatColorPalette();
        return normalizePadHex(palette[beatIndex % Math.max(1, palette.length)] || '#fcd116', '#fcd116');
    };

    const shouldUseCircularToneSymbolForPads = () => {
        if (latestNotationUseNeonArticulationStyle) return true;
        try {
            const saved = JSON.parse(localStorage.getItem('notationDebugSettings') || '{}');
            if (Object.prototype.hasOwnProperty.call(saved, 'useNeonArticulationStyle')) {
                return !!saved.useNeonArticulationStyle;
            }
            return true;
        } catch {
            return true;
        }
    };

    const shouldUseNeonArticulationStyleForPads = () => {
        if (latestNotationUseNeonArticulationStyle) return true;
        try {
            const saved = JSON.parse(localStorage.getItem('notationDebugSettings') || '{}');
            if (Object.prototype.hasOwnProperty.call(saved, 'useNeonArticulationStyle')) {
                return !!saved.useNeonArticulationStyle;
            }
            return true;
        } catch {
            return true;
        }
    };

    const getDefaultWrapAfterBeats = (beats) => {
        const safeBeats = Math.max(1, parseInt(beats, 10) || 1);
        if (safeBeats === 6) return 3;
        if (safeBeats === 8) return 4;
        if (safeBeats === 9) return 3;
        if (safeBeats === 12) return 6;
        if (safeBeats <= 4) return safeBeats;
        return Math.max(4, Math.floor(safeBeats / 2));
    };

    const getPadNotationWrapConfig = (rhythmData = null) => {
        const beats = Math.max(1, parseInt(rhythmData?.beats, 10) || 4);
        const fallback = { enabled: true, beatsPerSegment: getDefaultWrapAfterBeats(beats) };
        const dataWrapRaw = parseInt(rhythmData?.wrapAfterBeats, 10);
        if (Number.isFinite(dataWrapRaw) && dataWrapRaw > 0) {
            return {
                enabled: rhythmData?.wrapNotationRows !== false,
                beatsPerSegment: Math.max(1, Math.min(16, dataWrapRaw))
            };
        }
        try {
            const saved = JSON.parse(localStorage.getItem('notationDebugSettings') || '{}');
            const enabled = typeof saved.wrapNotationRows === 'boolean'
                ? !!saved.wrapNotationRows
                : fallback.enabled;
            const parsed = parseInt(saved.wrapAfterBeats, 10);
            const beatsPerSegment = Number.isFinite(parsed)
                ? Math.max(1, Math.min(16, parsed))
                : fallback.beatsPerSegment;
            return { enabled, beatsPerSegment };
        } catch {
            return fallback;
        }
    };

    const getPadPreviewNotationToken = (sound, useCircularToneSymbol = false) => {
        const key = String(sound || '').trim().toLowerCase();
        if (key === 'tone' || key === 'open') {
            return {
                text: '',
                className: useCircularToneSymbol ? 'tone-circular-symbol' : 'tone',
                useOpenCircle: true,
                circularTone: useCircularToneSymbol
            };
        }
        if (key === 'slap' || key === 'bell') return { text: 'X', className: 'slap', useOpenCircle: false };
        if (key === 'bass') return { text: 'B', className: 'bass', useOpenCircle: false };
        if (key === 'mute') return { text: 'M', className: 'mute', useOpenCircle: false };
        return { text: '·', className: '', useOpenCircle: false, circularTone: false };
    };

    const buildPreviewRows = (panel, instrument) => {
        const rhythmData = getCurrentRhythmData();
        if (!rhythmData || !Array.isArray(rhythmData.instruments)) return [];
        const rhythmInstrument = getRhythmInstrumentById(rhythmData, instrument?.id, instrument?.type);
        if (!rhythmInstrument) return [];
        const rows = [];
        const baseType = String(rhythmInstrument.type || '').replace(/_bell$/i, '');
        const totalSteps = Math.max(1, (parseInt(rhythmData.beats, 10) || 1) * (parseInt(rhythmData.subdivisions, 10) || 1));
        const pattern = Array.isArray(rhythmInstrument.pattern) ? rhythmInstrument.pattern.slice(0, totalSteps) : [];
        while (pattern.length < totalSteps) pattern.push(null);
        rows.push({
            label: String(rhythmInstrument.name || 'Pattern').trim(),
            pattern
        });
        if (['kenkeni', 'sangban', 'doundoun'].includes(baseType)) {
            const bellPartner = resolveBellPartner(rhythmData, rhythmInstrument);
            if (bellPartner) {
                const bellPattern = Array.isArray(bellPartner.pattern) ? bellPartner.pattern.slice(0, totalSteps) : [];
                while (bellPattern.length < totalSteps) bellPattern.push(null);
                rows.push({
                    label: String(bellPartner.name || 'Bell').trim(),
                    pattern: bellPattern
                });
            }
        }
        return rows;
    };

    const renderPadNotationPreview = (panel, instrument) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs || !refs.preview) return;
        const rhythmData = getCurrentRhythmData();
        if (!rhythmData || !Array.isArray(rhythmData.instruments)) {
            refs.preview.innerHTML = '<div class="trigger-pad-preview-empty">Load notation to show pattern</div>';
            return;
        }
        const beats = Math.max(1, parseInt(rhythmData.beats, 10) || 1);
        const subdivisions = Math.max(1, parseInt(rhythmData.subdivisions, 10) || 1);
        const totalSteps = beats * subdivisions;
        const rows = buildPreviewRows(panel, instrument);
        const useCircularToneSymbol = shouldUseCircularToneSymbolForPads();
        const useNeonArticulationStyle = shouldUseNeonArticulationStyleForPads();
        const wrapConfig = getPadNotationWrapConfig(rhythmData);
        const shouldWrapRows = !!wrapConfig.enabled && beats > Math.max(1, wrapConfig.beatsPerSegment);
        const beatsPerSegment = shouldWrapRows ? Math.max(1, Math.min(beats, wrapConfig.beatsPerSegment)) : beats;
        const stepSegments = [];
        for (let beatStart = 0; beatStart < beats; beatStart += beatsPerSegment) {
            const beatCount = Math.max(1, Math.min(beatsPerSegment, beats - beatStart));
            const stepStart = beatStart * subdivisions;
            const stepCount = beatCount * subdivisions;
            stepSegments.push({
                beatStart,
                beatCount,
                stepStart,
                stepCount
            });
        }
        if (rows.length === 0) {
            refs.preview.innerHTML = '<div class="trigger-pad-preview-empty">No pattern for instrument</div>';
            return;
        }

        refs.preview.innerHTML = '';
        refs.preview.classList.toggle('use-neon-articulation-style', !!useNeonArticulationStyle);
        const hud = document.createElement('div');
        hud.className = 'trigger-pad-preview-hud';
        hud.innerHTML = `
            <span class="trigger-pad-preview-hud-tempo">Tempo: ${Math.max(40, Math.min(240, parseInt(latestNotationPlaybackTempo, 10) || 100))} BPM</span>
            <span class="trigger-pad-preview-hud-beat">Beat: 1.1</span>
        `;
        refs.preview.appendChild(hud);

        const beatStrip = document.createElement('div');
        beatStrip.className = 'trigger-pad-preview-beat-strip';
        const beatStripWrap = document.createElement('div');
        beatStripWrap.className = 'trigger-pad-preview-beat-strip-wrap';
        if (stepSegments.length > 1) beatStripWrap.classList.add('wrapped');
        const beatMarkers = [];
        const beatArrows = [];
        const beatTracks = [];
        const beatSegments = [];
        let markerOffset = 0;
        stepSegments.forEach((segment, segmentIndex) => {
            const beatTrack = document.createElement('div');
            beatTrack.className = 'trigger-pad-preview-beat-track';
            if (stepSegments.length > 1) beatTrack.classList.add('wrapped-segment');
            beatTrack.dataset.segment = String(segmentIndex);
            beatTrack.style.gridTemplateColumns = `repeat(${Math.max(1, segment.beatCount)}, minmax(0, 1fr))`;
            const segmentMarkers = [];
            for (let relBeat = 0; relBeat < segment.beatCount; relBeat += 1) {
                const beatIdx = segment.beatStart + relBeat;
                const marker = document.createElement('span');
                marker.className = 'trigger-pad-preview-beat-number';
                marker.dataset.beat = String(beatIdx + 1);
                marker.textContent = String(beatIdx + 1);
                beatTrack.appendChild(marker);
                beatMarkers.push(marker);
                segmentMarkers.push(marker);
            }
            const beatArrow = document.createElement('span');
            beatArrow.className = 'trigger-pad-preview-beat-arrow';
            beatArrow.classList.add(segmentIndex === 0 ? 'main-row-arrow' : 'wrapped-row-arrow');
            beatArrow.textContent = '▼';
            beatTrack.appendChild(beatArrow);
            beatArrows.push(beatArrow);
            beatTracks.push(beatTrack);
            beatSegments.push({
                beatStart: segment.beatStart,
                beatCount: segment.beatCount,
                markerStart: markerOffset,
                markerEnd: markerOffset + segment.beatCount - 1,
                markers: segmentMarkers,
                arrow: beatArrow,
                track: beatTrack
            });
            markerOffset += segment.beatCount;
            beatStripWrap.appendChild(beatTrack);
        });
        beatStrip.appendChild(beatStripWrap);
        refs.preview.appendChild(beatStrip);

        rows.forEach((rowData) => {
            const row = document.createElement('div');
            row.className = 'trigger-pad-preview-row';
            row.dataset.floatingInteractive = 'true';

            const label = document.createElement('div');
            label.className = 'trigger-pad-preview-label';
            label.textContent = rowData.label;
            row.appendChild(label);

            const stepsWrap = document.createElement('div');
            stepsWrap.className = 'trigger-pad-preview-steps-wrap';
            if (stepSegments.length > 1) stepsWrap.classList.add('wrapped');

            stepSegments.forEach((segment, segmentIndex) => {
                const steps = document.createElement('div');
                steps.className = 'trigger-pad-preview-steps';
                if (stepSegments.length > 1) steps.classList.add('wrapped-segment');
                steps.dataset.columns = String(segment.stepCount);
                steps.dataset.segment = String(segmentIndex);
                steps.dataset.segmentStartStep = String(segment.stepStart);

                const templateColumns = [];
                const dividerCount = Math.max(0, segment.beatCount - 1);
                const stepWidthExpr = `minmax(0, calc((100% - (${dividerCount} * var(--pad-beat-divider-slot, 4px))) / ${segment.stepCount}))`;
                for (let relStep = 0; relStep < segment.stepCount; relStep++) {
                    templateColumns.push(stepWidthExpr);
                    const isBeatEnd = ((relStep + 1) % subdivisions === 0);
                    const hasNextStep = (relStep + 1) < segment.stepCount;
                    if (isBeatEnd && hasNextStep) templateColumns.push('var(--pad-beat-divider-slot, 4px)');
                }
                steps.style.gridTemplateColumns = templateColumns.join(' ');

                for (let relStep = 0; relStep < segment.stepCount; relStep++) {
                    const stepIdx = segment.stepStart + relStep;
                    const sound = rowData.pattern[stepIdx];
                    const cell = document.createElement('span');
                    const normalizedSound = String(sound || '').trim().toLowerCase();
                    const token = getPadPreviewNotationToken(normalizedSound, useCircularToneSymbol);
                    cell.className = 'trigger-pad-preview-step';
                    cell.dataset.step = String(stepIdx);
                    if (stepIdx % subdivisions === 0) {
                        const beatColors = getPadBeatColorPalette();
                        const beatIndex = Math.floor(stepIdx / Math.max(1, subdivisions));
                        const beatColor = beatColors[beatIndex % beatColors.length] || '#fcd116';
                        cell.classList.add('beat-start-indicator');
                        cell.style.setProperty('--pad-beat-indicator-color', beatColor);
                    }
                    if (normalizedSound && normalizedSound !== 'silence') {
                        cell.classList.add('active');
                        if (token.className) cell.classList.add(token.className);
                    }
                    if (token.useOpenCircle) {
                        const ring = document.createElement('span');
                        ring.className = 'trigger-pad-preview-open-circle';
                        if (token.circularTone) ring.classList.add('circular-tone');
                        cell.appendChild(ring);
                    } else {
                        cell.textContent = token.text;
                    }
                    steps.appendChild(cell);
                    const isBeatEnd = ((relStep + 1) % subdivisions === 0);
                    const hasNextStep = (relStep + 1) < segment.stepCount;
                    if (isBeatEnd && hasNextStep) {
                        const divider = document.createElement('span');
                        divider.className = 'trigger-pad-preview-divider';
                        divider.textContent = '|';
                        steps.appendChild(divider);
                    }
                }
                stepsWrap.appendChild(steps);
            });
            row.appendChild(stepsWrap);
            refs.preview.appendChild(row);
        });
        const tempoEl = refs.preview.querySelector('.trigger-pad-preview-hud-tempo');
        const beatEl = refs.preview.querySelector('.trigger-pad-preview-hud-beat');
        const pointerTrackEl = refs.preview.querySelector('.trigger-pad-preview-pointer-track');
        const pointerEl = refs.preview.querySelector('.trigger-pad-preview-pointer');
        const firstSteps = refs.preview.querySelector('.trigger-pad-preview-row .trigger-pad-preview-steps');
        const stepCellsByStep = new Map();
        refs.preview.querySelectorAll('.trigger-pad-preview-step').forEach((cell) => {
            const key = parseInt(cell.dataset.step, 10);
            if (!Number.isFinite(key)) return;
            if (!stepCellsByStep.has(key)) stepCellsByStep.set(key, []);
            stepCellsByStep.get(key).push(cell);
        });
        refs.previewCache = {
            tempoEl,
            beatEl,
            beatMarkers,
            beatArrows,
            beatTracks,
            beatStripWrap,
            beatSegments,
            firstSteps,
            stepCellsByStep,
            currentPlayheadStep: null,
            activeSegmentIndex: -1,
            segmentArrowState: beatSegments.map(() => ({ phaseKey: '' })),
            lastVisualSignature: '',
            gridMetricsReady: false,
            lastPreviewWidth: 0
        };
        applyPadPlaybackPreviewState(panel);
    };

    const padPlaybackState = {
        playing: !!latestNotationPlaybackPlaying,
        step: parseInt(latestNotationPlaybackStep, 10) || 0,
        stepEpoch: parseInt(latestNotationPlaybackStepEpoch, 10) || 0,
        tempo: Math.max(40, Math.min(240, parseInt(latestNotationPlaybackTempo, 10) || 100)),
        beatColor: normalizePadHex(latestNotationPlaybackBeatColor || DEFAULT_BEAT_COLORS[0], DEFAULT_BEAT_COLORS[0])
    };

    function applyPadPlaybackPreviewState(panel, incoming = null) {
        if (!panel || !panel._triggerPadRefs || !panel._triggerPadRefs.preview) return;
        const refs = panel._triggerPadRefs;
        const preview = refs.preview;
        const rhythmData = getCurrentRhythmData();
        if (!rhythmData) return;
        const beats = Math.max(1, parseInt(rhythmData.beats, 10) || 1);
        const subdivisions = Math.max(1, parseInt(rhythmData.subdivisions, 10) || 1);
        const totalSteps = Math.max(1, beats * subdivisions);

        if (incoming && typeof incoming === 'object') {
            if (Number.isFinite(Number(incoming.step))) padPlaybackState.step = parseInt(incoming.step, 10) || 0;
            if (Number.isFinite(Number(incoming.tempo))) padPlaybackState.tempo = Math.max(40, Math.min(240, parseInt(incoming.tempo, 10) || 100));
            if (typeof incoming.playing === 'boolean') padPlaybackState.playing = incoming.playing;
            if (Number.isFinite(Number(incoming.stepEpoch))) padPlaybackState.stepEpoch = parseInt(incoming.stepEpoch, 10) || 0;
            padPlaybackState.stepDurationMs = Number(incoming.stepDurationMs) > 0 ? Number(incoming.stepDurationMs) : 0;
            if (typeof incoming.beatColor === 'string' && incoming.beatColor.trim()) {
                padPlaybackState.beatColor = normalizePadHex(incoming.beatColor, DEFAULT_BEAT_COLORS[0]);
            }
        }

        const step = ((padPlaybackState.step % totalSteps) + totalSteps) % totalSteps;
        const beat = Math.floor(step / subdivisions) + 1;
        const sub = (step % subdivisions) + 1;
        const beatColor = normalizePadHex(
            (incoming && typeof incoming.beatColor === 'string' && incoming.beatColor.trim())
                ? incoming.beatColor
                : getPadPlaybackBeatColor(step, subdivisions),
            '#fcd116'
        );
        padPlaybackState.beatColor = beatColor;
        preview.style.setProperty('--pad-preview-accent', beatColor);

        const cache = refs.previewCache || {};
        const visualSignature = `${padPlaybackState.playing ? 1 : 0}|${step}|${padPlaybackState.tempo}|${beatColor}|${totalSteps}|${sub}`;
        if (cache.lastVisualSignature === visualSignature) return;
        const tempoEl = cache.tempoEl || preview.querySelector('.trigger-pad-preview-hud-tempo');
        if (tempoEl) tempoEl.textContent = `Tempo: ${padPlaybackState.tempo} BPM`;
        const beatEl = cache.beatEl || preview.querySelector('.trigger-pad-preview-hud-beat');
        if (beatEl) beatEl.textContent = `Beat: ${beat}.${sub}`;
        const firstSteps = cache.firstSteps || preview.querySelector('.trigger-pad-preview-row .trigger-pad-preview-steps');
        const previewWidth = Math.max(0, preview.clientWidth || 0);
        if (firstSteps && (
            !cache.gridMetricsReady ||
            Math.abs((cache.lastPreviewWidth || 0) - previewWidth) > 1
        )) {
            const alignedWidth = Math.max(0, firstSteps.clientWidth || 0);
            const alignedOffset = Math.max(0, firstSteps.offsetLeft || 0);
            preview.style.setProperty('--pad-preview-grid-offset', `${alignedOffset}px`);
            preview.style.setProperty('--pad-preview-grid-width', `${alignedWidth}px`);
            if (refs.previewCache) {
                refs.previewCache.gridMetricsReady = true;
                refs.previewCache.lastPreviewWidth = previewWidth;
            }
        } else if (!firstSteps) {
            if (!cache.gridMetricsReady) {
                preview.style.setProperty('--pad-preview-grid-offset', '0px');
                preview.style.setProperty('--pad-preview-grid-width', '100%');
            }
            if (refs.previewCache) {
                refs.previewCache.gridMetricsReady = true;
                refs.previewCache.lastPreviewWidth = previewWidth;
            }
        }

        const beatMarkers = Array.isArray(cache.beatMarkers) ? cache.beatMarkers : [];
        const beatSegments = Array.isArray(cache.beatSegments) ? cache.beatSegments : [];
        const beatArrows = Array.isArray(cache.beatArrows) ? cache.beatArrows : [];
        const beatStripWrap = cache.beatStripWrap || preview.querySelector('.trigger-pad-preview-beat-strip-wrap');
        if (refs.previewCache && !refs.previewCache.beatStripWrap && beatStripWrap) refs.previewCache.beatStripWrap = beatStripWrap;
        const currentBeatIndex = Math.max(0, Math.min(beats - 1, Math.floor(step / Math.max(1, subdivisions))));
        beatMarkers.forEach((marker, idx) => marker.classList.toggle('current-beat', idx === currentBeatIndex));
        const activeSegmentIndex = beatSegments.findIndex((segment) => (
            currentBeatIndex >= segment.beatStart &&
            currentBeatIndex < (segment.beatStart + segment.beatCount)
        ));
        const activeSegment = activeSegmentIndex >= 0 ? beatSegments[activeSegmentIndex] : null;
        const segmentArrowState = Array.isArray(cache.segmentArrowState) ? cache.segmentArrowState : [];
        while (segmentArrowState.length < beatSegments.length) segmentArrowState.push({ phaseKey: '' });
        beatArrows.forEach((arrow, idx) => {
            if (!arrow) return;
            const isActive = idx === activeSegmentIndex && !!activeSegment && activeSegment.arrow === arrow;
            arrow.style.opacity = isActive ? (padPlaybackState.playing ? '1' : '0.6') : '0';
            if (!isActive) {
                arrow.classList.remove('arc-hop');
                arrow.style.transition = 'none';
                arrow.style.left = '50%';
                if (segmentArrowState[idx]) segmentArrowState[idx].phaseKey = '';
            }
        });
        if (activeSegment && activeSegment.arrow) {
            const beatArrow = activeSegment.arrow;
            const segmentStart = activeSegment.beatStart;
            const segmentCount = Math.max(1, activeSegment.beatCount || 1);
            const localBeatIndex = Math.max(0, Math.min(segmentCount - 1, currentBeatIndex - segmentStart));
            const segmentState = segmentArrowState[activeSegmentIndex] || { phaseKey: '' };
            segmentArrowState[activeSegmentIndex] = segmentState;
            const beatToRatio = (localIndex) => {
                const idx = Math.max(0, Math.min(segmentCount - 1, localIndex));
                return ((idx + 0.5) / Math.max(1, segmentCount));
            };
            const findSegmentIndexByBeatIndex = (beatIndex) => beatSegments.findIndex((segment) => (
                beatIndex >= segment.beatStart &&
                beatIndex < (segment.beatStart + segment.beatCount)
            ));
            const currentRatio = Math.max(0, Math.min(1, beatToRatio(localBeatIndex)));
            if (!padPlaybackState.playing) {
                beatArrow.classList.remove('arc-hop');
                beatArrow.style.transition = 'none';
                beatArrow.style.left = `${currentRatio * 100}%`;
                segmentState.phaseKey = '';
                if (refs.previewCache) {
                    refs.previewCache.activeSegmentIndex = activeSegmentIndex;
                }
            } else {
                const nextBeatIndex = (currentBeatIndex + 1) % beats;
                const nextSegmentIndex = findSegmentIndexByBeatIndex(nextBeatIndex);
                const nextInSameSegment = nextSegmentIndex === activeSegmentIndex;
                const nextLocalBeat = nextInSameSegment
                    ? Math.max(0, Math.min(segmentCount - 1, nextBeatIndex - segmentStart))
                    : localBeatIndex;
                const nextRatio = Math.max(0, Math.min(1, beatToRatio(nextLocalBeat)));
                const tempo = Math.max(40, Math.min(240, Number(padPlaybackState.tempo) || 100));
                // Time left until the next step is heard (swing included), so the glide lands on it.
                const knownStepMs = padPlaybackState.stepDurationMs > 0
                    ? padPlaybackState.stepDurationMs - Math.max(0, Date.now() - (padPlaybackState.stepEpoch || Date.now()))
                    : 0;
                const stepDurationMs = Math.max(24, knownStepMs > 0 ? knownStepMs : 60000 / (tempo * Math.max(1, subdivisions)));
                const beatDurationMs = Math.max(50, 60000 / Math.max(1, tempo));
                const isPreBeatSnapPhase = sub >= subdivisions;
                const phaseKey = `${currentBeatIndex}:${sub}:${tempo}:${subdivisions}:${segmentStart}:${padBeatArrowArcEnabled ? 1 : 0}`;
                const mustApplyPhase = segmentState.phaseKey !== phaseKey;
                if (mustApplyPhase) {
                    if (!nextInSameSegment) {
                        beatArrow.classList.remove('arc-hop');
                        beatArrow.style.transition = 'none';
                        beatArrow.style.left = `${currentRatio * 100}%`;
                    } else if (padBeatArrowArcEnabled) {
                        beatArrow.classList.remove('arc-hop');
                        beatArrow.style.transition = 'none';
                        beatArrow.style.left = `${currentRatio * 100}%`;
                        void beatArrow.offsetWidth;
                        beatArrow.style.transition = `left ${beatDurationMs}ms cubic-bezier(0.26, 0.72, 0.28, 1), opacity 120ms ease`;
                        beatArrow.style.setProperty('--pad-beat-arrow-arc-duration', `${beatDurationMs}ms`);
                        beatArrow.classList.add('arc-hop');
                        beatArrow.style.left = `${nextRatio * 100}%`;
                    } else if (!isPreBeatSnapPhase) {
                        beatArrow.classList.remove('arc-hop');
                        beatArrow.style.transition = 'none';
                        beatArrow.style.left = `${currentRatio * 100}%`;
                    } else {
                        beatArrow.classList.remove('arc-hop');
                        beatArrow.style.transition = 'none';
                        beatArrow.style.left = `${currentRatio * 100}%`;
                        void beatArrow.offsetWidth;
                        beatArrow.style.transition = `left ${stepDurationMs}ms cubic-bezier(0.2, 1.25, 0.3, 1), opacity 120ms ease`;
                        beatArrow.style.left = `${nextRatio * 100}%`;
                    }
                    segmentState.phaseKey = phaseKey;
                    if (refs.previewCache) {
                        refs.previewCache.activeSegmentIndex = activeSegmentIndex;
                        refs.previewCache.segmentArrowState = segmentArrowState;
                    }
                }
            }
        }

        const stepCellsByStep = cache.stepCellsByStep || null;
        const prevStep = Number.isFinite(Number(cache.currentPlayheadStep)) ? Number(cache.currentPlayheadStep) : null;
        if (prevStep !== null && prevStep !== step) {
            const prevCells = stepCellsByStep && stepCellsByStep.get(prevStep)
                ? stepCellsByStep.get(prevStep)
                : preview.querySelectorAll(`.trigger-pad-preview-step[data-step="${prevStep}"]`);
            (prevCells || []).forEach((cell) => cell.classList.remove('playhead'));
        }
        if (!padPlaybackState.playing) {
            if (prevStep !== null) {
                const prevCells = stepCellsByStep && stepCellsByStep.get(prevStep)
                    ? stepCellsByStep.get(prevStep)
                    : preview.querySelectorAll(`.trigger-pad-preview-step[data-step="${prevStep}"]`);
                (prevCells || []).forEach((cell) => cell.classList.remove('playhead'));
            }
                if (refs.previewCache) refs.previewCache.currentPlayheadStep = null;
        } else {
            const nextCells = stepCellsByStep && stepCellsByStep.get(step)
                ? stepCellsByStep.get(step)
                : preview.querySelectorAll(`.trigger-pad-preview-step[data-step="${step}"]`);
            (nextCells || []).forEach((cell) => cell.classList.add('playhead'));
            if (refs.previewCache) refs.previewCache.currentPlayheadStep = step;
        }
        if (refs.previewCache) {
            refs.previewCache.lastVisualSignature = visualSignature;
            refs.previewCache.segmentArrowState = segmentArrowState;
            refs.previewCache.activeSegmentIndex = activeSegmentIndex;
        }
    }

    let padPreviewRefreshRaf = 0;
    let pendingPadPreviewIncoming = null;
    function requestPadPreviewRefresh(incoming = null) {
        if (incoming && typeof incoming === 'object') {
            pendingPadPreviewIncoming = incoming;
        }
        if (padPreviewRefreshRaf) return;
        padPreviewRefreshRaf = requestAnimationFrame(() => {
            padPreviewRefreshRaf = 0;
            const payload = pendingPadPreviewIncoming;
            pendingPadPreviewIncoming = null;
            refreshAllPadPlaybackPreview(payload);
        });
    }
    window._requestPadPreviewRefresh = requestPadPreviewRefresh;

    function refreshAllPadPlaybackPreview(incoming = null) {
        let hasVisiblePanel = false;
        panels.forEach((panel) => {
            if (!panel || panel.classList.contains('hidden')) return;
            hasVisiblePanel = true;
            applyPadPlaybackPreviewState(panel, incoming);
        });
        if (!hasVisiblePanel) {
            panels.forEach((panel) => applyPadPlaybackPreviewState(panel, incoming));
        }
    }

    const ensurePadNotationVerticalSpace = (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!panel || !refs || !refs.preview) return;
        const indicatorSpace = Math.max(0, padBeatIndicatorHeight + padBeatIndicatorOffset + 2);
        refs.preview.style.setProperty('--pad-beat-indicator-space', indicatorSpace + 'px');

        const BASE_MIN_HEIGHT = 214;
        const targetMinHeight = BASE_MIN_HEIGHT + indicatorSpace;
        panel.style.minHeight = `${targetMinHeight}px`;
        panel.setAttribute('data-window-min-h', String(Math.round(targetMinHeight)));

        const rect = panel.getBoundingClientRect();
        if (rect.height > 0 && rect.height < targetMinHeight) {
            panel.style.height = `${Math.round(targetMinHeight)}px`;
            if (typeof window._updateFloatingWindowScale === 'function') {
                window._updateFloatingWindowScale(panel);
            }
        }
    };

    // Used by the room view so strokes played on a 3D instrument take the same path as pad strokes.
    window._rrcSendTriggerHit = (hit) => sendTriggerHit(hit);
    const triggerPadHit = (panel, sound, pointerEvent, button, explicitLane = null, velocityMode = 'center') => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs) return;
        const instruments = getCurrentInstruments();
        const instrument = findInstrumentById(instruments, refs.instrumentSelect.value);
        if (!instrument) {
            updatePadStatus(panel, 'No instrument available');
            return;
        }
        const forcedLane = (explicitLane === 0 || explicitLane === 1) ? explicitLane : null;
        const outputVelocity = clampTriggerPadVelocityUnit(computeVelocityFromPointer(button, pointerEvent));
        const resolvedVelocity = velocityMode === 'split' && forcedLane !== null
            ? clampTriggerPadVelocityUnit(computeVelocityFromSplitZone(button, pointerEvent, forcedLane))
            : outputVelocity;
        const reverbMix = normalizeTriggerPadReverb(refs.reverbInput ? refs.reverbInput.value : 0.1);
        if (forcedLane !== null) refs._triggerLane = forcedLane;
        else refs._triggerLane = refs._triggerLane === 1 ? 0 : 1;
        const ok = sendTriggerHit({
            instrumentId: instrument.id,
            instrumentType: instrument.type,
            sound,
            velocity: resolvedVelocity,
            triggerLane: forcedLane !== null ? forcedLane : refs._triggerLane,
            reverbMix
        });
        if (ok) {
            if (!isPadRemoteUi()) {
                const now = performance.now();
                if (!panel._triggerPadLastStatusAt || (now - panel._triggerPadLastStatusAt) >= 120) {
                    panel._triggerPadLastStatusAt = now;
                    updatePadStatus(panel, `Triggered ${instrument.name}: ${sound} (${Math.round(resolvedVelocity * 100)}%)`);
                }
            }
        } else {
            if (padRemoteMode) {
                updatePadStatus(panel, 'Loading audio samples...');
            } else {
                updatePadStatus(panel, 'Notation engine not ready');
            }
        }
    };

    const layoutPadGrid = (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs || !refs.grid) return;
        const pairs = refs.grid.querySelectorAll('.trigger-pad-hit-pair');
        const buttons = refs.grid.querySelectorAll('.trigger-pad-hit');
        const count = pairs.length > 0 ? pairs.length : buttons.length;
        if (count === 0) return;

        const cols = (refs.grid.classList.contains('djembe-stack') || refs.grid.classList.contains('single-articulation')) ? 1 : 2;
        const rows = Math.max(1, Math.ceil(count / cols));
        refs.grid.style.setProperty('--pad-grid-cols', String(cols));
        refs.grid.style.setProperty('--pad-grid-rows', String(rows));

        const rect = refs.grid.getBoundingClientRect();
        if (!rect || rect.width < 8 || rect.height < 8) return;
        const gridStyle = window.getComputedStyle(refs.grid);
        const gapX = parseFloat(gridStyle.columnGap || gridStyle.gap || '0') || 0;
        const gapY = parseFloat(gridStyle.rowGap || gridStyle.gap || '0') || 0;
        const availableW = Math.max(8, rect.width - (gapX * (cols - 1)));
        const availableH = Math.max(8, rect.height - (gapY * (rows - 1)));
        const cellW = Math.max(10, availableW / cols);
        const cellH = Math.max(10, availableH / rows);
        let sizeRef = Math.min(cellW, cellH);
        const sampleButton = refs.grid.querySelector('.trigger-pad-hit');
        if (sampleButton) {
            const bRect = sampleButton.getBoundingClientRect();
            if (bRect && bRect.width > 2 && bRect.height > 2) {
                sizeRef = Math.min(bRect.width, bRect.height);
            }
        }
        refs.grid.style.setProperty('--pad-hit-font-size', `${Math.max(8, Math.min(22, sizeRef * 0.24)).toFixed(1)}px`);
        refs.grid.style.setProperty('--pad-hit-emoji-size', `${Math.max(10, Math.min(24, sizeRef * 0.30)).toFixed(1)}px`);

        if (refs.preview) {
            const previewRows = refs.preview.querySelectorAll('.trigger-pad-preview-steps');
            if (previewRows.length > 0) {
                const previewRect = refs.preview.getBoundingClientRect();
                const columns = Math.max(1, parseInt(previewRows[0].dataset.columns || '1', 10) || 1);
                const usableH = Math.max(10, previewRect.height / previewRows.length);
                const usableW = Math.max(10, previewRect.width / columns);
                const previewSize = Math.min(usableH, usableW);
                refs.preview.style.setProperty('--pad-preview-font-size', `${Math.max(7, Math.min(16, previewSize * 0.58)).toFixed(1)}px`);
            }
            // Keep playback pointer locked to the notation grid area during resizes.
            applyPadPlaybackPreviewState(panel);
        }
    };

    const queuePadGridLayout = (panel) => {
        if (!panel || !panel._triggerPadRefs) return;
        if (panel._triggerPadLayoutRaf) return;
        panel._triggerPadLayoutRaf = requestAnimationFrame(() => {
            panel._triggerPadLayoutRaf = 0;
            layoutPadGrid(panel);
        });
    };

    const renderPadGrid = (panel) => {
        const refs = panel && panel._triggerPadRefs;
        if (!refs) return;
        const instruments = getCurrentInstruments();
        const instrument = findInstrumentById(instruments, refs.instrumentSelect.value);
        if (!instrument) return;
        const instrumentType = String(instrument.type || '').trim();
        const baseType = instrumentType.replace(/_bell$/i, '');
        const isDjembeFamily = baseType === 'djembe' || baseType === 'djembe_solo';
        const isDundunFamily = baseType === 'kenkeni' || baseType === 'sangban' || baseType === 'doundoun';
        const articulations = getArticulationsForType(instrument.type);
        const displayArticulations = isDjembeFamily
            ? ['bass', 'tone', 'slap', 'mute'].filter((sound) => articulations.includes(sound))
            : isDundunFamily
                ? ['bell', 'mute', 'tone'].filter((sound) => articulations.includes(sound))
                : articulations.slice();
        refs.grid.classList.toggle('djembe-stack', isDjembeFamily || isDundunFamily);
        refs.grid.classList.toggle('single-articulation', displayArticulations.length === 1);
        refs.grid.innerHTML = '';

        const useCircularToneSymbol = shouldUseCircularToneSymbolForPads();
        displayArticulations.forEach((sound) => {
            const meta = { ...(TRIGGER_PAD_SOUND_META[sound] || { label: sound, symbol: String(sound || '').slice(0, 1).toUpperCase(), className: '' }) };
            if (sound === 'mute' && isDundunFamily) {
                meta.label = 'Muffle';
            } else if (sound === 'slap' && baseType === 'shekere') {
                meta.label = 'Shake';
            }
            const pair = document.createElement('div');
            pair.className = 'trigger-pad-hit-pair';
            pair.dataset.floatingInteractive = 'true';
            const shell = document.createElement('div');
            shell.className = 'trigger-pad-hit trigger-pad-hit-shell';
            shell.dataset.sound = sound;
            shell.dataset.floatingInteractive = 'true';
            const openCircleClass = useCircularToneSymbol ? 'trigger-pad-hit-open-circle circular-tone' : 'trigger-pad-hit-open-circle';
            const symbolHtml = meta.openCircle
                ? `<span class="${openCircleClass}" aria-hidden="true"></span>`
                : `<span class="trigger-pad-hit-symbol-text">${meta.symbol || ''}</span>`;
            shell.innerHTML = `<span class="trigger-pad-hit-symbol ${meta.className || ''}">${symbolHtml}</span><span class="trigger-pad-hit-label">${meta.label}</span>`;

            [0, 1].forEach((lane) => {
                const zone = document.createElement('button');
                zone.type = 'button';
                zone.className = `trigger-pad-hit-zone trigger-pad-hit-zone-${lane === 0 ? 'left' : 'right'}`;
                zone.dataset.sound = sound;
                zone.dataset.triggerLane = String(lane);
                zone.dataset.floatingInteractive = 'true';
                zone.tabIndex = -1;
                zone.setAttribute('aria-hidden', 'true');

                const clearPressed = () => shell.classList.remove('pressed');
                zone.addEventListener('pointerdown', (e) => {
                    if (e.pointerType !== 'touch' && e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    shell.classList.add('pressed');
                    try { zone.setPointerCapture(e.pointerId); } catch {}
                    triggerPadHit(panel, sound, e, zone, lane, 'split');
                });
                zone.addEventListener('pointerup', (e) => { e.stopPropagation(); clearPressed(); });
                zone.addEventListener('pointercancel', (e) => { e.stopPropagation(); clearPressed(); });
                zone.addEventListener('pointerleave', (e) => { e.stopPropagation(); clearPressed(); });
                zone.addEventListener('lostpointercapture', clearPressed);
                zone.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
                zone.addEventListener('contextmenu', (e) => e.preventDefault());
                zone.addEventListener('dragstart', (e) => e.preventDefault());
                shell.appendChild(zone);
            });

            pair.appendChild(shell);
            refs.grid.appendChild(pair);
        });

        const rhythmLabel = String(
            (isPadRemoteUi() ? activeRemoteRhythmName : '')
            || latestNotationRhythmData?.rhythmName
            || (selectedRhythm && allRhythms[selectedRhythm]?.name)
            || sharedRhythmName
            || 'Pad'
        ).trim();
        refs.titleEl.textContent = `Pad - ${panel.dataset.padIndex || ''}`;
        refs.titleEl.title = rhythmLabel;
        renderPadNotationPreview(panel, instrument);
        ensurePadNotationVerticalSpace(panel);
        queuePadGridLayout(panel);
    };

    const applyRemoteRhythmSelection = (rhythmKey, panel = null) => {
        const key = String(rhythmKey || '').trim();
        if (!key || !allRhythms[key]) return;
        activeRemoteRhythmKey = key;
        selectedRhythm = key;
        const rhythm = allRhythms[key];
        activeRemoteRhythmName = String(rhythm?.name || key).trim();

        const liveData = rhythmToPadRhythmData(rhythm, activeRemoteRhythmName);
        if (liveData) latestNotationRhythmData = liveData;

        panels.forEach((entry) => {
            const refs = entry && entry._triggerPadRefs;
            if (!refs) return;
            populateRhythmSelect(entry, activeRemoteRhythmKey);
            const selectedId = refs.instrumentSelect.value;
            populateInstrumentSelect(entry, selectedId);
            renderPadGrid(entry);
        });

        clearRemoteRhythmLoadRetry();
        requestSharedRhythmFromNotation(true);
        syncPadRemoteMobileRhythmSelector();
        if (panel) updatePadStatus(panel, `Loading ${activeRemoteRhythmName}...`);
    };

    const applyGlobalRhythmSelectionFromPad = async (rhythmKey, panel = null, options = {}) => {
        let key = String(rhythmKey || '').trim();
        if (!key) return;
        const opts = options && typeof options === 'object' ? options : {};
        const forceLoad = !!opts.force;
        const suppressAutoAudio = opts.suppressAutoAudio !== undefined
            ? !!opts.suppressAutoAudio
            : !!(padRemoteMode && padRemoteFullSiteMode);
        if (padRemoteMode && opts.skipCatalogRefresh !== true) {
            await refreshRemoteRhythmsFromSupabase();
        }
        if (!allRhythms[key]) {
            const byName = findRhythmKeyByName(key);
            if (byName) key = byName;
        }
        if (!allRhythms[key] && (loadDatabaseOnStartup || padRemoteMode)) {
            try {
                await refreshRhythmDatabaseAndUi({ silent: true });
            } catch {}
            if (!allRhythms[key]) {
                const byName = findRhythmKeyByName(key);
                if (byName) key = byName;
            }
        }
        if (!allRhythms[key]) {
            if (panel) updatePadStatus(panel, `Rhythm "${rhythmKey}" not found`);
            return;
        }
        const now = Date.now();
        if (!forceLoad && lastPadRhythmSwitchKey === key && (now - lastPadRhythmSwitchAt) < 900) {
            return;
        }
        lastPadRhythmSwitchKey = key;
        lastPadRhythmSwitchAt = now;
        const rhythmName = String(allRhythms[key].name || key).trim();
        const selectedRhythmEntry = allRhythms[key] || null;

        if (padRemoteMode) {
            activeRemoteRhythmKey = key;
            activeRemoteRhythmName = rhythmName;
        }

        if (!forceLoad && selectedRhythm === key && latestNotationRhythmData && Array.isArray(latestNotationRhythmData.instruments)) {
            if (panel) updatePadStatus(panel, `Already loaded: ${allRhythms[key].name || key}`);
            panels.forEach((entry) => {
                const refs = entry && entry._triggerPadRefs;
                if (!refs) return;
                populateRhythmSelect(entry, key);
                const selectedId = refs.instrumentSelect ? refs.instrumentSelect.value : '';
                if (selectedId) populateInstrumentSelect(entry, selectedId);
                renderPadGrid(entry);
            });
            syncPadRemoteMobileRhythmSelector();
            return;
        }
        if (panel) updatePadStatus(panel, `Loading ${rhythmName}...`);
        try {
            const noSessionBroadcast = opts.noSessionBroadcast === true || !isSessionLeader();
            await startJourney(key, {
                skipTravel: true,
                preserveWindowVisibility: true,
                suppressAutoAudio,
                noSessionBroadcast
            });
            if (selectedRhythm !== key) {
                if (panel) updatePadStatus(panel, `Could not switch to ${rhythmName}`);
                return;
            }
            const immediatePadData = rhythmToPadRhythmData(selectedRhythmEntry, rhythmName);
            if (immediatePadData && Array.isArray(immediatePadData.instruments)) {
                latestNotationRhythmData = immediatePadData;
            }

            // Ensure notation transport engine is updated even when notation UI is closed.
            const bridge = window._notationBridge;
            if (bridge && typeof bridge.ensureLoaded === 'function') bridge.ensureLoaded();
            if (bridge && typeof bridge.postMain === 'function') {
                const loadMessage = {
                    type: 'loadRhythm',
                    name: rhythmName,
                    lookupKey: key
                };
                const notationPath = String(selectedRhythmEntry?.notationPath || '').trim();
                if (notationPath) loadMessage.notationPath = notationPath;
                if (selectedRhythmEntry?.notationData && Array.isArray(selectedRhythmEntry.notationData.instruments)) {
                    loadMessage.notationData = selectedRhythmEntry.notationData;
                }
                bridge.postMain(loadMessage);
                if (typeof bridge.requestRhythmState === 'function') {
                    setTimeout(() => bridge.requestRhythmState(), 80);
                    setTimeout(() => bridge.requestRhythmState(), 280);
                }
            }

            if (panel) updatePadStatus(panel, `Loaded ${rhythmName}`);
            panels.forEach((entry) => {
                const refs = entry && entry._triggerPadRefs;
                if (!refs) return;
                populateRhythmSelect(entry, key);
                const selectedId = refs.instrumentSelect ? refs.instrumentSelect.value : '';
                if (selectedId) populateInstrumentSelect(entry, selectedId);
                renderPadGrid(entry);
            });
            syncPadRemoteMobileRhythmSelector();
        } catch (err) {
            if (panel) updatePadStatus(panel, 'Failed to load rhythm');
            console.error('Pad rhythm selection failed:', err);
        }
    };

    const hidePanel = (panel) => {
        if (!panel) return;
        closePadQrOverlay(panel);
        panel.classList.add('hidden');
        panel.classList.add('panel-hidden');
        if (padRemoteMode && padRemoteMobileCurrentView === 'pads') {
            const nextVisible = panels.find((entry) => entry.dataset.padCreated === '1' && !entry.classList.contains('hidden'));
            if (nextVisible) {
                nextVisible.classList.add('remote-active');
                if (remoteWelcomeUnlocked) setPadRemoteMobileView('pads', { persist: false });
            }
        }
        updateToggleState();
        persistState();
    };

    const removePanel = (panel) => {
        if (!panel) return;
        closePadQrOverlay(panel);
        panel.classList.add('hidden');
        panel.classList.add('panel-hidden');
        panel.dataset.padCreated = '0';
        const toggleId = padToggleIdForPanel(panel);
        const topToggle = document.getElementById(toggleId);
        if (topToggle && topToggle.parentElement) topToggle.parentElement.removeChild(topToggle);
        const refs = panel._triggerPadRefs;
        if (refs) {
            refs.instrumentSelect.selectedIndex = 0;
            if (refs.reverbInput) refs.reverbInput.value = '0.1';
            applyReverbLabel(panel);
            renderPadGrid(panel);
            updatePadStatus(panel, 'Removed');
        }
        updateToggleState();
        persistState();
    };

    const showPanel = (panel, seed = null, markCreated = true) => {
        if (!panel) return;
        const refs = panel._triggerPadRefs;
        if (seed && refs) {
            if (seed.instrumentId) populateInstrumentSelect(panel, seed.instrumentId);
            if (refs.reverbInput && seed.reverb !== undefined) {
                refs.reverbInput.value = String(normalizeTriggerPadReverb(seed.reverb));
            }
            applyReverbLabel(panel);
            renderPadGrid(panel);
        }
        if (markCreated) {
            panel.dataset.padCreated = '1';
            ensureTopToggleForPanel(panel);
        }
        if (padRemoteMode) {
            panels.forEach((entry) => entry.classList.remove('remote-active'));
            panel.classList.add('remote-active');
        }
        panel.classList.remove('hidden', 'panel-hidden');
        clampPanelOnOpen(panel);
        bringToFront(panel);
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(panel);
        }
        queuePadGridLayout(panel);
        updateToggleState();
        persistState();
        ensureNotationBridgeReady();
        if (remoteRhythmSyncEnabled) requestSharedRhythmFromNotation(true);
        if (padRemoteMode && remoteWelcomeUnlocked && padRemoteMobileCurrentView === 'pads') {
            setPadRemoteMobileView('pads', { persist: false });
        }
    };

    const findNextHiddenPanel = () => panels.find((panel) => panel.classList.contains('hidden'));
    const spawnNextPanel = (seed = null) => {
        const next = findNextHiddenPanel();
        if (!next) return false;
        showPanel(next, seed);
        return true;
    };

    panels.forEach((panel) => {
        let instrumentSelect = panel.querySelector('.trigger-pad-controls .trigger-pad-instrument-select')
            || panel.querySelector('.trigger-pad-instrument-select');
        const grid = panel.querySelector('.trigger-pad-grid');
        const statusEl = panel.querySelector('.trigger-pad-status');
        const titleEl = panel.querySelector('.trigger-pad-title');
        const duplicateBtn = panel.querySelector('.trigger-pad-duplicate-btn');
        const closeBtn = panel.querySelector('.trigger-pad-close-btn');
        const removeBtn = panel.querySelector('.trigger-pad-remove-btn');
        if (!grid || !statusEl || !titleEl) return;
        if (!instrumentSelect) {
            const instrumentRow = document.createElement('div');
            instrumentRow.className = 'control-row trigger-pad-controls trigger-pad-instrument-row';
            instrumentRow.dataset.floatingInteractive = 'true';
            instrumentRow.innerHTML = `
                <label>Instrument:</label>
                <select class="trigger-pad-instrument-select"></select>
            `;
            panel.insertBefore(instrumentRow, grid);
            instrumentSelect = instrumentRow.querySelector('.trigger-pad-instrument-select');
        }
        if (!instrumentSelect) return;

        let gridWrap = panel.querySelector('.trigger-pad-grid-wrap');
        if (!gridWrap) {
            gridWrap = document.createElement('div');
            gridWrap.className = 'trigger-pad-grid-wrap';
            gridWrap.dataset.floatingInteractive = 'true';
            const gridParent = grid.parentElement;
            if (gridParent) {
                gridParent.insertBefore(gridWrap, grid);
                gridWrap.appendChild(grid);
            }
        }
        const headerActions = panel.querySelector('.trigger-pad-header-actions');
        let playBtn = panel.querySelector('.trigger-pad-play-btn');
        if (headerActions && !playBtn) {
            playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'debug-action-btn trigger-pad-transport-btn trigger-pad-play-btn';
            playBtn.title = 'Play/Stop notation playback';
            playBtn.textContent = latestNotationPlaybackPlaying ? 'Stop' : 'Play';
            headerActions.insertBefore(playBtn, headerActions.firstChild || null);
        }
        let callBtn = panel.querySelector('.trigger-pad-call-btn');
        if (headerActions && !callBtn) {
            callBtn = document.createElement('button');
            callBtn.type = 'button';
            callBtn.className = 'debug-action-btn trigger-pad-transport-btn trigger-pad-call-btn';
            callBtn.title = 'Call In when stopped, Call when playing';
            callBtn.textContent = String(latestNotationCallState.callLabel || 'Call In');
            if (playBtn && playBtn.nextSibling) headerActions.insertBefore(callBtn, playBtn.nextSibling);
            else if (playBtn) headerActions.appendChild(callBtn);
            else headerActions.insertBefore(callBtn, headerActions.firstChild || null);
        }
        let callOutBtn = panel.querySelector('.trigger-pad-callout-btn');
        if (headerActions && !callOutBtn) {
            callOutBtn = document.createElement('button');
            callOutBtn.type = 'button';
            callOutBtn.className = 'debug-action-btn trigger-pad-transport-btn trigger-pad-callout-btn';
            callOutBtn.title = 'Play call next measure, then stop';
            callOutBtn.textContent = 'Call Out';
            callOutBtn.style.display = latestNotationCallState.showCallOut ? 'inline-flex' : 'none';
            if (callBtn && callBtn.nextSibling) headerActions.insertBefore(callOutBtn, callBtn.nextSibling);
            else if (callBtn) headerActions.appendChild(callOutBtn);
            else if (playBtn && playBtn.nextSibling) headerActions.insertBefore(callOutBtn, playBtn.nextSibling);
            else headerActions.insertBefore(callOutBtn, headerActions.firstChild || null);
        }
        let callInStepWrap = panel.querySelector('.trigger-pad-callin-step-wrap');
        let callInStepInput = panel.querySelector('.trigger-pad-callin-step-input');
        if (headerActions && (!callInStepWrap || !callInStepInput)) {
            callInStepWrap = document.createElement('span');
            callInStepWrap.className = 'trigger-pad-callin-step-wrap';
            callInStepWrap.dataset.floatingInteractive = 'true';
            callInStepWrap.title = 'Step In from end of call measure';
            callInStepWrap.innerHTML = `
                <span class="trigger-pad-callin-step-label">IN</span>
                <input type="text" class="trigger-pad-callin-step-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="${Math.max(1, parseInt(latestNotationCallState.callInStepOffset, 10) || 1)}" aria-label="Call In step from end">
            `;
            if (callOutBtn && callOutBtn.nextSibling) headerActions.insertBefore(callInStepWrap, callOutBtn.nextSibling);
            else if (callOutBtn) headerActions.appendChild(callInStepWrap);
            else if (callBtn && callBtn.nextSibling) headerActions.insertBefore(callInStepWrap, callBtn.nextSibling);
            else if (callBtn) headerActions.appendChild(callInStepWrap);
            else if (playBtn && playBtn.nextSibling) headerActions.insertBefore(callInStepWrap, playBtn.nextSibling);
            else if (playBtn) headerActions.appendChild(callInStepWrap);
            else headerActions.insertBefore(callInStepWrap, headerActions.firstChild || null);
            callInStepInput = callInStepWrap.querySelector('.trigger-pad-callin-step-input');
        }
        let shareBtn = panel.querySelector('.trigger-pad-share-btn');
        if (headerActions && !shareBtn) {
            shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'debug-action-btn trigger-pad-transport-btn trigger-pad-share-btn';
            shareBtn.title = 'Show QR for this pad';
            shareBtn.textContent = 'QR';
            const duplicateAnchor = headerActions.querySelector('.trigger-pad-duplicate-btn');
            if (duplicateAnchor) headerActions.insertBefore(shareBtn, duplicateAnchor);
            else headerActions.appendChild(shareBtn);
        }
        if (padRemoteMode && headerActions) {
            // Remote/mobile mode keeps the full pad header controls visible.
            headerActions.style.display = 'flex';
            if (shareBtn) shareBtn.style.display = '';
        }

        let playbackVolumeInput = panel.querySelector('.trigger-pad-playback-volume');
        let playbackVolumeValue = panel.querySelector('.trigger-pad-playback-volume-val');
        if (!playbackVolumeInput || !playbackVolumeValue) {
            const playbackRow = document.createElement('div');
            playbackRow.className = 'control-row trigger-pad-controls trigger-pad-playback-volume-row';
            playbackRow.dataset.floatingInteractive = 'true';
            playbackRow.innerHTML = `
                <label>Playback Vol:</label>
                <input type="range" class="trigger-pad-playback-volume" min="0" max="1" step="0.01" value="${Math.round(padPlaybackVolume * 100) / 100}">
                <span class="trigger-pad-playback-volume-val">${Math.round(padPlaybackVolume * 100)}%</span>
            `;
            panel.insertBefore(playbackRow, gridWrap || grid);
            playbackVolumeInput = playbackRow.querySelector('.trigger-pad-playback-volume');
            playbackVolumeValue = playbackRow.querySelector('.trigger-pad-playback-volume-val');
        }

        let reverbInput = panel.querySelector('.trigger-pad-reverb');
        let reverbValue = panel.querySelector('.trigger-pad-reverb-val');
        if (!reverbInput || !reverbValue) {
            const reverbRow = document.createElement('div');
            reverbRow.className = 'control-row trigger-pad-controls trigger-pad-reverb-row';
            reverbRow.dataset.floatingInteractive = 'true';
            reverbRow.innerHTML = `
                <label>Reverb:</label>
                <input type="range" class="trigger-pad-reverb" min="0" max="1" step="0.05" value="0.1">
                <span class="trigger-pad-reverb-val">10%</span>
            `;
            panel.insertBefore(reverbRow, gridWrap || grid);
            reverbInput = reverbRow.querySelector('.trigger-pad-reverb');
            reverbValue = reverbRow.querySelector('.trigger-pad-reverb-val');
        }

        let preview = panel.querySelector('.trigger-pad-notation-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.className = 'trigger-pad-notation-preview';
            preview.dataset.floatingInteractive = 'true';
            panel.insertBefore(preview, gridWrap || grid);
        }

        let rhythmSelect = panel.querySelector('.trigger-pad-rhythm-select');
        if (!rhythmSelect) {
            const instrumentRow = panel.querySelector('.trigger-pad-controls');
            const rhythmRow = document.createElement('div');
            rhythmRow.className = 'control-row trigger-pad-controls trigger-pad-rhythm-row';
            rhythmRow.dataset.floatingInteractive = 'true';
            rhythmRow.innerHTML = `
                <label>Rhythm:</label>
                <select class="trigger-pad-instrument-select trigger-pad-rhythm-select"></select>
            `;
            if (instrumentRow) {
                panel.insertBefore(rhythmRow, instrumentRow);
            } else {
                panel.insertBefore(rhythmRow, gridWrap || grid);
            }
            rhythmSelect = rhythmRow.querySelector('.trigger-pad-rhythm-select');
        }

        if (!reverbInput || !reverbValue || !preview) return;

        panel._triggerPadRefs = {
            rhythmSelect,
            instrumentSelect,
            reverbInput,
            reverbValue,
            playBtn,
            callBtn,
            callOutBtn,
            callInStepInput,
            preview,
            gridWrap,
            grid,
            statusEl,
            titleEl,
            playbackVolumeInput,
            playbackVolumeValue,
            _triggerLane: 0
        };

        const saved = state[panel.id] || {};
        const defaultReverb = normalizeTriggerPadReverb(saved.reverb !== undefined ? saved.reverb : (padSharePayload?.reverb !== undefined ? padSharePayload.reverb : 0.1));
        reverbInput.value = String(defaultReverb);
        applyReverbLabel(panel);
        setPadControlsCollapsed(panel, !!saved.controlsCollapsed, false);
        if (rhythmSelect) {
            const initialRhythmKey = populateRhythmSelect(panel, activeRemoteRhythmKey || selectedRhythm || '');
        if (padRemoteMode && initialRhythmKey) {
            activeRemoteRhythmKey = initialRhythmKey;
            activeRemoteRhythmName = String(allRhythms[initialRhythmKey]?.name || initialRhythmKey);
        }
        if (padRemoteMode) {
            const rhythmRow = rhythmSelect.closest('.trigger-pad-rhythm-row');
            if (rhythmRow) rhythmRow.style.display = 'flex';
        }
        }
        populateInstrumentSelect(panel, saved.instrumentId || padSharePayload?.instrumentId || '');
        renderPadGrid(panel);
        updatePadStatus(panel, 'Ready');

        if (typeof ResizeObserver === 'function') {
            const resizeObserver = new ResizeObserver(() => queuePadGridLayout(panel));
            resizeObserver.observe(panel);
            panel._triggerPadResizeObserver = resizeObserver;
        }

        const wasCreated = saved.created === true || !panel.classList.contains('hidden');
        if (wasCreated) {
            panel.dataset.padCreated = '1';
            ensureTopToggleForPanel(panel);
        }

        instrumentSelect.addEventListener('change', () => {
            renderPadGrid(panel);
            persistState();
        });
        if (rhythmSelect) {
            rhythmSelect.addEventListener('change', () => {
                void applyGlobalRhythmSelectionFromPad(rhythmSelect.value, panel, {
                    force: true,
                    suppressAutoAudio: true
                });
            });
        }
        reverbInput.addEventListener('input', () => {
            applyReverbLabel(panel);
            persistState();
        });
        if (playbackVolumeInput) {
            const onPlaybackVolumeInput = () => {
                applyPadPlaybackVolume(playbackVolumeInput.value, { persist: true, broadcast: true });
            };
            playbackVolumeInput.addEventListener('input', onPlaybackVolumeInput);
            playbackVolumeInput.addEventListener('change', onPlaybackVolumeInput);
        }
        if (preview) {
            let holdTimer = null;
            let holdTriggered = false;
            let holdStartX = 0;
            let holdStartY = 0;
            const HOLD_MS = 430;
            const HOLD_MOVE_CANCEL = 14;
            const clearHoldTimer = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
            };
            preview.addEventListener('pointerdown', (event) => {
                if (event.pointerType === 'mouse' && event.button !== 0) return;
                holdTriggered = false;
                holdStartX = Number.isFinite(event.clientX) ? event.clientX : 0;
                holdStartY = Number.isFinite(event.clientY) ? event.clientY : 0;
                clearHoldTimer();
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    holdTriggered = true;
                    togglePadControlsCollapsed(panel, true);
                    updatePadStatus(
                        panel,
                        panel.classList.contains('pad-controls-collapsed')
                            ? 'Pad controls hidden (hold grid to show)'
                            : 'Pad controls shown'
                    );
                }, HOLD_MS);
            });
            preview.addEventListener('pointermove', (event) => {
                if (!holdTimer) return;
                const x = Number.isFinite(event.clientX) ? event.clientX : holdStartX;
                const y = Number.isFinite(event.clientY) ? event.clientY : holdStartY;
                if (Math.abs(x - holdStartX) > HOLD_MOVE_CANCEL || Math.abs(y - holdStartY) > HOLD_MOVE_CANCEL) {
                    clearHoldTimer();
                }
            });
            preview.addEventListener('pointerup', clearHoldTimer);
            preview.addEventListener('pointercancel', clearHoldTimer);
            preview.addEventListener('pointerleave', clearHoldTimer);
            preview.addEventListener('click', (event) => {
                if (!holdTriggered) return;
                holdTriggered = false;
                event.preventDefault();
                event.stopPropagation();
            });
        }

        if (duplicateBtn) {
            duplicateBtn.addEventListener('click', () => {
                const seed = {
                    instrumentId: instrumentSelect.value || '',
                    reverb: normalizeTriggerPadReverb(reverbInput.value)
                };
                const created = spawnNextPanel(seed);
                if (!created) updatePadStatus(panel, 'All trigger pads are already in use');
            });
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => hidePanel(panel));
        }
        if (removeBtn) {
            removeBtn.addEventListener('click', () => removePanel(panel));
        }
        if (shareBtn) {
            shareBtn.addEventListener('click', () => {
                showPadQrOverlay(panel);
            });
        }
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                if (sessionState.active) {
                    if (isSessionFollower() && !sessionState.freeMode) {
                        sessionSetStatus('Playback is controlled by the session leader.', 'warn');
                        return;
                    }
                    if (isSessionLeader() && !sessionState.freeMode) {
                        const shouldStop = !!latestNotationPlaybackPlaying;
                        const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || latestNotationPlaybackTempo || circularTempo || 100));
                        if (shouldStop) {
                            void leaderBroadcastTransportStop({ forceLocalStop: false });
                        } else {
                            sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                            void leaderBroadcastTransportPlay('play', {
                                tempo: nextTempo,
                                startBeat: 0
                            });
                        }
                        return;
                    }
                }
                const bridge = window._notationBridge;
                if (!bridge || typeof bridge.postMain !== 'function') {
                    updatePadStatus(panel, 'Notation engine not ready');
                    return;
                }
                const shouldStop = !!latestNotationPlaybackPlaying;
                bridge.postMain({ type: shouldStop ? 'stopPlayback' : 'startPlayback' });
                if (!shouldStop) {
                    latestNotationPlaybackPlaying = true;
                    latestNotationPlaybackStep = 0;
                    latestNotationPlaybackStepEpoch = Date.now();
                    requestPadPreviewRefresh({
                        playing: true,
                        step: 0,
                        tempo: latestNotationPlaybackTempo,
                        stepEpoch: latestNotationPlaybackStepEpoch,
                        beatColor: latestNotationPlaybackBeatColor
                    });
                }
            });
        }
        if (callBtn) {
            callBtn.addEventListener('click', () => {
                if (sessionState.active) {
                    if (isSessionFollower() && !sessionState.freeMode) {
                        sessionSetStatus('Call is controlled by the session leader.', 'warn');
                        return;
                    }
                    if (isSessionLeader() && !sessionState.freeMode && !latestNotationPlaybackPlaying) {
                        const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || latestNotationPlaybackTempo || circularTempo || 100));
                        sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                        void leaderBroadcastTransportPlay('call_in', {
                            tempo: nextTempo,
                            startBeat: 0
                        });
                        return;
                    }
                }
                const bridge = window._notationBridge;
                if (!bridge || typeof bridge.postMain !== 'function') {
                    updatePadStatus(panel, 'Notation engine not ready');
                    return;
                }
                bridge.postMain({ type: 'callButton' });
            });
        }
        if (callOutBtn) {
            callOutBtn.addEventListener('click', () => {
                if (sessionState.active) {
                    if (isSessionFollower() && !sessionState.freeMode) {
                        sessionSetStatus('Call is controlled by the session leader.', 'warn');
                        return;
                    }
                    if (isSessionLeader() && !sessionState.freeMode) {
                        const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || latestNotationPlaybackTempo || circularTempo || 100));
                        void leaderBroadcastCallOut({ tempo: nextTempo });
                        return;
                    }
                }
                const bridge = window._notationBridge;
                if (!bridge || typeof bridge.postMain !== 'function') {
                    updatePadStatus(panel, 'Notation engine not ready');
                    return;
                }
                bridge.postMain({ type: 'callOut' });
            });
        }
        if (callInStepInput) {
            callInStepInput.addEventListener('focus', () => {
                callInStepInput.dataset.callInEditing = '1';
            });
            const getStepBounds = () => {
                const fallbackStepMax = Math.max(
                    1,
                    (parseInt(latestNotationRhythmData?.beats, 10) || 1) *
                    (parseInt(latestNotationRhythmData?.subdivisions, 10) || 1)
                );
                const max = Math.max(1, parseInt(latestNotationCallState.callInStepMax, 10) || fallbackStepMax);
                return { min: 1, max };
            };
            const sendCallInStepOffset = (rawValue, commit = false) => {
                const bridge = window._notationBridge;
                if (!bridge || typeof bridge.postMain !== 'function') {
                    updatePadStatus(panel, 'Notation engine not ready');
                    return;
                }
                const sanitized = String(rawValue ?? '').replace(/[^\d]/g, '');
                if (sanitized !== String(rawValue ?? '')) {
                    callInStepInput.value = sanitized;
                }
                const rawText = sanitized.trim();
                if (!rawText) {
                    if (!commit) return;
                }
                const parsed = parseInt(rawText, 10);
                const { min, max } = getStepBounds();
                const value = Number.isFinite(parsed)
                    ? Math.max(min, Math.min(max, parsed))
                    : min;
                if (commit) {
                    callInStepInput.dataset.callInEditing = '0';
                    callInStepInput.value = String(value);
                }
                bridge.postMain({ type: 'setCallInStepOffset', value });
            };
            callInStepInput.addEventListener('input', () => sendCallInStepOffset(callInStepInput.value, false));
            callInStepInput.addEventListener('change', () => sendCallInStepOffset(callInStepInput.value, true));
            callInStepInput.addEventListener('blur', () => sendCallInStepOffset(callInStepInput.value, true));
            callInStepInput.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                sendCallInStepOffset(callInStepInput.value, true);
                callInStepInput.blur();
            });
        }
    });

    const syncPadHeaderTransportButtons = () => {
        const isPlaying = !!latestNotationPlaybackPlaying;
        const fallbackStepMax = Math.max(
            1,
            (parseInt(latestNotationRhythmData?.beats, 10) || 1) *
            (parseInt(latestNotationRhythmData?.subdivisions, 10) || 1)
        );
        const callInStepMax = Math.max(1, parseInt(latestNotationCallState.callInStepMax, 10) || fallbackStepMax);
        const callInStepOffset = Math.max(1, Math.min(callInStepMax, parseInt(latestNotationCallState.callInStepOffset, 10) || 1));
        panels.forEach((panel) => {
            const refs = panel?._triggerPadRefs || {};
            const playBtn = refs.playBtn || panel.querySelector('.trigger-pad-play-btn');
            if (playBtn) {
                playBtn.textContent = isPlaying ? 'Stop' : 'Play';
                playBtn.classList.toggle('active', isPlaying);
            }
            const callBtn = refs.callBtn || panel.querySelector('.trigger-pad-call-btn');
            if (callBtn) {
                callBtn.textContent = String(latestNotationCallState.callLabel || (isPlaying ? 'Call' : 'Call In'));
                callBtn.title = String(latestNotationCallState.callTitle || 'Call control');
                callBtn.classList.toggle('pending', !!latestNotationCallState.callPending);
                callBtn.classList.toggle('active-call', !!latestNotationCallState.callActive);
                callBtn.disabled = !!latestNotationCallState.callInActive;
            }
            const callOutBtn = refs.callOutBtn || panel.querySelector('.trigger-pad-callout-btn');
            if (callOutBtn) {
                const showCallOut = !!latestNotationCallState.showCallOut;
                callOutBtn.style.display = showCallOut ? 'inline-flex' : 'none';
                callOutBtn.classList.toggle('active-callout', !!latestNotationCallState.callOutActive);
                callOutBtn.disabled = !!latestNotationCallState.callOutActive;
            }
            const callInStepInput = refs.callInStepInput || panel.querySelector('.trigger-pad-callin-step-input');
            if (callInStepInput) {
                callInStepInput.setAttribute('inputmode', 'numeric');
                callInStepInput.setAttribute('pattern', '[0-9]*');
                callInStepInput.setAttribute('autocomplete', 'off');
                callInStepInput.dataset.min = '1';
                callInStepInput.dataset.max = String(callInStepMax);
                const isEditing = callInStepInput.dataset.callInEditing === '1' || document.activeElement === callInStepInput;
                if (!isEditing) {
                    callInStepInput.value = String(callInStepOffset);
                }
                callInStepInput.disabled = !!latestNotationPlaybackPlaying;
            }
        });
    };
    syncPadPlaybackVolumeUi();
    applyPadPlaybackVolume(padPlaybackVolume, { persist: false, broadcast: false });
    syncPadHeaderTransportButtons();

    window.addEventListener('resize', () => {
        syncPadRemoteViewportClass();
        panels.forEach((panel) => queuePadGridLayout(panel));
        if (padRemoteMode && remoteWelcomeUnlocked) {
            setPadRemoteMobileView(padRemoteMobileCurrentView || 'pads', { persist: false });
        }
    });

    toggleBtn.addEventListener('click', () => {
        const createdPanels = panels.filter((panel) => panel.dataset.padCreated === '1');
        if (createdPanels.length === 0) {
            if (panels[0]) showPanel(panels[0]);
            return;
        }

        const visibleCreated = createdPanels.filter((panel) => !panel.classList.contains('hidden'));
        if (visibleCreated.length > 0) {
            createdPanels.forEach((panel) => hidePanel(panel));
            return;
        }

        createdPanels.forEach((panel) => showPanel(panel, null, false));
    });

    window.addEventListener('rrc:notation-rhythm-state', (event) => {
        const rhythmData = event?.detail?.rhythmData;
        if (!rhythmData || !Array.isArray(rhythmData.instruments)) return;
        if (remoteRhythmSyncEnabled && remoteExpectedRhythmName) {
            const incomingName = String(rhythmData.rhythmName || '').trim().toLowerCase();
            if (incomingName && incomingName === remoteExpectedRhythmName) {
                clearRemoteRhythmLoadRetry();
            }
        }
        if (Array.isArray(event?.detail?.beatColors) && event.detail.beatColors.length > 0) {
            latestNotationBeatColors = event.detail.beatColors.slice(0, 12).map((value) => String(value || '').trim()).filter(Boolean);
        }
        if (lockSharedRhythmData && sharedRhythmData) return;
        if (remoteRhythmSyncEnabled && (activeRemoteRhythmName || sharedRhythmName)) {
            const expectedName = normalizeRhythmLookupText(activeRemoteRhythmName || sharedRhythmName);
            const incomingName = normalizeRhythmLookupText(rhythmData.rhythmName);
            if (expectedName && incomingName && expectedName !== incomingName) {
                requestSharedRhythmFromNotation(true);
            }
        }
        latestNotationRhythmData = ensureCallInstrumentInRhythmData(rhythmData);
        panels.forEach((panel) => {
            if (!panel._triggerPadRefs) return;
            populateRhythmSelect(panel, activeRemoteRhythmKey || selectedRhythm || '');
            const selectedId = panel._triggerPadRefs.instrumentSelect.value;
            populateInstrumentSelect(panel, selectedId);
            renderPadGrid(panel);
        });
        persistState();
    });

    // Clock-driven pad timeline. The notation engine announces each step before it sounds,
    // with the exact time it will be heard. A frame loop shows the step on the first frame at
    // or after that time, so the timeline no longer inherits timer and message delays.
    const padScheduledSteps = [];
    let padScheduleRaf = 0;
    let padScheduleSeenAt = 0;
    const padScheduleIsLive = () => (performance.now() - padScheduleSeenAt) < 600;
    const runPadScheduleFrame = () => {
        padScheduleRaf = 0;
        const now = Date.now();
        let due = null;
        // Half a frame of tolerance: show a step on the frame nearest to its time.
        while (padScheduledSteps.length && padScheduledSteps[0].stepEpoch <= now + 8) {
            due = padScheduledSteps.shift();
        }
        if (due) {
            if (Array.isArray(window.__rrcPadTimelineDebug)) window.__rrcPadTimelineDebug.push({ step: due.step, lateMs: now - due.stepEpoch, at: performance.now() });
            refreshAllPadPlaybackPreview({
                step: due.step,
                tempo: due.tempo,
                playing: true,
                stepEpoch: due.stepEpoch,
                stepDurationMs: due.stepDurationMs
            });
        }
        if (padScheduledSteps.length) padScheduleRaf = requestAnimationFrame(runPadScheduleFrame);
    };
    window.addEventListener('rrc:notation-step-scheduled', (event) => {
        const detail = event?.detail || {};
        if (!Number.isFinite(detail.stepEpoch)) return;
        padScheduleSeenAt = performance.now();
        // A re-sync can announce a step again: drop anything at or after the new step's time.
        while (padScheduledSteps.length && padScheduledSteps[padScheduledSteps.length - 1].stepEpoch >= detail.stepEpoch - 1) {
            padScheduledSteps.pop();
        }
        padScheduledSteps.push(detail);
        if (padScheduledSteps.length > 64) padScheduledSteps.splice(0, padScheduledSteps.length - 64);
        if (!padScheduleRaf) padScheduleRaf = requestAnimationFrame(runPadScheduleFrame);
    });

    window.addEventListener('rrc:notation-playback-tick', (event) => {
        const detail = event?.detail || {};
        if (padScheduleIsLive() && detail.playing !== false) {
            // The clock-driven loop above owns the playhead while the engine is announcing steps.
            syncPadHeaderTransportButtons();
            return;
        }
        const fallbackStep = Number.isFinite(Number(latestNotationPlaybackStep)) ? Number(latestNotationPlaybackStep) : 0;
        const fallbackTempo = Number.isFinite(Number(latestNotationPlaybackTempo)) ? Number(latestNotationPlaybackTempo) : 100;
        requestPadPreviewRefresh({
            step: Number.isFinite(Number(detail.step)) ? Number(detail.step) : fallbackStep,
            tempo: Number.isFinite(Number(detail.tempo)) ? Number(detail.tempo) : fallbackTempo,
            playing: detail.playing !== false,
            stepEpoch: Number.isFinite(Number(detail.stepEpoch)) ? Number(detail.stepEpoch) : Date.now(),
            beatColor: String(detail.beatColor || latestNotationPlaybackBeatColor || '').trim()
        });
        syncPadHeaderTransportButtons();
    });

    window.addEventListener('rrc:notation-playback-state', (event) => {
        const detail = event?.detail || {};
        if (!detail.playing) {
            padScheduledSteps.length = 0;
            padScheduleSeenAt = 0;
        }
        const explicitStep = Number.isFinite(Number(detail.step)) ? Number(detail.step) : null;
        const inferredStep = detail.playing ? 0 : latestNotationPlaybackStep;
        requestPadPreviewRefresh({
            playing: !!detail.playing,
            step: explicitStep !== null ? explicitStep : inferredStep,
            tempo: Number.isFinite(Number(detail.tempo)) ? Number(detail.tempo) : latestNotationPlaybackTempo,
            stepEpoch: Number.isFinite(Number(detail.stepEpoch)) ? Number(detail.stepEpoch) : latestNotationPlaybackStepEpoch,
            beatColor: String(detail.beatColor || latestNotationPlaybackBeatColor || '').trim()
        });
        syncPadHeaderTransportButtons();
    });

    window.addEventListener('rrc:notation-call-state', () => {
        syncPadHeaderTransportButtons();
    });
    window.addEventListener('rrc:notation-master-volume', (event) => {
        const next = Number(event?.detail?.masterVolume);
        if (!Number.isFinite(next)) return;
        applyPadPlaybackVolume(next, { persist: false, broadcast: false });
    });

    const remoteRhythmPanel = document.getElementById('rhythm-panel');
    if (padRemoteMode && remoteRhythmPanel && remoteRhythmPanel.dataset.padRemoteViewBound !== '1') {
        remoteRhythmPanel.dataset.padRemoteViewBound = '1';
        remoteRhythmPanel.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;
            const triggersSelection = !!target.closest('.rhythm-point, .carousel-card, .journey-mini-slide, .journey-source-item .journey-item-btn');
            if (!triggersSelection) return;
            setTimeout(() => {
                if (!padRemoteMode) return;
                if (padRemoteMobileCurrentView === 'rhythms' || padRemoteMobileCurrentView === 'journeys') {
                    setPadRemoteMobileView('journey');
                }
            }, 280);
        });
    }

    if (padSharePayload && panels[0]) {
        showPanel(panels[0], {
            instrumentId: String(padSharePayload.instrumentId || '').trim(),
            reverb: normalizeTriggerPadReverb(padSharePayload.reverb)
        }, true);
        activatePadRemoteMode(panels[0]);
    } else if (padRemoteMode && panels[0]) {
        showPanel(panels[0], null, true);
        activatePadRemoteMode(panels[0]);
    }

    if (isPadRemoteUi()) {
        const activeRemote = panels.find((panel) => panel.classList.contains('remote-active') && !panel.classList.contains('hidden'));
        if (!activeRemote && panels[0]) {
            showPanel(panels[0], null, true);
            activatePadRemoteMode(panels[0]);
        }
    }

    if ((padRemoteMode || isPadRemoteUi()) && !window.__rrcPadRapidTapGuardBound) {
        const shouldGuardTarget = (target) => (
            target instanceof Element &&
            !!target.closest('.trigger-pad-window, .trigger-pad-hit, .trigger-pad-hit-zone, .trigger-pad-grid, .trigger-pad-notation-preview')
        );
        let lastPadTapAt = 0;
        const preventIfPadTarget = (event) => {
            if (!shouldGuardTarget(event.target)) return;
            event.preventDefault();
        };
        const preventPadDoubleTapZoom = (event) => {
            if (!shouldGuardTarget(event.target)) return;
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if ((now - lastPadTapAt) < 320) {
                event.preventDefault();
            }
            lastPadTapAt = now;
        };
        document.addEventListener('dblclick', preventIfPadTarget, { capture: true, passive: false });
        document.addEventListener('gesturestart', preventIfPadTarget, { capture: true, passive: false });
        document.addEventListener('gesturechange', preventIfPadTarget, { capture: true, passive: false });
        document.addEventListener('gestureend', preventIfPadTarget, { capture: true, passive: false });
        document.addEventListener('touchend', preventPadDoubleTapZoom, { capture: true, passive: false });
        window.__rrcPadRapidTapGuardBound = true;
    }

    updateToggleState();
    persistState();
    setTimeout(ensureNotationBridgeReady, 60);
    if (remoteRhythmSyncEnabled) {
        setTimeout(async () => {
            await refreshRemoteRhythmsFromSupabase();
            const key = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
            if (key && allRhythms[key]) applyRemoteRhythmSelection(key);
            else if (Object.keys(allRhythms || {}).length > 0) applyRemoteRhythmSelection(Object.keys(allRhythms)[0]);
            requestSharedRhythmFromNotation(true);
        }, 40);
        setTimeout(async () => {
            await refreshRemoteRhythmsFromSupabase();
            const key = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
            if (key && allRhythms[key]) applyRemoteRhythmSelection(key);
            requestSharedRhythmFromNotation(true);
        }, 380);
        setTimeout(() => requestSharedRhythmFromNotation(true), 780);
    } else if (padRemoteMode) {
        setTimeout(async () => {
            await refreshRemoteRhythmsFromSupabase();
            const key = String(activeRemoteRhythmKey || sharedRhythmKey || selectedRhythm || '').trim();
            const fallback = key && allRhythms[key] ? key : (Object.keys(allRhythms || {})[0] || '');
            if (fallback) {
                void applyGlobalRhythmSelectionFromPad(fallback, panels[0] || null, {
                    force: true,
                    suppressAutoAudio: true
                });
            }
        }, 70);
    }

    window._refreshPadNotationLayout = () => {
        panels.forEach((panel) => {
            if (!panel || !panel._triggerPadRefs) return;
            ensurePadNotationVerticalSpace(panel);
            queuePadGridLayout(panel);
        });
    };
}

// Unsplash API Functions
async function fetchUnsplashImage(query, index = 0) {
    // Check if we have a valid API key
    if (!UNSPLASH_ACCESS_KEY || UNSPLASH_ACCESS_KEY === 'YOUR_UNSPLASH_ACCESS_KEY') {
        console.log('Unsplash API key not configured, using default images');
        return null;
    }

    try {
        // Request 20 results and pick by index to ensure unique images
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=20&orientation=landscape`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`
            }
        });

        if (!response.ok) {
            const remaining = response.headers.get('X-Ratelimit-Remaining');
            console.warn(`Unsplash API error: ${response.status} (Rate limit remaining: ${remaining})`);
            return null;
        }

        const data = await response.json();
        console.log(`  Query "${query}" returned ${data.results?.length || 0} results`);

        if (data.results && data.results.length > 0) {
            const total = data.results.length;
            const start = ((index % total) + total) % total;
            for (let offset = 0; offset < total; offset += 1) {
                const candidate = data.results[(start + offset) % total];
                if (!candidate || !candidate.urls?.regular) continue;
                if (!unsplashResultLooksLikePerson(candidate)) return candidate.urls.regular;
            }
            // If every result appears person-centric, use deterministic fallback pick.
            return data.results[start]?.urls?.regular || null;
        }
        return null;
    } catch (error) {
        console.error('Error fetching Unsplash image:', error);
        return null;
    }
}

// Get rhythm index for seeding unique image selection
function getRhythmIndex(rhythmKey) {
    const keys = Object.keys(allRhythms).sort();
    const idx = keys.indexOf(rhythmKey);
    return idx >= 0 ? idx : 0;
}

async function getImageForRhythm(rhythmKey, rhythm, forceRegenerate = false) {
    return getImageForRhythmWithCache(rhythmKey, rhythm, forceRegenerate, unsplashImageCache);
}

function getRhythmImageCacheKey(rhythmKey, rhythm) {
    const cacheDiscriminator = String(rhythm?.id || rhythmKey || '').trim() || String(rhythmKey || '').trim();
    return `unsplash_${cacheDiscriminator}`;
}

async function getImageForRhythmWithCache(rhythmKey, rhythm, forceRegenerate = false, cacheRef = unsplashImageCache) {
    const cacheKey = getRhythmImageCacheKey(rhythmKey, rhythm);
    const instrumentOnlyImage = getInstrumentOnlyRhythmImage(rhythmKey || rhythm?.name || rhythm?.id || 'instrument');

    if (RHYTHM_IMAGE_INSTRUMENT_ONLY) {
        cacheRef[cacheKey] = instrumentOnlyImage;
        if (cacheRef === unsplashImageCache) {
            saveUnsplashImageCache();
        }
        return instrumentOnlyImage;
    }

    // Check cache first (unless forcing regeneration)
    if (!forceRegenerate && cacheRef[cacheKey]) {
        return cacheRef[cacheKey];
    }

    // If Unsplash API isn't configured, use bundled local fallback photos.
    if (!UNSPLASH_ACCESS_KEY || UNSPLASH_ACCESS_KEY === 'YOUR_UNSPLASH_ACCESS_KEY') {
        const localFallback = getBundledFallbackImage(rhythmKey || rhythm?.name || 'fallback');
        cacheRef[cacheKey] = localFallback;
        if (cacheRef === unsplashImageCache) {
            saveUnsplashImageCache();
        }
        return localFallback;
    }

    // Build search query - use simple terms that Unsplash has images for
    // Prefer country name or major city, avoid complex multi-word locations
    let query = rhythm.country || rhythm.location || 'african drums';

    // Map specific countries to better search terms
    const queryMap = {
        'guinea': 'african drumming djembe',
        'mali': 'african drums village',
        'brazil': 'brazil samba drumming',
        'japan': 'japan taiko drumming',
        'uruguay': 'candombe drumming uruguay',
        'ireland': 'irish bodhran drumming',
        'morocco': 'morocco gnawa music drums',
        'indonesia': 'bali gamelan drums'
    };

    if (rhythm.country && queryMap[rhythm.country.toLowerCase()]) {
        query = queryMap[rhythm.country.toLowerCase()];
    }

    // Use rhythm index to pick different image from results
    const index = getRhythmIndex(rhythmKey);
    console.log(`Fetching Unsplash image for ${rhythmKey}: "${query}" (index ${index})`);

    let imageUrl = await fetchUnsplashImage(query, index);

    // If no results, try fallback queries
    if (!imageUrl) {
        const fallbackQueries = ['african drums', 'world music drums', 'drum circle', 'percussion'];
        for (const fallbackQuery of fallbackQueries) {
            console.log(`  Trying fallback query: "${fallbackQuery}"`);
            imageUrl = await fetchUnsplashImage(fallbackQuery, index);
            if (imageUrl) break;
        }
    }

    if (imageUrl) {
        cacheRef[cacheKey] = imageUrl;
        if (cacheRef === unsplashImageCache) {
            saveUnsplashImageCache();
        }
        return imageUrl;
    }

    // Fallback to generic default only
    return getBundledFallbackImage(rhythmKey || rhythm?.name || 'fallback');
}

async function regenerateAllImages() {
    console.log('Regenerating all images from Unsplash...');
    const previousCache = { ...unsplashImageCache };
    const nextCache = {};
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const [key, rhythm] of Object.entries(allRhythms)) {
        const imageUrl = await getImageForRhythmWithCache(key, rhythm, true, nextCache);
        rhythm.cachedImageUrl = imageUrl;
        console.log(`  ${key}: ${String(imageUrl || '').includes('assets/fallback-photos/') ? 'FALLBACK' : 'OK'}`);
        await delay(100);
    }

    // Commit cache atomically so failed/partial fetches cannot wipe image history.
    unsplashImageCache = { ...previousCache, ...nextCache };
    Object.entries(allRhythms).forEach(([key, rhythm]) => {
        const cacheKey = getRhythmImageCacheKey(key, rhythm);
        const legacyCacheKey = `unsplash_${key}`;
        const previousValue = previousCache[cacheKey] || previousCache[legacyCacheKey];
        if (!nextCache[cacheKey] && previousValue) {
            rhythm.cachedImageUrl = previousValue;
            if (!unsplashImageCache[cacheKey]) {
                unsplashImageCache[cacheKey] = previousValue;
            }
        }
    });
    saveUnsplashImageCache();
    populateRhythmPanel(currentRhythmSource);
    populateCarousel();
    console.log('Image regeneration complete');
}

async function loadCachedImages() {
    let needsRefresh = false;
    for (const [key, rhythm] of Object.entries(allRhythms)) {
        const cacheKey = getRhythmImageCacheKey(key, rhythm);
        const legacyCacheKey = `unsplash_${key}`;
        if (RHYTHM_IMAGE_INSTRUMENT_ONLY) {
            const instrumentImage = getInstrumentOnlyRhythmImage(key || rhythm?.name || rhythm?.id || 'instrument');
            if (rhythm.cachedImageUrl !== instrumentImage) {
                rhythm.cachedImageUrl = instrumentImage;
                needsRefresh = true;
            }
            if (unsplashImageCache[cacheKey] !== instrumentImage) {
                unsplashImageCache[cacheKey] = instrumentImage;
                needsRefresh = true;
            }
            if (unsplashImageCache[legacyCacheKey]) {
                delete unsplashImageCache[legacyCacheKey];
                needsRefresh = true;
            }
            continue;
        }
        const cached = unsplashImageCache[cacheKey] || unsplashImageCache[legacyCacheKey];
        if (cached) {
            rhythm.cachedImageUrl = cached;
            if (!unsplashImageCache[cacheKey]) {
                unsplashImageCache[cacheKey] = cached;
                delete unsplashImageCache[legacyCacheKey];
                needsRefresh = true;
            }
        } else {
            console.log(`Fetching missing image for: ${key}`);
            rhythm.cachedImageUrl = await getImageForRhythm(key, rhythm, false);
            needsRefresh = true;
        }
    }
    if (needsRefresh) {
        saveUnsplashImageCache();
        setTimeout(() => {
            populateRhythmPanel(currentRhythmSource);
            populateCarousel();
        }, 100);
    }
}

function setupNavigationToolbar() {
    if (!NAV_TOOLBAR_LEGACY_ENABLED) {
        enforceLegacyNavDisabled();
        return;
    }
    const pivotBtn = document.getElementById('nav-orbit');
    const panBtn = document.getElementById('nav-pan');
    const zoomInBtn = document.getElementById('nav-zoom-in');
    const zoomOutBtn = document.getElementById('nav-zoom-out');
    const resetBtn = document.getElementById('nav-reset');
    const northBtn = document.getElementById('nav-north');

    // Pivot mode - tilt/rotate the view (like Ctrl+drag on Mac)
    let pivotActive = false;
    let pivotStartX = 0;
    let pivotStartY = 0;
    const PIVOT_THRESHOLD = 5; // Pixels before pivot starts

    pivotBtn.addEventListener('mousedown', (e) => {
        pivotActive = true;
        pivotBtn.classList.add('active');
        pivotStartX = e.clientX;
        pivotStartY = e.clientY;
        e.preventDefault();
    });

    const pivotMoveHandler = (e) => {
        if (!pivotActive) return;

        const deltaX = e.clientX - pivotStartX;
        const deltaY = e.clientY - pivotStartY;

        // Only start pivoting after threshold is met
        if (Math.abs(deltaX) < PIVOT_THRESHOLD && Math.abs(deltaY) < PIVOT_THRESHOLD) {
            return;
        }

        // Update start position for continuous rotation
        pivotStartX = e.clientX;
        pivotStartY = e.clientY;

        // Use lookLeft/lookUp - this is what Ctrl+drag does in Cesium
        // It changes the camera's heading and pitch without moving position
        viewer.camera.lookLeft(deltaX * 0.005);
        viewer.camera.lookUp(deltaY * 0.005);
    };

    const stopPivot = () => {
        pivotActive = false;
        pivotBtn.classList.remove('active');
    };

    document.addEventListener('mousemove', pivotMoveHandler);
    document.addEventListener('mouseup', stopPivot);

    // Pan mode - spin the globe like clicking and dragging it
    let panActive = false;
    let panStartX = 0;
    let panStartY = 0;
    const PAN_THRESHOLD = 5;

    panBtn.addEventListener('mousedown', (e) => {
        panActive = true;
        panBtn.classList.add('active');
        panStartX = e.clientX;
        panStartY = e.clientY;
        e.preventDefault();
    });

    const panMoveHandler = (e) => {
        if (!panActive) return;

        const deltaX = e.clientX - panStartX;
        const deltaY = e.clientY - panStartY;

        // Only start panning after threshold
        if (Math.abs(deltaX) < PAN_THRESHOLD && Math.abs(deltaY) < PAN_THRESHOLD) {
            return;
        }

        // Update start position for continuous dragging
        panStartX = e.clientX;
        panStartY = e.clientY;

        // Rotate the globe - like dragging it with mouse
        // Horizontal drag rotates around the vertical axis (longitude)
        // Vertical drag rotates around the horizontal axis (latitude)
        viewer.camera.rotateLeft(deltaX * 0.005);
        viewer.camera.rotateUp(deltaY * 0.005);
    };

    const stopPan = () => {
        panActive = false;
        panBtn.classList.remove('active');
    };

    document.addEventListener('mousemove', panMoveHandler);
    document.addEventListener('mouseup', stopPan);

    // Zoom In
    let zoomInInterval = null;
    zoomInBtn.addEventListener('mousedown', () => {
        zoomInBtn.classList.add('active');
        zoomInInterval = setInterval(() => {
            viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.02);
        }, 16);
    });

    const stopZoomIn = () => {
        zoomInBtn.classList.remove('active');
        if (zoomInInterval) {
            clearInterval(zoomInInterval);
            zoomInInterval = null;
        }
    };
    zoomInBtn.addEventListener('mouseup', stopZoomIn);
    zoomInBtn.addEventListener('mouseleave', stopZoomIn);

    // Zoom Out
    let zoomOutInterval = null;
    zoomOutBtn.addEventListener('mousedown', () => {
        zoomOutBtn.classList.add('active');
        zoomOutInterval = setInterval(() => {
            viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.02);
        }, 16);
    });

    const stopZoomOut = () => {
        zoomOutBtn.classList.remove('active');
        if (zoomOutInterval) {
            clearInterval(zoomOutInterval);
            zoomOutInterval = null;
        }
    };
    zoomOutBtn.addEventListener('mouseup', stopZoomOut);
    zoomOutBtn.addEventListener('mouseleave', stopZoomOut);

    // Reset View - go back to initial West Africa view
    resetBtn.addEventListener('click', () => {
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(-5, 10, 5000000),
            orientation: {
                heading: 0.0,
                pitch: -Cesium.Math.PI_OVER_TWO * 0.7,
                roll: 0.0
            },
            duration: 1.5
        });
    });

    // Face North - reset heading to north
    northBtn.addEventListener('click', () => {
        const currentPosition = viewer.camera.positionCartographic;
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(
                currentPosition.longitude,
                currentPosition.latitude,
                currentPosition.height
            ),
            orientation: {
                heading: 0.0,
                pitch: viewer.camera.pitch,
                roll: 0.0
            },
            duration: 0.8
        });
    });
}

function changeImagery(imageryType) {
    // Remove all existing imagery layers
    while (viewer.imageryLayers.length > 0) {
        viewer.imageryLayers.remove(viewer.imageryLayers.get(0));
    }

    // Cesium Ion Asset IDs:
    // 2 = Bing Maps Aerial
    // 3 = Bing Maps Aerial with Labels
    // 4 = Bing Maps Roads
    // 3954 = Sentinel-2
    // 3845 = Natural Earth II
    // 3812 = Blue Marble Next Generation
    // 3813 = Black Marble (Night Lights)

    switch (imageryType) {
        case 'osm':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.OpenStreetMapImageryProvider({
                    url: 'https://a.tile.openstreetmap.org/'
                })
            );
            break;
        case 'bingAerialLabels':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3)
                )
            );
            break;
        case 'bingRoads':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(4)
                )
            );
            break;
        case 'googleSatellite':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.UrlTemplateImageryProvider({
                    url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
                    maximumLevel: 20
                })
            );
            break;
        case 'googleHybrid':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.UrlTemplateImageryProvider({
                    url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
                    maximumLevel: 20
                })
            );
            break;
        case 'googleRoads':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.UrlTemplateImageryProvider({
                    url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
                    maximumLevel: 20
                })
            );
            break;
        case 'googleTerrain':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.UrlTemplateImageryProvider({
                    url: 'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
                    maximumLevel: 20
                })
            );
            break;
        case 'arcgis':
            viewer.imageryLayers.addImageryProvider(
                new Cesium.ArcGisMapServerImageryProvider({
                    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
                })
            );
            break;
        case 'sentinel':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3954)
                )
            );
            break;
        case 'naturalEarth':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3845)
                )
            );
            break;
        case 'bluemarble':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3812)
                )
            );
            break;
        case 'blackmarble':
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(3813)
                )
            );
            break;
        case 'dark':
            // Dark solid color background
            viewer.imageryLayers.addImageryProvider(
                new Cesium.SingleTileImageryProvider({
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                })
            );
            break;
        default: // 'default' - Bing Aerial
            viewer.imageryLayers.add(
                Cesium.ImageryLayer.fromProviderAsync(
                    Cesium.IonImageryProvider.fromAssetId(2)
                )
            );
            break;
    }
    viewer.scene.requestRender();
}

// Populate color map for ALL rhythms (both local and community)
// This must be called before addHolographicDomes
// Colors are assigned based on alphabetical order for consistency across all views
function populateAllRhythmColors() {
    const sortedEntries = Object.entries(allRhythms).sort((a, b) =>
        a[1].name.localeCompare(b[1].name)
    );
    sortedEntries.forEach(([key, rhythm], index) => {
        const colorIndex = index % 12;
        const dbColor = rhythm.colorHex;
        const hasValidDbColor = dbColor && /^#[0-9A-Fa-f]{6}$/.test(dbColor) && dbColor !== '#000000';
        // Use DB color if available AND rainbow mode is off, otherwise rainbow
        const hexColor = (!useRainbowColors && hasValidDbColor) ? dbColor : colorSpectrum[colorIndex];
        rhythmColorMap[key] = {
            hex: hexColor,
            cesium: Cesium.Color.fromCssColorString(hexColor),
            index: colorIndex
        };
    });
    console.log('Colors populated:', Object.keys(rhythmColorMap).length, 'mode:', useRainbowColors ? 'rainbow' : 'database');
}

function handleRhythmOrJourneySelection(key) {
    if (!key) return;
    if (String(key).startsWith('journey:')) {
        const journeyId = String(key).slice('journey:'.length);
        const preset = readJourneyPresets().find((entry) => entry.id === journeyId);
        if (!preset) return;
        setJourneyDraftFromPreset(preset);
        const nameInput = document.getElementById('journey-name-input');
        if (nameInput) nameInput.value = journeyDraft.name || '';
        renderJourneyItems();
        renderJourneyLibrary();
        setRhythmBrowserTab('journeys');
        selectedRhythm = key;
        return;
    }
    if (stopTransportOnRhythmSelect && sessionState.active && isSessionLeader()
        && (notationPlaybackActive || sessionState.transportState === 'playing')) {
        // In a session the stop is for everyone, or followers carry on alone with the old transport.
        notationPlaybackActive = false;
        void leaderBroadcastTransportStop({ forceLocalStop: true });
    } else if (stopTransportOnRhythmSelect) {
        notationPlaybackActive = false;
        const bridge = window._notationBridge;
        if (bridge && typeof bridge.postMain === 'function') {
            try { bridge.postMain({ type: 'stopPlayback' }); } catch {}
        }
        if (bridge && typeof bridge.postCircular === 'function') {
            try { bridge.postCircular({ type: 'stopPlayback' }); } catch {}
        }
    }
    startJourney(key);
}

function getJourneyCollectionEntries(rhythm) {
    if (!rhythm || !Array.isArray(rhythm.journeyItems)) return [];
    return rhythm.journeyItems
        .map((rhythmKey) => {
            const normalized = String(rhythmKey || '').trim();
            return normalized ? { key: normalized, rhythm: allRhythms[normalized] } : null;
        })
        .filter((entry) => entry && entry.rhythm);
}

function buildJourneyMiniCarouselHtml(rhythm, defaultImage, variant = 'list') {
    const entries = getJourneyCollectionEntries(rhythm);
    if (entries.length === 0) {
        const fallback = rhythm?.cachedImageUrl || defaultImage;
        return `<img src="${fallback}" alt="${rhythm?.name || 'Collection'}" onerror="this.src='${defaultImage}'">`;
    }
    const loopedEntries = entries.length > 1 ? entries.concat(entries) : entries.slice();
    const duration = Math.max(8, Math.min(44, entries.length * 4));
    const slides = loopedEntries.map((entry) => {
        const imageUrl = entry.rhythm.cachedImageUrl || defaultImage;
        const name = entry.rhythm.name || entry.key;
        const colorData = rhythmColorMap[entry.key] || { hex: '#7bdfff' };
        const activeClass = selectedRhythm === entry.key ? ' active' : '';
        return `
            <div class="journey-mini-slide${activeClass}" data-rhythm-key="${entry.key}" style="color:${colorData.hex};border-color:${colorData.hex};">
                <img src="${imageUrl}" alt="${name}" draggable="false" onerror="this.src='${defaultImage}'">
                <button class="carousel-preview-btn" type="button" data-rhythm="${entry.key}" title="Preview Audio">
                    <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                </button>
                <div class="card-label">${name}</div>
            </div>
        `;
    }).join('');
    const loopClass = entries.length > 1 ? 'is-looped' : 'is-static';
    return `
        <div class="journey-mini-carousel ${loopClass} journey-mini-variant-${variant}" style="--journey-mini-duration:${duration}s;">
            <div class="journey-mini-track">${slides}</div>
        </div>
    `;
}

function wireJourneyMiniInteractions(hostEl) {
    if (!hostEl) return;
    hostEl.querySelectorAll('.journey-mini-slide[data-rhythm-key]').forEach((slide) => {
        if (slide.dataset.miniBound === '1') return;
        slide.dataset.miniBound = '1';
        slide.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rhythmKey = String(slide.dataset.rhythmKey || '').trim();
            if (!rhythmKey || !allRhythms[rhythmKey]) return;
            document.querySelectorAll('.journey-mini-slide').forEach((el) => el.classList.remove('active'));
            document.querySelectorAll(`.journey-mini-slide[data-rhythm-key="${rhythmKey}"]`).forEach((el) => el.classList.add('active'));
            startJourney(rhythmKey);
        });
    });
    hostEl.querySelectorAll('.journey-mini-slide .carousel-preview-btn[data-rhythm]').forEach((btn) => {
        if (btn.dataset.miniPreviewBound === '1') return;
        btn.dataset.miniPreviewBound = '1';
        const rhythmKey = String(btn.dataset.rhythm || '').trim();
        if (!rhythmKey || !allRhythms[rhythmKey]) return;
        setupPreviewHold(btn, rhythmKey);
    });
}

function populateRhythmPanel(source = 'all') {
    const list = document.getElementById('rhythm-list');
    list.innerHTML = '';
    const data = getFilteredRhythms(source);
    const defaultImage = getBundledFallbackImage(source || 'rhythm-list');
    const sortedEntries = Object.entries(data).sort((a, b) =>
        a[1].name.localeCompare(b[1].name)
    );

    sortedEntries.forEach(([key, rhythm], index) => {
        const div = document.createElement('div');
        let colorData = rhythmColorMap[key];
        if (!colorData) {
            colorData = { hex: '#7bdfff', cesium: null, index: index % 12 };
        }
        const fallbackImage = getBundledFallbackImage(key || rhythm?.name || index);
        const imageUrl = rhythm.cachedImageUrl || fallbackImage;
        const creatorInfo = rhythm.library === 'Community'
            ? `<span class="rhythm-uploader">by @${rhythm.creator}</span>`
            : rhythm.library === 'Journey'
                ? `<span class="rhythm-uploader">Curated Collection</span>`
            : `<span class="rhythm-uploader">by @Rhythms‿Re‿Connected</span>`;
        const communityInfo = rhythm.community
            ? `<span class="rhythm-community">${rhythm.community}</span>` : '';
        const previewKey = rhythm.isJourneyCard
            ? ((Array.isArray(rhythm.journeyItems) && rhythm.journeyItems[0]) || '')
            : key;

        div.className = `rhythm-point color-${colorData.index}`;
        div.style.color = colorData.hex;
        div.dataset.rhythm = key;
        div.dataset.floatingInteractive = 'true';
        const mediaHtml = rhythm.isJourneyCard
            ? buildJourneyMiniCarouselHtml(rhythm, defaultImage, 'list')
            : `<img src="${imageUrl}" alt="${rhythm.name}" draggable="false" onerror="this.src='${fallbackImage}'">`;
        const previewBtnHtml = rhythm.isJourneyCard ? '' : `
                    <button class="rhythm-preview-btn" data-rhythm="${previewKey}" title="Preview Audio">
                        <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                    </button>`;
        div.innerHTML = `
                <div class="rhythm-card-image">
                    ${mediaHtml}
                    ${previewBtnHtml}
                </div>
                <div class="rhythm-label">
                    <span class="rhythm-name">${rhythm.name}</span>
                    ${communityInfo}
                    <span class="rhythm-location">${rhythm.location}</span>
                    ${creatorInfo}
                </div>
            `;
        const previewBtn = div.querySelector('.rhythm-preview-btn');
        if (previewBtn && previewKey) setupPreviewHold(previewBtn, previewKey);
        else if (previewBtn) previewBtn.style.display = 'none';
        if (rhythm.isJourneyCard) wireJourneyMiniInteractions(div);
        if (!rhythm.isJourneyCard) {
            attachRhythmDragSource(div, key);
        }
        div.addEventListener('click', () => {
            if (div.dataset.wasDragging === '1') return;
            handleRhythmOrJourneySelection(key);
        });
        list.appendChild(div);
    });
}

function buildCarouselCardElement(key, rhythm, index, defaultImage, isClone = false) {
    const colorData = rhythmColorMap[key] || { hex: '#7bdfff', index: index % 12 };
    const hexColor = colorData.hex;
    const previewKey = rhythm.isJourneyCard
        ? ((Array.isArray(rhythm.journeyItems) && rhythm.journeyItems[0]) || '')
        : key;
    const card = document.createElement('div');
    card.className = 'carousel-card';
    card.style.color = hexColor;
    card.style.borderColor = hexColor;
    card.dataset.rhythm = key;
    card.dataset.clone = isClone ? '1' : '0';
    card.dataset.floatingInteractive = 'true';
    if (selectedRhythm === key) card.classList.add('active');

    const fallbackImage = getBundledFallbackImage(key || rhythm?.name || index);
    const imageUrl = rhythm.cachedImageUrl || fallbackImage;
    const mediaHtml = rhythm.isJourneyCard
        ? buildJourneyMiniCarouselHtml(rhythm, defaultImage, 'carousel')
        : `<img src="${imageUrl}" alt="${rhythm.name}" draggable="false" onerror="this.src='${fallbackImage}'">`;
    const previewBtnHtml = rhythm.isJourneyCard ? '' : `
        <button class="carousel-preview-btn" data-rhythm="${previewKey}" title="Preview Audio">
            <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        </button>`;
    card.innerHTML = `
        ${mediaHtml}
        ${previewBtnHtml}
        <div class="card-label">${rhythm.name}</div>
    `;

    const previewBtn = card.querySelector('.carousel-preview-btn');
    if (previewBtn && previewKey) setupPreviewHold(previewBtn, previewKey);
    else if (previewBtn) previewBtn.style.display = 'none';
    if (rhythm.isJourneyCard) wireJourneyMiniInteractions(card);
    return card;
}

function getMatrixCarouselRowCount(entryCount, containerHeight) {
    const total = Math.max(0, parseInt(entryCount, 10) || 0);
    if (total <= 0) return 1;
    const maxRows = Math.max(1, Math.min(8, total));
    const fallbackByItems = total >= 24 ? 4 : (total >= 12 ? 3 : (total >= 5 ? 2 : 1));
    const h = Number(containerHeight);
    if (!Number.isFinite(h) || h < 40) return Math.min(maxRows, fallbackByItems);

    const rowGap = 8;
    const targetLaneHeight = 82;
    const rowAddThreshold = Number.isFinite(carouselRowAddThreshold) ? Math.max(0, carouselRowAddThreshold) : 0;
    const adjustedHeight = Math.max(0, h - rowAddThreshold);
    let rowsByHeight = Math.floor((adjustedHeight + rowGap) / (targetLaneHeight + rowGap));
    rowsByHeight = Math.max(1, Math.min(maxRows, rowsByHeight));

    // Edge case: moderate/tall panel with enough cards should still use at least 2 rows.
    if (rowsByHeight < 2 && total >= 8 && adjustedHeight >= 145) rowsByHeight = 2;
    return Math.max(1, Math.min(maxRows, rowsByHeight));
}

function populateCarousel() {
    const data = getFilteredRhythms(currentRhythmSource);
    const rhythmEntries = Object.entries(data).sort((a, b) =>
        a[1].name.localeCompare(b[1].name)
    );
    const defaultImage = getBundledFallbackImage(currentRhythmSource || 'carousel');

    const mainTrack = document.getElementById('carousel-track');
    const mainContent = document.querySelector('#rhythm-carousel .carousel-content');
    if (mainTrack && mainContent) {
        mainTrack.dataset.floatingInteractive = 'true';
        mainTrack.innerHTML = '';
        mainContent.classList.add('matrix-carousel');
        mainTrack.classList.remove('carousel-track');
        mainTrack.classList.add('matrix-carousel-grid');
        mainTrack.dataset.carouselCount = String(rhythmEntries.length);

        const rowCount = getMatrixCarouselRowCount(
            rhythmEntries.length,
            mainContent.getBoundingClientRect().height
        );
        mainTrack.dataset.matrixRows = String(rowCount);
        const rows = Array.from({ length: rowCount }, () => []);
        rhythmEntries.forEach((entry, idx) => {
            rows[idx % rowCount].push(entry);
        });

        rows.forEach((rowEntries, rowIdx) => {
            if (rowEntries.length === 0) return;
            const row = document.createElement('div');
            row.className = 'matrix-carousel-row';
            row.dataset.rowDir = rowIdx % 2 === 0 ? '1' : '-1';
            row.dataset.floatingInteractive = 'true';

            const rowTrack = document.createElement('div');
            rowTrack.className = 'matrix-carousel-row-track';
            rowTrack.dataset.baseCount = String(rowEntries.length);
            rowTrack.dataset.floatingInteractive = 'true';

            const looped = rowEntries.length > 1 ? rowEntries.concat(rowEntries) : rowEntries.slice();
            looped.forEach(([key, rhythm], idx) => {
                const card = buildCarouselCardElement(key, rhythm, idx, defaultImage, rowEntries.length > 1 && idx >= rowEntries.length);
                rowTrack.appendChild(card);
            });

            row.appendChild(rowTrack);
            mainTrack.appendChild(row);
        });

        bindMatrixCarouselInteractions(mainTrack, mainContent);
    }

    const circularTrack = document.getElementById('circular-carousel-track');
    const circularContent = document.querySelector('#circular-panel .carousel-content');
    if (circularTrack && circularContent) {
        circularTrack.dataset.floatingInteractive = 'true';
        circularTrack.innerHTML = '';
        circularContent.classList.remove('matrix-carousel');
        circularTrack.classList.add('carousel-track');
        circularTrack.classList.remove('matrix-carousel-grid');

        const loopedEntries = rhythmEntries.length > 1
            ? rhythmEntries.concat(rhythmEntries)
            : rhythmEntries.slice();
        circularTrack.dataset.carouselLooped = rhythmEntries.length > 1 ? '1' : '0';
        circularTrack.dataset.carouselCount = String(rhythmEntries.length);

        loopedEntries.forEach(([key, rhythm], idx) => {
            const isClone = rhythmEntries.length > 1 && idx >= rhythmEntries.length;
            const card = buildCarouselCardElement(key, rhythm, idx, defaultImage, isClone);
            circularTrack.appendChild(card);
        });

        bindCarouselInteractions(circularTrack, circularContent);
    }
}

function bindMatrixCarouselInteractions(track, carouselContent) {
    if (!track || !carouselContent) return;
    const DRAG_THRESHOLD = 6;
    let autoLastTs = 0;

    if (carouselContent._matrixCleanup) {
        try { carouselContent._matrixCleanup(); } catch {}
        carouselContent._matrixCleanup = null;
    }
    if (carouselContent._carouselAutoRaf) {
        cancelAnimationFrame(carouselContent._carouselAutoRaf);
        carouselContent._carouselAutoRaf = null;
    }
    if (carouselContent._carouselResizeObserver) {
        try { carouselContent._carouselResizeObserver.disconnect(); } catch {}
        carouselContent._carouselResizeObserver = null;
    }
    if (track._carouselClickHandler) {
        track.removeEventListener('click', track._carouselClickHandler);
        track._carouselClickHandler = null;
    }
    if (carouselContent._carouselMouseDownHandler) {
        carouselContent.removeEventListener('mousedown', carouselContent._carouselMouseDownHandler);
        carouselContent.removeEventListener('mousemove', carouselContent._carouselMouseMoveHandler);
        carouselContent.removeEventListener('mouseup', carouselContent._carouselMouseUpHandler);
        carouselContent.removeEventListener('mouseleave', carouselContent._carouselMouseLeaveHandler);
        carouselContent.removeEventListener('touchstart', carouselContent._carouselTouchStartHandler);
        carouselContent.removeEventListener('touchmove', carouselContent._carouselTouchMoveHandler);
        carouselContent.removeEventListener('touchend', carouselContent._carouselTouchEndHandler);
        carouselContent._carouselMouseDownHandler = null;
        carouselContent._carouselMouseMoveHandler = null;
        carouselContent._carouselMouseUpHandler = null;
        carouselContent._carouselMouseLeaveHandler = null;
        carouselContent._carouselTouchStartHandler = null;
        carouselContent._carouselTouchMoveHandler = null;
        carouselContent._carouselTouchEndHandler = null;
    }

    const rows = Array.from(track.querySelectorAll('.matrix-carousel-row'));
    const totalItems = Math.max(0, parseInt(track.dataset.carouselCount || '0', 10) || 0);
    const currentRows = rows.length;
    const cleanups = [];
    const rowStates = rows.map((row, idx) => {
        const rowTrack = row.querySelector('.matrix-carousel-row-track');
        const baseCount = Math.max(1, parseInt(rowTrack?.dataset.baseCount || '1', 10) || 1);
        const dir = String(row.dataset.rowDir || '').trim() === '-1' ? -1 : 1;
        const getLoopWidth = () => baseCount > 1 ? Math.max(0, (rowTrack?.scrollWidth || 0) / 2) : 0;
        const normalize = () => {
            const loopWidth = getLoopWidth();
            if (loopWidth <= 1) return;
            let next = row.scrollLeft % loopWidth;
            if (next < 0) next += loopWidth;
            row.scrollLeft = next;
        };
        if (dir < 0) {
            const loopWidth = getLoopWidth();
            if (loopWidth > 1 && row.scrollLeft <= 1) row.scrollLeft = loopWidth;
        }

        const state = {
            row,
            baseCount,
            dir,
            isDragging: false,
            hasDragged: false,
            startX: 0,
            startScrollLeft: 0,
            getLoopWidth,
            normalize
        };

        const onClick = (e) => {
            if (state.hasDragged) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const card = e.target.closest('.carousel-card');
            if (!card) return;
            const key = card.dataset.rhythm;
            handleRhythmOrJourneySelection(key);
            document.querySelectorAll('.carousel-card').forEach((c) => c.classList.remove('active'));
            document.querySelectorAll(`.carousel-card[data-rhythm="${key}"]`).forEach((c) => c.classList.add('active'));
        };
        row.addEventListener('click', onClick);

        const onMouseDown = (e) => {
            if (e.target.closest('button')) return;
            e.preventDefault();
            state.isDragging = true;
            state.hasDragged = false;
            state.startX = e.pageX;
            state.startScrollLeft = row.scrollLeft;
            row.classList.add('dragging');
        };
        const onMouseMove = (e) => {
            if (!state.isDragging) return;
            const deltaX = e.pageX - state.startX;
            if (Math.abs(deltaX) > DRAG_THRESHOLD) state.hasDragged = true;
            if (!state.hasDragged) return;
            e.preventDefault();
            row.scrollLeft = state.startScrollLeft - deltaX;
            state.normalize();
        };
        const stopDragging = () => {
            if (!state.isDragging) return;
            state.isDragging = false;
            row.classList.remove('dragging');
            state.normalize();
            setTimeout(() => { state.hasDragged = false; }, 50);
        };
        row.addEventListener('mousedown', onMouseDown);
        row.addEventListener('mousemove', onMouseMove);
        row.addEventListener('mouseup', stopDragging);
        row.addEventListener('mouseleave', stopDragging);

        const onTouchStart = (e) => {
            if (e.target.closest && e.target.closest('button')) return;
            state.isDragging = true;
            state.hasDragged = false;
            state.startX = e.touches[0].pageX;
            state.startScrollLeft = row.scrollLeft;
            row.classList.add('dragging');
        };
        const onTouchMove = (e) => {
            if (!state.isDragging) return;
            const deltaX = e.touches[0].pageX - state.startX;
            if (Math.abs(deltaX) > DRAG_THRESHOLD) state.hasDragged = true;
            if (!state.hasDragged) return;
            row.scrollLeft = state.startScrollLeft - deltaX;
            state.normalize();
        };
        const onTouchEnd = (e) => {
            if (!state.hasDragged) {
                const touch = e.changedTouches && e.changedTouches[0];
                const element = touch ? document.elementFromPoint(touch.clientX, touch.clientY) : null;
                const miniSlide = element?.closest('.journey-mini-slide[data-rhythm-key]');
                if (miniSlide) {
                    const miniKey = String(miniSlide.getAttribute('data-rhythm-key') || '').trim();
                    if (miniKey) handleRhythmOrJourneySelection(miniKey);
                    stopDragging();
                    return;
                }
                const card = element?.closest('.carousel-card');
                if (card) {
                    const key = card.dataset.rhythm;
                    handleRhythmOrJourneySelection(key);
                    document.querySelectorAll('.carousel-card').forEach((c) => c.classList.remove('active'));
                    document.querySelectorAll(`.carousel-card[data-rhythm="${key}"]`).forEach((c) => c.classList.add('active'));
                }
            }
            stopDragging();
        };
        row.addEventListener('touchstart', onTouchStart, { passive: true });
        row.addEventListener('touchmove', onTouchMove, { passive: true });
        row.addEventListener('touchend', onTouchEnd);

        cleanups.push(() => {
            row.removeEventListener('click', onClick);
            row.removeEventListener('mousedown', onMouseDown);
            row.removeEventListener('mousemove', onMouseMove);
            row.removeEventListener('mouseup', stopDragging);
            row.removeEventListener('mouseleave', stopDragging);
            row.removeEventListener('touchstart', onTouchStart);
            row.removeEventListener('touchmove', onTouchMove);
            row.removeEventListener('touchend', onTouchEnd);
        });
        return state;
    });

    const updateMatrixSizing = () => {
        const rect = carouselContent.getBoundingClientRect();
        if (!rect || rect.width < 24 || rect.height < 24) return;
        const rowGap = 8;
        const rowCount = Math.max(1, rows.length);
        const rowHeight = Math.max(48, (rect.height - (rowGap * (rowCount - 1)) - 8) / rowCount);
        const cardH = Math.max(44, Math.min(170, rowHeight - 6));
        const cardW = Math.max(72, Math.min(240, cardH * 1.34));
        carouselContent.style.setProperty('--carousel-card-w', `${cardW.toFixed(1)}px`);
        carouselContent.style.setProperty('--carousel-card-h', `${cardH.toFixed(1)}px`);
    };

    let resizeObserver = null;
    let pendingRowRebuild = false;
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
            updateMatrixSizing();
            const nextRows = getMatrixCarouselRowCount(totalItems, carouselContent.getBoundingClientRect().height);
            if (nextRows !== currentRows && !pendingRowRebuild) {
                pendingRowRebuild = true;
                requestAnimationFrame(() => {
                    pendingRowRebuild = false;
                    populateCarousel();
                });
            }
        });
        resizeObserver.observe(carouselContent);
        resizeObserver.observe(track);
    }

    const runAutoScroll = (ts) => {
        const style = window.getComputedStyle(carouselContent);
        const hidden = style.display === 'none' || style.visibility === 'hidden' || document.visibilityState !== 'visible';
        if (!autoLastTs) autoLastTs = ts;
        const dt = (ts - autoLastTs) / 1000;

        if (!hidden) {
            rowStates.forEach((state) => {
                const row = state.row;
                const loopWidth = state.getLoopWidth();
                const maxScroll = Math.max(0, row.scrollWidth - row.clientWidth);
                const travelWidth = state.baseCount > 1 ? Math.max(loopWidth, maxScroll) : maxScroll;
                const rowHover = !!(row.matches && row.matches(':hover'));
                if (state.isDragging || rowHover || travelWidth <= 0.5) return;

                const duration = Math.max(5, carouselSpeed || 30);
                const pxPerSecond = Math.max(18, row.clientWidth / duration);
                let next = row.scrollLeft + (pxPerSecond * dt * state.dir);
                if (state.baseCount > 1) {
                    if (loopWidth > 1) {
                        while (next >= loopWidth) next -= loopWidth;
                        while (next < 0) next += loopWidth;
                    }
                } else if (maxScroll > 1) {
                    if (next >= maxScroll) next = 0;
                    if (next < 0) next = maxScroll;
                } else {
                    next = 0;
                }
                row.scrollLeft = next;
            });
        }

        autoLastTs = ts;
        carouselContent._matrixAutoRaf = requestAnimationFrame(runAutoScroll);
    };

    updateMatrixSizing();
    carouselContent._matrixAutoRaf = requestAnimationFrame(runAutoScroll);
    carouselContent._matrixCleanup = () => {
        if (carouselContent._matrixAutoRaf) {
            cancelAnimationFrame(carouselContent._matrixAutoRaf);
            carouselContent._matrixAutoRaf = null;
        }
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch {}
            resizeObserver = null;
        }
        cleanups.forEach((fn) => {
            try { fn(); } catch {}
        });
        cleanups.length = 0;
    };
}

function bindCarouselInteractions(track, carouselContent) {
    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startScrollLeft = 0;
    const DRAG_THRESHOLD = 6;
    let autoLastTs = 0;
    const isLoopedCarousel = () => track.dataset.carouselLooped === '1';
    const getLoopWidth = () => {
        if (!isLoopedCarousel()) return 0;
        const width = track.scrollWidth / 2;
        return Number.isFinite(width) ? width : 0;
    };
    const normalizeLoopPosition = () => {
        const loopWidth = getLoopWidth();
        if (loopWidth <= 1) return;
        let next = carouselContent.scrollLeft % loopWidth;
        if (next < 0) next += loopWidth;
        carouselContent.scrollLeft = next;
    };
    const updateCarouselSizing = () => {
        if (!track || !carouselContent) return;
        const rect = carouselContent.getBoundingClientRect();
        if (!rect || rect.width < 24 || rect.height < 24) return;

        const style = window.getComputedStyle(track);
        const gap = parseFloat(style.columnGap || style.gap || '10') || 10;
        const entryCount = Math.max(1, parseInt(track.dataset.carouselCount || '1', 10) || 1);
        const visibleSlots = Math.max(2, Math.min(4.5, 1.8 + (rect.width / 180)));
        const widthByViewport = (rect.width - (gap * (visibleSlots - 1))) / visibleSlots;
        const heightByViewport = Math.max(46, Math.min(168, rect.height - 20));
        const widthByHeight = heightByViewport * 1.34;

        let cardW = Math.min(widthByViewport, widthByHeight);
        cardW = Math.max(58, Math.min(240, cardW));
        if (entryCount <= 2) {
            cardW = Math.max(cardW, Math.min(210, rect.width * 0.34));
        }
        const cardH = Math.max(44, Math.min(170, cardW / 1.34));

        carouselContent.style.setProperty('--carousel-card-w', `${cardW.toFixed(1)}px`);
        carouselContent.style.setProperty('--carousel-card-h', `${cardH.toFixed(1)}px`);
    };

    if (carouselContent._carouselAutoRaf) {
        cancelAnimationFrame(carouselContent._carouselAutoRaf);
        carouselContent._carouselAutoRaf = null;
    }
    if (carouselContent._carouselResizeObserver) {
        try { carouselContent._carouselResizeObserver.disconnect(); } catch {}
        carouselContent._carouselResizeObserver = null;
    }

    // Remove prior handlers before rebinding (populateCarousel runs many times)
    if (track._carouselClickHandler) {
        track.removeEventListener('click', track._carouselClickHandler);
    }
    if (carouselContent._carouselMouseDownHandler) {
        carouselContent.removeEventListener('mousedown', carouselContent._carouselMouseDownHandler);
        carouselContent.removeEventListener('mousemove', carouselContent._carouselMouseMoveHandler);
        carouselContent.removeEventListener('mouseup', carouselContent._carouselMouseUpHandler);
        carouselContent.removeEventListener('mouseleave', carouselContent._carouselMouseLeaveHandler);
        carouselContent.removeEventListener('touchstart', carouselContent._carouselTouchStartHandler);
        carouselContent.removeEventListener('touchmove', carouselContent._carouselTouchMoveHandler);
        carouselContent.removeEventListener('touchend', carouselContent._carouselTouchEndHandler);
    }

    const onTrackClick = (e) => {
        if (hasDragged) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const card = e.target.closest('.carousel-card');
        if (!card) return;
        const key = card.dataset.rhythm;
        handleRhythmOrJourneySelection(key);
        document.querySelectorAll('.carousel-card').forEach(c => c.classList.remove('active'));
        document.querySelectorAll(`.carousel-card[data-rhythm="${key}"]`).forEach(c => c.classList.add('active'));
    };
    track.addEventListener('click', onTrackClick);
    track._carouselClickHandler = onTrackClick;

    const onMouseDown = (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        isDragging = true;
        hasDragged = false;
        startX = e.pageX;
        startScrollLeft = carouselContent.scrollLeft;
        carouselContent.classList.add('dragging');
    };
    carouselContent.addEventListener('mousedown', onMouseDown);
    carouselContent._carouselMouseDownHandler = onMouseDown;

    const onMouseMove = (e) => {
        if (!isDragging) return;
        const deltaX = e.pageX - startX;
        if (Math.abs(deltaX) > DRAG_THRESHOLD) hasDragged = true;
        if (hasDragged) {
            e.preventDefault();
            carouselContent.scrollLeft = startScrollLeft - deltaX;
            if (isLoopedCarousel()) normalizeLoopPosition();
        }
    };
    carouselContent.addEventListener('mousemove', onMouseMove);
    carouselContent._carouselMouseMoveHandler = onMouseMove;

    const stopDragging = () => {
        if (!isDragging) return;
        isDragging = false;
        carouselContent.classList.remove('dragging');
        if (isLoopedCarousel()) normalizeLoopPosition();
        setTimeout(() => { hasDragged = false; }, 50);
    };
    const onMouseLeave = () => {
        stopDragging();
    };
    carouselContent.addEventListener('mouseup', stopDragging);
    carouselContent.addEventListener('mouseleave', onMouseLeave);
    carouselContent._carouselMouseUpHandler = stopDragging;
    carouselContent._carouselMouseLeaveHandler = onMouseLeave;

    const onTouchStart = (e) => {
        if (e.target.closest && e.target.closest('button')) return;
        isDragging = true;
        hasDragged = false;
        startX = e.touches[0].pageX;
        startScrollLeft = carouselContent.scrollLeft;
        carouselContent.classList.add('dragging');
    };
    carouselContent.addEventListener('touchstart', onTouchStart, { passive: true });
    carouselContent._carouselTouchStartHandler = onTouchStart;

    const onTouchMove = (e) => {
        if (!isDragging) return;
        const x = e.touches[0].pageX;
        const deltaX = x - startX;
        if (Math.abs(deltaX) > DRAG_THRESHOLD) hasDragged = true;
        if (hasDragged) {
            carouselContent.scrollLeft = startScrollLeft - deltaX;
            if (isLoopedCarousel()) normalizeLoopPosition();
        }
    };
    carouselContent.addEventListener('touchmove', onTouchMove, { passive: true });
    carouselContent._carouselTouchMoveHandler = onTouchMove;

    const onTouchEnd = (e) => {
        if (!hasDragged) {
            const touch = e.changedTouches[0];
            const element = document.elementFromPoint(touch.clientX, touch.clientY);
            const miniSlide = element?.closest('.journey-mini-slide[data-rhythm-key]');
            if (miniSlide) {
                const miniKey = String(miniSlide.getAttribute('data-rhythm-key') || '').trim();
                if (miniKey) {
                    startJourney(miniKey);
                    stopDragging();
                    return;
                }
            }
            const card = element?.closest('.carousel-card');
            if (card) {
                const key = card.dataset.rhythm;
                handleRhythmOrJourneySelection(key);
                document.querySelectorAll('.carousel-card').forEach(c => c.classList.remove('active'));
                document.querySelectorAll(`.carousel-card[data-rhythm="${key}"]`).forEach(c => c.classList.add('active'));
            }
        }
        stopDragging();
    };
    carouselContent.addEventListener('touchend', onTouchEnd);
    carouselContent._carouselTouchEndHandler = onTouchEnd;

    const runAutoScroll = (ts) => {
        const style = window.getComputedStyle(carouselContent);
        const hidden = style.display === 'none' || style.visibility === 'hidden' || document.visibilityState !== 'visible';
        const maxScroll = Math.max(0, carouselContent.scrollWidth - carouselContent.clientWidth);
        const loopWidth = getLoopWidth();
        const travelWidth = isLoopedCarousel() ? Math.max(loopWidth, maxScroll) : maxScroll;
        const isHoveringNow = !!(carouselContent.matches && carouselContent.matches(':hover'));
        const pause = hidden || isDragging || isHoveringNow;

        if (!pause && travelWidth > 0.5) {
            if (!autoLastTs) autoLastTs = ts;
            const dt = (ts - autoLastTs) / 1000;
            const duration = Math.max(5, carouselSpeed || 30);
            // Keep speed perceptually consistent across resized carousel windows.
            const viewportWidth = Math.max(80, carouselContent.clientWidth);
            const pxPerSecond = viewportWidth / duration;
            let next = carouselContent.scrollLeft + (pxPerSecond * dt);
            if (isLoopedCarousel()) {
                if (loopWidth > 1) {
                    while (next >= loopWidth) next -= loopWidth;
                }
            } else if (next >= maxScroll) {
                next = 0;
            }
            carouselContent.scrollLeft = next;
        }
        autoLastTs = ts;
        carouselContent._carouselAutoRaf = requestAnimationFrame(runAutoScroll);
    };
    updateCarouselSizing();
    if (typeof ResizeObserver === 'function') {
        const resizeObserver = new ResizeObserver(() => updateCarouselSizing());
        resizeObserver.observe(carouselContent);
        resizeObserver.observe(track);
        carouselContent._carouselResizeObserver = resizeObserver;
    }
    carouselContent._carouselAutoRaf = requestAnimationFrame(runAutoScroll);
}

function fitInfoBannerTextToBox() {
    const infoBanner = document.getElementById('info-banner');
    const titleEl = document.getElementById('info-title');
    const descEl = document.getElementById('info-description');
    const distanceEl = document.getElementById('info-distance');
    if (!infoBanner || !titleEl || !descEl || !distanceEl) return;

    const style = window.getComputedStyle(infoBanner);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const availableHeight = Math.max(36, infoBanner.clientHeight - padTop - padBottom);
    const availableWidth = Math.max(120, infoBanner.clientWidth - padLeft - padRight);
    if (availableHeight <= 0 || availableWidth <= 0) return;

    descEl.style.overflowWrap = 'anywhere';
    descEl.style.wordBreak = 'break-word';

    const getMargins = (el) => {
        const s = window.getComputedStyle(el);
        return {
            top: parseFloat(s.marginTop) || 0,
            bottom: parseFloat(s.marginBottom) || 0
        };
    };

    const fitsAt = (basePx) => {
        const titlePx = Math.max(8, basePx * 1.3);
        const descPx = Math.max(7, basePx);
        const distPx = Math.max(6, basePx * 0.9);

        titleEl.style.fontSize = titlePx.toFixed(2) + 'px';
        titleEl.style.lineHeight = '1.15';
        descEl.style.fontSize = descPx.toFixed(2) + 'px';
        descEl.style.lineHeight = '1.35';
        distanceEl.style.fontSize = distPx.toFixed(2) + 'px';
        distanceEl.style.lineHeight = '1.2';

        const titleMargins = getMargins(titleEl);
        const descMargins = getMargins(descEl);
        const distMargins = getMargins(distanceEl);

        const heightUsed =
            titleEl.scrollHeight + titleMargins.top + titleMargins.bottom +
            descEl.scrollHeight + descMargins.top + descMargins.bottom +
            distanceEl.scrollHeight + distMargins.top + distMargins.bottom;

        const widthFits =
            titleEl.scrollWidth <= availableWidth + 1 &&
            descEl.scrollWidth <= availableWidth + 1 &&
            distanceEl.scrollWidth <= availableWidth + 1;

        return heightUsed <= availableHeight + 1 && widthFits;
    };

    let low = 7;
    let high = 46;
    let best = 7;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (fitsAt(mid)) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    fitsAt(best);
}

function scheduleFitInfoText() {
    if (window._infoFitTimer) {
        clearTimeout(window._infoFitTimer);
    }
    window._infoFitTimer = setTimeout(() => {
        requestAnimationFrame(() => fitInfoBannerTextToBox());
    }, 30);
}

function fitHistoryTextToBox() {
    const historyBox = document.getElementById('history-box');
    const historyText = document.getElementById('history-text');
    if (!historyBox || !historyText) return;

    const text = (historyText.textContent || '').trim();
    if (!text) return;

    const boxStyle = window.getComputedStyle(historyBox);
    const padTop = parseFloat(boxStyle.paddingTop) || 0;
    const padBottom = parseFloat(boxStyle.paddingBottom) || 0;
    const padLeft = parseFloat(boxStyle.paddingLeft) || 0;
    const padRight = parseFloat(boxStyle.paddingRight) || 0;

    const titleEl = historyBox.querySelector('.history-title');
    const titleStyle = titleEl ? window.getComputedStyle(titleEl) : null;
    const titleHeight = titleEl
        ? titleEl.getBoundingClientRect().height + (parseFloat(titleStyle.marginBottom) || 0)
        : 0;

    const availableHeight = Math.max(40, historyBox.clientHeight - padTop - padBottom - titleHeight);
    const availableWidth = Math.max(120, historyBox.clientWidth - padLeft - padRight);

    historyText.style.height = Math.round(availableHeight) + 'px';
    historyText.style.maxHeight = Math.round(availableHeight) + 'px';
    historyText.style.overflowY = 'auto';

    const minPx = 9;
    const maxPx = 64;
    let low = minPx;
    let high = maxPx;
    let best = minPx;

    const fitsAt = (px) => {
        historyText.style.fontSize = px + 'px';
        historyText.style.lineHeight = '1.35';
        return historyText.scrollHeight <= availableHeight + 1 && historyText.scrollWidth <= availableWidth + 1;
    };

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (fitsAt(mid)) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    historyText.style.fontSize = best + 'px';
    historyText.style.lineHeight = '1.35';
}

function scheduleFitHistoryText() {
    if (window._historyFitTimer) {
        clearTimeout(window._historyFitTimer);
    }
    window._historyFitTimer = setTimeout(() => {
        requestAnimationFrame(() => fitHistoryTextToBox());
    }, 30);
}

function getCesiumDisplayFontName() {
    const raw = String(localStorage.getItem('selectedFont') || "'Orbitron', sans-serif").trim();
    const first = raw.split(',')[0] || "'Orbitron'";
    const cleaned = first.replace(/['"]/g, '').trim();
    return cleaned || 'Orbitron';
}

window._fitHistoryText = scheduleFitHistoryText;
window._fitInfoText = scheduleFitInfoText;
window.addEventListener('resize', scheduleFitInfoText);
window.addEventListener('resize', scheduleFitHistoryText);

function addHolographicDomes() {
    if (!viewer || !viewer.entities || !viewer.scene) {
        console.warn('[RRC] addHolographicDomes skipped: viewer not ready');
        return;
    }
    console.log('Adding holographic domes, rhythmColorMap keys:', Object.keys(rhythmColorMap));

    // Add domes for BOTH local and community rhythms
    // Uses global allRhythms
    clearDomeAnimationIntervals();
    domeEntities.forEach((entity) => {
        try { viewer.entities.remove(entity); } catch {}
    });
    domeEntities = [];
    const entries = Object.entries(allRhythms);
    const domeProfile = getDomeRenderProfile(entries.length);

    entries.forEach(([key, rhythm]) => {
        const colorData = rhythmColorMap[key];
        if (!colorData) {
            console.error('No color data for rhythm:', key);
            return;
        }
        const cesiumColor = colorData.cesium;
        // Use height offset setting - multiply domeSize by offset factor
        const heightPos = domeSize * sphereHeightOffset;

        // Create a simple translucent sphere
        const entity = viewer.entities.add({
            name: rhythm.name,
            show: true,
            position: Cesium.Cartesian3.fromDegrees(rhythm.lng, rhythm.lat, heightPos),
            ellipsoid: {
                show: true,
                radii: new Cesium.Cartesian3(domeSize, domeSize, domeSize),
                material: cesiumColor.withAlpha(Math.max(0.4, sphereOpacity)),
                outline: true,
                outlineColor: cesiumColor,
                outlineWidth: 2,
                slicePartitions: domeProfile.slicePartitions,
                stackPartitions: domeProfile.stackPartitions
            },
            label: {
                show: domeProfile.showLabels,
                text: rhythm.name,
                font: `bold 14px ${getCesiumDisplayFontName()}`,
                fillColor: cesiumColor,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -50),
                eyeOffset: new Cesium.Cartesian3(0, 0, -50000),
                scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.5, 1.5e7, 0.4),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });

        // Store reference with key for updates and double-click detection
        entity.rhythmKey = key;
        domeEntities.push(entity);

        console.log('Created dome entity for:', key, 'at', rhythm.lat, rhythm.lng);
    });

    // Setup double-click handler for globe selection
    setupGlobeDoubleClick();

    // Log entities for debugging
    console.log('Total dome entities created:', domeEntities.length);
    console.log('Viewer entities count:', viewer.entities.values.length);

    // Start animations after a short delay to ensure entities are rendered
    setTimeout(() => {
        if (domeProfile.animateIdle) {
            domeEntities.forEach(entity => {
                const colorData = rhythmColorMap[entity.rhythmKey];
                if (colorData) {
                    animateDome(entity, colorData.cesium);
                }
            });
            console.log('Dome animations started');
        } else {
            console.log('Dome idle animations disabled for memory profile');
        }
    }, 500);
}

function setupGlobeDoubleClick() {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
        const pickedObject = viewer.scene.pick(click.position);
        if (Cesium.defined(pickedObject) && pickedObject.id && pickedObject.id.rhythmKey) {
            const rhythmKey = pickedObject.id.rhythmKey;
            startJourney(rhythmKey);
        }
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
}

function updateDomesForSource(source) {
    if (!viewer || !viewer.entities || !viewer.scene) {
        console.warn('[RRC] updateDomesForSource skipped: viewer not ready');
        return;
    }
    // Remove existing domes
    clearDomeAnimationIntervals();
    domeEntities.forEach(entity => {
        viewer.entities.remove(entity);
    });
    domeEntities = [];

    // Always populate colors for ALL rhythms
    populateAllRhythmColors();

    const normalizedSource = source === 'Community' || source === 'Local' || source === 'all' || source === DEMO_SOURCE || isUserCollectionSource(source)
        ? source
        : 'all';
    const entries = Object.entries(getFilteredRhythms(normalizedSource));
    const domeProfile = getDomeRenderProfile(entries.length);

    entries.forEach(([key, rhythm]) => {
        const colorData = rhythmColorMap[key];
        if (!colorData) {
            console.error('No color data for rhythm:', key);
            return;
        }
        const cesiumColor = colorData.cesium;
        const heightPos = domeSize * sphereHeightOffset;

        const entity = viewer.entities.add({
            name: rhythm.name,
            show: true,
            position: Cesium.Cartesian3.fromDegrees(rhythm.lng, rhythm.lat, heightPos),
            ellipsoid: {
                show: true,
                radii: new Cesium.Cartesian3(domeSize, domeSize, domeSize),
                material: cesiumColor.withAlpha(Math.max(0.4, sphereOpacity)),
                outline: true,
                outlineColor: cesiumColor,
                outlineWidth: 2,
                slicePartitions: domeProfile.slicePartitions,
                stackPartitions: domeProfile.stackPartitions
            },
            label: {
                show: domeProfile.showLabels,
                text: rhythm.name,
                font: `bold 14px ${getCesiumDisplayFontName()}`,
                fillColor: cesiumColor,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -50),
                eyeOffset: new Cesium.Cartesian3(0, 0, -50000),
                scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.5, 1.5e7, 0.4),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });

        entity.rhythmKey = key;
        domeEntities.push(entity);
        if (domeProfile.animateIdle) animateDome(entity, cesiumColor);
    });

    // Update carousel as well
    populateCarousel();
    renderJourneySourceList();

    viewer.scene.requestRender();
}

function updateLabelSizes(selectedKey) {
    domeEntities.forEach(entity => {
        const key = entity.rhythmKey;
        if (key === selectedKey) {
            // Make selected label larger
            entity.label.font = `bold 18px ${getCesiumDisplayFontName()}`;
            entity.label.scaleByDistance = new Cesium.NearFarScalar(1.0e6, 1.8, 1.5e7, 0.4);
        } else {
            // Make other labels smaller
            entity.label.font = `bold 12px ${getCesiumDisplayFontName()}`;
            entity.label.scaleByDistance = new Cesium.NearFarScalar(1.0e6, 1.2, 1.5e7, 0.3);
        }
    });
}

function updateAllDomes() {
    domeEntities.forEach(entity => {
        const key = entity.rhythmKey;
        const rhythm = allRhythms[key];
        const cesiumColor = rhythmColorMap[key].cesium;
        // Use height offset setting
        const heightPos = domeSize * sphereHeightOffset;

        // Update sphere size
        entity.ellipsoid.radii = new Cesium.Cartesian3(domeSize, domeSize, domeSize);

        // Update position with height offset
        entity.position = Cesium.Cartesian3.fromDegrees(rhythm.lng, rhythm.lat, heightPos);

        // Update material based on wireframe mode
        if (wireframeMode) {
            entity.ellipsoid.material = cesiumColor.withAlpha(0.15);
            entity.ellipsoid.outline = true;
            entity.ellipsoid.outlineColor = cesiumColor.withAlpha(0.8);
        } else {
            entity.ellipsoid.material = cesiumColor.withAlpha(sphereOpacity);
            entity.ellipsoid.outline = showWireframeOutline;
            entity.ellipsoid.outlineColor = cesiumColor.withAlpha(0.8);
        }

        // Update label position
        entity.label.pixelOffset = new Cesium.Cartesian2(0, -80);
    });

    // Force scene to re-render
    if (viewer && viewer.scene) {
        viewer.scene.requestRender();
    }
}

function animateDome(entity, color) {
    if (!entity || !entity.ellipsoid) {
        console.warn('Invalid entity passed to animateDome');
        return;
    }

    let scale = 1.0;
    let growing = true;
    const key = entity.rhythmKey;
    if (!key) return;
    const existingTimer = domeAnimationIntervals.get(key);
    if (existingTimer) {
        try { clearInterval(existingTimer); } catch {}
        domeAnimationIntervals.delete(key);
    }

    const timerId = setInterval(() => {
        // Safety check - make sure entity still exists
        if (!entity || !entity.ellipsoid || !domeEntities.includes(entity)) {
            const staleTimer = domeAnimationIntervals.get(key);
            if (staleTimer) {
                try { clearInterval(staleTimer); } catch {}
                domeAnimationIntervals.delete(key);
            }
            return;
        }

        // Skip animation for selected rhythm (it has its own special animation)
        if (selectedRhythm === key) return;

        if (!isJourneyActive) {
            if (growing) {
                scale += 0.008;
                if (scale >= 1.2) growing = false;
            } else {
                scale -= 0.008;
                if (scale <= 1.0) growing = true;
            }

            // Update sphere size with pulsing effect
            const size = domeSize * scale;
            entity.ellipsoid.radii = new Cesium.Cartesian3(size, size, size);

            // Get current color
            const currentColor = rhythmColorMap[key] ? rhythmColorMap[key].cesium : color;

            // Shimmer effect - vary alpha
            const alpha = sphereOpacity + (scale - 1.0) * 0.25;

            // Update material
            if (wireframeMode) {
                entity.ellipsoid.material = currentColor.withAlpha(0.1 + (scale - 1.0) * 0.2);
                entity.ellipsoid.outline = true;
                entity.ellipsoid.outlineColor = currentColor.withAlpha(0.8);
            } else {
                entity.ellipsoid.material = currentColor.withAlpha(alpha);
                entity.ellipsoid.outline = showWireframeOutline;
                if (showWireframeOutline) {
                    entity.ellipsoid.outlineColor = currentColor.withAlpha(0.8);
                }
            }
        }
    }, 100);
    domeAnimationIntervals.set(key, timerId);
}

function animateSelectedDome(rhythmKey) {
    // Clear previous selected animation
    if (selectedAnimationInterval) {
        clearInterval(selectedAnimationInterval);
        selectedAnimationInterval = null;
    }

    const entity = domeEntities.find(e => e.rhythmKey === rhythmKey);
    if (!entity) return;

    const cesiumColor = rhythmColorMap[rhythmKey].cesium;
    let pulse = 0;

    selectedAnimationInterval = setInterval(() => {
        pulse += 0.1;
        const scale = 1.0 + Math.sin(pulse) * 0.3;
        const size = domeSize * scale;
        entity.ellipsoid.radii = new Cesium.Cartesian3(size, size, size);

        // Pulse the alpha as well
        const alpha = sphereOpacity + Math.sin(pulse) * 0.2;
        entity.ellipsoid.material = cesiumColor.withAlpha(Math.min(1, Math.max(0.2, alpha)));

        // Always show stronger glow outline for selected dome
        entity.ellipsoid.outline = true;
        entity.ellipsoid.outlineColor = cesiumColor.withAlpha(0.9);
    }, 50);
}

function addUserMarker() {
    viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(userLocation.lng, userLocation.lat, 0),
        point: {
            pixelSize: 16,
            color: Cesium.Color.CYAN,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3
        },
        label: {
            text: 'You',
            font: `13px ${getCesiumDisplayFontName()}`,
            fillColor: Cesium.Color.CYAN,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -18)
        }
    });
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function createGlowPath(startLat, startLng, endLat, endLng, color) {
    const positions = [];
    const steps = 200;

    const distance = calculateDistance(startLat, startLng, endLat, endLng);
    const dynamicArcHeight = distance * 1000 * arcHeightFactor;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const lat = startLat + (endLat - startLat) * t;
        const lng = startLng + (endLng - startLng) * t;
        const height = dynamicArcHeight * Math.sin(t * Math.PI);
        positions.push(Cesium.Cartesian3.fromDegrees(lng, lat, height));
    }

    // Base path (subtle)
    const basePath = viewer.entities.add({
        polyline: { positions, width: pathWidth * 0.4, material: color.withAlpha(0.2) }
    });

    let animationProgress = 0;

    // Animated glow segment
    const animatedSegment = viewer.entities.add({
        polyline: {
            positions: new Cesium.CallbackProperty(() => {
                const startIdx = Math.floor(animationProgress * steps);
                const endIdx = Math.min(steps, Math.floor((animationProgress + pathLength) * steps));
                return positions.slice(startIdx, endIdx + 1);
            }, false),
            width: pathWidth,
            material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.3, taperPower: 0.8, color })
        }
    });

    // Airplane model riding the path
    let planeEnt = null;
    if (showPlane) {
        try {
            planeEnt = viewer.entities.add({
                position: new Cesium.CallbackProperty(() => {
                    // Place plane at the FRONT (leading edge) of the glow segment
                    const frontProgress = Math.min(1, animationProgress + pathLength);
                    const idx = Math.min(steps, Math.floor(frontProgress * steps));
                    return positions[idx] || positions[0];
                }, false),
                orientation: new Cesium.CallbackProperty(() => {
                    const frontProgress = Math.min(1, animationProgress + pathLength);
                    const idx = Math.min(steps - 1, Math.floor(frontProgress * steps));
                    const nextIdx = Math.min(steps, idx + 1);
                    const pos = positions[idx];
                    const nextPos = positions[nextIdx];
                    // Compute heading from current to next position
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    const nextCarto = Cesium.Cartographic.fromCartesian(nextPos);
                    const dLon = nextCarto.longitude - carto.longitude;
                    const y = Math.sin(dLon) * Math.cos(nextCarto.latitude);
                    const x = Math.cos(carto.latitude) * Math.sin(nextCarto.latitude) -
                        Math.sin(carto.latitude) * Math.cos(nextCarto.latitude) * Math.cos(dLon);
                    const bearing = Math.atan2(y, x);
                    // Compute pitch from altitude change
                    const dist3d = Cesium.Cartesian3.distance(pos, nextPos);
                    const dAlt = nextCarto.height - carto.height;
                    const pitchAngle = dist3d > 0 ? Math.asin(dAlt / dist3d) : 0;
                    // Apply user offsets (in degrees, converted to radians)
                    const hpr = new Cesium.HeadingPitchRoll(
                        bearing + Cesium.Math.toRadians(planeHeading),
                        pitchAngle + Cesium.Math.toRadians(planePitch),
                        Cesium.Math.toRadians(planeRoll)
                    );
                    return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
                }, false),
                model: {
                    uri: PLANE_MODEL_URL,
                    minimumPixelSize: 16,
                    scale: planeScale,
                    color: color.withAlpha(0.9),
                    colorBlendMode: Cesium.ColorBlendMode.MIX,
                    colorBlendAmount: 0.4,
                    silhouetteColor: color,
                    silhouetteSize: 1.5
                }
            });
            planeEntity = planeEnt;
        } catch (err) { console.warn('Could not load plane model:', err); }
    }

    const animationInterval = setInterval(() => {
        animationProgress += pathSpeed;
        if (animationProgress >= 1.0) animationProgress = 0;
    }, 30);

    const entities = [basePath, animatedSegment];
    if (planeEnt) entities.push(planeEnt);

    return { entities, animationInterval };
}

function disableButtons() {
    document.querySelectorAll('.rhythm-point').forEach(btn => {
        btn.style.pointerEvents = 'none';
        btn.style.opacity = '0.5';
    });
}

function enableButtons() {
    document.querySelectorAll('.rhythm-point').forEach(btn => {
        btn.style.pointerEvents = 'auto';
        btn.style.opacity = '1';
    });
}

// Handle rhythm preview button click - placeholder for now
function handleRhythmPreview(rhythmKey) {
    const rhythm = allRhythms[rhythmKey];
    if (!rhythm) return;
    console.log(`Preview rhythm: ${rhythm.name}`);
    // Visual feedback
    document.querySelectorAll(`.rhythm-preview-btn[data-rhythm="${rhythmKey}"], .carousel-preview-btn[data-rhythm="${rhythmKey}"]`).forEach(btn => {
        btn.style.transform = 'scale(1.2)';
        btn.style.boxShadow = '0 0 15px currentColor';
        setTimeout(() => { btn.style.transform = ''; btn.style.boxShadow = ''; }, 300);
    });
}

// Press-and-hold audio preview on sound icon buttons
function setupPreviewHold(btn, rhythmKey) {
    let holding = false;

    function startPreview(e) {
        e.preventDefault(); e.stopPropagation();
        holding = true;
        const url = getFirstVideoUrl(rhythmKey);
        if (url && useFirstVideoAsAudio) {
            playBackgroundAudio(url);
        }
        btn.style.transform = 'scale(1.2)';
        btn.style.boxShadow = '0 0 15px currentColor';
    }
    function stopPreview(e) {
        if (!holding) return;
        e.preventDefault(); e.stopPropagation();
        holding = false;
        stopBackgroundAudio();
        btn.style.transform = '';
        btn.style.boxShadow = '';
    }

    btn.addEventListener('mousedown', startPreview);
    btn.addEventListener('touchstart', startPreview, { passive: false });
    btn.addEventListener('mouseup', stopPreview);
    btn.addEventListener('mouseleave', stopPreview);
    btn.addEventListener('touchend', stopPreview);
    btn.addEventListener('touchcancel', stopPreview);
    // Prevent click from triggering journey
    btn.addEventListener('click', e => { e.stopPropagation(); });
}

async function startJourney(rhythmType, options = {}) {
    const runToken = ++journeyRunToken;
    const isLatestRun = () => runToken === journeyRunToken;
    const fromSession = !!options.fromSession;
    const noSessionBroadcast = !!options.noSessionBroadcast;
    const skipTravel = !!options.skipTravel;
    const preserveWindowVisibility = !!options.preserveWindowVisibility
        || document.documentElement.matches('.rrc-room, .rrc-room-boot');
    let restoreWindowStateAfterTravel = null;
    let windowsHiddenForTravel = false;
    let mainNotationWasVisibleBeforeTravel = false;
    let circularNotationWasVisibleBeforeTravel = false;
    let resolvedJourneyRhythmKey = '';
    let resolvedJourneyRhythm = null;
    const captureFloatingWindowVisibility = () => {
        const state = {};
        document.querySelectorAll('[data-floating-window="true"]').forEach((panel) => {
            if (!(panel instanceof HTMLElement) || !panel.id) return;
            state[panel.id] = {
                hidden: panel.classList.contains('hidden'),
                panelHidden: panel.classList.contains('panel-hidden'),
                active: panel.classList.contains('active')
            };
        });
        return state;
    };
    const hideFloatingWindowsForTravel = () => {
        document.querySelectorAll('[data-floating-window="true"]').forEach((panel) => {
            if (!(panel instanceof HTMLElement)) return;
            const id = String(panel.id || '').trim();
            if (id === 'cesiumContainer') {
                panel.classList.remove('hidden', 'panel-hidden');
                return;
            }
            panel.classList.add('hidden', 'panel-hidden');
            panel.classList.remove('active');
        });
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };
    const restoreFloatingWindowVisibility = (state) => {
        if (!state || typeof state !== 'object') return;
        Object.entries(state).forEach(([id, saved]) => {
            const panel = document.getElementById(id);
            if (!(panel instanceof HTMLElement)) return;
            panel.classList.toggle('hidden', !!saved.hidden);
            panel.classList.toggle('panel-hidden', !!saved.panelHidden);
            panel.classList.toggle('active', !!saved.active);
        });
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };
    const forceJourneyWindowsVisible = () => {
        const ensureJourneyWindowVisible = (windowId, toggleId) => {
            const panel = document.getElementById(windowId);
            if (panel) {
                panel.classList.remove('hidden', 'panel-hidden');
                panel.classList.add('active');
                panel.style.display = '';
                panel.style.visibility = '';
                panel.style.opacity = '';
                panel.style.pointerEvents = '';
            }
            const toggle = document.getElementById(toggleId);
            if (toggle) toggle.classList.add('active');
        };
        ensureJourneyWindowVisible('info-banner', 'info-toggle');
        ensureJourneyWindowVisible('history-box', 'history-toggle');
        ensureJourneyWindowVisible('image-window', 'media-toggle');
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
    };
    const forceJourneyUiFailSafe = () => {
        if (preserveWindowVisibility || fromSession) return;
        forceJourneyWindowsVisible();
    };
    const hydrateJourneyContentFallback = () => {
        if (preserveWindowVisibility || fromSession) return;
        const key = String(resolvedJourneyRhythmKey || selectedRhythm || '').trim();
        const rhythm = resolvedJourneyRhythm || (key ? allRhythms[key] : null);
        if (!rhythm) return;

        const infoTitleEl = document.getElementById('info-title');
        const infoDescEl = document.getElementById('info-description');
        const historyTextEl = document.getElementById('history-text');
        const contextImageEl = document.getElementById('context-image');
        const defaultImage = getBundledFallbackImage(key || rhythm?.name || 'journey-media');
        const hasInfo = !!String(infoTitleEl?.textContent || '').trim();
        const hasContext = !!String(historyTextEl?.textContent || '').trim();

        if (!hasInfo && infoTitleEl) {
            infoTitleEl.textContent = `${rhythm.name || key} - ${rhythm.location || ''}`.trim();
        }
        if (infoDescEl && !String(infoDescEl.textContent || '').trim()) {
            infoDescEl.textContent = String(rhythm.description || '');
        }
        if (!hasContext && historyTextEl) {
            historyTextEl.textContent = String(rhythm.culturalContext || '');
        }
        if (contextImageEl && !String(contextImageEl.src || '').trim()) {
            contextImageEl.src = rhythm.cachedImageUrl || defaultImage;
        }

        const rebuildMediaItems = !Array.isArray(currentMediaItems) || currentMediaItems.length === 0;
        if (rebuildMediaItems) {
            currentMediaItems = [];
            const photoUrl = rhythm.cachedImageUrl || defaultImage;
            currentMediaItems.push({
                type: 'photo',
                url: photoUrl,
                embedUrl: '',
                caption: rhythm.imageCaption || rhythm.name || ''
            });
            const videos = (rhythm.listeningExamples && rhythm.listeningExamples.length > 0)
                ? rhythm.listeningExamples
                : (rhythm.videoUrl ? [{ url: rhythm.videoUrl, caption: '' }] : []);
            videos.forEach((v) => {
                if (v && v.url) {
                    currentMediaItems.push({
                        type: 'video',
                        url: v.url,
                        embedUrl: v.url,
                        caption: v.caption || ''
                    });
                }
            });
            currentMediaIndex = Math.max(0, Math.min(currentMediaItems.length - 1, currentMediaIndex || 0));
            if (typeof window._updateMediaGallery === 'function') {
                window._updateMediaGallery();
            }
        }
    };
    const scheduleJourneyUiReassert = () => {
        if (preserveWindowVisibility || fromSession) return;
        requestAnimationFrame(() => {
            if (!isLatestRun()) return;
            forceJourneyUiFailSafe();
            hydrateJourneyContentFallback();
        });
        setTimeout(() => {
            if (!isLatestRun()) return;
            forceJourneyUiFailSafe();
            hydrateJourneyContentFallback();
        }, 180);
    };
    const restoreNotationVisibilityFromPreTravel = () => {
        if (preserveWindowVisibility || fromSession || skipTravel) return;
        const mainOverlay = document.getElementById('notation-overlay');
        const circularOverlay = document.getElementById('notation-circular-overlay');
        if (mainOverlay) {
            mainOverlay.classList.toggle('hidden', !mainNotationWasVisibleBeforeTravel);
            mainOverlay.classList.toggle('panel-hidden', !mainNotationWasVisibleBeforeTravel);
            mainOverlay.classList.toggle('active', !!mainNotationWasVisibleBeforeTravel);
        }
        if (circularOverlay) {
            circularOverlay.classList.toggle('hidden', !circularNotationWasVisibleBeforeTravel);
            circularOverlay.classList.toggle('panel-hidden', !circularNotationWasVisibleBeforeTravel);
            circularOverlay.classList.toggle('active', !!circularNotationWasVisibleBeforeTravel);
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };
    const resolveRhythmByInput = (value) => {
        const target = String(value || '').trim();
        if (!target) return { key: '', rhythm: null };
        if (allRhythms[target]) return { key: target, rhythm: allRhythms[target] };
        const targetLower = target.toLowerCase();
        for (const [key, entry] of Object.entries(allRhythms || {})) {
            if (!entry) continue;
            if (String(key || '').trim().toLowerCase() === targetLower) return { key, rhythm: entry };
            if (String(entry.name || '').trim().toLowerCase() === targetLower) return { key, rhythm: entry };
        }
        return { key: '', rhythm: null };
    };
    if (isSessionFollower() && !fromSession) {
        sessionSetStatus('Leader controls rhythm selection during session.', 'warn');
        return;
    }
    if (isJourneyActive) {
        try {
            if (pathEntity) {
                if (pathEntity.animationInterval) clearInterval(pathEntity.animationInterval);
                if (pathEntity.entities) pathEntity.entities.forEach((entity) => viewer?.entities?.remove(entity));
                pathEntity = null;
            }
            const overlayEl = document.getElementById('journey-overlay');
            if (overlayEl) overlayEl.classList.remove('active');
        } catch {}
        isJourneyActive = false;
    }

    isJourneyActive = true;
    disableButtons();
    try {
        if (!isLatestRun()) return;
        let resolvedRhythmKey = String(rhythmType || '').trim();
        let resolvedRhythm = resolveRhythmByInput(resolvedRhythmKey);
        if (!resolvedRhythm.rhythm && loadDatabaseOnStartup) {
            try {
                await refreshRhythmDatabaseAndUi({ silent: true });
            } catch {}
            if (!isLatestRun()) return;
            resolvedRhythm = resolveRhythmByInput(resolvedRhythmKey);
        }
        if (!resolvedRhythm.rhythm && selectedRhythm) {
            resolvedRhythm = resolveRhythmByInput(selectedRhythm);
        }
        if (!resolvedRhythm.rhythm) {
            resolvedRhythmKey = ensureSelectedRhythmBootstrap();
            resolvedRhythm = resolveRhythmByInput(resolvedRhythmKey);
        }

        const rhythm = resolvedRhythm.rhythm;
        rhythmType = resolvedRhythm.key || resolvedRhythmKey;
        resolvedJourneyRhythmKey = String(rhythmType || '').trim();
        resolvedJourneyRhythm = rhythm || null;

        if (!rhythm) {
            console.error('Rhythm not found:', rhythmType);
            return;
        }

    if (isSessionLeader() && !fromSession && !noSessionBroadcast) {
        sessionState.rhythmKey = rhythmType;
        resetSessionTickBroadcastState();
        void sendSessionEvent('rhythm_selected', {
            rhythmKey: rhythmType,
            rhythmPayload: buildSessionRhythmPayload(rhythmType)
        });
        void sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({ rhythmKey: rhythmType }));
        void announceSessionDirectory(true);
    }

    stopBackgroundAudio();

        const rhythmHexColor = rhythmColorMap[rhythmType]?.hex || '#00ffff';
        const distance = calculateDistance(
            currentLocation.lat, currentLocation.lng,
            rhythm.lat, rhythm.lng
        );

        // Update label sizes - make selected rhythm's label larger
        selectedRhythm = rhythmType;
        localStorage.setItem(LAST_SELECTED_RHYTHM_STORAGE_KEY, rhythmType);
        // In the room and in sessions the player switches now, not when the travel animation ends:
        // a leader pressing Play mid-journey must not play the old rhythm while followers play the new one.
        if ((document.documentElement.classList.contains('rrc-room') || sessionState.active) && window._updateNotation) {
            try { window._updateNotation(rhythm.name); } catch {}
        }
        // The room view follows the journey: it hands over to the globe for the flight and takes over again on arrival.
        const announceJourneyPhase = (phase) => {
            try {
                window.dispatchEvent(new CustomEvent('rrc:journey', {
                    detail: {
                        phase,
                        key: rhythmType,
                        name: rhythm.name,
                        location: rhythm.fullLocation || rhythm.location || '',
                        description: rhythm.description || '',
                        lat: rhythm.lat,
                        lng: rhythm.lng,
                        color: rhythmHexColor,
                        travel: !skipTravel
                    }
                }));
            } catch {}
        };
        announceJourneyPhase('start');
        updateLabelSizes(selectedRhythm);
        animateSelectedDome(selectedRhythm);
        if (window.RRCBridge && typeof window.RRCBridge.emit === 'function') {
            window.RRCBridge.emit('rhythm_selected', {
                rhythmKey: rhythmType,
                rhythmName: rhythm.name || rhythmType
            });
        }

        if (!preserveWindowVisibility && !fromSession && !skipTravel) {
            const mainOverlay = document.getElementById('notation-overlay');
            const circularOverlay = document.getElementById('notation-circular-overlay');
            mainNotationWasVisibleBeforeTravel = !!mainOverlay
                && mainOverlay.classList.contains('active')
                && !mainOverlay.classList.contains('hidden')
                && !mainOverlay.classList.contains('panel-hidden');
            circularNotationWasVisibleBeforeTravel = !!circularOverlay
                && circularOverlay.classList.contains('active')
                && !circularOverlay.classList.contains('hidden')
                && !circularOverlay.classList.contains('panel-hidden');
            restoreWindowStateAfterTravel = captureFloatingWindowVisibility();
            hideFloatingWindowsForTravel();
            windowsHiddenForTravel = true;
        }

        if (!skipTravel) {
        const effectiveZoomOutAltitude = normalizeJourneyAltitudeMeters(zoomOutAltitude, 20000000);
        const effectiveZoomInAltitude = normalizeJourneyAltitudeMeters(zoomInAltitude, 600000);
        const effectiveZoomOutDuration = normalizeJourneyDurationSeconds(zoomOutDuration, 2.0);
        const effectiveZoomPauseDuration = normalizeJourneyDurationSeconds(zoomPauseDuration, 0.5);
        const effectiveZoomInDuration = normalizeJourneyDurationSeconds(zoomInDuration, 2.5);

        // Show journey overlay with rhythm name in big colored text
        const journeyTitle = document.getElementById('journey-title');
        journeyTitle.textContent = rhythm.name;
        journeyTitle.style.background = `linear-gradient(135deg, ${rhythmHexColor}, ${rhythmHexColor}cc)`;
        journeyTitle.style.webkitBackgroundClip = 'text';
        journeyTitle.style.webkitTextFillColor = 'transparent';
        journeyTitle.style.backgroundClip = 'text';

        document.getElementById('journey-subtitle').textContent = 'Traveling to ' + rhythm.fullLocation;
        document.getElementById('journey-overlay').classList.add('active');

        // Create path from CURRENT location with matched color
        if (pathEntity) {
            if (pathEntity.animationInterval) {
                clearInterval(pathEntity.animationInterval);
            }
            if (pathEntity.entities) {
                pathEntity.entities.forEach(entity => viewer.entities.remove(entity));
            }
        }
        const rhythmColor = rhythmColorMap[rhythmType]?.cesium || Cesium.Color.fromCssColorString(rhythmHexColor) || Cesium.Color.CYAN;
        pathEntity = createGlowPath(currentLocation.lat, currentLocation.lng, rhythm.lat, rhythm.lng, rhythmColor);

        // Helper function to wrap flyTo in a proper Promise
        function flyToPromise(options) {
            return new Promise((resolve) => {
                viewer.camera.flyTo({
                    ...options,
                    complete: () => resolve()
                });
            });
        }

        // STEP 1: Zoom out to global view to show the path
        if (viewer?.camera && Number.isFinite(rhythm.lng) && Number.isFinite(rhythm.lat)) {
            await flyToPromise({
                destination: Cesium.Cartesian3.fromDegrees(
                    (currentLocation.lng + rhythm.lng) / 2,
                    (currentLocation.lat + rhythm.lat) / 2,
                    effectiveZoomOutAltitude
                ),
                duration: effectiveZoomOutDuration,
                easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
            });
            if (!isLatestRun()) return;

            // Pause at the zoomed out view
            await new Promise(resolve => setTimeout(resolve, effectiveZoomPauseDuration * 1000));
            if (!isLatestRun()) return;

            // STEP 2: Zoom in to destination
            await flyToPromise({
                destination: Cesium.Cartesian3.fromDegrees(rhythm.lng, rhythm.lat, effectiveZoomInAltitude),
                duration: effectiveZoomInDuration,
                easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
            });
            if (!isLatestRun()) return;
        }

        // Update current location for next journey
        currentLocation = { lat: rhythm.lat, lng: rhythm.lng };

        // Hide journey overlay
        document.getElementById('journey-overlay').classList.remove('active');

            // Restore rhythm panel layout baseline (panel may remain hidden by focused journey flow).
            document.getElementById('rhythm-panel').style.opacity = '1';
            document.getElementById('rhythm-panel').style.pointerEvents = 'auto';
        }

        if (!isLatestRun()) return;
        announceJourneyPhase('arrive');

        // Update rhythm panel border to match selected rhythm
        const rhythmPanel = document.getElementById('rhythm-panel');
        if (rhythmPanel) {
            rhythmPanel.style.setProperty('--rhythm-accent', rhythmHexColor);
            rhythmPanel.style.borderColor = `${rhythmHexColor}66`;
            rhythmPanel.style.boxShadow = `0 0 30px ${rhythmHexColor}50, inset 0 0 20px ${rhythmHexColor}15`;
        }

        // Update global scrollbar theme to the selected rhythm color.
        document.documentElement.style.setProperty('--rrc-scrollbar-thumb', `${rhythmHexColor}80`);
        document.documentElement.style.setProperty('--rrc-scrollbar-thumb-hover', `${rhythmHexColor}`);
        document.documentElement.style.setProperty('--rrc-scrollbar-track-glow', `${rhythmHexColor}30`);

        // Update info banner with rhythm color
        const infoBanner = document.getElementById('info-banner');
        const infoToggle = document.getElementById('info-toggle');
        if (!preserveWindowVisibility) {
            infoBanner.classList.remove('hidden', 'panel-hidden');
            if (infoToggle) infoToggle.classList.add('active');
        }
        infoBanner.style.borderColor = `${rhythmHexColor}80`;
        infoBanner.style.boxShadow = `0 0 30px ${rhythmHexColor}60, inset 0 0 20px ${rhythmHexColor}20`;

        document.getElementById('info-title').textContent = rhythm.name + ' - ' + rhythm.location;
        document.getElementById('info-title').style.color = rhythmHexColor;
        document.getElementById('info-title').style.textShadow = `0 0 10px ${rhythmHexColor}99`;

    // Keep description text white
        document.getElementById('info-description').textContent = rhythm.description;
        document.getElementById('info-description').style.color = '#ffffff';

        document.getElementById('info-distance').textContent = Math.round(distance).toLocaleString() + ' km from previous location';
        document.getElementById('info-distance').style.color = '#aaaaaa';

        if (!preserveWindowVisibility) {
            document.getElementById('info-banner').classList.add('active');
        }
        scheduleFitInfoText();

        // Update history box with rhythm color
        const historyBox = document.getElementById('history-box');
        const historyToggle = document.getElementById('history-toggle');
        if (!preserveWindowVisibility) {
            historyBox.classList.remove('hidden', 'panel-hidden');
            if (historyToggle) historyToggle.classList.add('active');
        }
        historyBox.style.borderColor = `${rhythmHexColor}66`;
        historyBox.style.boxShadow = `0 0 30px ${rhythmHexColor}40, inset 0 0 20px ${rhythmHexColor}10`;

        const historyTitle = historyBox.querySelector('.history-title');
        historyTitle.style.color = rhythmHexColor;
        historyTitle.style.textShadow = `0 0 10px ${rhythmHexColor}99`;

    // Keep context text white
        document.getElementById('history-text').textContent = rhythm.culturalContext;
        document.getElementById('history-text').style.color = '#ffffff';
        if (!preserveWindowVisibility) {
            document.getElementById('history-box').classList.add('active');
        }
        scheduleFitHistoryText();

        // Update image window with rhythm color
        const imageWindow = document.getElementById('image-window');
        const mediaToggle = document.getElementById('media-toggle');
        if (!preserveWindowVisibility) {
            imageWindow.classList.remove('hidden', 'panel-hidden');
            if (mediaToggle) mediaToggle.classList.add('active');
        }
        imageWindow.style.borderColor = `${rhythmHexColor}66`;
        imageWindow.style.boxShadow = `0 0 30px ${rhythmHexColor}40, inset 0 0 20px ${rhythmHexColor}08`;
        imageWindow.style.color = rhythmHexColor; // For the focus button icon

        const defaultImage = getBundledFallbackImage(selectedRhythm || rhythm?.name || 'journey-media');
        const contextImageEl = document.getElementById('context-image');
        contextImageEl.onerror = () => {
            contextImageEl.onerror = null;
            contextImageEl.src = defaultImage;
        };
        contextImageEl.src = rhythm.cachedImageUrl || defaultImage;
        contextImageEl.style.borderColor = `${rhythmHexColor}50`;

        // Build unified media gallery: photo first, then all videos
        currentMediaItems = [];
        // Add the photo
        const photoUrl = rhythm.cachedImageUrl || defaultImage;
        currentMediaItems.push({ type: 'photo', url: photoUrl, embedUrl: '', caption: rhythm.imageCaption || rhythm.name });
        // Add all videos
        const videos = (rhythm.listeningExamples && rhythm.listeningExamples.length > 0)
            ? rhythm.listeningExamples
            : (rhythm.videoUrl ? [{ url: rhythm.videoUrl, caption: '' }] : []);
        videos.forEach(v => {
            if (v.url) currentMediaItems.push({ type: 'video', url: v.url, embedUrl: v.url, caption: v.caption || '' });
        });
        currentMediaIndex = 0;

        if (window._updateMediaGallery) window._updateMediaGallery();

        // Update song texts for lyrics overlay
        currentSongTexts = rhythm.songTexts || [];
        document.getElementById('lyrics-overlay').classList.remove('active');
        document.getElementById('media-lyrics-btn').classList.remove('active');

        // Update notation if visible
        if (window._updateNotation) window._updateNotation(rhythm.name);

        if (!preserveWindowVisibility) {
            document.getElementById('image-window').classList.add('active');
            forceJourneyWindowsVisible();
        }

        // Update carousel active state
        document.querySelectorAll('.carousel-card').forEach(c => c.classList.remove('active'));
        document.querySelectorAll(`.carousel-card[data-rhythm="${rhythmType}"]`).forEach(c => c.classList.add('active'));
    } catch (err) {
        console.error('startJourney failed:', err);
    } finally {
        const latestRun = isLatestRun();
        if (!latestRun) return;
        try {
            const isPadRemoteRuntime = typeof window._isPadRemoteMode === 'function' && !!window._isPadRemoteMode();
            if (windowsHiddenForTravel && restoreWindowStateAfterTravel) {
                restoreFloatingWindowVisibility(restoreWindowStateAfterTravel);
                if (!preserveWindowVisibility && !fromSession && !skipTravel) {
                    forceJourneyWindowsVisible();
                }
                const rhythmPanel = document.getElementById('rhythm-panel');
                const rhythmState = restoreWindowStateAfterTravel['rhythm-panel'];
                const shouldShowRhythmPanel = !isPadRemoteRuntime && (!rhythmState || (!rhythmState.hidden && !rhythmState.panelHidden));
                const forceShowRhythmPanel = !isPadRemoteRuntime && !!restoreRhythmPanelAfterJourney;
                if (rhythmPanel && (forceShowRhythmPanel || shouldShowRhythmPanel)) {
                    rhythmPanel.classList.remove('hidden', 'panel-hidden');
                    if (typeof window._syncTopPanelToggleStates === 'function') {
                        window._syncTopPanelToggleStates();
                    }
                }
            }
            if (!isPadRemoteRuntime && !preserveWindowVisibility && !fromSession && !skipTravel && restoreRhythmPanelAfterJourney) {
                const rhythmPanel = document.getElementById('rhythm-panel');
                if (rhythmPanel) rhythmPanel.classList.remove('hidden', 'panel-hidden');
            }
            if (!preserveWindowVisibility) {
                forceJourneyUiFailSafe();
                restoreNotationVisibilityFromPreTravel();
                hydrateJourneyContentFallback();
                scheduleJourneyUiReassert();
                if (isPadRemoteRuntime && typeof window._setPadRemoteMobileView === 'function') {
                    // On mobile journey completion, keep focus on compact Journey view.
                    window._setPadRemoteMobileView('journey', { persist: false });
                }
            }
        } catch (restoreErr) {
            console.error('startJourney restore failed:', restoreErr);
        }
        isJourneyActive = false;
        try { enableButtons(); } catch {}
        try { applySessionInteractionLocks(); } catch {}
    }
}

function restoreLastSelectedRhythmOnLoad() {
    const resolved = ensureSelectedRhythmBootstrap();
    if (!resolved || !allRhythms[resolved]) return;
    startJourney(resolved, {
        skipTravel: true,
        preserveWindowVisibility: true,
        suppressAutoAudio: true,
        noSessionBroadcast: true
    }).catch(() => {});
}

// ─── BACKGROUND AUDIO (hidden iframe for rhythm audio) ────

function setupBackgroundAudio() {
    // Create a hidden iframe for background audio playback
    bgAudioIframe = document.createElement('iframe');
    bgAudioIframe.id = 'bg-audio-iframe';
    bgAudioIframe.allow = 'autoplay';
    bgAudioIframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:none;pointer-events:none;opacity:0;';
    document.body.appendChild(bgAudioIframe);
}

function playBackgroundAudio(videoUrl) {
    if (sessionState.active && !sessionState.freeMode) return;
    if (!bgAudioIframe || !videoUrl) return;
    bgAudioFading = false;
    bgAudioActive = true;
    // Add autoplay and mute=0 to play audio
    const sep = videoUrl.includes('?') ? '&' : '?';
    bgAudioIframe.src = videoUrl + sep + 'autoplay=1';
}

function stopBackgroundAudio() {
    if (!bgAudioIframe || !bgAudioActive) return;
    bgAudioFading = true;
    // Fade: set iframe to a muted version briefly, then kill it
    // Since YouTube iframes don't expose volume, we use opacity as visual cue
    // and a timed ramp-down
    bgAudioIframe.style.transition = 'opacity 0.5s';
    bgAudioIframe.style.opacity = '0';
    setTimeout(() => {
        if (bgAudioFading) {
            bgAudioIframe.src = '';
            bgAudioActive = false;
            bgAudioFading = false;
            bgAudioIframe.style.opacity = '0';
        }
    }, 500);
}

function stopAllAudioPlayback() {
    stopBackgroundAudio();
    notationPlaybackActive = false;

    const bridge = window._notationBridge;
    if (bridge && typeof bridge.postMain === 'function') {
        try { bridge.postMain({ type: 'stopPlayback' }); } catch {}
    }
    if (bridge && typeof bridge.postCircular === 'function') {
        try { bridge.postCircular({ type: 'stopPlayback' }); } catch {}
    }

    const notationIframe = document.getElementById('notation-iframe');
    if (notationIframe && notationIframe.contentWindow) {
        try { notationIframe.contentWindow.postMessage({ type: 'stopPlayback' }, '*'); } catch {}
    }
    const circularNotationIframe = document.getElementById('notation-circular-iframe');
    if (circularNotationIframe && circularNotationIframe.contentWindow) {
        try { circularNotationIframe.contentWindow.postMessage({ type: 'stopPlayback' }, '*'); } catch {}
    }

    const mediaVideo = document.getElementById('video-player');
    const mediaVideoContainer = document.getElementById('video-player-container');
    if (mediaVideo) {
        mediaVideo.src = '';
        mediaVideo.dataset.mediaEmbedBase = '';
    }
    if (mediaVideoContainer) mediaVideoContainer.classList.remove('active');

    const contextImage = document.getElementById('context-image');
    if (contextImage && contextImage.style.display === 'none') contextImage.style.display = '';
    const lyricsOverlay = document.getElementById('lyrics-overlay');
    if (lyricsOverlay) lyricsOverlay.classList.remove('active');
    const lyricsBtn = document.getElementById('media-lyrics-btn');
    if (lyricsBtn) lyricsBtn.classList.remove('active');

    document.querySelectorAll('audio, video').forEach((mediaEl) => {
        try {
            mediaEl.pause();
            if (typeof mediaEl.currentTime === 'number') mediaEl.currentTime = 0;
        } catch {}
    });
}

function setupGlobalAudioStopButton() {
    const button = document.getElementById('mute-all-audio-btn');
    if (!button || button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    let releaseTimer = null;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        stopAllAudioPlayback();
        button.classList.add('active');
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
            button.classList.remove('active');
            releaseTimer = null;
        }, 180);
    });
}

function getFirstVideoUrl(rhythmKey) {
    const rhythm = allRhythms[rhythmKey];
    if (!rhythm) return null;
    if (rhythm.listeningExamples && rhythm.listeningExamples.length > 0) {
        return rhythm.listeningExamples[0].url || null;
    }
    return rhythm.videoUrl || null;
}

// ─── UNIFIED MEDIA GALLERY (photos + videos in one nav) ───

function setupMediaGallery() {
    const nav = document.getElementById('media-nav');
    const label = document.getElementById('media-nav-label');
    const prevBtn = document.getElementById('media-prev-btn');
    const nextBtn = document.getElementById('media-next-btn');
    const caption = document.getElementById('media-caption');
    const contextImage = document.getElementById('context-image');
    const videoContainer = document.getElementById('video-player-container');
    const player = document.getElementById('video-player');

    function showItem(index) {
        if (currentMediaItems.length === 0) return;
        // Endless loop: wrap around
        currentMediaIndex = ((index % currentMediaItems.length) + currentMediaItems.length) % currentMediaItems.length;
        const item = currentMediaItems[currentMediaIndex];

        if (item.type === 'video') {
            if (sessionState.active && !sessionState.freeMode) {
                videoContainer.classList.remove('active');
                contextImage.style.display = '';
                player.src = '';
                player.dataset.mediaEmbedBase = '';
                caption.textContent = 'Video playback is locked by the session leader.';
                label.textContent = `${currentMediaIndex + 1} / ${currentMediaItems.length}`;
                sessionSetStatus('Media playback is locked by the session leader.', 'warn');
                return;
            }
            videoContainer.classList.add('active');
            contextImage.style.display = 'none';
            const targetEmbed = toEmbedUrl(item.embedUrl || item.url || '');
            const targetSrc = targetEmbed + (targetEmbed.includes('?') ? '&' : '?') + 'autoplay=1';
            const currentEmbed = toEmbedUrl(player.dataset.mediaEmbedBase || player.src || '');
            const sameActiveVideo = !!targetEmbed
                && currentEmbed === targetEmbed
                && videoContainer.classList.contains('active')
                && contextImage.style.display === 'none';
            if (!sameActiveVideo) {
                player.src = targetSrc;
            }
            player.dataset.mediaEmbedBase = targetEmbed || '';
            // Stop background audio when playing a video in the panel
            stopBackgroundAudio();
        } else {
            videoContainer.classList.remove('active');
            contextImage.style.display = '';
            player.src = ''; // Stop any playing video
            player.dataset.mediaEmbedBase = '';
            contextImage.src = item.url;
        }

        caption.textContent = item.caption || '';
        label.textContent = `${currentMediaIndex + 1} / ${currentMediaItems.length}`;
    }

    function updateNav() {
        if (currentMediaItems.length <= 1) {
            nav.classList.remove('active');
            if (currentMediaItems.length === 1) showItem(0);
        } else {
            nav.classList.add('active');
            showItem(currentMediaIndex);
        }
    }

    prevBtn.addEventListener('click', () => showItem(currentMediaIndex - 1));
    nextBtn.addEventListener('click', () => showItem(currentMediaIndex + 1));

    window._updateMediaGallery = updateNav;
    window._showMediaItem = showItem;
}

// ─── SONG TEXT (Lyrics overlay) ────────────────────────────

function setupLyrics() {
    const overlay = document.getElementById('lyrics-overlay');
    const body = document.getElementById('lyrics-body');
    const scrollBtn = document.getElementById('lyrics-scroll-btn');
    const splitBtn = document.getElementById('lyrics-split-btn');
    const closeBtn = document.getElementById('lyrics-close-btn');
    const lyricsBtn = document.getElementById('media-lyrics-btn');
    let mode = 'scroll';

    function render() {
        if (!currentSongTexts || currentSongTexts.length === 0) {
            body.innerHTML = '<div class="lyrics-empty">No song text available</div>';
            return;
        }
        const sorted = [...currentSongTexts].sort((a, b) => {
            const aE = (a.language || '').toLowerCase().includes('english');
            const bE = (b.language || '').toLowerCase().includes('english');
            return aE === bE ? 0 : aE ? 1 : -1;
        });
        const cls = mode === 'scroll' ? 'lyrics-scroll' : 'lyrics-split';
        body.className = `lyrics-body ${cls}`;
        body.innerHTML = sorted.map(st => `
            <div class="lyrics-lang-block">
                <span class="lyrics-lang-label">${st.language || 'Unknown'}</span>
                <div class="lyrics-lang-text">${st.text || ''}</div>
            </div>`).join('');
    }

    scrollBtn.addEventListener('click', () => { mode = 'scroll'; scrollBtn.classList.add('active'); splitBtn.classList.remove('active'); render(); });
    splitBtn.addEventListener('click', () => { mode = 'split'; splitBtn.classList.add('active'); scrollBtn.classList.remove('active'); render(); });
    closeBtn.addEventListener('click', () => { overlay.classList.remove('active'); lyricsBtn.classList.remove('active'); });
    lyricsBtn.addEventListener('click', () => {
        overlay.classList.toggle('active');
        lyricsBtn.classList.toggle('active', overlay.classList.contains('active'));
        render();
    });
    window._renderLyrics = render;
}

// ─── NOTATION OVERLAY ──────────────────────────────────────

function setupNotation() {
    if (window._rrcNotationSetupInitialized) return;
    window._rrcNotationSetupInitialized = true;

    const btn = document.getElementById('media-notation-btn');
    const overlay = document.getElementById('notation-overlay');
    const closeBtn = document.getElementById('notation-close-btn');
    const iframe = document.getElementById('notation-iframe');
    const circularOverlay = document.getElementById('notation-circular-overlay');
    const circularIframe = document.getElementById('notation-circular-iframe');
    const circularTempoText = document.getElementById('notation-circular-tempo-text');
    const circularBeatHud = document.getElementById('notation-circular-beat-hud');
    const circularBtn = document.getElementById('circular-toggle');
    let iframeLoaded = false;
    let mainIframeReady = false;
    const pendingMainMessages = [];
    let circularIframeLoaded = false;
    let notationViewMode = 'linear';
    let pendingViewMode = null;
    let notationCircularVisible = false;
    let circularTempo = 100;
    let circularBeats = 4;
    let circularSubdivisions = 4;
    let circularStep = 0;
    let circularBridgeDragging = false;
    let circularBridgeStartPointerX = 0;
    let circularBridgeStartPointerY = 0;
    let circularBridgeStartLeft = 0;
    let circularBridgeStartTop = 0;
    let circularBridgeWidth = 0;
    let circularBridgeHeight = 0;
    let circularBridgeRaf = 0;
    let circularBridgePendingLeft = 0;
    let circularBridgePendingTop = 0;
    const notationUiVersion = '2026-11-18-room-v12'; // bump whenever Notation/ changes, or devices keep a cached player

    function getThemeColor() {
        if (selectedRhythm && rhythmColorMap[selectedRhythm]) return rhythmColorMap[selectedRhythm].hex;
        return '#00ffff';
    }

    function applyBorderColor(targetOverlay) {
        if (!targetOverlay) return;
        const color = getThemeColor();
        targetOverlay.style.setProperty('--notation-border-color', color + '80');
        targetOverlay.style.borderColor = color + '80';
        targetOverlay.style.boxShadow = `0 0 40px ${color}20, inset 0 0 20px rgba(0,0,0,0.5)`;
    }

    function buildNotationSrc(extraParams = {}) {
        const rhythmName = selectedRhythm ? (allRhythms[selectedRhythm]?.name || '') : '';
        const color = getThemeColor();
        const params = [];
        if (rhythmName) params.push('rhythm=' + encodeURIComponent(rhythmName));
        if (color) params.push('color=' + encodeURIComponent(color));
        Object.entries(extraParams).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        });
        return 'Notation/notation.html' + (params.length ? '?' + params.join('&') : '');
    }

    function hasIframeSource(iframeEl) {
        if (!iframeEl) return false;
        return !!String(iframeEl.getAttribute('src') || '').trim();
    }

    function ensureIframeVersion(iframeEl, extraParams = {}) {
        if (!iframeEl) return false;
        const currentVersion = iframeEl.dataset.notationUiVersion || '';
        if (currentVersion === notationUiVersion && hasIframeSource(iframeEl)) return false;
        iframeEl.src = buildNotationSrc({ ...extraParams, uiVersion: notationUiVersion });
        iframeEl.dataset.notationUiVersion = notationUiVersion;
        if (iframeEl === iframe) mainIframeReady = false;
        return true;
    }

    function queueMainMessage(message) {
        if (!message || typeof message !== 'object') return;
        const msgType = String(message.type || '').trim();
        if (msgType === 'loadRhythm') {
            for (let i = pendingMainMessages.length - 1; i >= 0; i--) {
                if (String(pendingMainMessages[i]?.type || '').trim() === 'loadRhythm') {
                    pendingMainMessages.splice(i, 1);
                }
            }
        }
        pendingMainMessages.push(message);
        if (pendingMainMessages.length > 120) {
            pendingMainMessages.splice(0, pendingMainMessages.length - 120);
        }
    }

    function isMainNotationReady() {
        if (!iframe || !iframe.contentWindow) return false;
        if (mainIframeReady) return true;
        try {
            if (typeof iframe.contentWindow.__rrcTriggerPadHit === 'function') {
                mainIframeReady = true;
                flushPendingMainMessages();
                return true;
            }
        } catch {}
        return false;
    }

    function postToNotation(message) {
        if (!message || typeof message !== 'object') return false;
        const type = String(message.type || '').trim();
        if (!isMainNotationReady()) {
            if (type !== 'triggerPadHit') queueMainMessage(message);
            ensureMainNotationLoaded();
            return false;
        }
        try {
            iframe.contentWindow.postMessage(message, '*');
            return true;
        } catch (e) {
            if (type !== 'triggerPadHit') queueMainMessage(message);
            return false;
        }
    }

    function postToCircularNotation(message) {
        try {
            circularIframe.contentWindow.postMessage(message, '*');
            return true;
        } catch (e) {
            return false;
        }
    }

    window._rrcSyncRhythmCatalogToNotation = () => syncRhythmCatalogToNotationTargets();
    // Phones and tablets only start audio inside a tap. Any tap on the page wakes the player's audio if it
    // is not running, so a session that starts later (with no tap) is heard right away.
    if ((navigator.maxTouchPoints || 0) > 0) {
        const wakePlayerAudio = () => {
            try {
                const w = iframe && iframe.contentWindow;
                if (w && typeof w.__rrcAudioRunning === 'function' && !w.__rrcAudioRunning()) w.__rrcWarmupAudio?.();
            } catch {}
        };
        ['pointerdown', 'touchend', 'click'].forEach((type) => document.addEventListener(type, wakePlayerAudio, { capture: true, passive: true }));
    }
    window._notationBridge = {
        ensureLoaded: () => ensureMainNotationLoaded(),
        postMain: (message) => postToNotation(message),
        postCircular: (message) => postToCircularNotation(message),
        warmupMainAudio: () => {
            ensureMainNotationLoaded();
            try {
                const win = iframe && iframe.contentWindow ? iframe.contentWindow : null;
                if (win && typeof win.__rrcWarmupAudio === 'function') {
                    win.__rrcWarmupAudio();
                    return true;
                }
            } catch {}
            return postToNotation({ type: 'warmupAudio' });
        },
        getMainWindow: () => {
            try { return iframe && iframe.contentWindow ? iframe.contentWindow : null; } catch { return null; }
        },
        isMainReady: () => isMainNotationReady(),
        loadRhythmByName: (name) => {
            const rhythmName = String(name || '').trim();
            if (!rhythmName) return false;
            ensureMainNotationLoaded();
            return postToNotation({ type: 'loadRhythm', name: rhythmName, themeColor: getThemeColor() });
        },
        requestRhythmState: () => {
            ensureMainNotationLoaded();
            return postToNotation({ type: 'requestRhythmState' });
        },
        requestNotationState: () => {
            ensureMainNotationLoaded();
            return postToNotation({ type: 'requestNotationState' });
        }
    };

    // Main-page diagnostics proxy so reports can be controlled from parent console.
    window.__rrcTransportDiag = {
        setEnabled: (enabled) => postToNotation({ type: 'rrcTransportDiag', command: 'setEnabled', enabled: !!enabled }),
        setVerbose: (verbose) => postToNotation({ type: 'rrcTransportDiag', command: 'setVerbose', verbose: !!verbose }),
        clear: () => postToNotation({ type: 'rrcTransportDiag', command: 'clear' }),
        requestReport: () => postToNotation({ type: 'rrcTransportDiag', command: 'export' }),
        getLastReport: () => window.__rrcLastTransportDiagReport || ''
    };

    function buildRhythmMessage() {
        if (!selectedRhythm || !allRhythms[selectedRhythm]) {
            ensureSelectedRhythmBootstrap();
        }
        const rhythmName = selectedRhythm ? (allRhythms[selectedRhythm]?.name || '') : '';
        const color = getThemeColor();
        const rhythm = selectedRhythm ? allRhythms[selectedRhythm] : null;
        const msg = { type: 'loadRhythm', name: rhythmName, themeColor: color };
        if (selectedRhythm) msg.lookupKey = selectedRhythm;
        if (rhythm?.notationPath) msg.notationPath = rhythm.notationPath;
        if (rhythm?.notationData) msg.notationData = rhythm.notationData;
        return msg;
    }

    function resolveRhythmKeyFromNotationSelection(payload = {}) {
        const byKey = String(payload.key || '').trim();
        if (byKey && allRhythms[byKey]) return byKey;
        const incomingName = String(payload.name || '').trim().toLowerCase();
        if (!incomingName) return '';
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const exact = Object.entries(allRhythms).find(([, rhythm]) => normalize(rhythm?.name) === incomingName);
        if (exact && exact[0]) return exact[0];
        const fuzzy = Object.entries(allRhythms).find(([, rhythm]) => normalize(rhythm?.name).includes(incomingName));
        return fuzzy && fuzzy[0] ? fuzzy[0] : '';
    }

    function buildRhythmCatalogMessage() {
        const items = Object.entries(allRhythms || {})
            .map(([key, rhythm]) => ({
                key: String(key || '').trim(),
                name: String(rhythm?.name || key || '').trim()
            }))
            .filter((entry) => entry.key && entry.name)
            .sort((a, b) => a.name.localeCompare(b.name));
        const selectedName = selectedRhythm && allRhythms[selectedRhythm]
            ? String(allRhythms[selectedRhythm].name || selectedRhythm)
            : '';
        return {
            type: 'notationRhythmCatalog',
            items,
            selectedKey: selectedRhythm || '',
            selectedName
        };
    }

    function syncRhythmCatalogToNotationTargets() {
        const msg = buildRhythmCatalogMessage();
        postToNotation(msg);
        if (circularIframe) postToCircularNotation(msg);
    }

    function syncNotationSessionRole() {
        const role = isSessionLeader()
            ? 'leader'
            : (isSessionFollower() ? 'follower' : 'none');
        postToNotation({ type: 'setSessionRole', role, freeMode: !!sessionState.freeMode });
        if (circularIframe) {
            postToCircularNotation({ type: 'setSessionRole', role, freeMode: !!sessionState.freeMode });
        }
    }
    window._syncNotationSessionRole = syncNotationSessionRole;

    function syncNotationPrimeLead() {
        const lead = Math.max(0, Math.min(300, Number(notationPrimeLeadMs) || 0));
        postToNotation({ type: 'setTransportPrimeLeadMs', value: lead });
        if (circularIframe) {
            postToCircularNotation({ type: 'setTransportPrimeLeadMs', value: lead });
        }
    }
    window._syncNotationPrimeLead = syncNotationPrimeLead;

    function syncNotationBeatArcVisual() {
        const arcHeightPx = Math.max(1, Math.min(40, Number(notationBeatArcHeight) || 7));
        document.body.style.setProperty('--pad-beat-arrow-arc-height', `${arcHeightPx}px`);
        postToNotation({ type: 'setBeatArcVisual', arcHeightPx });
        if (circularIframe) {
            postToCircularNotation({ type: 'setBeatArcVisual', arcHeightPx });
        }
    }
    window._syncNotationBeatArcVisual = syncNotationBeatArcVisual;

    function applyPendingViewMode() {
        if (!pendingViewMode) return;
        const mode = pendingViewMode === 'circular' ? 'circular' : 'linear';
        if (postToNotation({ type: 'setViewMode', mode })) {
            notationViewMode = mode;
            pendingViewMode = null;
            updateToggleState();
        }
    }

    function requestNotationLayoutRefresh() {
        postToNotation({ type: 'notationForceLayout' });
        setTimeout(() => {
            postToNotation({ type: 'notationForceLayout' });
        }, 140);
    }

    function show(options = {}) {
        const requestedView = options.viewMode === 'circular' || options.viewMode === 'linear'
            ? options.viewMode
            : null;
        pendingViewMode = requestedView;
        notationVisible = true;
        overlay.classList.remove('hidden', 'panel-hidden');
        overlay.classList.add('active');
        if (typeof window._bringFloatingWindowToFront === 'function') {
            window._bringFloatingWindowToFront(overlay);
        }
        updateToggleState();
        applyBorderColor(overlay);
        syncNotationSessionRole();
        syncNotationPrimeLead();
        syncNotationBeatArcVisual();
        if (!iframeLoaded || ensureIframeVersion(iframe)) {
            if (!hasIframeSource(iframe)) iframe.src = buildNotationSrc({ uiVersion: notationUiVersion });
            mainIframeReady = false;
            iframeLoaded = true;
            console.log('Notation iframe loading:', iframe.src);
        } else {
            const msg = buildRhythmMessage();
            if (!postToNotation(msg)) {
                console.warn('postMessage failed: loadRhythm');
            }
            syncRhythmCatalogToNotationTargets();
            applyPendingViewMode();
            postToNotation({ type: 'requestNotationState' });
        }
        requestNotationLayoutRefresh();
    }

    function ensureMainNotationLoaded() {
        const started = (!iframeLoaded) || ensureIframeVersion(iframe);
        if (started) {
            if (!hasIframeSource(iframe)) iframe.src = buildNotationSrc({ uiVersion: notationUiVersion });
            mainIframeReady = false;
            iframeLoaded = true;
            console.log('Notation iframe loading (background):', iframe.src);
        }
    }

    function flushPendingMainMessages() {
        if (!mainIframeReady || !iframe || !iframe.contentWindow || pendingMainMessages.length === 0) return;
        const queue = pendingMainMessages.splice(0, pendingMainMessages.length);
        queue.forEach((msg) => {
            try { iframe.contentWindow.postMessage(msg, '*'); } catch {}
        });
    }

    function ensureCircularNotationLoaded() {
        if (!circularIframe) return false;
        const started = (!circularIframeLoaded) || ensureIframeVersion(circularIframe, { circularOnly: 1 });
        if (started) {
            if (!hasIframeSource(circularIframe)) circularIframe.src = buildNotationSrc({ circularOnly: 1, uiVersion: notationUiVersion });
            circularIframeLoaded = true;
            console.log('Circular notation iframe loading:', circularIframe.src);
            return true;
        }
        return false;
    }

    function hide() {
        notationVisible = false;
        overlay.classList.remove('active');
        overlay.classList.add('panel-hidden');
        updateToggleState();
    }

    function showCircularWindow() {
        ensureMainNotationLoaded();
        notationCircularVisible = true;
        if (circularOverlay) {
            circularOverlay.classList.remove('hidden', 'panel-hidden');
            circularOverlay.classList.add('active');
        }
        if (typeof window._bringFloatingWindowToFront === 'function') {
            window._bringFloatingWindowToFront(circularOverlay);
        }
        updateToggleState();
        applyBorderColor(circularOverlay);
        syncNotationSessionRole();
        syncNotationPrimeLead();
        syncNotationBeatArcVisual();

        if (ensureCircularNotationLoaded()) {
            return;
        }

        const msg = buildRhythmMessage();
        postToCircularNotation(msg);
        syncRhythmCatalogToNotationTargets();
        postToCircularNotation({
            type: 'syncCallState',
            ...latestNotationCallState
        });
        postToNotation({ type: 'requestNotationState' });
        postToNotation({ type: 'requestRhythmState' });
    }

    function hideCircularWindow() {
        notationCircularVisible = false;
        if (circularOverlay) {
            circularOverlay.classList.remove('active');
            circularOverlay.classList.add('panel-hidden');
        }
        updateToggleState();
        endCircularBridgeDrag();
    }

    function tryOpenJourneyCompactNotation(options = {}) {
        const isRemoteUi = typeof window._isPadRemoteMode === 'function' && !!window._isPadRemoteMode();
        const openCompact = typeof window._openPadRemoteJourneyCompactNotation === 'function'
            ? window._openPadRemoteJourneyCompactNotation
            : null;
        if (!isRemoteUi || !openCompact) return false;
        const didOpen = !!openCompact({
            ensureJourneyView: options.ensureJourneyView !== false
        });
        if (didOpen && !notationVisible) {
            show({ viewMode: 'linear' });
        }
        if (didOpen) {
            const bridge = window._notationBridge;
            if (bridge && typeof bridge.postMain === 'function') {
                bridge.postMain({ type: 'setCompactMode', enabled: true });
            } else {
                postToNotation({ type: 'setCompactMode', enabled: true });
            }
        }
        return didOpen;
    }

    function getTopUiClearance() {
        const topUi = document.getElementById('top-panel-toggles');
        if (!topUi) return 56;
        const style = window.getComputedStyle(topUi);
        if (style.display === 'none' || style.visibility === 'hidden') return 56;
        if (topUi.classList.contains('top-buttons-side')) return 56;
        return Math.max(56, Math.ceil(topUi.getBoundingClientRect().bottom + 8));
    }

    function clampCircularOverlayPosition(left, top, width, height) {
        const gap = 4;
        const maxLeft = Math.max(gap, window.innerWidth - width - gap);
        const maxTop = Math.max(getTopUiClearance(), window.innerHeight - height - gap);
        return {
            left: Math.max(gap, Math.min(left, maxLeft)),
            top: Math.max(getTopUiClearance(), Math.min(top, maxTop))
        };
    }

    function setCircularOverlayPosition(left, top) {
        if (!circularOverlay) return;
        const width = circularBridgeWidth || circularOverlay.getBoundingClientRect().width || 220;
        const height = circularBridgeHeight || circularOverlay.getBoundingClientRect().height || 120;
        const clamped = clampCircularOverlayPosition(left, top, width, height);
        circularOverlay.style.position = 'fixed';
        circularOverlay.style.left = Math.round(clamped.left) + 'px';
        circularOverlay.style.top = Math.round(clamped.top) + 'px';
        circularOverlay.style.right = 'auto';
        circularOverlay.style.bottom = 'auto';
        circularOverlay.style.transform = 'none';
        circularOverlay.dataset.windowPinned = '1';
    }

    function flushCircularBridgePosition() {
        circularBridgeRaf = 0;
        setCircularOverlayPosition(circularBridgePendingLeft, circularBridgePendingTop);
    }

    function beginCircularBridgeDrag(pointerX, pointerY) {
        if (!circularOverlay) return;
        const rect = circularOverlay.getBoundingClientRect();
        circularBridgeStartLeft = rect.left;
        circularBridgeStartTop = rect.top;
        circularBridgeWidth = rect.width;
        circularBridgeHeight = rect.height;
        circularBridgeStartPointerX = Number.isFinite(pointerX) ? pointerX : 0;
        circularBridgeStartPointerY = Number.isFinite(pointerY) ? pointerY : 0;
        circularBridgeDragging = true;
        circularOverlay.classList.add('dragging');
        circularOverlay.style.willChange = 'left, top';
    }

    function updateCircularBridgeDrag(payload) {
        if (!circularBridgeDragging || !circularOverlay) return;
        const clientX = Number(payload?.clientX);
        const clientY = Number(payload?.clientY);
        const screenX = Number(payload?.screenX);
        const screenY = Number(payload?.screenY);
        const hasScreen = Number.isFinite(screenX) && Number.isFinite(screenY);
        const hasClient = Number.isFinite(clientX) && Number.isFinite(clientY);
        const hasAbsolute = hasScreen || hasClient;
        const nextX = hasScreen ? screenX : clientX;
        const nextY = hasScreen ? screenY : clientY;
        if (hasAbsolute) {
            circularBridgePendingLeft = circularBridgeStartLeft + (nextX - circularBridgeStartPointerX);
            circularBridgePendingTop = circularBridgeStartTop + (nextY - circularBridgeStartPointerY);
            if (!circularBridgeRaf) {
                circularBridgeRaf = requestAnimationFrame(flushCircularBridgePosition);
            }
            return;
        }
        const dx = Number(payload?.dx) || 0;
        const dy = Number(payload?.dy) || 0;
        const rect = circularOverlay.getBoundingClientRect();
        circularBridgePendingLeft = rect.left + dx;
        circularBridgePendingTop = rect.top + dy;
        if (!circularBridgeRaf) {
            circularBridgeRaf = requestAnimationFrame(flushCircularBridgePosition);
        }
    }

    function endCircularBridgeDrag() {
        if (!circularOverlay) return;
        if (!circularBridgeDragging) {
            circularOverlay.classList.remove('dragging');
            circularOverlay.style.willChange = '';
            if (circularBridgeRaf) {
                cancelAnimationFrame(circularBridgeRaf);
                circularBridgeRaf = 0;
            }
            return;
        }
        circularBridgeDragging = false;
        circularOverlay.classList.remove('dragging');
        circularOverlay.style.willChange = '';
        if (circularBridgeRaf) {
            cancelAnimationFrame(circularBridgeRaf);
            circularBridgeRaf = 0;
            setCircularOverlayPosition(circularBridgePendingLeft, circularBridgePendingTop);
        }
        if (typeof window._updateFloatingWindowScale === 'function') {
            window._updateFloatingWindowScale(circularOverlay);
        }
    }

    function syncCircularPlayButton(isPlaying) {
        // Circular playback controls now live inside the notation iframe.
    }

    function setCircularTempoHud(nextTempo) {
        circularTempo = Math.max(40, Math.min(240, parseInt(nextTempo, 10) || 100));
        if (circularTempoText) circularTempoText.innerHTML = `${circularTempo}<span>BPM</span>`;
    }

    function setCircularBeatHud(step, beatColor = '') {
        const totalSteps = Math.max(1, circularBeats * circularSubdivisions);
        const safeStep = ((parseInt(step, 10) || 0) % totalSteps + totalSteps) % totalSteps;
        circularStep = safeStep;
        const beat = Math.floor(safeStep / Math.max(1, circularSubdivisions)) + 1;
        const sub = (safeStep % Math.max(1, circularSubdivisions)) + 1;
        const palette = Array.isArray(latestNotationBeatColors) && latestNotationBeatColors.length
            ? latestNotationBeatColors
            : DEFAULT_BEAT_COLORS;
        const beatIndex = Math.floor(safeStep / Math.max(1, circularSubdivisions));
        const fallbackBeatColor = palette[beatIndex % palette.length] || DEFAULT_BEAT_COLORS[0];
        const normalizeColor = (typeof normalizePadHex === 'function')
            ? normalizePadHex
            : ((value, fallback) => {
                const raw = String(value || '').trim();
                if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
                if (/^#[0-9a-f]{3}$/i.test(raw)) {
                    return '#' + raw.slice(1).split('').map((ch) => ch + ch).join('');
                }
                return fallback;
            });
        const resolvedBeatColor = normalizeColor(
            String(beatColor || '').trim() || fallbackBeatColor,
            DEFAULT_BEAT_COLORS[0]
        );
        if (circularOverlay) {
            circularOverlay.style.setProperty('--notation-circular-beat-color', resolvedBeatColor);
        }
        if (circularBeatHud) circularBeatHud.textContent = `Beat ${beat}.${sub}`;
    }

    function stopActiveMediaForNotationPlayback() {
        const mediaVideo = document.getElementById('video-player');
        const mediaVideoContainer = document.getElementById('video-player-container');
        if (mediaVideo) {
            mediaVideo.src = '';
            mediaVideo.dataset.mediaEmbedBase = '';
        }
        if (mediaVideoContainer) mediaVideoContainer.classList.remove('active');
    }

    btn.addEventListener('click', () => {
        if (notationVisible) {
            hide();
            return;
        }
        const currentMobileView = typeof window._getPadRemoteMobileView === 'function'
            ? String(window._getPadRemoteMobileView() || '').trim().toLowerCase()
            : '';
        if (currentMobileView === 'journey' && tryOpenJourneyCompactNotation({ ensureJourneyView: false })) {
            return;
        }
        show();
    });
    if (closeBtn) closeBtn.addEventListener('click', hide);

    // Also wire the dedicated top-left notation button
    const topBtn = document.getElementById('notation-toggle');
    if (topBtn) {
        topBtn.addEventListener('click', () => notationVisible ? hide() : show());
    }
    if (circularBtn) {
        circularBtn.addEventListener('click', () => notationCircularVisible ? hideCircularWindow() : showCircularWindow());
    }
    const savedCircularTempo = Math.max(40, Math.min(240, parseInt(localStorage.getItem('notationCircularTempo') || '100', 10) || 100));
    setCircularTempoHud(savedCircularTempo);
    setCircularBeatHud(0, latestNotationPlaybackBeatColor);
    syncCircularPlayButton(false);

    function updateToggleState() {
        if (topBtn) topBtn.classList.toggle('active', notationVisible);
        if (circularBtn) circularBtn.classList.toggle('active', notationCircularVisible);
        btn.classList.toggle('active', notationVisible);
    }

    function syncNotationVisibilityFromDom() {
        const wantsMain = !!overlay
            && overlay.classList.contains('active')
            && !overlay.classList.contains('hidden')
            && !overlay.classList.contains('panel-hidden');
        const wantsCircular = !!circularOverlay
            && circularOverlay.classList.contains('active')
            && !circularOverlay.classList.contains('hidden')
            && !circularOverlay.classList.contains('panel-hidden');

        if (wantsMain && !notationVisible) show();
        else if (!wantsMain && notationVisible) hide();

        if (wantsCircular && !notationCircularVisible) showCircularWindow();
        else if (!wantsCircular && notationCircularVisible) hideCircularWindow();

        updateToggleState();
    }
    window._syncNotationWindowVisibilityFromDom = syncNotationVisibilityFromDom;
    syncNotationVisibilityFromDom();

    // Preload notation iframes so first user click opens instantly.
    setTimeout(() => {
        try {
            ensureMainNotationLoaded();
        } catch {}
    }, 0);

    iframe.addEventListener('load', () => {
        mainIframeReady = true;
        flushPendingMainMessages();
        const msg = buildRhythmMessage();
        postToNotation(msg);
        syncRhythmCatalogToNotationTargets();
        syncNotationSessionRole();
        syncNotationPrimeLead();
        syncNotationBeatArcVisual();
        applyPendingViewMode();
        postToNotation({ type: 'requestNotationState' });
        postToNotation({ type: 'requestRhythmState' });
        requestNotationLayoutRefresh();
    });
    if (circularIframe) {
        circularIframe.addEventListener('load', () => {
            if (!notationCircularVisible) return;
            const msg = buildRhythmMessage();
            postToCircularNotation(msg);
            syncRhythmCatalogToNotationTargets();
            syncNotationSessionRole();
            syncNotationPrimeLead();
            syncNotationBeatArcVisual();
            postToCircularNotation({ type: 'setViewMode', mode: 'circular' });
            postToCircularNotation({ type: 'syncTempo', tempo: savedCircularTempo });
            postToCircularNotation({
                type: 'syncCallState',
                ...latestNotationCallState
            });
            ensureMainNotationLoaded();
            postToNotation({ type: 'requestNotationState' });
            postToNotation({ type: 'requestRhythmState' });
        });
    }

    // ── Size slider ──
    const sizeSlider = document.getElementById('notation-size-slider');
    const debugScaleSlider = document.getElementById('notationScaleSlider');
    const debugScaleInput = document.getElementById('notationScaleInput');
    const debugMinW = document.getElementById('notationMinWidth');
    const debugMinH = document.getElementById('notationMinHeight');

    function applyNotationScale(pct) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.max(400, (vw - 80) * pct / 100);
        const h = Math.max(300, (vh - 100) * pct / 100);
        overlay.style.width = w + 'px';
        overlay.style.height = h + 'px';
        // Re-center
        overlay.style.left = Math.max(0, (vw - w) / 2) + 'px';
        overlay.style.top = Math.max(0, (vh - h) / 2) + 'px';
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        localStorage.setItem('notationScale', pct);
    }

    if (sizeSlider) {
        const savedScale = localStorage.getItem('notationScale');
        if (savedScale) sizeSlider.value = savedScale;
        sizeSlider.addEventListener('input', (e) => {
            applyNotationScale(parseInt(e.target.value));
            if (debugScaleSlider) debugScaleSlider.value = e.target.value;
            if (debugScaleInput) debugScaleInput.value = e.target.value;
        });
    }
    // Sync debug panel controls
    if (debugScaleSlider) {
        debugScaleSlider.addEventListener('input', (e) => {
            applyNotationScale(parseInt(e.target.value));
            if (sizeSlider) sizeSlider.value = e.target.value;
            if (debugScaleInput) debugScaleInput.value = e.target.value;
        });
    }
    if (debugScaleInput) {
        debugScaleInput.addEventListener('change', (e) => {
            const v = Math.max(30, Math.min(100, parseInt(e.target.value) || 90));
            applyNotationScale(v);
            if (sizeSlider) sizeSlider.value = v;
            if (debugScaleSlider) debugScaleSlider.value = v;
        });
    }
    if (debugMinW) {
        debugMinW.addEventListener('change', (e) => {
            overlay.style.minWidth = (parseInt(e.target.value) || 400) + 'px';
        });
    }
    if (debugMinH) {
        debugMinH.addEventListener('change', (e) => {
            overlay.style.minHeight = (parseInt(e.target.value) || 300) + 'px';
        });
    }
    // Apply saved scale on init
    const initScale = localStorage.getItem('notationScale');
    // On startup the window manager has already restored the notation window where the user left it;
    // only fall back to the size slider when there is no saved placement.
    if (initScale && overlay.dataset.windowPinned !== '1') { applyNotationScale(parseInt(initScale)); }

    window._updateNotation = (rhythmName) => {
        const color = getThemeColor();
        if (notationVisible) applyBorderColor(overlay);
        if (notationCircularVisible) applyBorderColor(circularOverlay);
        // The player is also the engine behind the room and sessions, so it must follow the rhythm even
        // while its window is hidden; otherwise followers switched rhythm in name only.
        const playerNeedsRhythm = notationVisible
            || document.documentElement.classList.contains('rrc-room')
            || !!(sessionState && sessionState.active);
        if (playerNeedsRhythm && !notationVisible) ensureMainNotationLoaded();
        if (playerNeedsRhythm && iframe.contentWindow) {
            // Pass notation data directly if rhythm has it
            const rhythm = selectedRhythm ? allRhythms[selectedRhythm] : null;
            const msg = { type: 'loadRhythm', name: rhythmName, themeColor: color };
            if (selectedRhythm) msg.lookupKey = selectedRhythm;
            if (rhythm?.notationPath) msg.notationPath = rhythm.notationPath;
            if (rhythm?.notationData) msg.notationData = rhythm.notationData;
            postToNotation(msg);
            syncRhythmCatalogToNotationTargets();
        }
        if (notationCircularVisible && circularIframe && circularIframe.contentWindow) {
            const rhythm = selectedRhythm ? allRhythms[selectedRhythm] : null;
            const msg = { type: 'loadRhythm', name: rhythmName, themeColor: color };
            if (selectedRhythm) msg.lookupKey = selectedRhythm;
            if (rhythm?.notationPath) msg.notationPath = rhythm.notationPath;
            if (rhythm?.notationData) msg.notationData = rhythm.notationData;
            postToCircularNotation(msg);
            syncRhythmCatalogToNotationTargets();
            ensureMainNotationLoaded();
            postToNotation({ type: 'requestNotationState' });
            postToNotation({ type: 'requestRhythmState' });
        }
    };

    // Relay Supabase credentials to notation iframe when requested
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'requestRhythmCatalog') {
            syncRhythmCatalogToNotationTargets();
            return;
        }
        if (e.data?.type === 'notationSelectRhythm') {
            const nextKey = resolveRhythmKeyFromNotationSelection(e.data || {});
            if (nextKey && allRhythms[nextKey]) {
                if (nextKey === selectedRhythm && !isJourneyActive) {
                    syncRhythmCatalogToNotationTargets();
                    return;
                }
                const noSessionBroadcast = !isSessionLeader();
                startJourney(nextKey, {
                    skipTravel: true,
                    preserveWindowVisibility: true,
                    suppressAutoAudio: true,
                    noSessionBroadcast
                }).catch(() => {});
                syncRhythmCatalogToNotationTargets();
            }
            return;
        }
        if (e.data?.type === 'requestSupabaseCredentials') {
            const hasUrl = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL;
            const hasKey = typeof SUPABASE_ANON_KEY !== 'undefined' && SUPABASE_ANON_KEY;
            const mainWindow = iframe && iframe.contentWindow;
            const circularWindow = circularIframe && circularIframe.contentWindow;
            const sourceWindow = e.source;
            const targetWindow = sourceWindow === circularWindow
                ? circularWindow
                : (sourceWindow === mainWindow ? mainWindow : mainWindow);

            if (hasUrl && hasKey && targetWindow) {
                try {
                    targetWindow.postMessage({
                        type: 'supabaseCredentials',
                        url: SUPABASE_URL,
                        key: SUPABASE_ANON_KEY
                    }, '*');
                } catch {}
            }
            return;
        }
        const fromMainNotation = !!(iframe && e.source === iframe.contentWindow);
        const fromCircularNotation = !!(circularIframe && e.source === circularIframe.contentWindow);

        if (e.data?.type === 'rrcTransportDiagReport') {
            const report = String(e.data.report || '');
            if (report) {
                window.__rrcLastTransportDiagReport = report;
                console.log('[RRC Transport Diagnostics Report]', report);
                sessionSetStatus('Transport diagnostics report captured in console.', 'info');
            }
            return;
        }

        if (e.data?.type === 'notationCircularCommand') {
            if (!fromCircularNotation) return;
            if (!notationCircularVisible) return;
            ensureMainNotationLoaded();
            const command = String(e.data.command || '').trim();
            if (command === 'togglePlayback') {
                if (isSessionFollower() && !sessionState.freeMode) {
                    sessionSetStatus('Playback is controlled by the session leader.', 'warn');
                    return;
                }
                if (isSessionLeader() && sessionState.active && !sessionState.freeMode) {
                    const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || circularTempo || 100));
                    if (latestNotationPlaybackPlaying) {
                        void leaderBroadcastTransportStop({ forceLocalStop: false });
                    } else {
                        sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                        void leaderBroadcastTransportPlay('play', {
                            tempo: nextTempo,
                            startBeat: 0
                        });
                    }
                } else {
                    postToNotation({ type: latestNotationPlaybackPlaying ? 'stopPlayback' : 'startPlayback' });
                }
                return;
            }
            if (command === 'callButton') {
                if (isSessionFollower() && !sessionState.freeMode) {
                    sessionSetStatus('Call is controlled by the session leader.', 'warn');
                    return;
                }
                if (isSessionLeader() && sessionState.active && !sessionState.freeMode && !latestNotationPlaybackPlaying) {
                    const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || circularTempo || 100));
                    sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                    void leaderBroadcastTransportPlay('call_in', {
                        tempo: nextTempo,
                        startBeat: 0
                    });
                } else {
                    postToNotation({ type: 'callButton' });
                }
                return;
            }
            if (command === 'callOut') {
                if (isSessionFollower() && !sessionState.freeMode) {
                    sessionSetStatus('Call is controlled by the session leader.', 'warn');
                    return;
                }
                if (isSessionLeader() && sessionState.active && !sessionState.freeMode) {
                    const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || circularTempo || 100));
                    void leaderBroadcastCallOut({ tempo: nextTempo });
                } else {
                    postToNotation({ type: 'callOut' });
                }
                return;
            }
            if (command === 'setCallInStep') {
                const step = Math.max(1, parseInt(e.data?.payload?.value, 10) || 1);
                postToNotation({ type: 'setCallInStepOffset', value: step });
                return;
            }
            if (command === 'tapTempo') {
                postToNotation({ type: 'tapTempo' });
                return;
            }
            if (command === 'setTempo') {
                const nextTempo = Math.max(40, Math.min(240, parseInt(e.data?.payload?.tempo, 10) || circularTempo || 100));
                postToNotation({ type: 'setTempo', tempo: nextTempo });
                return;
            }
            return;
        }

        if (e.data?.type === 'notationCircularDragBridge') {
            if (!fromCircularNotation || !circularOverlay) return;
            if (e.data.phase === 'start') {
                const startX = Number.isFinite(Number(e.data.screenX))
                    ? Number(e.data.screenX)
                    : Number(e.data.clientX);
                const startY = Number.isFinite(Number(e.data.screenY))
                    ? Number(e.data.screenY)
                    : Number(e.data.clientY);
                beginCircularBridgeDrag(startX, startY);
                return;
            }
            if (e.data.phase === 'move') {
                updateCircularBridgeDrag(e.data);
                return;
            }
            if (e.data.phase === 'end' || e.data.phase === 'cancel') {
                endCircularBridgeDrag();
                return;
            }
            return;
        }

        if (e.data?.type === 'notationRhythmState') {
            if (fromMainNotation && e.data.rhythmData) {
                latestNotationRhythmData = ensureCallInstrumentInRhythmData(e.data.rhythmData);
                window._latestNotationRhythmData = latestNotationRhythmData;
                if (Array.isArray(e.data.beatColors) && e.data.beatColors.length > 0) {
                    latestNotationBeatColors = e.data.beatColors.slice(0, 12).map((value) => String(value || '').trim()).filter(Boolean);
                } else if (!Array.isArray(latestNotationBeatColors) || latestNotationBeatColors.length === 0) {
                    latestNotationBeatColors = DEFAULT_BEAT_COLORS.slice();
                }
                latestNotationUseCircularToneSymbol = !!e.data.useCircularToneSymbol;
                latestNotationUseNeonArticulationStyle = !!e.data.useNeonArticulationStyle;
                window._latestNotationBeatColors = latestNotationBeatColors.slice();
                window._latestNotationUseCircularToneSymbol = latestNotationUseCircularToneSymbol;
                window._latestNotationUseNeonArticulationStyle = latestNotationUseNeonArticulationStyle;
                try {
                    window.dispatchEvent(new CustomEvent('rrc:notation-rhythm-state', {
                        detail: {
                            rhythmData: latestNotationRhythmData,
                            beatColors: latestNotationBeatColors.slice(),
                            usePadBeatVisuals: !!e.data.usePadBeatVisuals,
                            useBeatArcVisual: !!e.data.useBeatArcVisual,
                            beatArcHeightPx: Number.isFinite(Number(e.data.beatArcHeightPx)) ? Number(e.data.beatArcHeightPx) : notationBeatArcHeight,
                            useCircularToneSymbol: latestNotationUseNeonArticulationStyle,
                            useNeonArticulationStyle: latestNotationUseNeonArticulationStyle
                        }
                    }));
                } catch {}
                const nextBeats = parseInt(e.data.rhythmData.beats, 10);
                const nextSubs = parseInt(e.data.rhythmData.subdivisions, 10);
                if (Number.isFinite(nextBeats) && nextBeats > 0) circularBeats = nextBeats;
                if (Number.isFinite(nextSubs) && nextSubs > 0) circularSubdivisions = nextSubs;
                setCircularBeatHud(circularStep, latestNotationPlaybackBeatColor);
            }
            if (fromMainNotation && notationCircularVisible) {
                postToCircularNotation({
                    type: 'syncRhythmData',
                    rhythmData: e.data.rhythmData || null,
                    beatColors: Array.isArray(e.data.beatColors) ? e.data.beatColors : null,
                    usePadBeatVisuals: !!e.data.usePadBeatVisuals,
                    useBeatArcVisual: !!e.data.useBeatArcVisual,
                    beatArcHeightPx: Number.isFinite(Number(e.data.beatArcHeightPx)) ? Number(e.data.beatArcHeightPx) : notationBeatArcHeight,
                    useNeonArticulationStyle: !!e.data.useNeonArticulationStyle
                });
            }
            return;
        }

        if (e.data?.type === 'notationCallState') {
            if (!fromMainNotation) return;
            latestNotationCallState = {
                ...latestNotationCallState,
                callLabel: String(e.data.callLabel || latestNotationCallState.callLabel || 'Call In'),
                callTitle: String(e.data.callTitle || ''),
                showCallOut: !!e.data.showCallOut,
                callPending: !!e.data.callPending,
                callActive: !!e.data.callActive,
                callInActive: !!e.data.callInActive,
                callOutActive: !!e.data.callOutActive,
                playing: !!e.data.playing,
                callInStepOffset: Math.max(1, parseInt(e.data.callInStepOffset, 10) || latestNotationCallState.callInStepOffset || 1),
                callInStepMax: Math.max(1, parseInt(e.data.callInStepMax, 10) || latestNotationCallState.callInStepMax || 16)
            };
            try {
                window.dispatchEvent(new CustomEvent('rrc:notation-call-state', {
                    detail: { ...latestNotationCallState }
                }));
            } catch {}
            if (notationCircularVisible) {
                postToCircularNotation({
                    type: 'syncCallState',
                    ...latestNotationCallState
                });
            }
            return;
        }

        if (e.data?.type === 'notationViewMode') {
            if (fromMainNotation) notationViewMode = e.data.mode === 'circular' ? 'circular' : 'linear';
            updateToggleState();
            return;
        }
        if (e.data?.type === 'notationCallCue') {
            if (!fromMainNotation) return;
            if (isSessionLeader()) {
                void sendSessionEvent('call_cued', {
                    at: Date.now()
                });
            } else if (isSessionFollower() && !sessionState.freeMode) {
                sessionSetStatus('Call is controlled by the session leader.', 'warn');
            }
            return;
        }
        if (e.data?.type === 'notationActionBlocked') {
            if (!fromMainNotation) return;
            if (!sessionState.active) return;
            const action = String(e.data.action || '').trim();
            if (action === 'playback') {
                sessionSetStatus('Playback is controlled by the session leader.', 'warn');
            } else if (action === 'call' || action === 'call_in' || action === 'call_out') {
                sessionSetStatus('Call is controlled by the session leader.', 'warn');
            }
            return;
        }
        if (e.data?.type === 'notationLeaderAction') {
            if (!fromMainNotation) return;
            if (!(sessionState.active && isSessionLeader() && !sessionState.freeMode)) return;
            const action = String(e.data.action || '').trim().toLowerCase();
            const nextTempo = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || circularTempo || 100));
            if (action === 'stop') {
                void leaderBroadcastTransportStop({ forceLocalStop: false });
                return;
            }
            if (action === 'call_out') {
                void leaderBroadcastCallOut({ tempo: nextTempo });
                return;
            }
            if (action === 'call_in') {
                sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                void leaderBroadcastTransportPlay('call_in', {
                    tempo: nextTempo,
                    startBeat: 0
                });
                return;
            }
            if (action === 'play') {
                sessionState.rhythmKey = selectedRhythm || sessionState.rhythmKey || '';
                void leaderBroadcastTransportPlay('play', {
                    tempo: nextTempo,
                    startBeat: 0
                });
                return;
            }
            return;
        }
        if (e.data?.type === 'notationTempoState') {
            if (fromMainNotation) {
                const nextTempo = Math.max(40, Math.min(240, parseInt(e.data.tempo, 10) || 100));
                setCircularTempoHud(nextTempo);
                localStorage.setItem('notationCircularTempo', String(nextTempo));
                if (notationCircularVisible) postToCircularNotation({ type: 'syncTempo', tempo: nextTempo });
                if (isSessionLeader()) {
                    const leaderNow = sessionMonotonicNowMs();
                    const execLeaderTime = Math.max(leaderNow + 16, leaderNow + Math.min(120, computeSessionLookaheadMs() * 0.55));
                    setSessionTransportTempoAt(nextTempo, execLeaderTime);
                    triggerSessionSyncBoost(SESSION_LOCAL_BOOST_DURATION_MS);
                    void sendSessionEvent('TEMPO_CHANGE', {
                        execLeaderTime,
                        tempo: nextTempo,
                        rampMs: 0
                    });
                    void sendSessionEvent('SESSION_SNAPSHOT', buildSessionSnapshot({ tempo: nextTempo }));
                } else if (isSessionFollower() && !sessionState.freeMode) {
                    const authoritative = Math.max(40, Math.min(240, parseInt(sessionState.tempo, 10) || nextTempo));
                    if (Math.abs(authoritative - nextTempo) >= 1) {
                        postToNotation({ type: 'syncTempo', tempo: authoritative });
                        sessionSetStatus('Tempo is controlled by the session leader.', 'warn');
                    } else {
                        sessionState.tempo = nextTempo;
                    }
                } else {
                    sessionState.tempo = nextTempo;
                }
            }
            return;
        }
        if (e.data?.type === 'notationState') {
            if (fromMainNotation) {
                if (Number.isFinite(Number(e.data.tempo))) {
                    const nextTempo = Math.max(40, Math.min(240, parseInt(e.data.tempo, 10) || 100));
                    setCircularTempoHud(nextTempo);
                    localStorage.setItem('notationCircularTempo', String(nextTempo));
                }
                if (Number.isFinite(Number(e.data.masterVolume))) {
                    latestNotationMasterVolume = Math.max(0, Math.min(1, Number(e.data.masterVolume)));
                    try {
                        window.dispatchEvent(new CustomEvent('rrc:notation-master-volume', {
                            detail: { masterVolume: latestNotationMasterVolume }
                        }));
                    } catch {}
                }
                if (Number.isFinite(Number(e.data.step))) setCircularBeatHud(e.data.step, e.data.beatColor);
                syncCircularPlayButton(!!e.data.playing);
                if (notationCircularVisible) {
                    postToCircularNotation({
                        type: 'syncNotationState',
                        tempo: e.data.tempo,
                        playing: !!e.data.playing,
                        mode: 'circular',
                        step: e.data.step,
                        stepEpoch: e.data.stepEpoch,
                        beats: circularBeats,
                        subdivisions: circularSubdivisions
                    });
                }
            }
            if (fromCircularNotation) {
                syncCircularPlayButton(!!e.data.playing);
            }
            return;
        }
        if (e.data?.type === 'notationStepScheduled') {
            if (fromMainNotation && Number.isFinite(Number(e.data.step)) && Number.isFinite(Number(e.data.stepEpoch))) {
                latestScheduledNotationStep = { step: parseInt(e.data.step, 10) || 0, epoch: Number(e.data.stepEpoch) };
                try {
                    window.dispatchEvent(new CustomEvent('rrc:notation-step-scheduled', {
                        detail: {
                            step: parseInt(e.data.step, 10) || 0,
                            stepEpoch: Number(e.data.stepEpoch),
                            stepDurationMs: Number(e.data.stepDurationMs) || 0,
                            tempo: Number(e.data.tempo) || latestNotationPlaybackTempo,
                            metronome: !!e.data.metronome,
                            callActive: !!e.data.callActive,
                            silentIds: Array.isArray(e.data.silentIds) ? e.data.silentIds : [],
                            callSound: typeof e.data.callSound === 'string' ? e.data.callSound : null
                        }
                    }));
                } catch {}
            }
            return;
        }
        if (e.data?.type === 'notationMetronomeState') {
            if (fromMainNotation) {
                try { window.dispatchEvent(new CustomEvent('rrc:notation-metronome', { detail: { enabled: !!e.data.enabled } })); } catch {}
            }
            return;
        }
        if (e.data?.type === 'notationPlaybackTick') {
            if (fromMainNotation && Number.isFinite(Number(e.data.step))) {
                setCircularBeatHud(e.data.step, e.data.beatColor);
                latestNotationPlaybackStep = parseInt(e.data.step, 10) || 0;
            }
            if (fromMainNotation && Number.isFinite(Number(e.data.tempo))) {
                setCircularTempoHud(e.data.tempo);
                latestNotationPlaybackTempo = Math.max(40, Math.min(240, parseInt(e.data.tempo, 10) || 100));
            }
            if (fromMainNotation) {
                latestNotationPlaybackPlaying = !!e.data.playing;
                latestNotationPlaybackStepEpoch = parseInt(e.data.stepEpoch, 10) || Date.now();
                latestNotationPlaybackBeatColor = String(e.data.beatColor || latestNotationPlaybackBeatColor || DEFAULT_BEAT_COLORS[0]).trim() || DEFAULT_BEAT_COLORS[0];
                try {
                    window.dispatchEvent(new CustomEvent('rrc:notation-playback-tick', {
                        detail: {
                            step: latestNotationPlaybackStep,
                            tempo: latestNotationPlaybackTempo,
                            playing: latestNotationPlaybackPlaying,
                            stepEpoch: latestNotationPlaybackStepEpoch,
                            beatColor: latestNotationPlaybackBeatColor
                        }
                    }));
                } catch {}
            }
            if (fromMainNotation && isSessionLeader() && sessionState.active && !!e.data.playing) {
                // Transport sync now uses scheduled start/stop + adaptive SYNC_CHECK.
                // We intentionally avoid per-step realtime broadcasts to reduce jitter/stutter.
                sessionState.lastTickBroadcastAt = Date.now();
                sessionState.lastTickBroadcastStep = parseInt(e.data.step, 10) || 0;
                sessionState.lastTickBroadcastEpoch = parseInt(e.data.stepEpoch, 10) || Date.now();
            }
            if (fromMainNotation && notationCircularVisible) {
                postToCircularNotation({
                    type: 'syncPlaybackTick',
                    step: e.data.step,
                    stepEpoch: e.data.stepEpoch,
                    tempo: e.data.tempo,
                    playing: !!e.data.playing,
                    beatColor: e.data.beatColor,
                    beats: circularBeats,
                    subdivisions: circularSubdivisions
                });
            }
            return;
        }
        if (e.data?.type === 'notationPlaybackState') {
            if (fromMainNotation) {
                latestNotationPlaybackPlaying = !!e.data.playing;
                if (Number.isFinite(Number(e.data.step))) {
                    latestNotationPlaybackStep = parseInt(e.data.step, 10) || 0;
                } else if (latestNotationPlaybackPlaying) {
                    // Prevent stale pad playhead start position before first playback tick.
                    latestNotationPlaybackStep = 0;
                    latestNotationPlaybackStepEpoch = Date.now();
                }
                syncCircularPlayButton(!!e.data.playing);
                try {
                    window.dispatchEvent(new CustomEvent('rrc:notation-playback-state', {
                        detail: {
                            playing: latestNotationPlaybackPlaying,
                            step: latestNotationPlaybackStep,
                            tempo: latestNotationPlaybackTempo,
                            stepEpoch: latestNotationPlaybackStepEpoch,
                            beatColor: latestNotationPlaybackBeatColor
                        }
                    }));
                } catch {}
                if (!e.data.playing) resetSessionTickBroadcastState();
                if (notationCircularVisible) {
                    postToCircularNotation({
                        type: 'syncPlaybackState',
                        playing: !!e.data.playing
                    });
                }
            }
            if (fromMainNotation && sessionState.active && !!e.data.playing && !notationVisible) {
                tryOpenJourneyCompactNotation({ ensureJourneyView: true });
            }
            if (fromMainNotation && isSessionFollower() && !sessionState.freeMode && !!e.data.playing) {
                const allowUntil = Number(sessionState.allowPlaybackUntil) || 0;
                if (Date.now() > allowUntil) {
                    postToNotation({ type: 'stopPlayback' });
                    sessionSetStatus('Playback is controlled by the session leader.', 'warn');
                    return;
                }
            }
            notationPlaybackActive = !!e.data.playing;
            if (notationPlaybackActive) {
                stopBackgroundAudio();
                stopActiveMediaForNotationPlayback();
            }
        }
    });
}

// ─── EXTENDED DEBUG SYSTEM (sliders + export/import) ───────

const BUNDLED_DEFAULT_SETTINGS_PROFILE_VERSION = '2026-02-11T07-00-52-395Z-v1';
const BUNDLED_DEFAULT_SETTINGS_PROFILE_KEY = 'rrcBundledDefaultSettingsProfileVersion';
// Screen the bundled layout was captured on; the window manager refits it to the visitor's screen.
const BUNDLED_DEFAULT_SETTINGS_SCREEN = { w: 1680, h: 915 };
// Utility windows that were open when the profile was exported. New visitors open them from the top bar.
const BUNDLED_DEFAULT_CLOSED_WINDOWS = ['debug-controls', 'auth-panel', 'session-panel'];
const BUNDLED_DEFAULT_SETTINGS_PROFILE = {
    "zoomOutAltitude": 14500,
    "zoomInAltitude": 600,
    "zoomOutDuration": 2,
    "zoomPauseDuration": 0.5,
    "zoomInDuration": 2.5,
    "domeSize": 15,
    "sphereOpacity": 0.5,
    "sphereHeightOffset": 0.5,
    "pathWidth": 15,
    "pathSpeed": 0.005,
    "pathLength": 0.21,
    "arcHeightFactor": 0.21,
    "planeScale": 5510,
    "rhythmPanelWidth": 220,
    "rhythmPanelHeight": 75,
    "windowScaleMin": 0.72,
    "floatingSnapDistance": 14,
    "sessionEcoMinTickIntervalMs": 0,
    "sessionEcoMaxSilenceMs": 1400,
    "panelOpacity": 1,
    "topButtonsAlpha": 1,
    "frostIntensity": 20,
    "topButtonsBlur": 20,
    "carouselSpeed": 20,
    "carouselRowAddThreshold": 154,
    "padPreviewStepGap": 4,
    "padBeatStartGap": 5,
    "padPlayVisualScale": 110.00000000000001,
    "padBeatIndicatorHeight": 4,
    "padBeatIndicatorOffset": 6,
    "notationBeatArcHeight": 7,
    "notationPrimeLeadMs": 50,
    "stageMinVelocity": 5,
    "stageMaxVelocity": 95,
    "stageLiveUpdateThresholdPx": 4,
    "stageMinVelocityRange": 10,
    "stageBoundsOffsetXPx": 80,
    "stageBoundsOffsetYPx": 16,
    "topButtonEmojiScale": 100,
    "topTogglePhoneEmojiScale": 100,
    "topToggleLaptopEmojiScale": 100,
    "textScale": 1,
    "focusTextScale": 0.85,
    "bannerTitleSize": 14,
    "bannerDescSize": 10,
    "contextTitleSize": 24,
    "contextBodySize": 20,
    "cardNameSize": 23,
    "cardOverlayBlur": 2,
    "createTextSize": 18,
    "carouselCardNameSize": 16,
    "cardLocationSize": 13,
    "cardCommunitySize": 11,
    "cardCreatorSize": 11,
    "stageInstrumentScale": 3.15,
    "stageLabelScale": 0.75,
    "stageUiTextScale": 1.45,
    "domeLabelSize": 14,
    "navLabelSize": 9,
    "planeHeading": 180,
    "planePitch": 0,
    "planeRoll": 5,
    "focusBannerTitleSize": 22,
    "focusBannerDescSize": 14,
    "focusContextTitleSize": 18,
    "focusContextBodySize": 15,
    "tooltipTypeSpeed": 19,
    "tooltipHoverDelayMs": 500,
    "tooltipWindowScale": 160,
    "tooltipTextScale": 150,
    "debugScale": 2.15,
    "wireframeMode": true,
    "showWireframeOutline": false,
    "showPlane": false,
    "floatingSnapEnabled": true,
    "floatingSnapToWindows": true,
    "floatingSnapToViewport": true,
    "floatingMagneticDock": true,
    "sessionEcoSyncMode": true,
    "sessionEcoTickGranularity": "beat",
    "sessionDefaultSyncMode": "remote",
    "topButtonsUseEmoji": true,
    "topButtonsCompactMode": false,
    "topButtonsSideMode": false,
    "showNavTopButton": false,
    "stopTransportOnRhythmSelect": true,
    "restoreRhythmPanelAfterJourney": true,
    "rhythmCardContainImages": true,
    "tooltipHideOnUnhover": false,
    "hintMessages": {
        "views-panel": "Save your favorite window layout, load it later, or export it as JSON.",
        "rhythm-create-panel": "Build a new rhythm step by step: name, location, context, notation, media, then save to Local or Community.",
        "auth-panel": "Sign in, set your profile, and save a personal view you can restore anytime.",
        "session-panel": "Start a room or join one with a Session ID. The leader controls shared rhythm playback.",
        "serve-panel": "Copy the local server command, run it in terminal, then open the shown URL on this device or your network.",
        "stage-panel": "Place instruments on stage. Left/right changes pan, front/back changes loudness.",
        "rhythm-panel": "Pick a rhythm to begin the journey, or switch sources to browse more.",
        "info-banner": "Shows the current rhythm title and where it comes from.",
        "history-box": "Read cultural background and learning notes for the selected rhythm.",
        "image-window": "View images, videos, and lyrics connected to the selected rhythm.",
        "notation-overlay": "Main rhythm player and editor. Use this for transport, instruments, and notation controls.",
        "notation-circular-overlay": "Circular rhythm view synced to the same playback as the main notation window.",
        "trigger-pad": "Choose a rhythm and instrument, then tap to play. Great for practice and teaching.",
        "debug-controls": "Customize app behavior, visuals, and performance settings in one place.",
        "notation-cycle-help": "GRID INPUT\nTap: write selected articulation.\nFast repeat tap (same box): cycle articulations if cycle is enabled. \nThis also updates the active articulation too.\nDrag: paint with current articulation.\nHold (mouse/touch): write silence.\nHold + drag: erase multiple boxes.\nRight Click: write silence\nRight Click + drag: erase multiple boxes.",
        "notation-grid-help": "GRID STEPS\nBeats control number of divisions in a measure.\nSubdivisions controls boxes inside each beat.\nIncrease to add beats or steps, decrease to remove beats or steps."
    },
    "topPanelButtonOrder": [
        "rhythm-toggle",
        "notation-toggle",
        "circular-toggle",
        "info-toggle",
        "history-toggle",
        "media-toggle",
        "auth-toggle",
        "nav-toggle",
        "session-toggle",
        "views-toggle",
        "trigger-pad-toggle",
        "stage-toggle",
        "map-toggle",
        "tidy-toggle",
        "hide-ui-toggle",
        "mute-all-audio-btn",
        "window-select-toggle",
        "serve-local-toggle",
        "debug-toggle"
    ],
    "selectedImagery": "googleHybrid",
    "mapWindowedMode": false,
    "mapSceneMode": "3d",
    "selectedFont": "'Oxanium', cursive",
    "selectedSecondaryFont": "'Rajdhani', sans-serif",
    "selectedUiFont": "'Segoe UI', sans-serif",
    "selectedMonoFont": "'Share Tech Mono', monospace",
    "system": {
        "version": 1,
        "notation": {
            "notationDebugSettings": "{\"playheadGlow\":0.6,\"playheadBorder\":2.5,\"playheadPointer\":8,\"showPointer\":true,\"showGlow\":true,\"boxGrowth\":1.25,\"keepSize\":false,\"playheadSeparation\":3,\"boxSize\":36,\"groupGap\":22,\"boxGap\":5,\"rowGap\":8,\"instrumentInfoWidth\":225,\"instrumentNameWidth\":80,\"reverbAmount\":0.1,\"useNeonArticulationStyle\":true,\"disableResponsiveButtonSwap\":false,\"openSymbolSize\":70,\"beatNumberAlign\":0,\"toneOutlineWidth\":4,\"beatIndicatorHeight\":2,\"beatIndicatorOffset\":7,\"playbackBeatOffsetX\":6,\"playbackBeatOffsetY\":0,\"transportEmojiTint\":\"#f7d016\",\"beatColors\":[\"#ce1126\",\"#ff8c00\",\"#fcd116\",\"#006b3f\",\"#2196f3\",\"#9c27b0\",\"#e91e63\",\"#00bcd4\",\"#009688\",\"#cddc39\",\"#673ab7\",\"#03a9f4\"],\"titleFontSize\":24,\"titleVisible\":false,\"dialSyncOffset\":0,\"smoothCircularArrow\":true,\"usePadBeatVisuals\":false,\"useBeatArcVisual\":false,\"beatArcHeightPx\":7,\"gridScale\":1,\"holdToSilenceMs\":420,\"cycleTapWindowMs\":500,\"circularDialScale\":1,\"resizeSensitivity\":2}",
            "rhythmNotation": "{\"rhythmName\":\"Sofa-Limbadji Toko\",\"beats\":4,\"subdivisions\":4,\"tempo\":100,\"cycleMode\":false,\"rapidCycleEnabled\":true,\"compactMode\":true,\"compactInstrumentPanelOpen\":false,\"masterVolume\":0.98,\"masterMuted\":false,\"swing\":{\"factor\":100,\"A\":0,\"B\":-10,\"C\":0,\"D\":10},\"themeColor\":\"#fcd116\",\"instruments\":[{\"id\":\"call1\",\"name\":\"Call\",\"icon\":\"📣\",\"type\":\"djembe_solo\",\"sampleSet\":\"Solo\",\"pattern\":[\"tone\",null,\"tone\",\"tone\",null,\"tone\",null,\"tone\",\"tone\",null,\"tone\",null,\"tone\",null,null,null],\"visible\":true,\"muted\":false,\"volume\":0,\"focused\":false,\"isCall\":true,\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"djembe1\",\"name\":\"Djembe 1\",\"icon\":\"🥁\",\"type\":\"djembe\",\"sampleSet\":\"One\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"tone\",\"tone\",\"slap\",\"slap\",null,null,\"slap\",null,\"tone\",\"tone\",\"silence\",\"slap\",\"bass\",null,\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"djembe2\",\"name\":\"Djembe 2\",\"icon\":\"🥁\",\"type\":\"djembe\",\"sampleSet\":\"Two\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"bass\",null,null,\"slap\",null,null,\"tone\",null,\"bass\",null,\"tone\",\"slap\",\"tone\",\"tone\",\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"djembe3\",\"name\":\"Djembe 3\",\"icon\":\"🥁\",\"type\":\"djembe\",\"sampleSet\":\"Three\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"bass\",null,null,\"slap\",null,null,\"slap\",\"tone\",\"tone\",null,\"tone\",\"slap\",\"tone\",\"tone\",\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"kenkeni1\",\"name\":\"Kenkeni\",\"icon\":\"🪘\",\"type\":\"kenkeni\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":0.55,\"focused\":false,\"pattern\":[\"silence\",null,null,null,\"tone\",null,\"tone\",null,null,null,null,null,\"tone\",null,\"tone\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"kenkeni_bell1\",\"name\":\"Kenkeni Bell\",\"icon\":\"🔔\",\"type\":\"kenkeni_bell\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":0.4,\"focused\":false,\"pattern\":[\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null,\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"sangban1\",\"name\":\"Sangban\",\"icon\":\"🪘\",\"type\":\"sangban\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"tone\",\"tone\",null,null,null,null,null,null,\"tone\",null,\"tone\",null,null,null,null,null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"sangban_bell1\",\"name\":\"Sangban Bell\",\"icon\":\"🔔\",\"type\":\"sangban_bell\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"slap\",\"slap\",\"silence\",\"slap\",\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"doundoun1\",\"name\":\"Doundoun\",\"icon\":\"🪘\",\"type\":\"doundoun\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"silence\",\"silence\",null,null,null,null,\"tone\",null,null,null,null,null,\"tone\",null,\"tone\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"doundoun_bell1\",\"name\":\"Doundoun Bell\",\"icon\":\"🔔\",\"type\":\"doundoun_bell\",\"sampleSet\":\"default\",\"visible\":true,\"muted\":false,\"volume\":1,\"focused\":false,\"pattern\":[\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null],\"soloed\":false,\"pan\":0,\"stageX\":null,\"stageY\":null},{\"id\":\"shekere1\",\"name\":\"Shekere\",\"icon\":\"🎶\",\"type\":\"shekere\",\"sampleSet\":\"default\",\"pattern\":[\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\"],\"visible\":true,\"muted\":false,\"volume\":1,\"soloed\":false,\"pan\":0,\"focused\":false,\"stageX\":null,\"stageY\":null}],\"patternArchive\":{\"id:call1\":{\"4x4\":[\"tone\",null,\"tone\",\"tone\",null,\"tone\",null,\"tone\",\"tone\",null,\"tone\",null,\"tone\",null,null,null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:djembe1\":{\"4x4\":[\"tone\",\"tone\",\"slap\",\"slap\",null,null,\"slap\",null,\"tone\",\"tone\",\"silence\",\"slap\",\"bass\",null,\"slap\",null],\"4x3\":[\"bass\",null,null,\"bass\",null,\"slap\",\"bass\",null,null,\"bass\",null,\"slap\"]},\"id:djembe2\":{\"4x4\":[\"bass\",null,null,\"slap\",null,null,\"tone\",null,\"bass\",null,\"tone\",\"slap\",\"tone\",\"tone\",\"slap\",null],\"4x3\":[\"tone\",\"slap\",null,\"tone\",\"slap\",null,null,\"tone\",\"tone\",\"tone\",\"slap\",null]},\"id:djembe3\":{\"4x4\":[\"bass\",null,null,\"slap\",null,null,\"slap\",\"tone\",\"tone\",null,\"tone\",\"slap\",\"tone\",\"tone\",\"slap\",null],\"4x3\":[\"slap\",\"slap\",\"silence\",\"tone\",\"silence\",\"tone\",\"slap\",\"slap\",null,null,null,null]},\"id:kenkeni1\":{\"4x4\":[\"silence\",null,null,null,\"tone\",null,\"tone\",null,null,null,null,null,\"tone\",null,\"tone\",null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:kenkeni_bell1\":{\"4x4\":[\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null,\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null],\"4x3\":[\"tone\",null,\"tone\",null,\"tone\",null,\"tone\",null,\"tone\",null,\"tone\",null]},\"id:sangban1\":{\"4x4\":[\"tone\",\"tone\",null,null,null,null,null,null,\"tone\",null,\"tone\",null,null,null,null,null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:sangban_bell1\":{\"4x4\":[\"slap\",\"slap\",\"silence\",\"slap\",\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:doundoun1\":{\"4x4\":[\"silence\",\"silence\",null,null,null,null,\"tone\",null,null,null,null,null,\"tone\",null,\"tone\",null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:doundoun_bell1\":{\"4x4\":[\"slap\",\"slap\",null,\"slap\",\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null,\"slap\",null],\"4x3\":[null,null,null,null,null,null,null,null,null,null,null,null]},\"id:shekere1\":{\"4x3\":[\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\"],\"4x4\":[\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\",\"silence\"]}}}",
            "notationScale": "90",
            "notationCircularTempo": "100",
            "notationCircularPopoutLayout": "{\"left\":799,\"top\":36,\"width\":160,\"height\":523}"
        },
        "storage": {
            "rrcFloatingWindowStateV1": "{\"debug-controls\":{\"left\":19,\"top\":100,\"width\":420,\"height\":743,\"zIndex\":5200,\"active\":false,\"hidden\":false,\"panelHidden\":false},\"views-panel\":{\"left\":488,\"top\":499,\"width\":539,\"height\":275,\"zIndex\":2818,\"active\":false,\"hidden\":true,\"panelHidden\":false},\"auth-panel\":{\"left\":8,\"top\":595,\"width\":435,\"height\":250,\"zIndex\":2848,\"active\":false,\"hidden\":false,\"panelHidden\":false},\"session-panel\":{\"left\":189,\"top\":217,\"width\":320,\"height\":455,\"zIndex\":2847,\"active\":false,\"hidden\":false,\"panelHidden\":false},\"serve-panel\":{\"left\":730,\"top\":394,\"width\":680,\"height\":451,\"zIndex\":2611,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"rhythm-create-panel\":{\"left\":725,\"top\":545,\"width\":783,\"height\":300,\"zIndex\":2608,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"stage-panel\":{\"left\":512,\"top\":100,\"width\":1147,\"height\":765,\"zIndex\":2613,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-1\":{\"left\":123,\"top\":100,\"width\":560,\"height\":634,\"zIndex\":2877,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-2\":{\"left\":104,\"top\":609,\"width\":372,\"height\":236,\"zIndex\":2607,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-3\":{\"left\":228,\"top\":616,\"width\":248,\"height\":229,\"zIndex\":2606,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-4\":{\"left\":228,\"top\":616,\"width\":248,\"height\":229,\"zIndex\":2605,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-5\":{\"left\":228,\"top\":616,\"width\":248,\"height\":229,\"zIndex\":2604,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"trigger-pad-6\":{\"left\":228,\"top\":616,\"width\":248,\"height\":229,\"zIndex\":2602,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"rhythm-panel\":{\"left\":8,\"top\":100,\"width\":365,\"height\":804,\"zIndex\":2832,\"active\":false,\"hidden\":true,\"panelHidden\":false},\"circular-panel\":{\"left\":56,\"top\":609,\"width\":420,\"height\":236,\"zIndex\":2603,\"active\":false,\"hidden\":true,\"panelHidden\":true},\"info-banner\":{\"left\":1266,\"top\":100,\"width\":405,\"height\":152,\"zIndex\":2741,\"active\":true,\"hidden\":false,\"panelHidden\":false},\"history-box\":{\"left\":1266,\"top\":492,\"width\":406,\"height\":414,\"zIndex\":2720,\"active\":true,\"hidden\":false,\"panelHidden\":false},\"image-window\":{\"left\":1266,\"top\":256,\"width\":406,\"height\":240,\"zIndex\":2790,\"active\":true,\"hidden\":false,\"panelHidden\":false},\"notation-overlay\":{\"left\":349,\"top\":172,\"width\":1092,\"height\":734,\"zIndex\":2902,\"active\":true,\"hidden\":false,\"panelHidden\":false},\"notation-circular-overlay\":{\"left\":1136,\"top\":198,\"width\":536,\"height\":647,\"zIndex\":2872,\"active\":true,\"hidden\":false,\"panelHidden\":false},\"nav-toolbar\":{\"left\":559,\"top\":613,\"width\":140,\"height\":232,\"zIndex\":2616,\"active\":false,\"hidden\":true,\"panelHidden\":true}}",
            "rrcViewPresets": "[{\"id\":\"mldhvmmr\",\"name\":\"Test View\",\"windows\":{\"debug-controls\":{\"left\":469,\"top\":40,\"width\":1382,\"height\":814,\"hidden\":true},\"views-panel\":{\"left\":454,\"top\":9,\"width\":340,\"height\":90,\"hidden\":false},\"auth-panel\":{\"left\":800,\"top\":9,\"width\":340,\"height\":207,\"hidden\":false},\"session-panel\":{\"left\":1139,\"top\":10,\"width\":423,\"height\":257,\"hidden\":false},\"rhythm-panel\":{\"left\":1651,\"top\":4,\"width\":388,\"height\":579,\"hidden\":false},\"info-banner\":{\"left\":954,\"top\":15,\"width\":225,\"height\":90,\"hidden\":false},\"history-box\":{\"left\":1039,\"top\":280,\"width\":601,\"height\":271,\"hidden\":false},\"image-window\":{\"left\":687,\"top\":270,\"width\":340,\"height\":317,\"hidden\":false},\"notation-overlay\":{\"left\":39,\"top\":605,\"width\":1145,\"height\":300,\"hidden\":false},\"nav-toolbar\":{\"left\":2077,\"top\":60,\"width\":46,\"height\":244,\"hidden\":false}},\"meta\":{\"rhythmPanelView\":\"cards\"}},{\"id\":\"mle00gv2\",\"name\":\"Windowed Map\",\"windows\":{\"cesiumContainer\":{\"left\":243,\"top\":416,\"width\":463,\"height\":392,\"hidden\":false},\"debug-controls\":{\"left\":407,\"top\":93,\"width\":805,\"height\":879,\"hidden\":true},\"views-panel\":{\"left\":243,\"top\":93,\"width\":340,\"height\":154,\"hidden\":false},\"auth-panel\":{\"left\":370,\"top\":68,\"width\":340,\"height\":215,\"hidden\":true},\"session-panel\":{\"left\":723,\"top\":93,\"width\":320,\"height\":220,\"hidden\":false},\"rhythm-panel\":{\"left\":4,\"top\":93,\"width\":235,\"height\":715,\"hidden\":false},\"circular-panel\":{\"left\":764,\"top\":68,\"width\":420,\"height\":260,\"hidden\":true},\"info-banner\":{\"left\":706,\"top\":308,\"width\":482,\"height\":104,\"hidden\":false},\"history-box\":{\"left\":4,\"top\":812,\"width\":1184,\"height\":160,\"hidden\":false},\"image-window\":{\"left\":706,\"top\":416,\"width\":482,\"height\":392,\"hidden\":false},\"notation-overlay\":{\"left\":48,\"top\":93,\"width\":1042,\"height\":788,\"hidden\":false},\"notation-circular-overlay\":{\"left\":224,\"top\":120,\"width\":560,\"height\":620,\"hidden\":false}},\"meta\":{\"rhythmPanelView\":\"cards\"}},{\"id\":\"mlhn1r24\",\"name\":\"Learning View\",\"windows\":{\"cesiumContainer\":{\"left\":0,\"top\":0,\"width\":1680,\"height\":914,\"hidden\":false,\"panelHidden\":false,\"active\":false},\"debug-controls\":{\"left\":19,\"top\":100,\"width\":420,\"height\":743,\"hidden\":true,\"panelHidden\":false,\"active\":false},\"views-panel\":{\"left\":488,\"top\":499,\"width\":539,\"height\":275,\"hidden\":false,\"panelHidden\":false,\"active\":false},\"session-panel\":{\"left\":189,\"top\":217,\"width\":320,\"height\":455,\"hidden\":true,\"panelHidden\":false,\"active\":false},\"rhythm-panel\":{\"left\":8,\"top\":100,\"width\":365,\"height\":804,\"hidden\":true,\"panelHidden\":false,\"active\":false},\"info-banner\":{\"left\":1266,\"top\":100,\"width\":405,\"height\":152,\"hidden\":false,\"panelHidden\":false,\"active\":true},\"history-box\":{\"left\":1266,\"top\":492,\"width\":406,\"height\":414,\"hidden\":false,\"panelHidden\":false,\"active\":true},\"image-window\":{\"left\":1266,\"top\":256,\"width\":406,\"height\":240,\"hidden\":false,\"panelHidden\":false,\"active\":true},\"notation-overlay\":{\"left\":375,\"top\":100,\"width\":891,\"height\":804,\"hidden\":false,\"panelHidden\":false,\"active\":true}},\"meta\":{\"rhythmPanelView\":\"cards\",\"rhythmPanelTab\":\"browse\",\"topButtonOrder\":[\"rhythm-toggle\",\"notation-toggle\",\"circular-toggle\",\"info-toggle\",\"history-toggle\",\"media-toggle\",\"auth-toggle\",\"nav-toggle\",\"session-toggle\",\"views-toggle\",\"trigger-pad-toggle\",\"stage-toggle\",\"map-toggle\",\"tidy-toggle\",\"hide-ui-toggle\",\"mute-all-audio-btn\",\"window-select-toggle\",\"serve-local-toggle\",\"debug-toggle\"],\"showNavTopButton\":false}}]",
            "rrcJourneyPresets": "[{\"id\":\"jrny_mle6q4wu\",\"name\":\"Test 2\",\"items\":[\"dalah\",\"kassa\",\"toro\",\"djagb_\"]}]",
            "rrcLastSelectedRhythmKey": "sofa_limbadji_toko",
            "rhythmPanelViewMode": "cards",
            "rhythmPanelTab": "browse",
            "topPanelButtonOrder": "[\"rhythm-toggle\",\"notation-toggle\",\"circular-toggle\",\"info-toggle\",\"history-toggle\",\"media-toggle\",\"auth-toggle\",\"nav-toggle\",\"session-toggle\",\"views-toggle\",\"trigger-pad-toggle\",\"stage-toggle\",\"map-toggle\",\"tidy-toggle\",\"hide-ui-toggle\",\"mute-all-audio-btn\",\"window-select-toggle\",\"serve-local-toggle\",\"debug-toggle\"]",
            "showNavTopButton": "false",
            "stopTransportOnRhythmSelect": "true",
            "restoreRhythmPanelAfterJourney": "true",
            "topButtonsSideMode": "false",
            "topButtonEmojiScale": "1",
            "topTogglePhoneEmojiScale": "1",
            "topToggleLaptopEmojiScale": "1",
            "mapWindowRect": "{\"left\":703,\"top\":421,\"width\":466,\"height\":484}"
        },
        "floatingWindows": {
            "debug-controls": {
                "left": 19,
                "top": 100,
                "width": 420,
                "height": 743,
                "active": false,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 5200
            },
            "views-panel": {
                "left": 488,
                "top": 499,
                "width": 539,
                "height": 275,
                "active": false,
                "hidden": true,
                "panelHidden": false,
                "zIndex": 2818
            },
            "auth-panel": {
                "left": 8,
                "top": 595,
                "width": 435,
                "height": 250,
                "active": false,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2848
            },
            "session-panel": {
                "left": 189,
                "top": 217,
                "width": 320,
                "height": 455,
                "active": false,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2847
            },
            "serve-panel": {
                "left": 730,
                "top": 394,
                "width": 680,
                "height": 451,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2611
            },
            "rhythm-create-panel": {
                "left": 725,
                "top": 545,
                "width": 783,
                "height": 300,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2608
            },
            "stage-panel": {
                "left": 512,
                "top": 100,
                "width": 1147,
                "height": 765,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2613
            },
            "trigger-pad-1": {
                "left": 123,
                "top": 100,
                "width": 560,
                "height": 634,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2877
            },
            "trigger-pad-2": {
                "left": 104,
                "top": 609,
                "width": 372,
                "height": 236,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2607
            },
            "trigger-pad-3": {
                "left": 228,
                "top": 616,
                "width": 248,
                "height": 229,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2606
            },
            "trigger-pad-4": {
                "left": 228,
                "top": 616,
                "width": 248,
                "height": 229,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2605
            },
            "trigger-pad-5": {
                "left": 228,
                "top": 616,
                "width": 248,
                "height": 229,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2604
            },
            "trigger-pad-6": {
                "left": 228,
                "top": 616,
                "width": 248,
                "height": 229,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2602
            },
            "rhythm-panel": {
                "left": 8,
                "top": 100,
                "width": 365,
                "height": 804,
                "active": false,
                "hidden": true,
                "panelHidden": false,
                "zIndex": 2832
            },
            "circular-panel": {
                "left": 56,
                "top": 609,
                "width": 420,
                "height": 236,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2603
            },
            "info-banner": {
                "left": 1266,
                "top": 100,
                "width": 405,
                "height": 152,
                "active": true,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2741
            },
            "history-box": {
                "left": 1266,
                "top": 492,
                "width": 406,
                "height": 414,
                "active": true,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2720
            },
            "image-window": {
                "left": 1266,
                "top": 256,
                "width": 406,
                "height": 240,
                "active": true,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2790
            },
            "notation-overlay": {
                "left": 349,
                "top": 172,
                "width": 1092,
                "height": 734,
                "active": true,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2902
            },
            "notation-circular-overlay": {
                "left": 1136,
                "top": 198,
                "width": 536,
                "height": 647,
                "active": true,
                "hidden": false,
                "panelHidden": false,
                "zIndex": 2872
            },
            "nav-toolbar": {
                "left": 559,
                "top": 613,
                "width": 140,
                "height": 232,
                "active": false,
                "hidden": true,
                "panelHidden": true,
                "zIndex": 2616
            }
        },
        "meta": {
            "rhythmPanelView": "cards",
            "rhythmPanelTab": "browse",
            "topButtonOrder": [
                "rhythm-toggle",
                "notation-toggle",
                "circular-toggle",
                "info-toggle",
                "history-toggle",
                "media-toggle",
                "auth-toggle",
                "nav-toggle",
                "session-toggle",
                "views-toggle",
                "trigger-pad-toggle",
                "stage-toggle",
                "map-toggle",
                "tidy-toggle",
                "hide-ui-toggle",
                "mute-all-audio-btn",
                "window-select-toggle",
                "serve-local-toggle",
                "debug-toggle"
            ],
            "showNavTopButton": false,
            "selectedRhythmKey": "sofa_limbadji_toko"
        }
    }
};

function setupExtendedDebug() {
    // All tunable settings with their localStorage keys, CSS vars, and updaters
    const SETTINGS = {
        zoomOutAltitude:   { val: () => zoomOutAltitude / 1000, set: v => {
            const km = Number(v);
            if (!Number.isFinite(km)) return;
            zoomOutAltitude = normalizeJourneyAltitudeMeters(km * 1000, zoomOutAltitude || 20000000);
            localStorage.setItem('zoomOutAltitude', String(zoomOutAltitude));
        }, fmt: v => v + 'km' },
        zoomInAltitude:    { val: () => zoomInAltitude / 1000, set: v => {
            const km = Number(v);
            if (!Number.isFinite(km)) return;
            zoomInAltitude = normalizeJourneyAltitudeMeters(km * 1000, zoomInAltitude || 600000);
            localStorage.setItem('zoomInAltitude', String(zoomInAltitude));
        }, fmt: v => v + 'km' },
        zoomOutDuration:   { val: () => zoomOutDuration, set: v => {
            zoomOutDuration = normalizeJourneyDurationSeconds(v, zoomOutDuration || 2.0);
            localStorage.setItem('zoomOutDuration', String(zoomOutDuration));
        }, fmt: v => v + 's' },
        zoomPauseDuration: { val: () => zoomPauseDuration, set: v => {
            zoomPauseDuration = normalizeJourneyDurationSeconds(v, zoomPauseDuration || 0.5);
            localStorage.setItem('zoomPauseDuration', String(zoomPauseDuration));
        }, fmt: v => v + 's' },
        zoomInDuration:    { val: () => zoomInDuration, set: v => {
            zoomInDuration = normalizeJourneyDurationSeconds(v, zoomInDuration || 2.5);
            localStorage.setItem('zoomInDuration', String(zoomInDuration));
        }, fmt: v => v + 's' },
        domeSize:          { val: () => domeSize / 1000, set: v => { domeSize = v * 1000; localStorage.setItem('domeSize', domeSize); updateAllDomes(); }, fmt: v => v + 'km' },
        sphereOpacity:     { val: () => sphereOpacity, set: v => { sphereOpacity = v; localStorage.setItem('sphereOpacity', v); updateAllDomes(); }, fmt: v => v.toFixed(2) },
        sphereHeightOffset:{ val: () => sphereHeightOffset, set: v => { sphereHeightOffset = v; localStorage.setItem('sphereHeightOffset', v); updateAllDomes(); }, fmt: v => v.toFixed(1) },
        pathWidth:         { val: () => pathWidth, set: v => { pathWidth = v; localStorage.setItem('pathWidth', v); }, fmt: v => v + 'px' },
        pathSpeed:         { val: () => pathSpeed, set: v => { pathSpeed = v; localStorage.setItem('pathSpeed', v); }, fmt: v => v.toFixed(3) },
        pathLength:        { val: () => pathLength, set: v => { pathLength = v; localStorage.setItem('pathLength', v); }, fmt: v => v.toFixed(2) },
        arcHeightFactor:   { val: () => arcHeightFactor, set: v => { arcHeightFactor = v; localStorage.setItem('arcHeightFactor', v); }, fmt: v => v.toFixed(2) },
        planeScale:        { val: () => planeScale, set: v => { planeScale = v; localStorage.setItem('planeScale', v); }, fmt: v => v },
        rhythmPanelWidth:  { val: () => rhythmPanelWidth, set: v => { rhythmPanelWidth = v; localStorage.setItem('rhythmPanelWidth', v); document.body.style.setProperty('--rhythm-panel-width', v + 'px'); }, fmt: v => v + 'px' },
        rhythmPanelHeight: { val: () => rhythmPanelHeight, set: v => { rhythmPanelHeight = v; localStorage.setItem('rhythmPanelHeight', v); document.body.style.setProperty('--rhythm-panel-height', v + 'vh'); }, fmt: v => v + 'vh' },
        windowScaleMin:    { val: () => windowScaleMin, set: v => {
            windowScaleMin = v;
            localStorage.setItem('windowScaleMin', v);
            if (typeof window._refreshFloatingWindowScales === 'function') {
                window._refreshFloatingWindowScales();
            }
        }, fmt: v => v.toFixed(2) + 'x' },
        floatingSnapDistance: { val: () => floatingSnapDistance, set: v => {
            floatingSnapDistance = Math.max(4, Math.min(64, v));
            localStorage.setItem('floatingSnapDistance', floatingSnapDistance);
        }, fmt: v => Math.round(v) + 'px' },
        sessionEcoMinTickIntervalMs: { val: () => sessionEcoMinTickIntervalMs, set: v => {
            sessionEcoMinTickIntervalMs = Math.max(0, Math.min(2000, v));
            localStorage.setItem('sessionEcoMinTickIntervalMs', sessionEcoMinTickIntervalMs);
        }, fmt: v => Math.round(v) + 'ms' },
        sessionEcoMaxSilenceMs: { val: () => sessionEcoMaxSilenceMs, set: v => {
            sessionEcoMaxSilenceMs = Math.max(250, Math.min(5000, v));
            localStorage.setItem('sessionEcoMaxSilenceMs', sessionEcoMaxSilenceMs);
        }, fmt: v => Math.round(v) + 'ms' },
        panelOpacity:      { val: () => panelOpacity, set: v => {
            panelOpacity = v;
            localStorage.setItem('panelOpacity', v);
            applyUnifiedPanelOpacity();
        }, fmt: v => v.toFixed(2) },
        topButtonsAlpha:   { val: () => topButtonsAlpha, set: v => {
            const next = Math.max(0.1, Math.min(1, Number(v) || topButtonsAlpha || 1));
            topButtonsAlpha = next;
            localStorage.setItem('topButtonsAlpha', String(topButtonsAlpha));
            applyTopButtonsPanelAppearance();
        }, fmt: v => Number(v).toFixed(2) },
        windowsAlpha:      { val: () => unityWindowsAlpha, set: v => {
            setUnityWindowsAlpha(v, { persist: true });
        }, fmt: v => v.toFixed(2) },
        fullscreenMapAlpha:{ val: () => unityFullscreenMapAlpha, set: v => {
            setUnityFullscreenMapAlpha(v, { persist: true });
        }, fmt: v => v.toFixed(2) },
        frostIntensity:    { val: () => frostIntensity, set: v => { frostIntensity = v; localStorage.setItem('frostIntensity', v); document.body.style.setProperty('--frost-intensity', v + 'px'); }, fmt: v => v + 'px' },
        topButtonsBlur:    { val: () => topButtonsBlur, set: v => {
            const next = Math.max(0, Math.min(50, Number(v) || 0));
            topButtonsBlur = next;
            localStorage.setItem('topButtonsBlur', String(topButtonsBlur));
            applyTopButtonsPanelAppearance();
        }, fmt: v => Math.round(Number(v) || 0) + 'px' },
        carouselSpeed:     { val: () => carouselSpeed, set: v => { carouselSpeed = v; localStorage.setItem('carouselSpeed', v); document.body.style.setProperty('--carousel-speed', v + 's'); }, fmt: v => v + 's' },
        carouselRowAddThreshold: { val: () => carouselRowAddThreshold, set: v => {
            carouselRowAddThreshold = Math.max(0, Math.min(240, v));
            localStorage.setItem('carouselRowAddThreshold', carouselRowAddThreshold);
            populateCarousel();
        }, fmt: v => Math.round(v) + 'px' },
        padPreviewStepGap: { val: () => padPreviewStepGap, set: v => {
            padPreviewStepGap = Math.max(0, Math.min(12, v));
            localStorage.setItem('padPreviewStepGap', padPreviewStepGap);
            document.body.style.setProperty('--pad-preview-step-gap', padPreviewStepGap + 'px');
        }, fmt: v => Math.round(v) + 'px' },
        padBeatStartGap: { val: () => padBeatStartGap, set: v => {
            padBeatStartGap = Math.max(0, Math.min(12, v));
            localStorage.setItem('padBeatStartGap', padBeatStartGap);
            document.body.style.setProperty('--pad-beat-start-gap', padBeatStartGap + 'px');
            document.body.style.setProperty('--pad-beat-divider-slot', (padBeatStartGap * 2) + 'px');
            if (typeof window._refreshPadNotationLayout === 'function') window._refreshPadNotationLayout();
        }, fmt: v => Math.round(v) + 'px' },
        padPlayVisualScale: { val: () => padPlayVisualScale * 100, set: v => {
            padPlayVisualScale = Math.max(0.7, Math.min(2.2, v / 100));
            localStorage.setItem('padPlayVisualScale', padPlayVisualScale);
            document.body.style.setProperty('--pad-play-visual-scale', padPlayVisualScale.toFixed(3));
            if (typeof window._refreshPadNotationLayout === 'function') window._refreshPadNotationLayout();
        }, fmt: v => Math.round(v) + '%' },
        padBeatIndicatorHeight: { val: () => padBeatIndicatorHeight, set: v => {
            padBeatIndicatorHeight = Math.max(1, Math.min(10, v));
            localStorage.setItem('padBeatIndicatorHeight', padBeatIndicatorHeight);
            document.body.style.setProperty('--pad-beat-indicator-height', padBeatIndicatorHeight + 'px');
            if (typeof window._refreshPadNotationLayout === 'function') window._refreshPadNotationLayout();
        }, fmt: v => Math.round(v) + 'px' },
        padBeatIndicatorOffset: { val: () => padBeatIndicatorOffset, set: v => {
            padBeatIndicatorOffset = Math.max(-12, Math.min(18, v));
            localStorage.setItem('padBeatIndicatorOffset', padBeatIndicatorOffset);
            document.body.style.setProperty('--pad-beat-indicator-offset', padBeatIndicatorOffset + 'px');
            if (typeof window._refreshPadNotationLayout === 'function') window._refreshPadNotationLayout();
        }, fmt: v => Math.round(v) + 'px' },
        notationBeatArcHeight: { val: () => notationBeatArcHeight, set: v => {
            notationBeatArcHeight = Math.max(1, Math.min(40, Number(v) || 7));
            localStorage.setItem('notationBeatArcHeight', notationBeatArcHeight);
            document.body.style.setProperty('--pad-beat-arrow-arc-height', `${notationBeatArcHeight}px`);
            if (typeof window._syncNotationBeatArcVisual === 'function') window._syncNotationBeatArcVisual();
        }, fmt: v => Math.round(v) + 'px' },
        notationPrimeLeadMs: { val: () => notationPrimeLeadMs, set: v => {
            notationPrimeLeadMs = Math.max(0, Math.min(300, v));
            localStorage.setItem('notationPrimeLeadMs', notationPrimeLeadMs);
            if (typeof window._syncNotationPrimeLead === 'function') window._syncNotationPrimeLead();
        }, fmt: v => Math.round(v) + 'ms' },
        stageMinVelocity: { val: () => Math.round(clampStageMinVelocity(stageMinVelocity) * 100), set: v => {
            const normalized = clampStageMinVelocity(Number(v) / 100);
            stageMinVelocity = normalized;
            localStorage.setItem('stageMinVelocity', String(stageMinVelocity));
            localStorage.setItem('stageMinVelocityPreset', String(stageMinVelocity));
            if (typeof window._applyStageMinVelocity === 'function') {
                window._applyStageMinVelocity(stageMinVelocity, {
                    persist: true,
                    broadcast: true,
                    updateControls: true,
                    requestState: true
                });
            }
        }, fmt: v => Math.round(v) + '%' },
        stageMaxVelocity: { val: () => Math.round(clampStageMaxVelocity(stageMaxVelocity) * 100), set: v => {
            const normalized = clampStageMaxVelocity(Number(v) / 100);
            stageMaxVelocity = normalized;
            localStorage.setItem('stageMaxVelocity', String(stageMaxVelocity));
            localStorage.setItem('stageMaxVelocityPreset', String(stageMaxVelocity));
            if (typeof window._applyStageMaxVelocity === 'function') {
                window._applyStageMaxVelocity(stageMaxVelocity, {
                    persist: true,
                    broadcast: true,
                    updateControls: true,
                    requestState: true
                });
            }
        }, fmt: v => Math.round(v) + '%' },
        stageLiveUpdateThresholdPx: { val: () => stageLiveUpdateThresholdPx, set: v => {
            stageLiveUpdateThresholdPx = Math.max(0, Math.min(40, Number(v) || 0));
            localStorage.setItem('stageLiveUpdateThresholdPx', String(stageLiveUpdateThresholdPx));
        }, fmt: v => Math.round(v) + 'px' },
        stageMinVelocityRange: { val: () => Math.round(clampStageMinVelocityRange(stageMinVelocityRange) * 100), set: v => {
            stageMinVelocityRange = clampStageMinVelocityRange(Number(v) / 100);
            enforceStageVelocityRange();
            localStorage.setItem('stageMinVelocityRange', String(stageMinVelocityRange));
            if (typeof window._applyStageMinVelocity === 'function') {
                window._applyStageMinVelocity(stageMinVelocity, {
                    persist: true,
                    broadcast: true,
                    updateControls: true,
                    requestState: true
                });
            }
        }, fmt: v => Math.round(v) + '%' },
        stageBoundsOffsetXPx: { val: () => stageBoundsOffsetXPx, set: v => {
            stageBoundsOffsetXPx = clampStageBoundsOffsetPx(v);
            localStorage.setItem('stageBoundsOffsetXPx', String(stageBoundsOffsetXPx));
            if (typeof window._refreshStagePanelLayout === 'function') window._refreshStagePanelLayout();
        }, fmt: v => Math.round(v) + 'px' },
        stageBoundsOffsetYPx: { val: () => stageBoundsOffsetYPx, set: v => {
            stageBoundsOffsetYPx = clampStageBoundsOffsetPx(v);
            localStorage.setItem('stageBoundsOffsetYPx', String(stageBoundsOffsetYPx));
            if (typeof window._refreshStagePanelLayout === 'function') window._refreshStagePanelLayout();
        }, fmt: v => Math.round(v) + 'px' },
        topButtonEmojiScale: { val: () => topButtonEmojiScale * 100, set: v => {
            topButtonEmojiScale = Math.max(0.8, Math.min(2.6, v / 100));
            localStorage.setItem('topButtonEmojiScale', topButtonEmojiScale);
            document.body.style.setProperty('--top-button-emoji-scale', topButtonEmojiScale.toFixed(2));
            applyTopPanelButtonLabels();
        }, fmt: v => Math.round(v) + '%' },
        topTogglePhoneEmojiScale: { val: () => topTogglePhoneEmojiScale * 100, set: v => {
            topTogglePhoneEmojiScale = Math.max(0.8, Math.min(3.2, v / 100));
            localStorage.setItem('topTogglePhoneEmojiScale', topTogglePhoneEmojiScale);
            document.body.style.setProperty('--top-toggle-phone-emoji-scale', topTogglePhoneEmojiScale.toFixed(2));
            applyTopPanelButtonLabels();
        }, fmt: v => Math.round(v) + '%' },
        topToggleLaptopEmojiScale: { val: () => topToggleLaptopEmojiScale * 100, set: v => {
            topToggleLaptopEmojiScale = Math.max(0.8, Math.min(3.2, v / 100));
            localStorage.setItem('topToggleLaptopEmojiScale', topToggleLaptopEmojiScale);
            document.body.style.setProperty('--top-toggle-laptop-emoji-scale', topToggleLaptopEmojiScale.toFixed(2));
            applyTopPanelButtonLabels();
        }, fmt: v => Math.round(v) + '%' },
        textScale:         { val: () => textScale, set: v => { textScale = v; localStorage.setItem('textScale', v); document.body.style.setProperty('--text-scale', v); }, fmt: v => v.toFixed(2) },
        focusTextScale:    { val: () => focusTextScale, set: v => { focusTextScale = v; localStorage.setItem('focusTextScale', v); document.body.style.setProperty('--focus-text-scale', v); }, fmt: v => v.toFixed(2) },
        bannerTitleSize:   { val: () => bannerTitleSize, set: v => { bannerTitleSize = v; localStorage.setItem('bannerTitleSize', v); document.body.style.setProperty('--banner-title-size', v + 'px'); }, fmt: v => v + 'px' },
        bannerDescSize:    { val: () => bannerDescSize, set: v => { bannerDescSize = v; localStorage.setItem('bannerDescSize', v); document.body.style.setProperty('--banner-desc-size', v + 'px'); }, fmt: v => v + 'px' },
        contextTitleSize:  { val: () => contextTitleSize, set: v => { contextTitleSize = v; localStorage.setItem('contextTitleSize', v); document.body.style.setProperty('--context-title-size', v + 'px'); }, fmt: v => v + 'px' },
        contextBodySize:   { val: () => contextBodySize, set: v => { contextBodySize = v; localStorage.setItem('contextBodySize', v); document.body.style.setProperty('--context-body-size', v + 'px'); }, fmt: v => v + 'px' },
        cardNameSize:      { val: () => cardNameSize, set: v => { cardNameSize = v; localStorage.setItem('cardNameSize', v); document.body.style.setProperty('--card-name-size', v + 'px'); }, fmt: v => v + 'px' },
        cardOverlayBlur:   { val: () => cardOverlayBlur, set: v => { cardOverlayBlur = v; localStorage.setItem('cardOverlayBlur', v); document.body.style.setProperty('--card-overlay-blur', v + 'px'); }, fmt: v => v + 'px' },
        createTextSize:    { val: () => createTextSize, set: v => { createTextSize = v; localStorage.setItem('createTextSize', v); document.body.style.setProperty('--create-text-size', v + 'px'); }, fmt: v => v + 'px' },
        carouselCardNameSize: { val: () => carouselCardNameSize, set: v => { carouselCardNameSize = v; localStorage.setItem('carouselCardNameSize', v); document.body.style.setProperty('--carousel-card-name-size', v + 'px'); }, fmt: v => v + 'px' },
        cardLocationSize:  { val: () => cardLocationSize, set: v => {
            cardLocationSize = v;
            localStorage.setItem('cardLocationSize', v);
            document.body.style.setProperty('--card-location-size', v + 'px');
            document.body.style.setProperty('--card-region-size', v + 'px');
        }, fmt: v => v + 'px' },
        cardCommunitySize: { val: () => cardCommunitySize, set: v => {
            cardCommunitySize = v;
            localStorage.setItem('cardCommunitySize', v);
            document.body.style.setProperty('--card-community-size', v + 'px');
        }, fmt: v => v + 'px' },
        cardCreatorSize:   { val: () => cardCreatorSize, set: v => {
            cardCreatorSize = v;
            localStorage.setItem('cardCreatorSize', v);
            document.body.style.setProperty('--card-creator-size', v + 'px');
        }, fmt: v => v + 'px' },
        stageInstrumentScale: { val: () => stageInstrumentScale, set: v => {
            stageInstrumentScale = Math.max(0.6, Math.min(12, Number(v) || 1));
            localStorage.setItem('stageInstrumentScale', stageInstrumentScale);
            document.body.style.setProperty('--stage-token-scale', stageInstrumentScale.toFixed(2));
            if (typeof window._refreshStagePanelLayout === 'function') window._refreshStagePanelLayout();
        }, fmt: v => v.toFixed(2) + 'x' },
        stageLabelScale:   { val: () => stageLabelScale, set: v => {
            stageLabelScale = Math.max(0.6, Math.min(2.2, v));
            localStorage.setItem('stageLabelScale', stageLabelScale);
            document.body.style.setProperty('--stage-label-scale', stageLabelScale.toFixed(2));
            if (typeof window._refreshStagePanelLayout === 'function') window._refreshStagePanelLayout();
        }, fmt: v => v.toFixed(2) + 'x' },
        stageUiTextScale:   { val: () => stageUiTextScale, set: v => {
            stageUiTextScale = Math.max(0.7, Math.min(3.2, Number(v) || 1));
            localStorage.setItem('stageUiTextScale', stageUiTextScale);
            document.body.style.setProperty('--stage-ui-scale', stageUiTextScale.toFixed(2));
        }, fmt: v => v.toFixed(2) + 'x' },
        domeLabelSize:     { val: () => domeLabelSize, set: v => { domeLabelSize = v; localStorage.setItem('domeLabelSize', v); domeEntities.forEach(e => { if(e.label) e.label.font = `bold ${v}px ${getCesiumDisplayFontName()}`; }); }, fmt: v => v + 'px' },
        navLabelSize:      { val: () => navLabelSize, set: v => { navLabelSize = v; localStorage.setItem('navLabelSize', v); document.body.style.setProperty('--nav-label-size', v + 'px'); }, fmt: v => v + 'px' },
        planeHeading:      { val: () => planeHeading, set: v => { planeHeading = v; localStorage.setItem('planeHeading', v); }, fmt: v => v + '°' },
        planePitch:        { val: () => planePitch, set: v => { planePitch = v; localStorage.setItem('planePitch', v); }, fmt: v => v + '°' },
        planeRoll:         { val: () => planeRoll, set: v => { planeRoll = v; localStorage.setItem('planeRoll', v); }, fmt: v => v + '°' },
        focusBannerTitleSize:  { val: () => focusBannerTitleSize, set: v => { focusBannerTitleSize = v; localStorage.setItem('focusBannerTitleSize', v); document.body.style.setProperty('--focus-banner-title-size', v + 'px'); }, fmt: v => v + 'px' },
        focusBannerDescSize:   { val: () => focusBannerDescSize, set: v => { focusBannerDescSize = v; localStorage.setItem('focusBannerDescSize', v); document.body.style.setProperty('--focus-banner-desc-size', v + 'px'); }, fmt: v => v + 'px' },
        focusContextTitleSize: { val: () => focusContextTitleSize, set: v => { focusContextTitleSize = v; localStorage.setItem('focusContextTitleSize', v); document.body.style.setProperty('--focus-context-title-size', v + 'px'); }, fmt: v => v + 'px' },
        focusContextBodySize:  { val: () => focusContextBodySize, set: v => { focusContextBodySize = v; localStorage.setItem('focusContextBodySize', v); document.body.style.setProperty('--focus-context-body-size', v + 'px'); }, fmt: v => v + 'px' },
        tooltipTypeSpeed: { val: () => tooltipTypeSpeed, set: v => {
            tooltipTypeSpeed = Math.max(4, Math.min(80, v));
            localStorage.setItem('tooltipTypeSpeed', tooltipTypeSpeed);
            window._rrcTooltipTypeSpeed = tooltipTypeSpeed;
        }, fmt: v => Math.round(v) + 'ms' },
        tooltipHoverDelayMs: { val: () => tooltipHoverDelayMs, set: v => {
            tooltipHoverDelayMs = Math.max(0, Math.min(3000, Number(v) || 0));
            localStorage.setItem('tooltipHoverDelayMs', tooltipHoverDelayMs);
            window._rrcTooltipHoverDelayMs = tooltipHoverDelayMs;
        }, fmt: v => Math.round(v) + 'ms' },
        tooltipWindowScale: { val: () => tooltipWindowScale * 100, set: v => {
            tooltipWindowScale = Math.max(0.6, Math.min(2.6, v / 100));
            localStorage.setItem('tooltipWindowScale', tooltipWindowScale);
            window._rrcTooltipWindowScale = tooltipWindowScale;
        }, fmt: v => Math.round(v) + '%' },
        tooltipTextScale: { val: () => tooltipTextScale * 100, set: v => {
            tooltipTextScale = Math.max(0.6, Math.min(2.6, v / 100));
            localStorage.setItem('tooltipTextScale', tooltipTextScale);
            window._rrcTooltipTextScale = tooltipTextScale;
        }, fmt: v => Math.round(v) + '%' },
        debugScale:        { val: () => debugScale, set: v => {
            debugScale = v;
            localStorage.setItem('debugScale', v);
            const debugPanel = document.getElementById('debug-controls');
            if (debugPanel) {
                // Keep panel geometry stable; this slider only scales debug text.
                debugPanel.style.zoom = '1';
                debugPanel.style.transform = 'none';
            }
            document.body.style.setProperty('--debug-text-scale', String(v));
        }, fmt: v => v.toFixed(2) },
    };

    // Bind all range sliders + input fields
    for (const [id, cfg] of Object.entries(SETTINGS)) {
        const rangeEl = document.getElementById(id);
        const valEl = document.getElementById(id + '-val');
        const inputEl = document.getElementById(id + '-input');
        if (!rangeEl) continue;
        const initVal = cfg.val();
        rangeEl.value = initVal;
        if (valEl) valEl.textContent = cfg.fmt(parseFloat(rangeEl.value));
        if (inputEl) inputEl.value = initVal;
        rangeEl.addEventListener('input', () => {
            const v = parseFloat(rangeEl.value);
            cfg.set(v);
            if (valEl) valEl.textContent = cfg.fmt(v);
            if (inputEl) inputEl.value = v;
        });
        if (inputEl) {
            inputEl.addEventListener('input', () => {
                const v = parseFloat(inputEl.value);
                if (isNaN(v)) return;
                cfg.set(v);
                rangeEl.value = v;
                if (valEl) valEl.textContent = cfg.fmt(v);
            });
        }
    }

    const debugControlsRoot = document.getElementById('debug-scroll-view') || document.getElementById('debug-controls');
    const debugSearchInput = document.getElementById('debugSearchInput');
    if (debugControlsRoot && debugSearchInput) {
        const applyDebugSearchFilter = () => {
            const query = String(debugSearchInput.value || '').trim().toLowerCase();
            const isEmpty = query.length === 0;

            // Top-level rows (outside grouped sections)
            Array.from(debugControlsRoot.children).forEach((child) => {
                if (!(child instanceof HTMLElement)) return;
                if (!child.classList.contains('control-row')) return;
                if (child.classList.contains('debug-search-row')) return;
                if (isEmpty) {
                    child.style.display = '';
                    return;
                }
                const rowText = String(child.innerText || '').toLowerCase();
                child.style.display = rowText.includes(query) ? '' : 'none';
            });

            // Sectioned rows
            const sections = Array.from(debugControlsRoot.querySelectorAll('.debug-section'));
            sections.forEach((section) => {
                const titleEl = section.querySelector('.debug-section-title');
                const sectionTitle = String(titleEl ? titleEl.textContent : '').toLowerCase();
                const rows = Array.from(section.querySelectorAll('.control-row'));
                if (isEmpty) {
                    rows.forEach((row) => { row.style.display = ''; });
                    section.style.display = '';
                    return;
                }
                const sectionMatch = sectionTitle.includes(query);
                let rowMatchCount = 0;
                rows.forEach((row) => {
                    const rowText = String(row.innerText || '').toLowerCase();
                    const matched = sectionMatch || rowText.includes(query);
                    row.style.display = matched ? '' : 'none';
                    if (matched) rowMatchCount += 1;
                });
                section.style.display = rowMatchCount > 0 ? '' : 'none';
            });
        };

        debugSearchInput.addEventListener('input', applyDebugSearchFilter);
        applyDebugSearchFilter();
    }

    renderHintTextSettingsEditor();
    const hintTextResetBtn = document.getElementById('hintTextResetBtn');
    if (hintTextResetBtn && hintTextResetBtn.dataset.bound !== '1') {
        hintTextResetBtn.dataset.bound = '1';
        hintTextResetBtn.addEventListener('click', async () => {
            const ok = await ensureInAppUi().confirm('Reset all hint text back to defaults?', 'Reset Hints');
            if (!ok) return;
            setHintMessages({ ...DEFAULT_HINT_MESSAGES }, { persist: true });
            renderHintTextSettingsEditor();
        });
    }

    // Checkboxes
    const mapWindowedToggle = document.getElementById('mapWindowedToggle');
    const mapSceneModeSelect = document.getElementById('mapSceneModeSelect');
    const wfEl = document.getElementById('wireframeToggle');
    if (wfEl) { wfEl.checked = wireframeMode; wfEl.addEventListener('change', () => { wireframeMode = wfEl.checked; localStorage.setItem('wireframeMode', wireframeMode); updateAllDomes(); }); }
    const woEl = document.getElementById('wireframeOutlineToggle');
    if (woEl) { woEl.checked = showWireframeOutline; woEl.addEventListener('change', () => { showWireframeOutline = woEl.checked; localStorage.setItem('showWireframeOutline', showWireframeOutline); updateAllDomes(); }); }
    const spEl = document.getElementById('showPlaneToggle');
    if (spEl) { spEl.checked = showPlane; spEl.addEventListener('change', () => { showPlane = spEl.checked; localStorage.setItem('showPlane', showPlane); }); }
    const audioToggle = document.getElementById('useFirstVideoAsAudioToggle');
    if (audioToggle) { audioToggle.checked = useFirstVideoAsAudio; audioToggle.addEventListener('change', () => { useFirstVideoAsAudio = audioToggle.checked; localStorage.setItem('useFirstVideoAsAudio', useFirstVideoAsAudio); }); }
    const loadDatabaseOnStartupToggle = document.getElementById('loadDatabaseOnStartupToggle');
    if (loadDatabaseOnStartupToggle) {
        loadDatabaseOnStartupToggle.checked = loadDatabaseOnStartup;
        loadDatabaseOnStartupToggle.addEventListener('change', () => {
            loadDatabaseOnStartup = loadDatabaseOnStartupToggle.checked;
            localStorage.setItem('rrcLoadDatabaseOnStartup', loadDatabaseOnStartup ? 'true' : 'false');
        });
    }
    const snapEnabledToggle = document.getElementById('floatingSnapEnabledToggle');
    if (snapEnabledToggle) {
        snapEnabledToggle.checked = floatingSnapEnabled;
        snapEnabledToggle.addEventListener('change', () => {
            floatingSnapEnabled = snapEnabledToggle.checked;
            localStorage.setItem('floatingSnapEnabled', floatingSnapEnabled);
        });
    }
    const sessionEcoSyncToggle = document.getElementById('sessionEcoSyncToggle');
    if (sessionEcoSyncToggle) {
        sessionEcoSyncToggle.checked = sessionEcoSyncMode;
        sessionEcoSyncToggle.addEventListener('change', () => {
            sessionEcoSyncMode = sessionEcoSyncToggle.checked;
            localStorage.setItem('sessionEcoSyncMode', sessionEcoSyncMode ? 'true' : 'false');
            resetSessionTickBroadcastState();
        });
    }
    const sessionEcoTickGranularitySelect = document.getElementById('sessionEcoTickGranularity');
    if (sessionEcoTickGranularitySelect) {
        sessionEcoTickGranularitySelect.value = normalizeSessionEcoGranularity(sessionEcoTickGranularity);
        sessionEcoTickGranularitySelect.addEventListener('change', () => {
            sessionEcoTickGranularity = normalizeSessionEcoGranularity(sessionEcoTickGranularitySelect.value);
            localStorage.setItem('sessionEcoTickGranularity', sessionEcoTickGranularity);
            resetSessionTickBroadcastState();
        });
    }
    const sessionDefaultSyncModeSelect = document.getElementById('sessionDefaultSyncMode');
    if (sessionDefaultSyncModeSelect) {
        sessionDefaultSyncModeSelect.value = normalizeSessionSyncMode(sessionDefaultSyncMode);
        sessionDefaultSyncModeSelect.addEventListener('change', () => {
            sessionDefaultSyncMode = normalizeSessionSyncMode(sessionDefaultSyncModeSelect.value);
            localStorage.setItem('sessionDefaultSyncMode', sessionDefaultSyncMode);
            if (!sessionState.active) {
                sessionState.syncMode = sessionDefaultSyncMode;
                if (typeof window._rrcSyncSessionButtons === 'function') {
                    window._rrcSyncSessionButtons();
                }
            }
        });
    }
    const snapToWindowsToggle = document.getElementById('floatingSnapToWindowsToggle');
    if (snapToWindowsToggle) {
        snapToWindowsToggle.checked = floatingSnapToWindows;
        snapToWindowsToggle.addEventListener('change', () => {
            floatingSnapToWindows = snapToWindowsToggle.checked;
            localStorage.setItem('floatingSnapToWindows', floatingSnapToWindows);
        });
    }
    const snapToViewportToggle = document.getElementById('floatingSnapToViewportToggle');
    if (snapToViewportToggle) {
        snapToViewportToggle.checked = floatingSnapToViewport;
        snapToViewportToggle.addEventListener('change', () => {
            floatingSnapToViewport = snapToViewportToggle.checked;
            localStorage.setItem('floatingSnapToViewport', floatingSnapToViewport);
        });
    }
    const magneticDockToggle = document.getElementById('floatingMagneticDockToggle');
    if (magneticDockToggle) {
        magneticDockToggle.checked = floatingMagneticDock;
        magneticDockToggle.addEventListener('change', () => {
            floatingMagneticDock = magneticDockToggle.checked;
            localStorage.setItem('floatingMagneticDock', floatingMagneticDock);
        });
    }
    const topButtonsEmojiToggle = document.getElementById('topButtonsEmojiToggle');
    if (topButtonsEmojiToggle) {
        topButtonsEmojiToggle.checked = topButtonsUseEmoji;
        topButtonsEmojiToggle.addEventListener('change', () => {
            topButtonsUseEmoji = topButtonsEmojiToggle.checked;
            localStorage.setItem('topButtonsUseEmoji', topButtonsUseEmoji);
            if (!topButtonsUseEmoji && topButtonsCompactMode) {
                topButtonsCompactMode = false;
                localStorage.setItem('topButtonsCompactMode', 'false');
            }
            applyTopPanelButtonLabels();
        });
    }
    const showNavTopButtonToggle = document.getElementById('showNavTopButtonToggle');
    if (showNavTopButtonToggle) {
        showNavTopButtonToggle.checked = NAV_TOOLBAR_LEGACY_ENABLED && showNavTopButton;
        showNavTopButtonToggle.disabled = !NAV_TOOLBAR_LEGACY_ENABLED;
        showNavTopButtonToggle.addEventListener('change', () => {
            if (!NAV_TOOLBAR_LEGACY_ENABLED) {
                showNavTopButtonToggle.checked = false;
                return;
            }
            showNavTopButton = showNavTopButtonToggle.checked;
            localStorage.setItem('showNavTopButton', showNavTopButton ? 'true' : 'false');
            applyTopPanelButtonLabels();
        });
    }
    const stopTransportOnRhythmSelectToggle = document.getElementById('stopTransportOnRhythmSelectToggle');
    if (stopTransportOnRhythmSelectToggle) {
        stopTransportOnRhythmSelectToggle.checked = stopTransportOnRhythmSelect;
        stopTransportOnRhythmSelectToggle.addEventListener('change', () => {
            stopTransportOnRhythmSelect = stopTransportOnRhythmSelectToggle.checked;
            localStorage.setItem('stopTransportOnRhythmSelect', stopTransportOnRhythmSelect ? 'true' : 'false');
        });
    }
    const restoreRhythmPanelAfterJourneyToggle = document.getElementById('restoreRhythmPanelAfterJourneyToggle');
    if (restoreRhythmPanelAfterJourneyToggle) {
        restoreRhythmPanelAfterJourneyToggle.checked = restoreRhythmPanelAfterJourney;
        restoreRhythmPanelAfterJourneyToggle.addEventListener('change', () => {
            restoreRhythmPanelAfterJourney = restoreRhythmPanelAfterJourneyToggle.checked;
            localStorage.setItem('restoreRhythmPanelAfterJourney', restoreRhythmPanelAfterJourney ? 'true' : 'false');
        });
    }
    const rhythmCardContainImagesToggle = document.getElementById('rhythmCardContainImagesToggle');
    if (rhythmCardContainImagesToggle) {
        rhythmCardContainImagesToggle.checked = !!rhythmCardContainImages;
        rhythmCardContainImagesToggle.addEventListener('change', () => {
            rhythmCardContainImages = rhythmCardContainImagesToggle.checked;
            localStorage.setItem('rhythmCardContainImages', rhythmCardContainImages ? 'true' : 'false');
            applyRhythmCardImageMode();
        });
    }
    const tooltipHideOnUnhoverToggle = document.getElementById('tooltipHideOnUnhoverToggle');
    if (tooltipHideOnUnhoverToggle) {
        tooltipHideOnUnhoverToggle.checked = !!tooltipHideOnUnhover;
        tooltipHideOnUnhoverToggle.addEventListener('change', () => {
            tooltipHideOnUnhover = tooltipHideOnUnhoverToggle.checked;
            localStorage.setItem('tooltipHideOnUnhover', tooltipHideOnUnhover ? 'true' : 'false');
            window._rrcTooltipHideOnUnhover = tooltipHideOnUnhover;
        });
    }
    const padBeatArrowArcToggle = document.getElementById('padBeatArrowArcToggle');
    if (padBeatArrowArcToggle) {
        padBeatArrowArcToggle.checked = padBeatArrowArcEnabled;
        padBeatArrowArcToggle.addEventListener('change', () => {
            padBeatArrowArcEnabled = padBeatArrowArcToggle.checked;
            localStorage.setItem('padBeatArrowArcEnabled', padBeatArrowArcEnabled ? 'true' : 'false');
            if (typeof window._requestPadPreviewRefresh === 'function') {
                window._requestPadPreviewRefresh();
            }
        });
    }

    // Apply CSS vars on init
    document.body.style.setProperty('--banner-title-size', bannerTitleSize + 'px');
    document.body.style.setProperty('--banner-desc-size', bannerDescSize + 'px');
    document.body.style.setProperty('--context-title-size', contextTitleSize + 'px');
    document.body.style.setProperty('--context-body-size', contextBodySize + 'px');
    document.body.style.setProperty('--card-name-size', cardNameSize + 'px');
    document.body.style.setProperty('--card-overlay-blur', cardOverlayBlur + 'px');
    document.body.style.setProperty('--create-text-size', createTextSize + 'px');
    document.body.style.setProperty('--carousel-card-name-size', carouselCardNameSize + 'px');
    document.body.style.setProperty('--card-location-size', cardLocationSize + 'px');
    document.body.style.setProperty('--card-region-size', cardLocationSize + 'px');
    document.body.style.setProperty('--card-community-size', cardCommunitySize + 'px');
    document.body.style.setProperty('--card-creator-size', cardCreatorSize + 'px');
    document.body.style.setProperty('--stage-token-scale', stageInstrumentScale.toFixed(2));
    document.body.style.setProperty('--stage-label-scale', stageLabelScale.toFixed(2));
    document.body.style.setProperty('--stage-ui-scale', stageUiTextScale.toFixed(2));
    document.body.style.setProperty('--nav-label-size', navLabelSize + 'px');
    document.body.style.setProperty('--focus-banner-title-size', focusBannerTitleSize + 'px');
    document.body.style.setProperty('--focus-banner-desc-size', focusBannerDescSize + 'px');
    document.body.style.setProperty('--focus-context-title-size', focusContextTitleSize + 'px');
    document.body.style.setProperty('--focus-context-body-size', focusContextBodySize + 'px');
    // Apply debug scale
    const debugPanel = document.getElementById('debug-controls');
    if (debugPanel) {
        debugPanel.style.zoom = '1';
        debugPanel.style.transform = 'none';
    }
    document.body.style.setProperty('--debug-text-scale', String(debugScale));
    document.body.style.setProperty('--rhythm-panel-width', rhythmPanelWidth + 'px');
    document.body.style.setProperty('--rhythm-panel-height', rhythmPanelHeight + 'vh');
    applyUnifiedPanelOpacity();
    applyTopButtonsPanelAppearance();
    document.body.style.setProperty('--frost-intensity', frostIntensity + 'px');
    document.body.style.setProperty('--carousel-speed', carouselSpeed + 's');
    document.body.style.setProperty('--pad-preview-step-gap', padPreviewStepGap + 'px');
    document.body.style.setProperty('--pad-beat-start-gap', padBeatStartGap + 'px');
    document.body.style.setProperty('--pad-beat-divider-slot', (padBeatStartGap * 2) + 'px');
    document.body.style.setProperty('--pad-play-visual-scale', padPlayVisualScale.toFixed(3));
    document.body.style.setProperty('--pad-beat-indicator-height', padBeatIndicatorHeight + 'px');
    document.body.style.setProperty('--pad-beat-indicator-offset', padBeatIndicatorOffset + 'px');
    document.body.style.setProperty('--pad-beat-arrow-arc-height', `${notationBeatArcHeight}px`);
    document.body.style.setProperty('--text-scale', textScale);
    document.body.style.setProperty('--focus-text-scale', focusTextScale);
    document.body.style.setProperty('--tooltip-window-scale', tooltipWindowScale.toFixed(3));
    document.body.style.setProperty('--tooltip-text-scale', tooltipTextScale.toFixed(3));
    document.body.style.setProperty('--top-button-emoji-scale', topButtonEmojiScale.toFixed(2));
    document.body.style.setProperty('--top-toggle-phone-emoji-scale', topTogglePhoneEmojiScale.toFixed(2));
    document.body.style.setProperty('--top-toggle-laptop-emoji-scale', topToggleLaptopEmojiScale.toFixed(2));
    applyStageMinPanelWidth({ clampPosition: true });
    applyTopPanelLayoutMode();
    applyRhythmCardImageMode();
    applyFullscreenMapAlpha();
    if (typeof window._refreshPadNotationLayout === 'function') window._refreshPadNotationLayout();
    if (typeof window._syncNotationBeatArcVisual === 'function') window._syncNotationBeatArcVisual();
    if (typeof window._syncNotationPrimeLead === 'function') window._syncNotationPrimeLead();

    const SYSTEM_EXPORT_VERSION = 1;
    const WINDOW_LAYOUT_GAP = 8;
    const WINDOW_LAYOUT_EXCLUDED_IDS = new Set(['cesiumContainer']);
    const LOCAL_SYSTEM_AUTOSAVE_KEY = 'rrcLocalSystemStateAutoV1';
    const LOCAL_SYSTEM_AUTOSAVE_INTERVAL_MS = 30000;
    const NOTATION_STORAGE_KEYS = [
        'notationDebugSettings',
        'rhythmNotation',
        'notationScale',
        'notationCircularTempo',
        'notationCircularPopoutLayout',
        'notationPadEmitEvents'
    ];
    const SYSTEM_STORAGE_KEYS = [
        'rrcFloatingWindowStateV1',
        'rrcViewPresets',
        JOURNEY_STORAGE_KEY,
        LAST_SELECTED_RHYTHM_STORAGE_KEY,
        'rhythmPanelViewMode',
        'rhythmPanelTab',
        TOP_BUTTON_ORDER_STORAGE_KEY,
        'showNavTopButton',
        'stopTransportOnRhythmSelect',
        'restoreRhythmPanelAfterJourney',
        'topButtonsSideMode',
        'topButtonEmojiScale',
        'topTogglePhoneEmojiScale',
        'topToggleLaptopEmojiScale',
        'mapWindowRect'
    ];

    const readStorageValue = (key) => localStorage.getItem(key);
    const writeStorageValue = (key, value) => {
        if (value === null || value === undefined) {
            localStorage.removeItem(key);
            return;
        }
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    };

    const getTopUiClearance = () => {
        const topUi = document.getElementById('top-panel-toggles');
        if (!topUi) return 56;
        const style = window.getComputedStyle(topUi);
        if (style.display === 'none' || style.visibility === 'hidden') return 56;
        if (topUi.classList.contains('top-buttons-side')) return 56;
        return Math.max(56, Math.ceil(topUi.getBoundingClientRect().bottom + 8));
    };

    const captureFloatingWindowLayout = () => {
        if (typeof window._captureFloatingWindowLayout === 'function') {
            return window._captureFloatingWindowLayout();
        }
        const out = {};
        document.querySelectorAll('[data-floating-window="true"]').forEach((el) => {
            if (!el || !el.id) return;
            if (WINDOW_LAYOUT_EXCLUDED_IDS.has(el.id)) return;
            const rect = el.getBoundingClientRect();
            const left = Number.isFinite(parseFloat(el.style.left)) ? parseFloat(el.style.left) : rect.left;
            const top = Number.isFinite(parseFloat(el.style.top)) ? parseFloat(el.style.top) : rect.top;
            const width = Number.isFinite(parseFloat(el.style.width)) ? parseFloat(el.style.width) : rect.width;
            const height = Number.isFinite(parseFloat(el.style.height)) ? parseFloat(el.style.height) : rect.height;
            if (!Number.isFinite(width) || !Number.isFinite(height) || width < 20 || height < 20) return;
            const z = parseInt(el.style.zIndex, 10);
            out[el.id] = {
                left: Math.round(left),
                top: Math.round(top),
                width: Math.round(width),
                height: Math.round(height),
                active: el.classList.contains('active'),
                hidden: el.classList.contains('hidden'),
                panelHidden: el.classList.contains('panel-hidden'),
                zIndex: Number.isFinite(z) ? z : null
            };
        });
        return out;
    };

    const applyFloatingWindowLayout = (layout, sourceScreen) => {
        if (!layout || typeof layout !== 'object') return;
        // The window manager owns geometry: it refits the layout from the screen it was made on.
        const managerApply = typeof window._setFloatingWindowIntent === 'function' ? window._setFloatingWindowIntent : null;
        const sourceViewport = (sourceScreen && Number.isFinite(Number(sourceScreen.w)) && Number.isFinite(Number(sourceScreen.h)))
            ? { w: Number(sourceScreen.w), h: Number(sourceScreen.h) }
            : (managerApply && typeof window._inferFloatingLayoutViewport === 'function'
                ? window._inferFloatingLayoutViewport(layout)
                : null);
        const CORE_WINDOW_IDS = ['rhythm-panel', 'info-banner', 'history-box', 'image-window'];
        const layoutHidesAllCoreWindows = CORE_WINDOW_IDS.every((id) => {
            const state = layout[id];
            if (!state || typeof state !== 'object') return false;
            return state.hidden === true || state.panelHidden === true;
        });
        const minTop = getTopUiClearance();
        Object.entries(layout).forEach(([id, state]) => {
            if (!state || typeof state !== 'object') return;
            if (WINDOW_LAYOUT_EXCLUDED_IDS.has(id)) return;
            const el = document.getElementById(id);
            if (!el) return;

            if (managerApply) {
                managerApply(el, state, sourceViewport);
            } else {
            const style = window.getComputedStyle(el);
            const minW = parseInt(el.dataset.windowMinW, 10) || parseInt(style.minWidth, 10) || 220;
            const minH = parseInt(el.dataset.windowMinH, 10) || parseInt(style.minHeight, 10) || 120;
            const widthRaw = parseFloat(state.width);
            const heightRaw = parseFloat(state.height);
            const width = Math.max(minW, Number.isFinite(widthRaw) ? widthRaw : el.getBoundingClientRect().width);
            const height = Math.max(minH, Number.isFinite(heightRaw) ? heightRaw : el.getBoundingClientRect().height);
            const clampedWidth = Math.max(minW, Math.min(width, window.innerWidth - WINDOW_LAYOUT_GAP * 2));
            const clampedHeight = Math.max(minH, Math.min(height, window.innerHeight - minTop - WINDOW_LAYOUT_GAP));
            const leftRaw = parseFloat(state.left);
            const topRaw = parseFloat(state.top);
            const left = Number.isFinite(leftRaw) ? leftRaw : el.getBoundingClientRect().left;
            const top = Number.isFinite(topRaw) ? topRaw : el.getBoundingClientRect().top;
            const maxLeft = Math.max(WINDOW_LAYOUT_GAP, window.innerWidth - clampedWidth - WINDOW_LAYOUT_GAP);
            const maxTop = Math.max(minTop, window.innerHeight - clampedHeight - WINDOW_LAYOUT_GAP);
            const nextLeft = Math.max(WINDOW_LAYOUT_GAP, Math.min(left, maxLeft));
            const nextTop = Math.max(minTop, Math.min(top, maxTop));

            el.style.position = 'fixed';
            el.style.left = Math.round(nextLeft) + 'px';
            el.style.top = Math.round(nextTop) + 'px';
            el.style.width = Math.round(clampedWidth) + 'px';
            el.style.height = Math.round(clampedHeight) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.margin = '0';
            el.style.transform = 'none';
            el.dataset.windowPinned = '1';
            }

            if (typeof state.active === 'boolean') el.classList.toggle('active', state.active);
            if (!layoutHidesAllCoreWindows) {
                if (typeof state.hidden === 'boolean') el.classList.toggle('hidden', state.hidden);
                if (typeof state.panelHidden === 'boolean') el.classList.toggle('panel-hidden', state.panelHidden);
            }
            const z = parseInt(state.zIndex, 10);
            if (Number.isFinite(z)) el.style.zIndex = String(z);

            if (typeof window._updateFloatingWindowScale === 'function') {
                window._updateFloatingWindowScale(el);
            }
        });

        const debugPanel = document.getElementById('debug-controls');
        if (debugPanel && !debugPanel.classList.contains('hidden')) {
            debugPanel.style.zIndex = '5200';
        }
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };

    const captureViewStateForAccount = () => {
        const rhythmPanel = document.getElementById('rhythm-panel');
        return {
            version: SYSTEM_EXPORT_VERSION,
            floatingWindows: captureFloatingWindowLayout(),
            meta: {
                rhythmPanelView: rhythmPanel && rhythmPanel.classList.contains('carousel-mode') ? 'carousel' : 'cards',
                rhythmPanelTab: localStorage.getItem('rhythmPanelTab') === 'journeys' ? 'journeys' : 'browse',
                topButtonOrder: getCurrentTopPanelButtonOrder(),
                showNavTopButton: !!showNavTopButton,
                selectedRhythmKey: selectedRhythm || localStorage.getItem(LAST_SELECTED_RHYTHM_STORAGE_KEY) || ''
            }
        };
    };

    const applyViewStateForAccount = (viewState) => {
        if (!viewState || typeof viewState !== 'object') return;
        if (viewState.floatingWindows && typeof viewState.floatingWindows === 'object') {
            applyFloatingWindowLayout(viewState.floatingWindows);
        }
        const meta = viewState.meta && typeof viewState.meta === 'object' ? viewState.meta : null;
        if (meta) {
            if (meta.rhythmPanelView && typeof window._setRhythmPanelMode === 'function') {
                window._setRhythmPanelMode(meta.rhythmPanelView, { saveCurrent: false, restoreTarget: false });
            }
            if (meta.rhythmPanelTab && typeof window._setRhythmBrowserTab === 'function') {
                window._setRhythmBrowserTab(meta.rhythmPanelTab);
            }
            if (Array.isArray(meta.topButtonOrder)) {
                applyTopPanelButtonOrder(meta.topButtonOrder, true);
            }
            if (meta.showNavTopButton !== undefined) {
                showNavTopButton = NAV_TOOLBAR_LEGACY_ENABLED && !!meta.showNavTopButton;
                localStorage.setItem('showNavTopButton', showNavTopButton ? 'true' : 'false');
                const showNavTopButtonToggle = document.getElementById('showNavTopButtonToggle');
                if (showNavTopButtonToggle) showNavTopButtonToggle.checked = showNavTopButton;
                applyTopPanelButtonLabels();
                enforceLegacyNavDisabled();
            }
            if (meta.selectedRhythmKey) {
                localStorage.setItem(LAST_SELECTED_RHYTHM_STORAGE_KEY, String(meta.selectedRhythmKey));
                restoreLastSelectedRhythmOnLoad();
            }
        }
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };

    const captureSystemState = () => {
        const notation = {};
        NOTATION_STORAGE_KEYS.forEach((key) => {
            const value = readStorageValue(key);
            if (value !== null) notation[key] = value;
        });
        const storage = {};
        SYSTEM_STORAGE_KEYS.forEach((key) => {
            const value = readStorageValue(key);
            if (value !== null) storage[key] = value;
        });
        return {
            version: SYSTEM_EXPORT_VERSION,
            notation,
            storage,
            floatingWindows: captureFloatingWindowLayout(),
            meta: captureViewStateForAccount().meta
        };
    };

    const applySystemState = (system, options = {}) => {
        if (!system || typeof system !== 'object') return;
        const hasWindowManager = typeof window._setFloatingWindowIntent === 'function';
        if (system.storage && typeof system.storage === 'object') {
            Object.entries(system.storage).forEach(([key, value]) => {
                // The window manager saves its own layout; a raw copy here would fight with it.
                if (key === 'rrcFloatingWindowStateV1' && (hasWindowManager || options.skipWindows)) return;
                writeStorageValue(key, value);
            });
        }
        if (system.notation && typeof system.notation === 'object') {
            Object.entries(system.notation).forEach(([key, value]) => writeStorageValue(key, value));
        }
        if (!options.skipWindows && system.floatingWindows && typeof system.floatingWindows === 'object') {
            applyFloatingWindowLayout(system.floatingWindows, options.sourceScreen);
        }

        // Map container is special-cased; always apply mode explicitly after storage restore.
        if (system.storage && Object.prototype.hasOwnProperty.call(system.storage, 'mapWindowedMode')) {
            const rawMapMode = system.storage.mapWindowedMode;
            mapWindowedMode = rawMapMode === true || rawMapMode === 'true';
            if (mapWindowedToggle) mapWindowedToggle.checked = mapWindowedMode;
            applyMapWindowMode(mapWindowedMode);
        }

        const meta = system.meta && typeof system.meta === 'object' ? system.meta : null;
        if (meta) {
            if (meta.rhythmPanelView && typeof window._setRhythmPanelMode === 'function') {
                window._setRhythmPanelMode(meta.rhythmPanelView, { saveCurrent: false, restoreTarget: false });
            }
            if (meta.rhythmPanelTab && typeof window._setRhythmBrowserTab === 'function') {
                window._setRhythmBrowserTab(meta.rhythmPanelTab);
            }
            if (Array.isArray(meta.topButtonOrder)) {
                applyTopPanelButtonOrder(meta.topButtonOrder, true);
            }
            if (meta.showNavTopButton !== undefined) {
                showNavTopButton = NAV_TOOLBAR_LEGACY_ENABLED && !!meta.showNavTopButton;
                localStorage.setItem('showNavTopButton', showNavTopButton ? 'true' : 'false');
                const showNavTopButtonToggle = document.getElementById('showNavTopButtonToggle');
                if (showNavTopButtonToggle) showNavTopButtonToggle.checked = showNavTopButton;
                applyTopPanelButtonLabels();
                enforceLegacyNavDisabled();
            }
        }

        if (typeof window._refreshRhythmSourceAfterCollectionsChanged === 'function') {
            window._refreshRhythmSourceAfterCollectionsChanged();
        }
        if (typeof window._refreshPadNotationLayout === 'function') {
            window._refreshPadNotationLayout();
        }
        restoreLastSelectedRhythmOnLoad();
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        if (typeof window._syncNotationWindowVisibilityFromDom === 'function') {
            window._syncNotationWindowVisibilityFromDom();
        }
    };

    const saveLocalSystemAutosave = () => {
        const payload = {
            savedAt: new Date().toISOString(),
            system: captureSystemState()
        };
        writeStorageValue(LOCAL_SYSTEM_AUTOSAVE_KEY, payload);
        return payload;
    };

    const restoreCoreWindowsIfEverythingHidden = () => {
        if (document.documentElement.matches('.rrc-room, .rrc-room-boot')) return false;
        const CORE_WINDOW_IDS = ['rhythm-panel', 'info-banner', 'history-box', 'image-window'];
        const isVisible = (el) => {
            if (!el) return false;
            if (el.classList.contains('hidden') || el.classList.contains('panel-hidden')) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const hasVisibleCore = CORE_WINDOW_IDS.some((id) => isVisible(document.getElementById(id)));
        if (hasVisibleCore) return false;

        CORE_WINDOW_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove('hidden', 'panel-hidden');
            if (typeof window._bringFloatingWindowToFront === 'function') {
                window._bringFloatingWindowToFront(el);
            }
        });
        if (typeof window._syncTopPanelToggleStates === 'function') {
            window._syncTopPanelToggleStates();
        }
        return true;
    };

    const restoreLocalSystemAutosave = () => {
        const raw = readStorageValue(LOCAL_SYSTEM_AUTOSAVE_KEY);
        if (!raw) return false;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !parsed.system || typeof parsed.system !== 'object') return false;
            // Window positions are restored by the window manager from its own, always current, state.
            // Re-applying the (up to 30 s old) copy in this snapshot made windows jump on load.
            applySystemState(parsed.system, { skipWindows: typeof window._setFloatingWindowIntent === 'function' });
            restoreCoreWindowsIfEverythingHidden();
            return true;
        } catch {
            return false;
        }
    };

    window._captureSystemState = captureSystemState;
    window._applySystemState = applySystemState;
    window._captureViewStateForAccount = captureViewStateForAccount;
    window._applyViewStateForAccount = applyViewStateForAccount;
    window._saveSystemAutosaveState = saveLocalSystemAutosave;
    window._restoreSystemAutosaveState = restoreLocalSystemAutosave;

    const startupParams = new URLSearchParams(window.location.search || '');
    const startupMobileMode = (() => {
        if (!startupParams.has('mobile')) return false;
        const value = String(startupParams.get('mobile') || '').trim().toLowerCase();
        return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    })();
    const startupPadRemoteMode = startupParams.get('padRemote') === '1' || startupMobileMode;

    // Restore latest local snapshot on startup, then keep it fresh every 30s.
    // In pad-remote/mobile startup we intentionally skip restore to avoid the
    // "all windows pop in, then hide" flash; remote mode establishes its own layout.
    if (!startupPadRemoteMode) {
        restoreLocalSystemAutosave();
        // Final fail-safe in case persisted visibility state became corrupted.
        setTimeout(() => {
            if (restoreCoreWindowsIfEverythingHidden()) {
                try { saveLocalSystemAutosave(); } catch {}
            }
        }, 0);
    }
    if (window._rrcSystemAutosaveTimer) {
        clearInterval(window._rrcSystemAutosaveTimer);
    }
    window._rrcSystemAutosaveTimer = setInterval(() => {
        try { saveLocalSystemAutosave(); } catch {}
    }, LOCAL_SYSTEM_AUTOSAVE_INTERVAL_MS);
    if (!window._rrcSystemAutosaveLifecycleBound) {
        window.addEventListener('beforeunload', () => {
            try { saveLocalSystemAutosave(); } catch {}
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                try { saveLocalSystemAutosave(); } catch {}
            }
        });
        window._rrcSystemAutosaveLifecycleBound = true;
    }

    const collectSettingsData = () => {
        const data = {};
        for (const [id, cfg] of Object.entries(SETTINGS)) data[id] = cfg.val();
        data.wireframeMode = wireframeMode;
        data.showWireframeOutline = showWireframeOutline;
        data.showPlane = showPlane;
        data.floatingSnapEnabled = floatingSnapEnabled;
        data.floatingSnapToWindows = floatingSnapToWindows;
        data.floatingSnapToViewport = floatingSnapToViewport;
        data.floatingMagneticDock = floatingMagneticDock;
        data.sessionEcoSyncMode = sessionEcoSyncMode;
        data.sessionEcoTickGranularity = sessionEcoTickGranularity;
        data.sessionDefaultSyncMode = sessionDefaultSyncMode;
        data.topButtonsUseEmoji = topButtonsUseEmoji;
        data.topButtonsCompactMode = topButtonsCompactMode;
        data.topButtonsSideMode = topButtonsSideMode;
        data.showNavTopButton = showNavTopButton;
        data.stopTransportOnRhythmSelect = stopTransportOnRhythmSelect;
        data.restoreRhythmPanelAfterJourney = restoreRhythmPanelAfterJourney;
        data.loadDatabaseOnStartup = loadDatabaseOnStartup;
        data.rhythmCardContainImages = rhythmCardContainImages;
        data.tooltipHideOnUnhover = !!tooltipHideOnUnhover;
        data.hintMessages = { ...hintMessages };
        data.topPanelButtonOrder = getCurrentTopPanelButtonOrder();
        data.selectedImagery = selectedImagery;
        data.mapWindowedMode = mapWindowedMode;
        data.mapSceneMode = mapSceneMode;
        data.selectedFont = document.getElementById('fontSelect')?.value || '';
        data.selectedSecondaryFont = document.getElementById('secondaryFontSelect')?.value || '';
        data.selectedUiFont = document.getElementById('uiFontSelect')?.value || '';
        data.selectedMonoFont = document.getElementById('monoFontSelect')?.value || '';
        data._exported = new Date().toISOString();
        data._screen = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
        data.system = captureSystemState();
        return data;
    };

    const applyImportedSettings = (data, { skipWindows = false } = {}) => {
        if (!data || typeof data !== 'object') throw new Error('Invalid settings file');
        for (const [id, cfg] of Object.entries(SETTINGS)) {
            if (data[id] !== undefined) {
                cfg.set(parseFloat(data[id]));
                const el = document.getElementById(id);
                const valEl = document.getElementById(id + '-val');
                if (el) el.value = data[id];
                if (valEl) valEl.textContent = cfg.fmt(parseFloat(data[id]));
            }
        }
        if (data.wireframeMode !== undefined) { wireframeMode = data.wireframeMode; localStorage.setItem('wireframeMode', wireframeMode); if(wfEl) wfEl.checked = wireframeMode; updateAllDomes(); }
        if (data.showPlane !== undefined) { showPlane = data.showPlane; localStorage.setItem('showPlane', showPlane); if(spEl) spEl.checked = showPlane; }
        if (data.floatingSnapEnabled !== undefined) {
            floatingSnapEnabled = !!data.floatingSnapEnabled;
            localStorage.setItem('floatingSnapEnabled', floatingSnapEnabled);
            if (snapEnabledToggle) snapEnabledToggle.checked = floatingSnapEnabled;
        }
        if (data.floatingSnapToWindows !== undefined) {
            floatingSnapToWindows = !!data.floatingSnapToWindows;
            localStorage.setItem('floatingSnapToWindows', floatingSnapToWindows);
            if (snapToWindowsToggle) snapToWindowsToggle.checked = floatingSnapToWindows;
        }
        if (data.floatingSnapToViewport !== undefined) {
            floatingSnapToViewport = !!data.floatingSnapToViewport;
            localStorage.setItem('floatingSnapToViewport', floatingSnapToViewport);
            if (snapToViewportToggle) snapToViewportToggle.checked = floatingSnapToViewport;
        }
        if (data.floatingMagneticDock !== undefined) {
            floatingMagneticDock = !!data.floatingMagneticDock;
            localStorage.setItem('floatingMagneticDock', floatingMagneticDock);
            if (magneticDockToggle) magneticDockToggle.checked = floatingMagneticDock;
        }
        if (data.sessionEcoSyncMode !== undefined) {
            sessionEcoSyncMode = !!data.sessionEcoSyncMode;
            localStorage.setItem('sessionEcoSyncMode', sessionEcoSyncMode ? 'true' : 'false');
            if (sessionEcoSyncToggle) sessionEcoSyncToggle.checked = sessionEcoSyncMode;
        }
        if (data.sessionEcoTickGranularity !== undefined) {
            sessionEcoTickGranularity = normalizeSessionEcoGranularity(data.sessionEcoTickGranularity);
            localStorage.setItem('sessionEcoTickGranularity', sessionEcoTickGranularity);
            if (sessionEcoTickGranularitySelect) sessionEcoTickGranularitySelect.value = sessionEcoTickGranularity;
        }
        if (data.sessionDefaultSyncMode !== undefined) {
            sessionDefaultSyncMode = normalizeSessionSyncMode(data.sessionDefaultSyncMode);
            localStorage.setItem('sessionDefaultSyncMode', sessionDefaultSyncMode);
            if (sessionDefaultSyncModeSelect) sessionDefaultSyncModeSelect.value = sessionDefaultSyncMode;
            if (!sessionState.active) sessionState.syncMode = sessionDefaultSyncMode;
        }
        resetSessionTickBroadcastState();
        if (data.topButtonsUseEmoji !== undefined) {
            topButtonsUseEmoji = !!data.topButtonsUseEmoji;
            localStorage.setItem('topButtonsUseEmoji', topButtonsUseEmoji);
            if (topButtonsEmojiToggle) topButtonsEmojiToggle.checked = topButtonsUseEmoji;
        }
        if (data.topButtonsCompactMode !== undefined) {
            topButtonsCompactMode = !!data.topButtonsCompactMode;
            localStorage.setItem('topButtonsCompactMode', topButtonsCompactMode ? 'true' : 'false');
        }
        if (data.topButtonsSideMode !== undefined) {
            topButtonsSideMode = !!data.topButtonsSideMode;
            localStorage.setItem('topButtonsSideMode', topButtonsSideMode ? 'true' : 'false');
        }
        if (data.showNavTopButton !== undefined) {
            showNavTopButton = NAV_TOOLBAR_LEGACY_ENABLED && !!data.showNavTopButton;
            localStorage.setItem('showNavTopButton', showNavTopButton ? 'true' : 'false');
            if (showNavTopButtonToggle) showNavTopButtonToggle.checked = showNavTopButton;
            enforceLegacyNavDisabled();
        }
        if (data.stopTransportOnRhythmSelect !== undefined) {
            stopTransportOnRhythmSelect = !!data.stopTransportOnRhythmSelect;
            localStorage.setItem('stopTransportOnRhythmSelect', stopTransportOnRhythmSelect ? 'true' : 'false');
            const stopTransportToggle = document.getElementById('stopTransportOnRhythmSelectToggle');
            if (stopTransportToggle) stopTransportToggle.checked = stopTransportOnRhythmSelect;
        }
        if (data.restoreRhythmPanelAfterJourney !== undefined) {
            restoreRhythmPanelAfterJourney = !!data.restoreRhythmPanelAfterJourney;
            localStorage.setItem('restoreRhythmPanelAfterJourney', restoreRhythmPanelAfterJourney ? 'true' : 'false');
            const restoreRhythmPanelToggle = document.getElementById('restoreRhythmPanelAfterJourneyToggle');
            if (restoreRhythmPanelToggle) restoreRhythmPanelToggle.checked = restoreRhythmPanelAfterJourney;
        }
        if (data.loadDatabaseOnStartup !== undefined) {
            loadDatabaseOnStartup = !!data.loadDatabaseOnStartup;
            localStorage.setItem('rrcLoadDatabaseOnStartup', loadDatabaseOnStartup ? 'true' : 'false');
            const loadDatabaseOnStartupToggle = document.getElementById('loadDatabaseOnStartupToggle');
            if (loadDatabaseOnStartupToggle) loadDatabaseOnStartupToggle.checked = loadDatabaseOnStartup;
        }
        if (data.rhythmCardContainImages !== undefined) {
            rhythmCardContainImages = !!data.rhythmCardContainImages;
            localStorage.setItem('rhythmCardContainImages', rhythmCardContainImages ? 'true' : 'false');
            const rhythmCardContainImagesToggle = document.getElementById('rhythmCardContainImagesToggle');
            if (rhythmCardContainImagesToggle) rhythmCardContainImagesToggle.checked = rhythmCardContainImages;
            const padBeatArrowArcToggle = document.getElementById('padBeatArrowArcToggle');
            if (padBeatArrowArcToggle) padBeatArrowArcToggle.checked = !!padBeatArrowArcEnabled;
            applyRhythmCardImageMode();
        }
        if (data.tooltipHideOnUnhover !== undefined) {
            tooltipHideOnUnhover = !!data.tooltipHideOnUnhover;
            localStorage.setItem('tooltipHideOnUnhover', tooltipHideOnUnhover ? 'true' : 'false');
            window._rrcTooltipHideOnUnhover = tooltipHideOnUnhover;
            const tooltipHideOnUnhoverToggle = document.getElementById('tooltipHideOnUnhoverToggle');
            if (tooltipHideOnUnhoverToggle) tooltipHideOnUnhoverToggle.checked = tooltipHideOnUnhover;
        }
        if (data.hintMessages && typeof data.hintMessages === 'object') {
            setHintMessages(data.hintMessages, { persist: true });
            renderHintTextSettingsEditor();
        }
        if (Array.isArray(data.topPanelButtonOrder)) {
            applyTopPanelButtonOrder(data.topPanelButtonOrder, true);
        }
        if (!topButtonsUseEmoji && topButtonsCompactMode) {
            topButtonsCompactMode = false;
            localStorage.setItem('topButtonsCompactMode', 'false');
        }
        applyTopPanelLayoutMode();
        applyTopPanelButtonLabels();
        enforceLegacyNavDisabled();
        if (data.selectedImagery) {
            selectedImagery = data.selectedImagery;
            localStorage.setItem('selectedImagery', selectedImagery);
            changeImagery(selectedImagery);
            const iSel = document.getElementById('imagerySelect');
            if(iSel) iSel.value = selectedImagery;
        }
        if (data.mapWindowedMode !== undefined) {
            mapWindowedMode = !!data.mapWindowedMode;
            if (mapWindowedToggle) mapWindowedToggle.checked = mapWindowedMode;
            applyMapWindowMode(mapWindowedMode);
        }
        if (data.mapSceneMode !== undefined) {
            mapSceneMode = normalizeMapSceneMode(data.mapSceneMode);
            if (mapSceneModeSelect) mapSceneModeSelect.value = mapSceneMode;
            applyMapSceneMode(mapSceneMode);
        }
        if (data.selectedFont) {
            localStorage.setItem('selectedFont', String(data.selectedFont));
            const fontSelect = document.getElementById('fontSelect');
            if (fontSelect) fontSelect.value = String(data.selectedFont);
        }
        if (data.selectedSecondaryFont) {
            localStorage.setItem('selectedSecondaryFont', String(data.selectedSecondaryFont));
            const secondaryFontSelect = document.getElementById('secondaryFontSelect');
            if (secondaryFontSelect) secondaryFontSelect.value = String(data.selectedSecondaryFont);
        }
        if (data.selectedUiFont) {
            localStorage.setItem('selectedUiFont', String(data.selectedUiFont));
            const uiFontSelect = document.getElementById('uiFontSelect');
            if (uiFontSelect) uiFontSelect.value = String(data.selectedUiFont);
        }
        if (data.selectedMonoFont) {
            localStorage.setItem('selectedMonoFont', String(data.selectedMonoFont));
            const monoFontSelect = document.getElementById('monoFontSelect');
            if (monoFontSelect) monoFontSelect.value = String(data.selectedMonoFont);
        }
        const displayFont = localStorage.getItem('selectedFont') || "'Orbitron', sans-serif";
        const secondaryFont = localStorage.getItem('selectedSecondaryFont') || "'Rajdhani', sans-serif";
        const uiFont = localStorage.getItem('selectedUiFont') || "'Segoe UI', sans-serif";
        const monoFont = localStorage.getItem('selectedMonoFont') || "'Share Tech Mono', monospace";
        document.documentElement.style.setProperty('--font-display', displayFont);
        document.documentElement.style.setProperty('--font-secondary', secondaryFont);
        document.documentElement.style.setProperty('--font-ui', uiFont);
        document.documentElement.style.setProperty('--font-mono', monoFont);
        if (data.system && typeof data.system === 'object') {
            applySystemState(data.system, { sourceScreen: data._screen, skipWindows });
        }
    };

    const maybeApplyBundledDefaultSettings = () => {
        let alreadyApplied = '';
        try {
            alreadyApplied = String(localStorage.getItem(BUNDLED_DEFAULT_SETTINGS_PROFILE_KEY) || '');
        } catch {
            alreadyApplied = '';
        }
        if (alreadyApplied === BUNDLED_DEFAULT_SETTINGS_PROFILE_VERSION) return;
        try {
            const profile = JSON.parse(JSON.stringify(BUNDLED_DEFAULT_SETTINGS_PROFILE));
            if (!profile._screen) profile._screen = BUNDLED_DEFAULT_SETTINGS_SCREEN;
            const bundledWindows = profile.system && profile.system.floatingWindows;
            if (bundledWindows) {
                BUNDLED_DEFAULT_CLOSED_WINDOWS.forEach((id) => {
                    if (bundledWindows[id]) bundledWindows[id].hidden = true;
                });
                Object.values(bundledWindows).forEach((state) => { if (state) state.user = false; });
            }
            applyImportedSettings(profile, {
                skipWindows: document.documentElement.matches('.rrc-room, .rrc-room-boot')
            });
            localStorage.setItem(BUNDLED_DEFAULT_SETTINGS_PROFILE_KEY, BUNDLED_DEFAULT_SETTINGS_PROFILE_VERSION);
            console.log(`[RRC] Applied bundled default settings profile ${BUNDLED_DEFAULT_SETTINGS_PROFILE_VERSION}`);
        } catch (error) {
            console.warn('[RRC] Failed to apply bundled default settings profile:', error);
        }
    };
    maybeApplyBundledDefaultSettings();

    const saveStateBtn = document.getElementById('saveStateBtn');
    if (saveStateBtn && saveStateBtn.dataset.bound !== '1') {
        saveStateBtn.dataset.bound = '1';
        saveStateBtn.addEventListener('click', async () => {
            const defaultName = `state-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
            const name = await ensureInAppUi().prompt('Save current window layout as:', defaultName, 'Save State');
            if (!name) return;
            if (typeof window._rrcSaveViewPreset !== 'function') {
                await ensureInAppUi().alert('Views panel is not ready yet.', 'Save State');
                return;
            }
            window._rrcSaveViewPreset(name, { replaceByName: true });
            ensureInAppUi().toast(`Saved state "${name}".`, 'success', 2400);
        });
    }

    // ── Export ──
    document.getElementById('exportSettingsBtn').addEventListener('click', () => {
        const data = collectSettingsData();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `rrc-settings-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });

    // ── Import ──
    let settingsImportInput = null;
    document.getElementById('importSettingsBtn').addEventListener('click', async () => {
        if (!settingsImportInput) {
            settingsImportInput = document.createElement('input');
            settingsImportInput.type = 'file';
            settingsImportInput.accept = 'application/json,.json';
            settingsImportInput.style.display = 'none';
            document.body.appendChild(settingsImportInput);
        }
        settingsImportInput.value = '';
        settingsImportInput.onchange = async () => {
            const file = settingsImportInput.files && settingsImportInput.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                applyImportedSettings(data);
            } catch (e) {
                await ensureInAppUi().alert('Invalid settings JSON: ' + (e?.message || e), 'Import Error');
            }
        };
        settingsImportInput.click();
    });

    // ── Reset ──
    document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
        const ok = await ensureInAppUi().confirm('Reset all debug settings to defaults?', 'Reset Settings');
        if (!ok) return;
        const keys = Object.keys(SETTINGS).concat([
            'wireframeMode',
            'showWireframeOutline',
            'showPlane',
            'selectedImagery',
            'mapWindowedMode',
            'mapSceneMode',
            'mapWindowRect',
            'floatingSnapEnabled',
            'floatingSnapToWindows',
            'floatingSnapToViewport',
            'floatingMagneticDock',
            'sessionEcoSyncMode',
            'sessionEcoTickGranularity',
            'sessionDefaultSyncMode',
            'topButtonsUseEmoji',
            'topButtonsCompactMode',
            'topButtonsSideMode',
            'topButtonEmojiScale',
            'topTogglePhoneEmojiScale',
            'topToggleLaptopEmojiScale',
            'showNavTopButton',
            'stopTransportOnRhythmSelect',
            'restoreRhythmPanelAfterJourney',
            'rrcLoadDatabaseOnStartup',
            'tooltipHideOnUnhover',
            HINT_MESSAGES_STORAGE_KEY,
            LOCAL_SYSTEM_AUTOSAVE_KEY,
            TOP_BUTTON_ORDER_STORAGE_KEY
        ]);
        keys.forEach(k => localStorage.removeItem(k));
        location.reload();
    });
}

window.addEventListener('load', async () => {
    const disableNonAuthAutofill = () => {
        const isAuthField = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.closest('#auth-panel')) return true;
            const id = String(el.id || '').toLowerCase();
            return id.includes('email') || id.includes('password');
        };
        const applyField = (el) => {
            if (!(el instanceof HTMLElement)) return;
            if (isAuthField(el)) return;
            if (el instanceof HTMLInputElement) {
                const type = String(el.type || 'text').toLowerCase();
                if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return;
            }
            if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') !== 'off') {
                el.setAttribute('autocomplete', 'off');
            }
            if (el instanceof HTMLInputElement && el.type === 'text') {
                el.setAttribute('autocapitalize', 'off');
                el.setAttribute('spellcheck', 'false');
            }
        };
        document.querySelectorAll('input, textarea, select').forEach((el) => applyField(el));
        if (!window.__rrcNonAuthAutocompleteGuard) {
            const onFocusIn = (event) => applyField(event.target);
            document.addEventListener('focusin', onFocusIn, true);
            window.__rrcNonAuthAutocompleteGuard = true;
        }
    };
    disableNonAuthAutofill();

    // Longer delay to ensure Cesium and DOM are fully ready
    await new Promise(resolve => setTimeout(resolve, 300));

    if (typeof Cesium === 'undefined') {
        console.error('Cesium not available after load');
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.innerHTML = `
                <div class="loading-spinner"></div>
                <div class="loading-text" style="color: #ff0000;">
                    Failed to load Cesium library
                </div>
            `;
        }
        return;
    }

    // Set up Cesium token
    if (typeof CESIUM_ION_TOKEN !== 'undefined' && CESIUM_ION_TOKEN !== 'YOUR_TOKEN_HERE') {
        Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
        console.log('Cesium token set');
    } else {
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.innerHTML = `
                <div class="loading-spinner"></div>
                <div class="loading-text" style="max-width: 400px; font-size: 13px;">
                    Token Required<br>
                    <a href="https://ion.cesium.com/tokens" target="_blank" style="color: #00ffff;">Get Free Token</a>
                </div>
            `;
        }
        return;
    }

    console.log('Starting initialization...');
    await initCesium();
});
