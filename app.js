/* =============================================
   NEON SEQ — Audio Engine, MIDI & UI Controller
   Uses Tone.js 14.x & WebMIDI API
   ============================================= */

(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────
    let NUM_STEPS = 64; // Dynamic
    const INITIAL_TRACKS = 4;
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
    const grid = [];          // grid[t][s] = bool
    const muteState = [];
    const sampleNames = [];   // stored name of loaded sample per track
    let isPlaying = false;
    let currentStep = -1;
    let isRecording = false;
    let recorder = null;
    let recordedBlob = null;
    let loop = null;

    // MIDI State
    let midiAccess = null;
    let isMidiLearning = false;
    let midiMappings = {}; // key: "channel_cc", value: { track: t, param: key }
    let waitingForMidiCC = null; // { track: t, param: key }

    // Key-assign modal state
    let assigningTrack = -1;

    // Audio nodes (per track)
    const players = [];
    const distortions = [];
    const delays = [];
    const reverbs = [];
    const panners = [];
    const volumes = [];

    // DOM elements
    const padElements = []; // padElements[t][s]
    const muteButtons = [];
    const trackElements = [];
    const effectCards = [];
    const samplePool = []; // { name, blobUrl, buffer }

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
    const effectsContainer = document.getElementById('effectsContainer');
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

    // Modal
    const keyAssignModal = document.getElementById('keyAssignModal');
    const modalCancelBtn = document.getElementById('modalCancelBtn');

    // ── Helpers ────────────────────────────────────────
    function getTrackColor(index) {
        return TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length];
    }

    // ── Audio Chain ────────────────────────────────────
    function createTrackAudio() {
        const player = new Tone.Player();
        player.volume.value = 0;
        const dist = new Tone.Distortion(0);
        const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0, wet: 0 });
        const reverb = new Tone.Reverb({ decay: 1.5, wet: 0 });
        const panner = new Tone.Panner(0);
        const vol = new Tone.Volume(0);
        player.chain(dist, delay, reverb, panner, vol, Tone.getDestination());
        return { player, dist, delay, reverb, panner, vol };
    }

    // ── Add Track ──────────────────────────────────────
    function addTrack() {
        const t = numTracks;
        numTracks++;
        const color = getTrackColor(t);

        // Audio
        const audio = createTrackAudio();
        players.push(audio.player);
        distortions.push(audio.dist);
        delays.push(audio.delay);
        reverbs.push(audio.reverb);
        panners.push(audio.panner);
        volumes.push(audio.vol);

        // State
        grid.push(Array(NUM_STEPS).fill(false));
        muteState.push(false);
        sampleNames.push(null);

        // DOM
        buildTrackRow(t, color);
        buildEffectCard(t, color);
    }

    function removeTrack(t) {
        if (numTracks <= 1) return;

        players[t].dispose();
        distortions[t].dispose();
        delays[t].dispose();
        reverbs[t].dispose();
        panners[t].dispose();
        volumes[t].dispose();

        players.splice(t, 1);
        distortions.splice(t, 1);
        delays.splice(t, 1);
        reverbs.splice(t, 1);
        panners.splice(t, 1);
        volumes.splice(t, 1);
        grid.splice(t, 1);
        muteState.splice(t, 1);
        sampleNames.splice(t, 1);
        padElements.splice(t, 1);
        muteButtons.splice(t, 1);

        trackElements[t].remove();
        trackElements.splice(t, 1);
        effectCards[t].remove();
        effectCards.splice(t, 1);

        numTracks--;
        reindexTracks();
    }

    function reindexTracks() {
        for (let i = 0; i < numTracks; i++) {
            const color = getTrackColor(i);
            const el = trackElements[i];
            el.style.setProperty('--track-color', color.hex);
            el.style.setProperty('--track-rgb', color.rgb);
            el.querySelector('.track-number').textContent = i + 1;

            const card = effectCards[i];
            card.querySelector('.effect-card-title').textContent = `TRACK ${i + 1}`;
            card.querySelector('.track-badge').textContent = `TRACK ${i + 1}`;
            card.querySelector('.effect-card-title').style.color = color.hex;
            card.querySelector('.track-badge').style.background = `rgba(${color.rgb}, 0.12)`;
            card.querySelector('.track-badge').style.color = color.hex;

            // Re-index slider IDs for Save/Load/MIDI consistency
            card.querySelectorAll('.effect-value').forEach(val => {
                const key = val.dataset.fxKey;
                val.id = `fx-${key}-val-${i}`;
            });
            card.querySelectorAll('.effect-slider').forEach(slider => {
                const key = slider.dataset.fxKey;
                slider.id = `fx-${key}-${i}`;
            });
        }
    }

    // ── Build Track DOM ────────────────────────────────
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
        muteBtn.innerHTML = `<span class="mute-label">M</span><span class="key-badge"></span>`;
        muteBtn.title = 'Mute';
        muteBtn.addEventListener('click', (e) => {
            if (e.target.closest('.key-assign-btn')) return;
            toggleMute(t);
        });
        muteButtons[t] = muteBtn;

        const removeBtn = document.createElement('button');
        removeBtn.classList.add('remove-track-btn');
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Eliminar track';
        removeBtn.addEventListener('click', () => removeTrack(t));

        info.appendChild(num);
        info.appendChild(uploadLabel);
        info.appendChild(muteBtn);
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

        // Drag & Drop
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

    // ── Build Effect Card ──────────────────────────────
    const FX_DEFS = [
        { key: 'volume', label: 'VOL', min: -40, max: 6, step: 1, defaultVal: 0 },
        { key: 'pan', label: 'PAN', min: -1, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'reverb', label: 'REV MIX', min: 0, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'reverbDecay', label: 'REV TIME', min: 0.1, max: 10, step: 0.1, defaultVal: 1.5 },
        { key: 'delay', label: 'DLY MIX', min: 0, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'delayTime', label: 'DLY TIME', min: 0, max: 1, step: 0.01, defaultVal: 0.25 },
        { key: 'saturation', label: 'SATUR', min: 0, max: 1, step: 0.01, defaultVal: 0 },
    ];

    function buildEffectCard(t, color) {
        const card = document.createElement('div');
        card.classList.add('effect-card');

        const header = document.createElement('div');
        header.classList.add('effect-card-header');

        const title = document.createElement('span');
        title.classList.add('effect-card-title');
        title.textContent = `TRACK ${t + 1}`;
        title.style.color = color.hex;

        const badge = document.createElement('span');
        badge.classList.add('track-badge');
        badge.textContent = `TRACK ${t + 1}`;
        badge.style.background = `rgba(${color.rgb}, 0.12)`;
        badge.style.color = color.hex;

        header.appendChild(title);
        header.appendChild(badge);
        card.appendChild(header);

        for (const fx of FX_DEFS) {
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
            slider.value = fx.defaultVal;
            slider.classList.add('slider', 'effect-slider', t % 2 === 0 ? 'slider-blue' : 'slider-red');
            slider.id = `fx-${fx.key}-${t}`;
            slider.dataset.fxKey = fx.key;

            const valDisplay = document.createElement('span');
            valDisplay.classList.add('effect-value');
            valDisplay.id = `fx-${fx.key}-val-${t}`;
            valDisplay.dataset.fxKey = fx.key;
            valDisplay.textContent = formatFxValue(fx.key, fx.defaultVal);

            // Slider Logic
            slider.addEventListener('mousedown', (e) => {
                if (isMidiLearning) {
                    e.preventDefault();
                    waitingForMidiCC = { track: t, param: fx.key };
                    document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
                    slider.classList.add('midi-learning-active');
                    alert(`Esperando señal MIDI para: Track ${t + 1} - ${fx.label}... Mové un control en tu dispositivo.`);
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
            card.appendChild(row);
        }

        effectsContainer.appendChild(card);
        effectCards[t] = card;
    }

    function formatFxValue(key, v) {
        switch (key) {
            case 'volume': return `${v > 0 ? '+' : ''}${Math.round(v)}dB`;
            case 'pan': return v === 0 ? 'C' : (v < 0 ? `L${Math.abs(Math.round(v * 10))}` : `R${Math.round(v * 10)}`);
            case 'reverb': case 'delay': case 'saturation': return `${Math.round(v * 100)}%`;
            case 'reverbDecay': case 'delayTime': return `${v.toFixed(2)}s`;
            default: return v;
        }
    }

    function applyEffect(trackIdx, key, value) {
        if (trackIdx >= numTracks) return;
        switch (key) {
            case 'volume': volumes[trackIdx].volume.value = value; break;
            case 'pan': panners[trackIdx].pan.value = value; break;
            case 'reverb': reverbs[trackIdx].wet.value = value; break;
            case 'reverbDecay': reverbs[trackIdx].decay = value; break;
            case 'delay': delays[trackIdx].wet.value = value; delays[trackIdx].feedback.value = value * 0.6; break;
            case 'delayTime': delays[trackIdx].delayTime.value = value; break;
            case 'saturation': distortions[trackIdx].distortion = value; distortions[trackIdx].wet.value = value > 0 ? 1 : 0; break;
        }
    }

    // ── MIDI Integration ───────────────────────────────
    function initMIDI() {
        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
        } else {
            console.warn('WebMIDI is not supported in this browser.');
            midiLearnBtn.disabled = true;
        }
    }

    function onMIDISuccess(midi) {
        midiAccess = midi;
        for (let input of midiAccess.inputs.values()) {
            input.onmidimessage = handleMIDIMessage;
        }
        midiAccess.onstatechange = (e) => {
            if (e.port.state === 'connected' && e.port.type === 'input') {
                e.port.onmidimessage = handleMIDIMessage;
            }
        };
        const saved = localStorage.getItem('neonseq_midi_map');
        if (saved) midiMappings = JSON.parse(saved);
    }

    function onMIDIFailure() { console.warn('Could not access MIDI devices.'); }

    function handleMIDIMessage(msg) {
        const [status, data1, data2] = msg.data;
        const channel = status & 0xf;
        const cmd = status >> 4;

        if (cmd === 11) { // Control Change (CC)
            const mapKey = `${channel}_${data1}`;

            if (isMidiLearning && waitingForMidiCC) {
                midiMappings[mapKey] = { ...waitingForMidiCC };
                waitingForMidiCC = null;
                isMidiLearning = false;
                midiLearnBtn.classList.remove('active');
                document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
                localStorage.setItem('neonseq_midi_map', JSON.stringify(midiMappings));
                alert(`Asignado CC ${data1} a Track ${midiMappings[mapKey].track + 1} - ${midiMappings[mapKey].param}`);
                return;
            }

            const map = midiMappings[mapKey];
            if (map && map.track < numTracks) {
                const def = FX_DEFS.find(d => d.key === map.param);
                if (def) {
                    const normalized = data2 / 127;
                    const val = def.min + (normalized * (def.max - def.min));
                    const slider = document.getElementById(`fx-${map.param}-${map.track}`);
                    const display = document.getElementById(`fx-${map.param}-val-${map.track}`);
                    if (slider && display) {
                        slider.value = val;
                        display.textContent = formatFxValue(map.param, val);
                        applyEffect(map.track, map.param, val);
                    }
                }
            }
        }
    }

    midiLearnBtn.addEventListener('click', () => {
        isMidiLearning = !isMidiLearning;
        midiLearnBtn.classList.toggle('active', isMidiLearning);
        if (isMidiLearning) {
            midiLearnBtn.textContent = 'LEARNING...';
            waitingForMidiCC = null;
        } else {
            midiLearnBtn.textContent = 'MIDI LEARN';
            waitingForMidiCC = null;
            document.querySelectorAll('.effect-slider').forEach(el => el.classList.remove('midi-learning-active'));
        }
    });

    // ── Sample Handling & Sequencer Logic ──────────────
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
        const span = trackElements[t].querySelector('.upload-btn span');
        span.textContent = name.length > 12 ? name.substring(0, 10) + '...' : name;
        trackElements[t].querySelector('.upload-btn').classList.add('loaded');
    }

    function togglePad(t, s) {
        grid[t][s] = !grid[t][s];
        padElements[t][s].classList.toggle('active', grid[t][s]);
    }

    function startSequencer() {
        if (loop) loop.dispose();
        if (isPlaying && !loop) return;

        Tone.start();
        isPlaying = true;
        playBtn.classList.add('active');

        // Create sequence for current NUM_STEPS
        const steps = Array.from({ length: NUM_STEPS }, (_, i) => i);
        loop = new Tone.Sequence((time, step) => {
            currentStep = step;
            Tone.Draw.schedule(() => updateVisuals(step), time);
            for (let t = 0; t < numTracks; t++) {
                if (grid[t][step] && !muteState[t] && players[t].buffer.loaded) {
                    players[t].start(time, 0, '16n');
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
            if (stepIndicatorsEl.children[step]) {
                const ind = stepIndicatorsEl.children[step];
                ind.classList.add('active');
                ind.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
            for (let t = 0; t < numTracks; t++) {
                if (padElements[t][step]) padElements[t][step].classList.add('current');
            }
        }
    }

    // ── Variable Steps Logic ───────────────────────────
    function initStepIndicators() {
        stepIndicatorsEl.innerHTML = '';
        for (let i = 0; i < NUM_STEPS; i++) {
            const d = document.createElement('div');
            d.className = 'step-indicator';
            d.textContent = i + 1;
            stepIndicatorsEl.appendChild(d);
        }
    }

    stepSelector.addEventListener('change', (e) => {
        const newSteps = parseInt(e.target.value);
        if (newSteps === NUM_STEPS) return;

        // Resize grid logic
        for (let t = 0; t < numTracks; t++) {
            const padsContainer = trackElements[t].querySelector('.pads-container');
            if (newSteps > NUM_STEPS) {
                // Grow
                for (let s = NUM_STEPS; s < newSteps; s++) {
                    grid[t][s] = false;
                    const pad = createPad(t, s);
                    padsContainer.appendChild(pad);
                    padElements[t][s] = pad;
                }
            } else {
                // Shrink
                for (let s = NUM_STEPS - 1; s >= newSteps; s--) {
                    if (padElements[t][s]) {
                        padElements[t][s].remove();
                        delete padElements[t][s]; // Clean array
                    }
                    grid[t].pop();
                    padElements[t].pop();
                }
            }
        }

        NUM_STEPS = newSteps;
        initStepIndicators();

        if (isPlaying) {
            stopSequencer();
            startSequencer();
        }
    });

    // ── Saving & Export ────────────────────────────────
    function saveJSON() {
        const data = {
            version: 5,
            bpm: parseInt(bpmSlider.value),
            numTracks,
            numSteps: NUM_STEPS, // Added numSteps persistence
            grid: grid,
            mutes: muteState,
            effects: {},
            samples: sampleNames,
            midiMappings: midiMappings // Added MIDI persistence
        };
        for (let t = 0; t < numTracks; t++) {
            data.effects[t] = {};
            FX_DEFS.forEach(fx => {
                const el = document.getElementById(`fx-${fx.key}-${t}`);
                if (el) data.effects[t][fx.key] = parseFloat(el.value);
            });
        }
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'neonseq-project.json';
        a.click();
    }

    async function loadJSON(file) {
        try {
            const txt = await file.text();
            const data = JSON.parse(txt);

            stopSequencer();

            // Restore Step Count
            if (data.numSteps && data.numSteps !== NUM_STEPS) {
                stepSelector.value = data.numSteps;
                stepSelector.dispatchEvent(new Event('change'));
            }

            while (numTracks > 0) removeTrack(numTracks - 1);
            const count = data.numTracks || 4;
            for (let i = 0; i < count; i++) addTrack();

            // Restore Mappings
            if (data.midiMappings) {
                midiMappings = data.midiMappings;
                localStorage.setItem('neonseq_midi_map', JSON.stringify(midiMappings));
            }

            // Restore Grid
            for (let t = 0; t < count; t++) {
                if (data.grid[t]) {
                    for (let s = 0; s < NUM_STEPS; s++) {
                        if (data.grid[t][s]) {
                            grid[t][s] = true;
                            if (padElements[t][s]) padElements[t][s].classList.add('active');
                        }
                    }
                }
                // Try to find sample in pool or just label it
                if (data.samples && data.samples[t]) {
                    const sName = data.samples[t];
                    sampleNames[t] = sName;
                    // Check pool
                    const poolItem = samplePool.find(p => p.name === sName);
                    if (poolItem && poolItem.buffer) {
                        players[t].buffer = poolItem.buffer;
                        updateTrackLabel(t, sName);
                    } else {
                        updateTrackLabel(t, `${sName} (MISSING)`);
                    }
                }
            }

            // Restore Effects
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
        } catch (e) { console.error('Error loading JSON', e); alert('Invalid Project File'); }
    }


    // ── Export WAV Fix ─────────────────────────────────
    // Helper to write string to DataView
    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    function bufferToWave(abuffer, len) {
        const numOfChan = abuffer.numberOfChannels;
        const length = len * numOfChan * 2 + 44;
        const buffer = new ArrayBuffer(length);
        const view = new DataView(buffer);
        const channels = [];
        let i, sample;
        let offset = 0;
        let pos = 0;

        // RIFF chunk descriptor
        writeString(view, pos, 'RIFF'); pos += 4;
        view.setUint32(pos, length - 8, true); pos += 4;
        writeString(view, pos, 'WAVE'); pos += 4;

        // FMT sub-chunk
        writeString(view, pos, 'fmt '); pos += 4;
        view.setUint32(pos, 16, true); pos += 4; // Subchunk1Size (16 for PCM)
        view.setUint16(pos, 1, true); pos += 2; // AudioFormat (1 = PCM)
        view.setUint16(pos, numOfChan, true); pos += 2;
        view.setUint32(pos, abuffer.sampleRate, true); pos += 4;
        view.setUint32(pos, abuffer.sampleRate * 2 * numOfChan, true); pos += 4; // ByteRate
        view.setUint16(pos, numOfChan * 2, true); pos += 2; // BlockAlign
        view.setUint16(pos, 16, true); pos += 2; // BitsPerSample

        // Data sub-chunk
        writeString(view, pos, 'data'); pos += 4;
        view.setUint32(pos, length - pos - 4, true); pos += 4;

        // Write interleaved data
        for (i = 0; i < abuffer.numberOfChannels; i++)
            channels.push(abuffer.getChannelData(i));

        while (pos < length) {
            for (i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
                view.setInt16(pos, sample, true);
                pos += 2;
            }
            offset++;
        }
        return new Blob([buffer], { type: "audio/wav" });
    }

    // Wiring Export
    recordBtn.onclick = async () => {
        if (!isRecording) {
            await Tone.start();
            // Start recording
            recorder = new Tone.Recorder();
            Tone.getDestination().connect(recorder);
            recorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
        } else {
            // Stop recording
            const blob = await recorder.stop();
            const url = URL.createObjectURL(blob);

            // Convert WebM/Opus blob to AudioBuffer then to WAV
            const fileReader = new FileReader();
            fileReader.onload = async function () {
                const arrayBuffer = this.result;
                const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);
                const wavBlob = bufferToWave(audioBuffer, audioBuffer.length);
                recordedBlob = wavBlob;

                isRecording = false;
                recordBtn.classList.remove('recording');
                exportAudioBtn.disabled = false;
                alert('Audio grabado y convertido a WAV. Listo para descargar.'); // Feedback
            };
            fileReader.readAsArrayBuffer(blob);
        }
    };
    exportAudioBtn.onclick = () => {
        if (!recordedBlob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(recordedBlob);
        a.download = `neonseq-${Date.now()}.wav`;
        a.click();
    };

    // ── Init ───────────────────────────────────────────
    loadPoolBtn.onclick = () => poolFolderInput.click();
    poolFolderInput.onchange = e => loadSamplePool(e.target.files);
    closePoolBtn.onclick = () => samplePoolSection.classList.add('hidden');
    saveBtn.onclick = saveJSON;
    loadBtn.onclick = () => loadJsonInput.click();
    loadJsonInput.onchange = e => loadJSON(e.target.files[0]);
    playBtn.onclick = () => isPlaying ? stopSequencer() : startSequencer();
    stopBtn.onclick = stopSequencer;
    addTrackBtn.onclick = addTrack;
    bpmSlider.oninput = e => { Tone.Transport.bpm.value = e.target.value; bpmValue.textContent = e.target.value; };
    swingSlider.oninput = e => { Tone.Transport.swing = e.target.value / 100; swingValue.textContent = e.target.value + '%'; };

    // keyAssignModal logic (simplified)
    const openKeyAssignModal = (t) => { assigningTrack = t; keyAssignModal.classList.remove('hidden'); };
    modalCancelBtn.onclick = () => keyAssignModal.classList.add('hidden');

    function loadSamplePool(files) {
        const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(wav|mp3)$/i.test(f.name));
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

    initMIDI();
    initStepIndicators();
    for (let i = 0; i < INITIAL_TRACKS; i++) addTrack();

})();
