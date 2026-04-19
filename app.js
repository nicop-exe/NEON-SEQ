/* =============================================
   NEON SEQ — Audio Engine, MIDI & UI Controller
   v3.0 — Inline FX, Filters, Envelopes, Polyrhythm
   Uses Tone.js 14.x & WebMIDI API
   ============================================= */

(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────
    let NUM_STEPS = 64;
    const INITIAL_TRACKS = 4;
    const STEP_OPTIONS = [4, 8, 12, 16, 24, 32, 48, 64];
    const TRACK_COLOR_PALETTE = [
        { hex: '#00d4ff', rgb: '0,212,255' },
        { hex: '#ff2d55', rgb: '255,45,85' },
        { hex: '#a855f7', rgb: '168,85,247' },
        { hex: '#00ffaa', rgb: '0,255,170' },
        { hex: '#f59e0b', rgb: '245,158,11' },
        { hex: '#ec4899', rgb: '236,72,153' },
        { hex: '#14b8a6', rgb: '20,184,166' },
        { hex: '#8b5cf6', rgb: '139,92,246' },
    ];

    // ── State ──────────────────────────────────────────
    let numTracks = 0;
    let projectName = 'Untitled';
    const grid = [];
    const muteState = [];
    const sampleNames = [];
    const trackLoopLengths = []; // Per-track loop length for polyrhythm
    let isPlaying = false;
    let currentStep = -1;
    let isRecording = false;
    let recorder = null;
    let recordedBlob = null;
    let loop = null;

    // MIDI State
    let midiAccess = null;
    let isMidiLearning = false;
    let midiMappings = {};
    let waitingForMidiCC = null;

    // Audio nodes (per track)
    const players = [];
    const filters = [];      // NEW: Tone.Filter
    const distortions = [];
    const delays = [];
    const reverbs = [];
    const panners = [];
    const volumes = [];

    // DOM caches
    const padElements = [];
    const muteButtons = [];
    const trackElements = [];
    const effectCards = [];
    const samplePool = [];

    // ── DOM refs ───────────────────────────────────────
    const playBtn = document.getElementById('playBtn');
    const stopBtn = document.getElementById('stopBtn');
    const bpmSlider = document.getElementById('bpmSlider');
    const bpmValue = document.getElementById('bpmValue');
    const swingSlider = document.getElementById('swingSlider');
    const swingValue = document.getElementById('swingValue');
    const stepSelector = document.getElementById('stepSelector');
    const currentStepEl = document.getElementById('currentStep');
    const stepIndicatorsEl = document.getElementById('stepIndicators');
    const tracksEl = document.getElementById('tracks');
    const fxPanelsContainer = document.getElementById('fxPanelsContainer');
    const recordBtn = document.getElementById('recordBtn');
    const exportAudioBtn = document.getElementById('exportAudioBtn');
    const saveBtn = document.getElementById('saveBtn');
    const loadBtn = document.getElementById('loadBtn');
    const loadJsonInput = document.getElementById('loadJsonInput');
    const loadPoolBtn = document.getElementById('loadPoolBtn');
    const poolFolderInput = document.getElementById('poolFolderInput');
    const samplePoolSection = document.getElementById('samplePoolSection');
    const samplePoolGrid = document.getElementById('samplePoolGrid');
    const poolCount = document.getElementById('poolCount');
    const closePoolBtn = document.getElementById('closePoolBtn');
    const addTrackBtn = document.getElementById('addTrackBtn');
    const midiLearnBtn = document.getElementById('midiLearnBtn');
    const keyAssignModal = document.getElementById('keyAssignModal');
    const modalCancelBtn = document.getElementById('modalCancelBtn');

    // ── Helpers ────────────────────────────────────────
    function getTrackColor(i) {
        return TRACK_COLOR_PALETTE[i % TRACK_COLOR_PALETTE.length];
    }

    // ── Audio Chain ────────────────────────────────────
    // Player -> Filter -> Distortion -> Delay -> Reverb -> Panner -> Volume -> Destination
    function createTrackAudio() {
        const player = new Tone.Player();
        player.volume.value = 0;
        const filter = new Tone.Filter({ frequency: 20000, type: 'lowpass', Q: 0 });
        const dist = new Tone.Distortion(0);
        const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0, wet: 0 });
        const reverb = new Tone.Reverb({ decay: 1.5, wet: 0 });
        const panner = new Tone.Panner(0);
        const vol = new Tone.Volume(0);
        player.chain(filter, dist, delay, reverb, panner, vol, Tone.getDestination());
        return { player, filter, dist, delay, reverb, panner, vol };
    }

    // ── Track Management ──────────────────────────────
    function addTrack() {
        const t = numTracks;
        numTracks++;
        const color = getTrackColor(t);

        const audio = createTrackAudio();
        players.push(audio.player);
        filters.push(audio.filter);
        distortions.push(audio.dist);
        delays.push(audio.delay);
        reverbs.push(audio.reverb);
        panners.push(audio.panner);
        volumes.push(audio.vol);

        grid.push(Array(NUM_STEPS).fill(false));
        muteState.push(false);
        sampleNames.push(null);
        trackLoopLengths.push(NUM_STEPS);

        buildTrackRow(t, color);
        buildEffectCard(t, color);
    }

    function removeTrack(t, force) {
        if (!force && numTracks <= 1) return;

        players[t].dispose();
        filters[t].dispose();
        distortions[t].dispose();
        delays[t].dispose();
        reverbs[t].dispose();
        panners[t].dispose();
        volumes[t].dispose();

        players.splice(t, 1);
        filters.splice(t, 1);
        distortions.splice(t, 1);
        delays.splice(t, 1);
        reverbs.splice(t, 1);
        panners.splice(t, 1);
        volumes.splice(t, 1);
        grid.splice(t, 1);
        muteState.splice(t, 1);
        sampleNames.splice(t, 1);
        trackLoopLengths.splice(t, 1);
        padElements.splice(t, 1);
        muteButtons.splice(t, 1);

        trackElements[t].remove();
        trackElements.splice(t, 1);

        // Remove FX panel from external container
        const fxPanel = document.getElementById(`fx-panel-${t}`);
        if (fxPanel) fxPanel.remove();
        effectCards.splice(t, 1);

        numTracks--;
        if (numTracks > 0) reindexTracks();
    }

    function clearAllTracks() {
        while (numTracks > 0) removeTrack(numTracks - 1, true);
    }

    function reindexTracks() {
        for (let i = 0; i < numTracks; i++) {
            const color = getTrackColor(i);
            const el = trackElements[i];
            el.style.setProperty('--track-color', color.hex);
            el.style.setProperty('--track-rgb', color.rgb);
            el.querySelector('.track-number').textContent = i + 1;

            // Reindex external FX panels
            const panels = fxPanelsContainer.querySelectorAll('.fx-panel');
            if (panels[i]) {
                panels[i].id = `fx-panel-${i}`;
                const header = panels[i].querySelector('.fx-panel-title');
                if (header) {
                    header.textContent = `TRACK ${i + 1} — FX`;
                    header.style.color = color.hex;
                }
            }

            const card = effectCards[i];
            if (card) {
                card.querySelectorAll('.effect-value').forEach(v => {
                    v.id = `fx-${v.dataset.fxKey}-val-${i}`;
                });
                card.querySelectorAll('.effect-slider').forEach(s => {
                    s.id = `fx-${s.dataset.fxKey}-${i}`;
                });
            }
        }
    }

    // ── Build Track Row ───────────────────────────────
    function buildTrackRow(t, color) {
        const track = document.createElement('div');
        track.classList.add('track');
        track.style.setProperty('--track-color', color.hex);
        track.style.setProperty('--track-rgb', color.rgb);

        const info = document.createElement('div');
        info.classList.add('track-info');

        const num = document.createElement('div');
        num.classList.add('track-number');
        num.textContent = t + 1;

        const uploadLabel = document.createElement('label');
        uploadLabel.classList.add('upload-btn');
        uploadLabel.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>CARGAR</span>
        `;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*';
        fileInput.classList.add('file-input');
        fileInput.addEventListener('change', (e) => handleFileUpload(e, t));
        uploadLabel.appendChild(fileInput);

        const muteBtn = document.createElement('button');
        muteBtn.classList.add('mute-btn');
        muteBtn.innerHTML = `<span class="mute-label">M</span>`;
        muteBtn.title = 'Mute';
        muteBtn.addEventListener('click', () => toggleMute(t));
        muteButtons[t] = muteBtn;

        const fxBtn = document.createElement('button');
        fxBtn.classList.add('fx-btn');
        fxBtn.textContent = 'FX';
        fxBtn.title = 'Efectos';
        fxBtn.addEventListener('click', () => toggleFxPanel(t));

        const removeBtn = document.createElement('button');
        removeBtn.classList.add('remove-track-btn');
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Eliminar track';
        removeBtn.addEventListener('click', () => removeTrack(t));

        info.appendChild(num);
        info.appendChild(uploadLabel);
        info.appendChild(muteBtn);
        info.appendChild(fxBtn);
        info.appendChild(removeBtn);

        const padsContainer = document.createElement('div');
        padsContainer.classList.add('pads-container');
        padElements[t] = [];

        for (let s = 0; s < NUM_STEPS; s++) {
            const pad = createPad(t, s);
            padsContainer.appendChild(pad);
            padElements[t][s] = pad;
        }

        track.appendChild(info);
        track.appendChild(padsContainer);
        tracksEl.appendChild(track);
        trackElements[t] = track;

        // Drag & Drop from pool
        track.addEventListener('dragover', (e) => { e.preventDefault(); track.classList.add('drag-over'); });
        track.addEventListener('dragleave', () => track.classList.remove('drag-over'));
        track.addEventListener('drop', (e) => {
            e.preventDefault();
            track.classList.remove('drag-over');
            const poolIdx = parseInt(e.dataTransfer.getData('text/plain'));
            if (!isNaN(poolIdx) && samplePool[poolIdx]) assignPoolSample(t, poolIdx);
        });
    }

    function createPad(t, s) {
        const pad = document.createElement('button');
        pad.classList.add('pad');
        pad.title = `Step ${s + 1}`;
        pad.addEventListener('click', () => togglePad(t, s));
        return pad;
    }

    // ── FX Definitions ────────────────────────────────
    const FX_DEFS = [
        { key: 'volume',      label: 'VOL',    min: -40,  max: 6,     step: 1,    defaultVal: 0 },
        { key: 'pan',         label: 'PAN',    min: -1,   max: 1,     step: 0.01, defaultVal: 0 },
        { key: 'filterFreq',  label: 'CUTOFF', min: 20,   max: 20000, step: 1,    defaultVal: 20000 },
        { key: 'filterRes',   label: 'RES',    min: 0,    max: 20,    step: 0.1,  defaultVal: 0 },
        { key: 'attack',      label: 'ATK',    min: 0,    max: 0.5,   step: 0.01, defaultVal: 0 },
        { key: 'release',     label: 'REL',    min: 0,    max: 2,     step: 0.01, defaultVal: 0 },
        { key: 'reverb',      label: 'REV',    min: 0,    max: 1,     step: 0.01, defaultVal: 0 },
        { key: 'reverbDecay', label: 'REVT',   min: 0.1,  max: 10,    step: 0.1,  defaultVal: 1.5 },
        { key: 'delay',       label: 'DLY',    min: 0,    max: 1,     step: 0.01, defaultVal: 0 },
        { key: 'delayTime',   label: 'DLYT',   min: 0,    max: 1,     step: 0.01, defaultVal: 0.25 },
        { key: 'saturation',  label: 'SAT',    min: 0,    max: 1,     step: 0.01, defaultVal: 0 },
        { key: 'loopLength',  label: 'LOOP',   min: 1,    max: 64,    step: 1,    defaultVal: 64 },
    ];

    // ── Toggle FX Panel (one at a time) ─────────────────
    let activeFxTrack = -1;

    function toggleFxPanel(t) {
        // Close all FX buttons
        document.querySelectorAll('.fx-btn.active').forEach(b => b.classList.remove('active'));

        if (activeFxTrack === t) {
            // Close current
            const panel = document.getElementById(`fx-panel-${t}`);
            if (panel) panel.classList.add('hidden');
            activeFxTrack = -1;
            return;
        }

        // Hide all panels
        fxPanelsContainer.querySelectorAll('.fx-panel').forEach(p => p.classList.add('hidden'));

        // Show selected
        const panel = document.getElementById(`fx-panel-${t}`);
        if (panel) {
            panel.classList.remove('hidden');
            const fxBtn = trackElements[t]?.querySelector('.fx-btn');
            if (fxBtn) fxBtn.classList.add('active');
            activeFxTrack = t;
        }
    }

    // ── Build Effect Card ──────────────────────────────
    // Groups: Mix, Filter, Envelope, Effects, Rhythm
    const FX_GROUPS = [
        {
            name: 'MIX',
            colorClass: 'fx-group-blue',
            keys: ['volume', 'pan'],
        },
        {
            name: 'FILTER',
            colorClass: 'fx-group-purple',
            keys: ['filterFreq', 'filterRes'],
        },
        {
            name: 'ENVELOPE',
            colorClass: 'fx-group-amber',
            keys: ['attack', 'release'],
        },
        {
            name: 'EFFECTS',
            colorClass: 'fx-group-cyan',
            keys: ['reverb', 'reverbDecay', 'delay', 'delayTime', 'saturation'],
        },
        {
            name: 'RHYTHM',
            colorClass: 'fx-group-green',
            keys: ['loopLength'],
        },
    ];

    function buildEffectCard(t, color) {
        // Create the external FX panel wrapper
        const panel = document.createElement('div');
        panel.classList.add('fx-panel', 'hidden');
        panel.id = `fx-panel-${t}`;

        const header = document.createElement('div');
        header.classList.add('fx-panel-header');

        const title = document.createElement('span');
        title.classList.add('fx-panel-title');
        title.textContent = `TRACK ${t + 1} — FX`;
        title.style.color = color.hex;

        const closeBtn = document.createElement('button');
        closeBtn.classList.add('fx-panel-close');
        closeBtn.innerHTML = '✕';
        closeBtn.addEventListener('click', () => toggleFxPanel(t));

        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const groupsRow = document.createElement('div');
        groupsRow.classList.add('fx-groups-row');

        for (const group of FX_GROUPS) {
            const groupBox = document.createElement('div');
            groupBox.classList.add('fx-group', group.colorClass);

            const groupTitle = document.createElement('div');
            groupTitle.classList.add('fx-group-title');
            groupTitle.textContent = group.name;
            groupBox.appendChild(groupTitle);

            for (const key of group.keys) {
                const fx = FX_DEFS.find(d => d.key === key);
                if (!fx) continue;

                const row = document.createElement('div');
                row.classList.add('effect-row');

                const label = document.createElement('span');
                label.classList.add('effect-label');
                label.textContent = fx.label;

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = fx.min;
                slider.max = fx.max;
                slider.step = fx.step;
                slider.value = fx.key === 'loopLength' ? NUM_STEPS : fx.defaultVal;
                slider.classList.add('slider', 'effect-slider');
                slider.id = `fx-${fx.key}-${t}`;
                slider.dataset.fxKey = fx.key;

                const valDisplay = document.createElement('span');
                valDisplay.classList.add('effect-value');
                valDisplay.id = `fx-${fx.key}-val-${t}`;
                valDisplay.dataset.fxKey = fx.key;
                valDisplay.textContent = formatFxValue(fx.key, fx.key === 'loopLength' ? NUM_STEPS : fx.defaultVal);

                slider.addEventListener('mousedown', (e) => {
                    if (isMidiLearning) {
                        e.preventDefault();
                        waitingForMidiCC = { track: t, param: fx.key };
                        document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
                        slider.classList.add('midi-learning-active');
                    }
                });

                slider.addEventListener('input', () => {
                    if (isMidiLearning) return;
                    const v = parseFloat(slider.value);
                    valDisplay.textContent = formatFxValue(fx.key, v);
                    applyEffect(t, fx.key, v);
                });

                row.appendChild(label);
                row.appendChild(slider);
                row.appendChild(valDisplay);
                groupBox.appendChild(row);
            }

            groupsRow.appendChild(groupBox);
        }

        panel.appendChild(groupsRow);
        fxPanelsContainer.appendChild(panel);
        effectCards[t] = groupsRow;
    }

    function formatFxValue(key, v) {
        switch (key) {
            case 'volume': return `${v > 0 ? '+' : ''}${Math.round(v)}dB`;
            case 'pan': return v === 0 ? 'C' : (v < 0 ? `L${Math.abs(Math.round(v * 10))}` : `R${Math.round(v * 10)}`);
            case 'reverb': case 'delay': case 'saturation': return `${Math.round(v * 100)}%`;
            case 'reverbDecay': case 'delayTime': return `${v.toFixed(2)}s`;
            case 'filterFreq': return v >= 1000 ? `${(v/1000).toFixed(1)}k` : `${Math.round(v)}Hz`;
            case 'filterRes': return v.toFixed(1);
            case 'attack': case 'release': return `${(v * 1000).toFixed(0)}ms`;
            case 'loopLength': return `${Math.round(v)}`;
            default: return v;
        }
    }

    function applyEffect(trackIdx, key, value) {
        if (trackIdx >= numTracks) return;
        switch (key) {
            case 'volume':      volumes[trackIdx].volume.value = value; break;
            case 'pan':         panners[trackIdx].pan.value = value; break;
            case 'filterFreq':  filters[trackIdx].frequency.value = value; break;
            case 'filterRes':   filters[trackIdx].Q.value = value; break;
            case 'attack':      players[trackIdx].fadeIn = value; break;
            case 'release':     players[trackIdx].fadeOut = value; break;
            case 'reverb':      reverbs[trackIdx].wet.value = value; break;
            case 'reverbDecay': reverbs[trackIdx].decay = value; break;
            case 'delay':       delays[trackIdx].wet.value = value; delays[trackIdx].feedback.value = value * 0.6; break;
            case 'delayTime':   delays[trackIdx].delayTime.value = value; break;
            case 'saturation':  distortions[trackIdx].distortion = value; distortions[trackIdx].wet.value = value > 0 ? 1 : 0; break;
            case 'loopLength':  trackLoopLengths[trackIdx] = Math.round(value); break;
        }
    }

    // ── MIDI ──────────────────────────────────────────
    function initMIDI() {
        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess().then(onMIDISuccess, () => console.warn('MIDI not available'));
        } else {
            if (midiLearnBtn) midiLearnBtn.disabled = true;
        }
    }

    function onMIDISuccess(midi) {
        midiAccess = midi;
        for (let input of midiAccess.inputs.values()) input.onmidimessage = handleMIDIMessage;
        midiAccess.onstatechange = (e) => {
            if (e.port.state === 'connected' && e.port.type === 'input') e.port.onmidimessage = handleMIDIMessage;
        };
        const saved = localStorage.getItem('neonseq_midi_map');
        if (saved) try { midiMappings = JSON.parse(saved); } catch(e) {}
    }

    function handleMIDIMessage(msg) {
        const [status, data1, data2] = msg.data;
        const cmd = status >> 4;
        const channel = status & 0xf;

        if (cmd === 11) {
            const mapKey = `${channel}_${data1}`;
            if (isMidiLearning && waitingForMidiCC) {
                midiMappings[mapKey] = { ...waitingForMidiCC };
                waitingForMidiCC = null;
                isMidiLearning = false;
                midiLearnBtn.classList.remove('active');
                midiLearnBtn.textContent = 'MIDI LEARN';
                document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
                localStorage.setItem('neonseq_midi_map', JSON.stringify(midiMappings));
                return;
            }
            const map = midiMappings[mapKey];
            if (map && map.track < numTracks) {
                const def = FX_DEFS.find(d => d.key === map.param);
                if (def) {
                    const val = def.min + ((data2 / 127) * (def.max - def.min));
                    applyEffect(map.track, map.param, val);
                    const slider = document.getElementById(`fx-${map.param}-${map.track}`);
                    const display = document.getElementById(`fx-${map.param}-val-${map.track}`);
                    if (slider) slider.value = val;
                    if (display) display.textContent = formatFxValue(map.param, val);
                }
            }
        }
    }

    if (midiLearnBtn) midiLearnBtn.addEventListener('click', () => {
        isMidiLearning = !isMidiLearning;
        midiLearnBtn.classList.toggle('active', isMidiLearning);
        midiLearnBtn.textContent = isMidiLearning ? 'LEARNING...' : 'MIDI LEARN';
        if (!isMidiLearning) {
            waitingForMidiCC = null;
            document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
        }
    });

    // ── Sample Handling ───────────────────────────────
    function toggleMute(t) {
        muteState[t] = !muteState[t];
        volumes[t].mute = muteState[t];
        muteButtons[t].classList.toggle('muted', muteState[t]);
        trackElements[t].classList.toggle('muted', muteState[t]);
    }

    function handleFileUpload(e, t) {
        if (e.target.files[0]) loadSampleToTrack(t, e.target.files[0]);
    }

    function loadSampleToTrack(t, file) {
        const url = URL.createObjectURL(file);
        const buf = new Tone.Buffer(url, () => {
            players[t].buffer = buf;
            sampleNames[t] = file.name;
            updateTrackLabel(t, file.name);
        });
    }

    function assignPoolSample(t, idx) {
        const s = samplePool[idx];
        if (s?.buffer) {
            players[t].buffer = s.buffer;
            sampleNames[t] = s.name;
            updateTrackLabel(t, s.name);
        }
    }

    function updateTrackLabel(t, name) {
        const span = trackElements[t]?.querySelector('.upload-btn span');
        if (span) {
            span.textContent = name.length > 12 ? name.substring(0, 10) + '…' : name;
            trackElements[t].querySelector('.upload-btn').classList.add('loaded');
        }
    }

    function togglePad(t, s) {
        grid[t][s] = !grid[t][s];
        padElements[t][s].classList.toggle('active', grid[t][s]);
    }

    // ── Sequencer ─────────────────────────────────────
    async function startSequencer() {
        if (loop) { loop.stop(); loop.dispose(); loop = null; }

        await Tone.start(); // FIX: await AudioContext resume
        isPlaying = true;
        playBtn.classList.add('active');

        const steps = Array.from({ length: NUM_STEPS }, (_, i) => i);
        loop = new Tone.Sequence((time, step) => {
            currentStep = step;
            Tone.Draw.schedule(() => updateVisuals(step), time);
            for (let t = 0; t < numTracks; t++) {
                // Polyrhythm: use modulo of track's loop length
                const loopLen = trackLoopLengths[t] || NUM_STEPS;
                const effectiveStep = step % loopLen;
                if (grid[t][effectiveStep] && !muteState[t] && players[t].buffer && players[t].buffer.loaded) {
                    players[t].start(time, 0);
                }
            }
        }, steps, '16n').start(0);

        Tone.Transport.start();
    }

    function stopSequencer() {
        if (!isPlaying) return;
        isPlaying = false;
        playBtn.classList.remove('active');
        if (loop) { loop.stop(); loop.dispose(); loop = null; }
        Tone.Transport.stop();
        currentStep = -1;
        updateVisuals(-1);
    }

    function updateVisuals(step) {
        document.querySelectorAll('.step-indicator.active').forEach(e => e.classList.remove('active'));
        document.querySelectorAll('.pad.current').forEach(e => e.classList.remove('current'));
        currentStepEl.textContent = step < 0 ? '--' : (step + 1);

        if (step >= 0) {
            const ind = stepIndicatorsEl.children[step];
            if (ind) {
                ind.classList.add('active');
                ind.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
            for (let t = 0; t < numTracks; t++) {
                const loopLen = trackLoopLengths[t] || NUM_STEPS;
                const effectiveStep = step % loopLen;
                if (padElements[t][effectiveStep]) padElements[t][effectiveStep].classList.add('current');
            }
        }
    }

    // ── Variable Steps ────────────────────────────────
    function initStepIndicators() {
        stepIndicatorsEl.innerHTML = '';
        for (let i = 0; i < NUM_STEPS; i++) {
            const d = document.createElement('div');
            d.className = 'step-indicator';
            d.textContent = i + 1;
            stepIndicatorsEl.appendChild(d);
        }
    }

    function setStepCount(newSteps) {
        if (newSteps === NUM_STEPS) return;
        for (let t = 0; t < numTracks; t++) {
            const padsContainer = trackElements[t].querySelector('.pads-container');
            if (newSteps > NUM_STEPS) {
                for (let s = NUM_STEPS; s < newSteps; s++) {
                    grid[t][s] = false;
                    const pad = createPad(t, s);
                    padsContainer.appendChild(pad);
                    padElements[t][s] = pad;
                }
            } else {
                for (let s = NUM_STEPS - 1; s >= newSteps; s--) {
                    if (padElements[t][s]) padElements[t][s].remove();
                    grid[t].length = newSteps;
                    padElements[t].length = newSteps;
                }
            }
            // Update loop length slider max and clamp value
            const loopSlider = document.getElementById(`fx-loopLength-${t}`);
            if (loopSlider) {
                loopSlider.max = newSteps;
                if (trackLoopLengths[t] > newSteps) {
                    trackLoopLengths[t] = newSteps;
                    loopSlider.value = newSteps;
                    const disp = document.getElementById(`fx-loopLength-val-${t}`);
                    if (disp) disp.textContent = newSteps;
                }
            }
        }
        NUM_STEPS = newSteps;
        initStepIndicators();
        if (isPlaying) { stopSequencer(); startSequencer(); }
    }

    stepSelector.addEventListener('change', (e) => setStepCount(parseInt(e.target.value)));

    // ── Save / Load ───────────────────────────────────
    function saveJSON() {
        const name = prompt('Nombre del proyecto:', projectName);
        if (!name) return;
        projectName = name;

        const data = {
            version: 6,
            name: projectName,
            bpm: parseInt(bpmSlider.value),
            swing: parseInt(swingSlider.value),
            numTracks,
            numSteps: NUM_STEPS,
            grid,
            mutes: muteState,
            loopLengths: trackLoopLengths,
            effects: {},
            samples: sampleNames,
            midiMappings
        };
        for (let t = 0; t < numTracks; t++) {
            data.effects[t] = {};
            FX_DEFS.forEach(fx => {
                const el = document.getElementById(`fx-${fx.key}-${t}`);
                if (el) data.effects[t][fx.key] = parseFloat(el.value);
            });
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        a.click();
    }

    async function loadJSON(file) {
        try {
            const txt = await file.text();
            const data = JSON.parse(txt);

            stopSequencer();
            clearAllTracks();

            // Restore step count
            const steps = data.numSteps || 64;
            NUM_STEPS = steps;
            stepSelector.value = steps;
            initStepIndicators();

            // Update loop length max in FX_DEFS
            const loopDef = FX_DEFS.find(d => d.key === 'loopLength');
            if (loopDef) loopDef.max = NUM_STEPS;

            // Restore project name
            if (data.name) projectName = data.name;

            // Restore BPM & Swing
            if (data.bpm) { bpmSlider.value = data.bpm; bpmValue.textContent = data.bpm; Tone.Transport.bpm.value = data.bpm; }
            if (data.swing !== undefined) { swingSlider.value = data.swing; swingValue.textContent = data.swing + '%'; Tone.Transport.swing = data.swing / 100; }

            // Recreate tracks
            const count = data.numTracks || 4;
            for (let i = 0; i < count; i++) addTrack();

            // Restore MIDI mappings
            if (data.midiMappings) {
                midiMappings = data.midiMappings;
                localStorage.setItem('neonseq_midi_map', JSON.stringify(midiMappings));
            }

            // Restore grid
            for (let t = 0; t < count; t++) {
                if (data.grid[t]) {
                    for (let s = 0; s < NUM_STEPS; s++) {
                        if (data.grid[t]?.[s]) {
                            grid[t][s] = true;
                            if (padElements[t]?.[s]) padElements[t][s].classList.add('active');
                        }
                    }
                }
                // Restore loop lengths (polyrhythm)
                if (data.loopLengths?.[t]) {
                    trackLoopLengths[t] = data.loopLengths[t];
                }
                // Restore sample name
                if (data.samples?.[t]) {
                    const sName = data.samples[t];
                    sampleNames[t] = sName;
                    const poolItem = samplePool.find(p => p.name === sName);
                    if (poolItem?.buffer) {
                        players[t].buffer = poolItem.buffer;
                        updateTrackLabel(t, sName);
                    } else {
                        updateTrackLabel(t, `⚠ ${sName}`);
                    }
                }
            }

            // Restore effects
            if (data.effects) {
                for (let t = 0; t < count; t++) {
                    if (data.effects[t]) {
                        for (const [k, v] of Object.entries(data.effects[t])) {
                            applyEffect(t, k, v);
                            const slider = document.getElementById(`fx-${k}-${t}`);
                            if (slider) slider.value = v;
                            const val = document.getElementById(`fx-${k}-val-${t}`);
                            if (val) val.textContent = formatFxValue(k, v);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error loading project:', e);
            alert('Error cargando el proyecto. Archivo inválido.');
        }
    }

    // ── WAV Export ─────────────────────────────────────
    function writeString(view, offset, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    function bufferToWave(abuffer, len) {
        const numCh = abuffer.numberOfChannels;
        const length = len * numCh * 2 + 44;
        const buf = new ArrayBuffer(length);
        const view = new DataView(buf);
        const channels = [];
        let pos = 0, offset = 0;

        writeString(view, pos, 'RIFF'); pos += 4;
        view.setUint32(pos, length - 8, true); pos += 4;
        writeString(view, pos, 'WAVE'); pos += 4;
        writeString(view, pos, 'fmt '); pos += 4;
        view.setUint32(pos, 16, true); pos += 4;
        view.setUint16(pos, 1, true); pos += 2;
        view.setUint16(pos, numCh, true); pos += 2;
        view.setUint32(pos, abuffer.sampleRate, true); pos += 4;
        view.setUint32(pos, abuffer.sampleRate * 2 * numCh, true); pos += 4;
        view.setUint16(pos, numCh * 2, true); pos += 2;
        view.setUint16(pos, 16, true); pos += 2;
        writeString(view, pos, 'data'); pos += 4;
        view.setUint32(pos, length - pos - 4, true); pos += 4;

        for (let i = 0; i < numCh; i++) channels.push(abuffer.getChannelData(i));

        while (pos < length) {
            for (let i = 0; i < numCh; i++) {
                let s = Math.max(-1, Math.min(1, channels[i][offset]));
                s = (0.5 + s < 0 ? s * 32768 : s * 32767) | 0;
                view.setInt16(pos, s, true);
                pos += 2;
            }
            offset++;
        }
        return new Blob([buf], { type: 'audio/wav' });
    }

    recordBtn.onclick = async () => {
        if (!isRecording) {
            await Tone.start();
            recorder = new Tone.Recorder();
            Tone.getDestination().connect(recorder);
            recorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
        } else {
            const blob = await recorder.stop();
            const fr = new FileReader();
            fr.onload = async function () {
                try {
                    const audioBuffer = await Tone.context.decodeAudioData(this.result);
                    recordedBlob = bufferToWave(audioBuffer, audioBuffer.length);
                    exportAudioBtn.disabled = false;
                } catch (e) {
                    console.error('WAV conversion error:', e);
                }
                isRecording = false;
                recordBtn.classList.remove('recording');
            };
            fr.readAsArrayBuffer(blob);
        }
    };

    exportAudioBtn.onclick = () => {
        if (!recordedBlob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(recordedBlob);
        a.download = `${projectName}-${Date.now()}.wav`;
        a.click();
    };

    // ── Sample Pool ───────────────────────────────────
    function loadSamplePool(files) {
        const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac)$/i.test(f.name));
        if (audioFiles.length) samplePoolSection.classList.remove('hidden');
        for (const f of audioFiles) {
            const i = samplePool.length;
            const url = URL.createObjectURL(f);
            const entry = { name: f.name, blobUrl: url, buffer: null };
            samplePool.push(entry);
            const buf = new Tone.Buffer(url, () => entry.buffer = buf);
            const el = document.createElement('div');
            el.className = 'pool-sample';
            el.draggable = true;
            el.innerHTML = `<span>${f.name.substr(0, 16)}</span>`;
            el.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', String(i)));
            el.addEventListener('dblclick', () => { if (entry.buffer) { const p = new Tone.Player(entry.buffer).toDestination(); p.start(); } });
            samplePoolGrid.appendChild(el);
        }
        poolCount.textContent = samplePool.length + ' samples';
    }

    // ── Event Wiring ──────────────────────────────────
    loadPoolBtn.onclick = () => poolFolderInput.click();
    poolFolderInput.onchange = e => loadSamplePool(e.target.files);
    closePoolBtn.onclick = () => samplePoolSection.classList.add('hidden');
    saveBtn.onclick = saveJSON;
    loadBtn.onclick = () => loadJsonInput.click();
    loadJsonInput.onchange = e => { if (e.target.files[0]) loadJSON(e.target.files[0]); };
    playBtn.onclick = () => isPlaying ? stopSequencer() : startSequencer();
    stopBtn.onclick = stopSequencer;
    addTrackBtn.onclick = addTrack;
    bpmSlider.oninput = e => { Tone.Transport.bpm.value = e.target.value; bpmValue.textContent = e.target.value; };
    swingSlider.oninput = e => { Tone.Transport.swing = e.target.value / 100; swingValue.textContent = e.target.value + '%'; };
    if (modalCancelBtn) modalCancelBtn.onclick = () => keyAssignModal?.classList.add('hidden');

    // ── Init ──────────────────────────────────────────
    initMIDI();
    initStepIndicators();
    for (let i = 0; i < INITIAL_TRACKS; i++) addTrack();

})();
