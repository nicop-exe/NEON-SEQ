/* =============================================
   NEON SEQ — Audio Engine & UI Controller
   Uses Tone.js 14.x
   ============================================= */

(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────
    const NUM_STEPS = 16;
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
    const keyBindings = [];   // assigned key per track
    let isPlaying = false;
    let currentStep = -1;
    let isRecording = false;
    let recorder = null;
    let recordedBlob = null;

    // Key-assign modal state
    let assigningTrack = -1;
    let modalKeyHandler = null;

    // Audio nodes (per track, indexed arrays)
    const players = [];
    const distortions = [];
    const delays = [];
    const reverbs = [];
    const panners = [];
    const volumes = [];

    // DOM elements per track
    const padElements = [];
    const muteButtons = [];
    const trackElements = [];
    const effectCards = [];

    // Sample pool
    const samplePool = []; // { name, blobUrl, buffer }

    // ── DOM refs ───────────────────────────────────────
    const playBtn = document.getElementById('playBtn');
    const stopBtn = document.getElementById('stopBtn');
    const bpmSlider = document.getElementById('bpmSlider');
    const bpmValue = document.getElementById('bpmValue');
    const swingSlider = document.getElementById('swingSlider');
    const swingValue = document.getElementById('swingValue');
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
    const keyAssignModal = document.getElementById('keyAssignModal');
    const modalTrackName = document.getElementById('modalTrackName');
    const modalKeyDisplay = document.getElementById('modalKeyDisplay');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const modalClearBtn = document.getElementById('modalClearBtn');

    // ── Track color helper ─────────────────────────────
    function getTrackColor(index) {
        return TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length];
    }

    // ── Create audio chain for one track ───────────────
    function createTrackAudio() {
        const player = new Tone.Player();
        player.volume.value = 0;
        const dist = new Tone.Distortion(0);
        const delay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0, wet: 0 });
        const reverb = new Tone.Reverb({ decay: 1.5, wet: 0 });
        const panner = new Tone.Panner(0);
        const vol = new Tone.Volume(0);
        player.chain(dist, delay, reverb, panner, vol, Tone.getDestination());
        return { player, dist, delay, reverb, panner, vol };
    }

    // ── Add a single track ─────────────────────────────
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
        keyBindings.push(null);

        // Build track row DOM
        buildTrackRow(t, color);

        // Build effects card
        buildEffectCard(t, color);
    }

    // ── Remove a track ─────────────────────────────────
    function removeTrack(t) {
        if (numTracks <= 1) return; // keep at least 1

        // Dispose audio nodes
        players[t].dispose();
        distortions[t].dispose();
        delays[t].dispose();
        reverbs[t].dispose();
        panners[t].dispose();
        volumes[t].dispose();

        // Remove from arrays
        players.splice(t, 1);
        distortions.splice(t, 1);
        delays.splice(t, 1);
        reverbs.splice(t, 1);
        panners.splice(t, 1);
        volumes.splice(t, 1);
        grid.splice(t, 1);
        muteState.splice(t, 1);
        keyBindings.splice(t, 1);
        padElements.splice(t, 1);
        muteButtons.splice(t, 1);

        // Remove DOM
        trackElements[t].remove();
        trackElements.splice(t, 1);
        effectCards[t].remove();
        effectCards.splice(t, 1);

        numTracks--;

        // Re-index remaining tracks visually
        reindexTracks();
    }

    function reindexTracks() {
        for (let i = 0; i < numTracks; i++) {
            const color = getTrackColor(i);
            const el = trackElements[i];
            el.style.setProperty('--track-color', color.hex);
            el.style.setProperty('--track-rgb', color.rgb);
            el.querySelector('.track-number').textContent = i + 1;

            // Update effect card header
            const card = effectCards[i];
            card.querySelector('.effect-card-title').textContent = `TRACK ${i + 1}`;
            card.querySelector('.track-badge').textContent = `TRACK ${i + 1}`;
            card.querySelector('.effect-card-title').style.color = color.hex;
            card.querySelector('.track-badge').style.background = `rgba(${color.rgb}, 0.12)`;
            card.querySelector('.track-badge').style.color = color.hex;

            // Re-index slider IDs
            card.querySelectorAll('.effect-slider').forEach(slider => {
                const key = slider.dataset.fxKey;
                slider.id = `fx-${key}-${i}`;
            });
            card.querySelectorAll('.effect-value').forEach(valEl => {
                const key = valEl.dataset.fxKey;
                valEl.id = `fx-${key}-val-${i}`;
            });
        }
    }

    // ── Build Track Row DOM ─────────────────────────────
    function buildTrackRow(t, color) {
        const track = document.createElement('div');
        track.classList.add('track');
        track.style.setProperty('--track-color', color.hex);
        track.style.setProperty('--track-rgb', color.rgb);
        track.style.animation = 'fade-in 0.3s ease-out';

        // Track info
        const info = document.createElement('div');
        info.classList.add('track-info');

        const num = document.createElement('div');
        num.classList.add('track-number');
        num.textContent = t + 1;

        // Upload button
        const uploadLabel = document.createElement('label');
        uploadLabel.classList.add('upload-btn');
        uploadLabel.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>CARGAR</span>
        `;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*';
        fileInput.classList.add('file-input');
        fileInput.addEventListener('change', (e) => handleFileUpload(e, t));
        uploadLabel.appendChild(fileInput);

        // Mute button
        const muteBtn = document.createElement('button');
        muteBtn.classList.add('mute-btn');
        muteBtn.innerHTML = `<span class="mute-label">M</span><span class="key-badge"></span>`;
        muteBtn.title = 'Mute';
        muteBtn.addEventListener('click', (e) => {
            if (e.target.closest('.key-assign-btn')) return;
            toggleMute(t);
        });

        const keyAssignIcon = document.createElement('div');
        keyAssignIcon.classList.add('key-assign-btn');
        keyAssignIcon.innerHTML = '⌨';
        keyAssignIcon.title = 'Asignar tecla';
        keyAssignIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            openKeyAssignModal(t);
        });
        muteBtn.appendChild(keyAssignIcon);
        muteButtons[t] = muteBtn;

        // Remove track button
        const removeBtn = document.createElement('button');
        removeBtn.classList.add('remove-track-btn');
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Eliminar track';
        removeBtn.addEventListener('click', () => removeTrack(t));

        info.appendChild(num);
        info.appendChild(uploadLabel);
        info.appendChild(muteBtn);
        info.appendChild(removeBtn);

        // Pads
        const padsContainer = document.createElement('div');
        padsContainer.classList.add('pads-container');
        padElements[t] = [];

        for (let s = 0; s < NUM_STEPS; s++) {
            const pad = document.createElement('button');
            pad.classList.add('pad');
            pad.addEventListener('click', () => togglePad(t, s));
            padsContainer.appendChild(pad);
            padElements[t][s] = pad;
        }

        track.appendChild(info);
        track.appendChild(padsContainer);
        tracksEl.appendChild(track);
        trackElements[t] = track;

        // Drag & drop: accept pool samples
        track.addEventListener('dragover', (e) => {
            e.preventDefault();
            track.classList.add('drag-over');
        });
        track.addEventListener('dragleave', () => {
            track.classList.remove('drag-over');
        });
        track.addEventListener('drop', (e) => {
            e.preventDefault();
            track.classList.remove('drag-over');
            const poolIdx = parseInt(e.dataTransfer.getData('text/plain'));
            if (!isNaN(poolIdx) && samplePool[poolIdx]) {
                assignPoolSample(t, poolIdx);
            }
        });
    }

    // ── Build Effect Card ──────────────────────────────
    const FX_DEFS = [
        { key: 'volume', label: 'VOL', min: -40, max: 6, step: 1, defaultVal: 0 },
        { key: 'pan', label: 'PAN', min: -1, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'reverb', label: 'REVERB', min: 0, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'delay', label: 'DELAY', min: 0, max: 1, step: 0.01, defaultVal: 0 },
        { key: 'saturation', label: 'SATUR', min: 0, max: 1, step: 0.01, defaultVal: 0 },
    ];

    function buildEffectCard(t, color) {
        const card = document.createElement('div');
        card.classList.add('effect-card');
        card.style.animation = 'fade-in 0.3s ease-out';

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

            slider.addEventListener('input', () => {
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

    // ── Format effect display value ────────────────────
    function formatFxValue(key, v) {
        switch (key) {
            case 'volume': return `${v > 0 ? '+' : ''}${v}dB`;
            case 'pan': {
                if (v === 0) return 'C';
                return v < 0 ? `L${Math.abs(Math.round(v * 100))}` : `R${Math.round(v * 100)}`;
            }
            case 'reverb':
            case 'delay':
            case 'saturation':
                return `${Math.round(v * 100)}%`;
            default: return v;
        }
    }

    // ── Apply effect value to audio node ───────────────
    function applyEffect(trackIdx, key, value) {
        if (trackIdx >= numTracks) return;
        switch (key) {
            case 'volume':
                volumes[trackIdx].volume.value = value;
                break;
            case 'pan':
                panners[trackIdx].pan.value = value;
                break;
            case 'reverb':
                reverbs[trackIdx].wet.value = value;
                break;
            case 'delay':
                delays[trackIdx].wet.value = value;
                delays[trackIdx].feedback.value = value * 0.6;
                break;
            case 'saturation':
                distortions[trackIdx].distortion = value;
                distortions[trackIdx].wet.value = value > 0 ? 1 : 0;
                break;
        }
    }

    // ── Mute ───────────────────────────────────────────
    function toggleMute(trackIdx) {
        muteState[trackIdx] = !muteState[trackIdx];
        volumes[trackIdx].mute = muteState[trackIdx];
        muteButtons[trackIdx].classList.toggle('muted', muteState[trackIdx]);
        trackElements[trackIdx].classList.toggle('muted', muteState[trackIdx]);
    }

    // ── Key Assign Modal ───────────────────────────────
    function openKeyAssignModal(trackIdx) {
        assigningTrack = trackIdx;
        modalTrackName.textContent = `TRACK ${trackIdx + 1}`;
        modalKeyDisplay.textContent = keyBindings[trackIdx] ? keyBindings[trackIdx].toUpperCase() : '...';
        keyAssignModal.classList.remove('hidden');

        if (modalKeyHandler) document.removeEventListener('keydown', modalKeyHandler);
        modalKeyHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { closeKeyAssignModal(); return; }
            const key = e.key;
            keyBindings[assigningTrack] = key;
            modalKeyDisplay.textContent = key.toUpperCase();
            updateKeyBadge(assigningTrack, key);
            setTimeout(() => closeKeyAssignModal(), 400);
        };
        document.addEventListener('keydown', modalKeyHandler);
    }

    function closeKeyAssignModal() {
        keyAssignModal.classList.add('hidden');
        assigningTrack = -1;
        if (modalKeyHandler) {
            document.removeEventListener('keydown', modalKeyHandler);
            modalKeyHandler = null;
        }
    }

    function updateKeyBadge(trackIdx, key) {
        const badge = muteButtons[trackIdx]?.querySelector('.key-badge');
        if (badge) badge.textContent = key ? key.toUpperCase() : '';
    }

    modalCancelBtn.addEventListener('click', closeKeyAssignModal);
    modalClearBtn.addEventListener('click', () => {
        if (assigningTrack >= 0) {
            keyBindings[assigningTrack] = null;
            updateKeyBadge(assigningTrack, null);
        }
        closeKeyAssignModal();
    });

    // Global keyboard listener for mute toggles
    document.addEventListener('keydown', (e) => {
        if (assigningTrack >= 0) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        for (let t = 0; t < numTracks; t++) {
            if (keyBindings[t] && e.key.toLowerCase() === keyBindings[t].toLowerCase()) {
                e.preventDefault();
                toggleMute(t);
                break;
            }
        }
    });

    // ── File Upload Handler ────────────────────────────
    function handleFileUpload(event, trackIdx) {
        const file = event.target.files[0];
        if (!file) return;
        loadSampleToTrack(trackIdx, file);
    }

    function loadSampleToTrack(trackIdx, file) {
        const blobUrl = URL.createObjectURL(file);
        const buffer = new Tone.Buffer(blobUrl, () => {
            players[trackIdx].buffer = buffer;
            URL.revokeObjectURL(blobUrl);
            const label = trackElements[trackIdx].querySelector('.upload-btn');
            const nameSpan = label.querySelector('span');
            nameSpan.textContent = truncateName(file.name, 12);
            label.classList.add('loaded');
            label.title = file.name;
        }, (err) => {
            console.error('Error decoding audio:', err);
            URL.revokeObjectURL(blobUrl);
        });
    }

    function assignPoolSample(trackIdx, poolIdx) {
        const sample = samplePool[poolIdx];
        if (!sample || !sample.buffer) return;
        players[trackIdx].buffer = sample.buffer;
        const label = trackElements[trackIdx].querySelector('.upload-btn');
        const nameSpan = label.querySelector('span');
        nameSpan.textContent = truncateName(sample.name, 12);
        label.classList.add('loaded');
        label.title = sample.name;
    }

    function truncateName(name, max) {
        if (name.length <= max) return name;
        const ext = name.slice(name.lastIndexOf('.'));
        return name.slice(0, max - ext.length - 1) + '…' + ext;
    }

    // ── Sample Pool ────────────────────────────────────
    function loadSamplePool(files) {
        const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|aiff|m4a)$/i.test(f.name));
        if (audioFiles.length === 0) return;

        samplePoolSection.classList.remove('hidden');

        for (const file of audioFiles) {
            const idx = samplePool.length;
            const blobUrl = URL.createObjectURL(file);
            const entry = { name: file.name, blobUrl, buffer: null };
            samplePool.push(entry);

            // Decode buffer
            const buffer = new Tone.Buffer(blobUrl, () => {
                entry.buffer = buffer;
            }, (err) => {
                console.error('Error loading pool sample:', file.name, err);
            });

            // Create pool item DOM
            const item = document.createElement('div');
            item.classList.add('pool-sample');
            item.draggable = true;
            item.innerHTML = `<svg class="pool-sample-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg><span>${truncateName(file.name, 20)}</span>`;
            item.title = `Arrastrá "${file.name}" a un track`;

            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', String(idx));
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

            // Click to preview
            item.addEventListener('dblclick', () => {
                if (entry.buffer) {
                    const preview = new Tone.Player(entry.buffer).toDestination();
                    preview.start();
                    preview.onstop = () => preview.dispose();
                }
            });

            samplePoolGrid.appendChild(item);
        }

        poolCount.textContent = `${samplePool.length} sample${samplePool.length !== 1 ? 's' : ''}`;
    }

    // ── Pad Toggle ─────────────────────────────────────
    function togglePad(track, step) {
        grid[track][step] = !grid[track][step];
        padElements[track][step].classList.toggle('active', grid[track][step]);
    }

    // ── Sequencer Loop ─────────────────────────────────
    let sequenceLoop = null;

    function startSequencer() {
        if (isPlaying) return;
        Tone.start().then(() => {
            isPlaying = true;
            playBtn.classList.add('active');
            currentStep = -1;

            sequenceLoop = new Tone.Sequence((time, step) => {
                currentStep = step;
                for (let t = 0; t < numTracks; t++) {
                    if (grid[t]?.[step] && !muteState[t] && players[t]?.buffer?.loaded) {
                        players[t].stop(time);
                        players[t].start(time);
                    }
                }
                Tone.getDraw().schedule(() => updateStepVisuals(step), time);
            }, Array.from({ length: NUM_STEPS }, (_, i) => i), '16n');

            sequenceLoop.start(0);
            Tone.getTransport().start();
        });
    }

    function stopSequencer() {
        if (!isPlaying) return;
        isPlaying = false;
        playBtn.classList.remove('active');
        if (sequenceLoop) { sequenceLoop.stop(); sequenceLoop.dispose(); sequenceLoop = null; }
        Tone.getTransport().stop();
        Tone.getTransport().position = 0;
        currentStep = -1;
        clearStepVisuals();
        currentStepEl.textContent = '--';
    }

    // ── Step Visuals ───────────────────────────────────
    function updateStepVisuals(step) {
        clearStepVisuals();
        const indicators = stepIndicatorsEl.children;
        if (indicators[step]) indicators[step].classList.add('active');
        for (let t = 0; t < numTracks; t++) {
            if (padElements[t]?.[step]) padElements[t][step].classList.add('current');
        }
        currentStepEl.textContent = String(step + 1).padStart(2, '0');
    }

    function clearStepVisuals() {
        const indicators = stepIndicatorsEl.children;
        for (let i = 0; i < indicators.length; i++) indicators[i].classList.remove('active');
        for (let t = 0; t < numTracks; t++) {
            for (let s = 0; s < NUM_STEPS; s++) {
                if (padElements[t]?.[s]) padElements[t][s].classList.remove('current');
            }
        }
    }

    // ── Recording ──────────────────────────────────────
    async function toggleRecording() {
        await Tone.start();
        if (!isRecording) {
            recordedBlob = null;
            exportAudioBtn.disabled = true;
            recorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
            recordBtn.querySelector('span').textContent = '● REC';
        } else {
            const blob = await recorder.stop();
            recordedBlob = blob;
            isRecording = false;
            recordBtn.classList.remove('recording');
            recordBtn.querySelector('span').textContent = 'REC';
            exportAudioBtn.disabled = false;
        }
    }

    function exportAudio() {
        if (!recordedBlob) return;
        const url = URL.createObjectURL(recordedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `neonseq-recording-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── JSON Save / Load ───────────────────────────────
    function saveJSON() {
        const effectValues = {};
        const fxKeys = ['volume', 'pan', 'reverb', 'delay', 'saturation'];
        for (let t = 0; t < numTracks; t++) {
            effectValues[t] = {};
            for (const key of fxKeys) {
                const slider = document.getElementById(`fx-${key}-${t}`);
                if (slider) effectValues[t][key] = parseFloat(slider.value);
            }
        }
        const data = {
            version: 2,
            numTracks,
            bpm: parseInt(bpmSlider.value),
            swing: parseInt(swingSlider.value),
            grid: grid.map(row => [...row]),
            effects: effectValues,
            mutes: [...muteState],
            keyBindings: [...keyBindings],
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `neonseq-pattern-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function loadJSON(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.grid) { console.error('Invalid pattern'); return; }

                // Stop if playing
                if (isPlaying) stopSequencer();

                // Clear existing tracks
                while (numTracks > 0) removeTrack(numTracks - 1);

                // Recreate tracks
                const targetTracks = data.numTracks || data.grid.length || 4;
                for (let i = 0; i < targetTracks; i++) addTrack();

                // BPM & Swing
                if (data.bpm) { bpmSlider.value = data.bpm; bpmValue.textContent = data.bpm; Tone.getTransport().bpm.value = data.bpm; }
                if (data.swing !== undefined) { swingSlider.value = data.swing; swingValue.textContent = `${data.swing}%`; Tone.getTransport().swing = data.swing / 100; }

                // Grid
                for (let t = 0; t < numTracks; t++) {
                    for (let s = 0; s < NUM_STEPS; s++) {
                        grid[t][s] = data.grid[t]?.[s] ?? false;
                        padElements[t][s].classList.toggle('active', grid[t][s]);
                    }
                }

                // Effects
                const fxKeys = ['volume', 'pan', 'reverb', 'delay', 'saturation'];
                for (let t = 0; t < numTracks; t++) {
                    if (data.effects?.[t]) {
                        for (const key of fxKeys) {
                            const val = data.effects[t][key];
                            if (val !== undefined) {
                                const slider = document.getElementById(`fx-${key}-${t}`);
                                const valDisplay = document.getElementById(`fx-${key}-val-${t}`);
                                if (slider && valDisplay) {
                                    slider.value = val;
                                    valDisplay.textContent = formatFxValue(key, val);
                                    applyEffect(t, key, val);
                                }
                            }
                        }
                    }
                }

                // Mutes
                if (data.mutes) {
                    for (let t = 0; t < numTracks; t++) {
                        muteState[t] = data.mutes[t] ?? false;
                        volumes[t].mute = muteState[t];
                        muteButtons[t].classList.toggle('muted', muteState[t]);
                        trackElements[t].classList.toggle('muted', muteState[t]);
                    }
                }

                // Key bindings
                if (data.keyBindings) {
                    for (let t = 0; t < numTracks; t++) {
                        keyBindings[t] = data.keyBindings[t] ?? null;
                        updateKeyBadge(t, keyBindings[t]);
                    }
                }
            } catch (err) {
                console.error('Error parsing JSON:', err);
            }
        };
        reader.readAsText(file);
    }

    // ── Transport Controls ─────────────────────────────
    playBtn.addEventListener('click', () => { isPlaying ? stopSequencer() : startSequencer(); });
    stopBtn.addEventListener('click', () => stopSequencer());
    bpmSlider.addEventListener('input', () => { const b = parseInt(bpmSlider.value); bpmValue.textContent = b; Tone.getTransport().bpm.value = b; });
    swingSlider.addEventListener('input', () => { const s = parseInt(swingSlider.value); swingValue.textContent = `${s}%`; Tone.getTransport().swing = s / 100; });

    // Toolbar
    recordBtn.addEventListener('click', () => toggleRecording());
    exportAudioBtn.addEventListener('click', () => exportAudio());
    saveBtn.addEventListener('click', () => saveJSON());
    loadBtn.addEventListener('click', () => loadJsonInput.click());
    loadJsonInput.addEventListener('change', (e) => { if (e.target.files[0]) loadJSON(e.target.files[0]); e.target.value = ''; });
    addTrackBtn.addEventListener('click', () => addTrack());

    // Sample Pool
    loadPoolBtn.addEventListener('click', () => poolFolderInput.click());
    poolFolderInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadSamplePool(e.target.files);
        e.target.value = '';
    });
    closePoolBtn.addEventListener('click', () => samplePoolSection.classList.add('hidden'));

    // ── Build step indicators ──────────────────────────
    function buildStepIndicators() {
        for (let s = 0; s < NUM_STEPS; s++) {
            const el = document.createElement('div');
            el.classList.add('step-indicator');
            el.textContent = s + 1;
            stepIndicatorsEl.appendChild(el);
        }
    }

    // ── Init ───────────────────────────────────────────
    function init() {
        Tone.getTransport().bpm.value = 120;
        recorder = new Tone.Recorder();
        Tone.getDestination().connect(recorder);
        buildStepIndicators();
        for (let i = 0; i < INITIAL_TRACKS; i++) addTrack();
    }

    init();
})();
