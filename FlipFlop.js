/******************************************
 * FlipFlop
 * Puzzle "lights out" su due immagini: ogni tocco gira una carta e le quattro
 * adiacenti. Quando tutte le carte mostrano la stessa faccia hai vinto e la
 * GIF vincente viene mostrata intera, per un numero di secondi che cresce a
 * ogni vittoria consecutiva.
 *
 * Easter egg: triplo tocco sul titolo -> carica immagini / GIF / archivi ZIP.
 *
 * Il caricamento è progressivo: le immagini entrano in gioco mano a mano che
 * sono pronte, senza mai bloccare la partita in corso. Nel serbatoio finiscono
 * solo immagini già decodificate, così il cambio di puzzle è istantaneo.
 ******************************************/
'use strict';

/******************************************
 * SEZIONE 1: COSTANTI E STATO
 ******************************************/
const MIN_SIZE = 3;
const MAX_SIZE = 10;
const DEFAULT_SIZE = 5;         // il gioco parte sempre da qui
const SCRAMBLE_MIN = 10;
const SCRAMBLE_MAX = 15;
const REWARD_BASE = 9;          // secondi di premio = REWARD_BASE + vittorie consecutive
const HUD_HEIGHT = 44;          // altezza della barra titolo/comandi
const TRIPLE_TAP_MS = 600;
const SWAP_MS = 170;            // dissolvenza quando il puzzle cambia a vista
const HANDOVER_MS = 350;        // quanto prima della fine del premio ricostruiamo la griglia
const FIRST_BATCH = 20;         // immagini pronte prima di mettersi in gioco
const DECODE_WORKERS = 3;       // decodifiche in parallelo

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|webp|avif)$/i;
const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', avif: 'image/avif'
};

const el = {};
[
    'stage', 'grid', 'title', 'restart', 'menuToggle', 'sizeLabel', 'menu', 'scrim',
    'sizeButtons', 'newGame', 'poolInfo', 'victory', 'victoryImg', 'victoryCount',
    'toast', 'fileInput', 'progress', 'progressFill'
].forEach(id => { el[id] = document.getElementById(id); });

const state = {
    size: DEFAULT_SIZE,
    cards: [],            // gli elementi .card, in ordine di indice
    pool: [],             // immagini pronte all'uso (già decodificate)
    queue: [],            // quelle non ancora usate nel giro corrente
    faces: { front: null, back: null },
    wins: 0,              // vittorie consecutive (allunga il premio)
    locked: true          // true = i tocchi sulle carte sono ignorati
};

const progress = { done: 0, total: 0, active: false };

// geometria calcolata a ogni layout
let geom = { side: 0, card: 0, gap: 0, left: 0, top: 0 };

const timers = new Set();

/******************************************
 * SEZIONE 2: UTILITÀ
 ******************************************/
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffled(array) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function later(ms, fn) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
}

function clearTimers() {
    timers.forEach(clearTimeout);
    timers.clear();
}

let toastTimer = null;
function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

async function runWithWorkers(tasks, limit, worker) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) await worker(tasks[next++]);
    });
    await Promise.all(workers);
}

/******************************************
 * SEZIONE 3: CARICAMENTO IMMAGINI
 * Di ogni immagine teniamo:
 *  - url    -> l'originale (le GIF si animano): serve per il premio
 *  - still  -> il primo fotogramma congelato: serve per le carte
 * Entrambi vengono decodificati subito, così quando l'immagine finisce sulla
 * griglia non c'è nessun attimo di attesa.
 ******************************************/
function decodeImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('immagine non leggibile'));
        img.src = src;
    });
}

function freezeFirstFrame(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
    });
}

async function buildAsset(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await decodeImage(url);
        const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
        const still = isGif ? (await freezeFirstFrame(img)) || url : url;
        if (still !== url) await decodeImage(still);   // scaldiamo anche il fotogramma fisso
        return { url, still, ratio: img.naturalWidth / img.naturalHeight };
    } catch (err) {
        URL.revokeObjectURL(url);
        console.warn('FlipFlop: scarto', file.name, err.message);
        return null;
    }
}

function mimeFor(name) {
    return MIME_BY_EXT[name.toLowerCase().split('.').pop()] || 'application/octet-stream';
}

function isZip(file) {
    return file.type === 'application/zip' || /\.zip$/i.test(file.name);
}

function isImage(file) {
    return file.type.startsWith('image/') || IMAGE_RE.test(file.name);
}

async function listZipImages(file) {
    if (typeof JSZip === 'undefined') {
        toast('Supporto ZIP non disponibile');
        return [];
    }
    try {
        const zip = await new JSZip().loadAsync(file);
        const entries = [];
        zip.forEach((path, entry) => {
            // __MACOSX e simili contengono doppioni inutilizzabili
            if (!entry.dir && IMAGE_RE.test(entry.name) && !entry.name.startsWith('__MACOSX/')) {
                entries.push(entry);
            }
        });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return entries;
    } catch (err) {
        console.error('FlipFlop: ZIP illeggibile', err);
        toast('ZIP illeggibile');
        return [];
    }
}

function showProgress(count) {
    progress.total += count;
    progress.active = true;
    el.progress.hidden = false;
    paintProgress();
}

function stepProgress() {
    progress.done++;
    paintProgress();
}

function paintProgress() {
    const ratio = progress.total ? progress.done / progress.total : 0;
    el.progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    updatePoolInfo();
}

function endProgress() {
    if (progress.done < progress.total) return;   // c'è ancora un altro caricamento in corso
    progress.active = false;
    progress.done = 0;
    progress.total = 0;
    setTimeout(() => {
        if (!progress.active) {
            el.progress.hidden = true;
            el.progressFill.style.width = '0%';
        }
    }, 400);
    updatePoolInfo();
}

function addToPool(asset) {
    state.pool.push(asset);
    // la infiliamo tra quelle ancora da usare, in un punto a caso
    state.queue.splice(randInt(0, state.queue.length), 0, asset);
    if (!state.faces.front && state.pool.length >= FIRST_BATCH) swapRound();
}

async function addFiles(files) {
    const tasks = [];
    for (const file of files) {
        if (isZip(file)) {
            const entries = await listZipImages(file);
            entries.forEach(entry => tasks.push(async () => {
                const blob = await entry.async('blob');
                return new File([blob], entry.name, { type: mimeFor(entry.name) });
            }));
        } else if (isImage(file)) {
            tasks.push(async () => file);
        }
    }

    if (!tasks.length) {
        toast('Nessuna immagine trovata');
        return;
    }

    showProgress(tasks.length);
    let added = 0;
    await runWithWorkers(tasks, DECODE_WORKERS, async task => {
        try {
            const asset = await buildAsset(await task());
            if (asset) { addToPool(asset); added++; }
        } catch (err) {
            console.warn('FlipFlop: immagine saltata', err);
        }
        stepProgress();
    });
    endProgress();

    // archivio piccolo: si parte con quello che c'è, senza aspettare le 20
    if (!state.faces.front && state.pool.length) swapRound();

    updatePoolInfo();
    toast(added ? `${added} pronte · ${state.pool.length} in archivio` : 'Nessuna immagine valida');
}

/******************************************
 * SEZIONE 4: GEOMETRIA E DISEGNO
 ******************************************/
function computeGeometry() {
    const availW = el.stage.clientWidth;
    const availH = el.stage.clientHeight;
    const n = state.size;
    const gap = Math.max(2, Math.min(7, Math.round(Math.min(availW, availH) / (n * 26))));

    const fit = box => {
        const card = Math.max(1, Math.floor((box - gap * (n - 1)) / n));
        return { card, side: card * n + gap * (n - 1) };
    };

    const margin = 12;
    let g = fit(Math.min(availW, availH) - margin * 2);

    // La griglia è quadrata, lo schermo quasi mai: di solito resta parecchio
    // spazio libero per l'HUD. Se non ne resta, glielo ricaviamo dall'alto.
    const roomAtSides = (availW - g.side) / 2 >= 110;
    const roomAbove = (availH - g.side) / 2 >= HUD_HEIGHT;
    const offsetTop = (roomAtSides || roomAbove) ? 0 : HUD_HEIGHT;
    if (offsetTop) g = fit(Math.min(availW, availH - offsetTop) - margin * 2);

    geom = {
        side: g.side,
        card: g.card,
        gap,
        left: Math.round((availW - g.side) / 2),
        top: offsetTop + Math.round((availH - offsetTop - g.side) / 2)
    };
}

function applyGeometry() {
    const { side, card, gap, left, top } = geom;
    const n = state.size;
    el.grid.style.width = `${side}px`;
    el.grid.style.height = `${side}px`;
    el.grid.style.left = `${left}px`;
    el.grid.style.top = `${top}px`;
    el.grid.style.gap = `${gap}px`;
    el.grid.style.gridTemplateColumns = `repeat(${n}, ${card}px)`;
    el.grid.style.gridTemplateRows = `repeat(${n}, ${card}px)`;
    el.grid.style.setProperty('--card-radius', `${Math.max(3, Math.min(10, Math.round(card * 0.11)))}px`);
}

/**
 * Spalma l'immagine su tutta la griglia quadrata ritagliandola al centro
 * (stile background-size: cover): niente deformazioni, niente bordi vuoti.
 */
function paintFace(side) {
    const asset = state.faces[side];
    const faces = el.grid.querySelectorAll(`.face-${side}`);
    if (!asset) {
        faces.forEach(face => { face.style.backgroundImage = ''; });
        return;
    }

    const n = state.size;
    const box = geom.side;
    const step = geom.card + geom.gap;
    const drawnW = asset.ratio >= 1 ? box * asset.ratio : box;
    const drawnH = asset.ratio >= 1 ? box : box / asset.ratio;
    const offsetX = (box - drawnW) / 2;
    const offsetY = (box - drawnH) / 2;
    const size = `${drawnW}px ${drawnH}px`;

    faces.forEach((face, i) => {
        const col = i % n;
        const row = (i / n) | 0;
        face.style.backgroundImage = `url("${asset.still}")`;
        face.style.backgroundSize = size;
        face.style.backgroundPosition = `${offsetX - col * step}px ${offsetY - row * step}px`;
    });
}

function relayout() {
    computeGeometry();
    applyGeometry();
    paintFace('front');
    paintFace('back');
}

/******************************************
 * SEZIONE 5: GRIGLIA E MOSSE
 ******************************************/
function buildGrid() {
    const total = state.size * state.size;
    el.grid.innerHTML = '';
    state.cards = [];

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.index = String(i);
        card.setAttribute('role', 'gridcell');

        const front = document.createElement('div');
        front.className = 'face face-front';
        const back = document.createElement('div');
        back.className = 'face face-back';

        card.append(front, back);
        fragment.appendChild(card);
        state.cards.push(card);
    }
    el.grid.appendChild(fragment);
}

function neighbours(index) {
    const n = state.size;
    const row = (index / n) | 0;
    const col = index % n;
    const list = [index];
    if (row > 0) list.push(index - n);
    if (row < n - 1) list.push(index + n);
    if (col > 0) list.push(index - 1);
    if (col < n - 1) list.push(index + 1);
    return list;
}

function applyMove(index) {
    neighbours(index).forEach(i => state.cards[i].classList.toggle('flipped'));
}

function isSolved() {
    const first = state.cards[0].classList.contains('flipped');
    return state.cards.every(card => card.classList.contains('flipped') === first);
}

function scramble() {
    const last = state.cards.length - 1;
    const moves = randInt(SCRAMBLE_MIN, SCRAMBLE_MAX);
    for (let i = 0; i < moves; i++) applyMove(randInt(0, last));
    // mosse ripetute possono annullarsi a vicenda: una griglia già risolta non è una partita
    let guard = 0;
    while (isSolved() && guard++ < 30) applyMove(randInt(0, last));
}

function setLocked(locked) {
    state.locked = locked;
    el.grid.classList.toggle('locked', locked);
}

/******************************************
 * SEZIONE 6: PARTITA E VITTORIA
 ******************************************/
function takePair() {
    const pool = state.pool;
    if (!pool.length) return [null, null];
    if (pool.length === 1) return [pool[0], null];

    if (state.queue.length < 2) {
        // giro finito: si ricomincia, ma senza ripescare le due appena viste
        const current = [state.faces.front, state.faces.back].filter(Boolean);
        const rest = pool.filter(asset => !current.includes(asset));
        state.queue = shuffled(rest.length >= 2 ? rest : pool);
    }
    return [state.queue.pop(), state.queue.pop()];
}

/**
 * Costruisce il puzzle successivo in un colpo solo e senza animazioni: le due
 * immagini sono già decodificate, quindi non esiste un istante in cui si veda
 * ancora quella vecchia. Chiamata sotto il premio, il cambio è invisibile.
 */
function startRound() {
    const [front, back] = takePair();
    state.faces.front = front;
    state.faces.back = back;

    el.grid.classList.add('instant');
    state.cards.forEach(card => card.classList.remove('flipped'));
    relayout();
    scramble();
    void el.grid.offsetWidth;                 // forza il reflow prima di riattivare le transizioni
    el.grid.classList.remove('instant');

    setLocked(false);
}

/** Come startRound, ma con una breve dissolvenza: serve quando il cambio è a vista. */
function swapRound() {
    setLocked(true);
    el.grid.classList.add('fading');
    later(SWAP_MS, () => {
        startRound();
        el.grid.classList.remove('fading');
    });
}

function newGame({ resetWins = true } = {}) {
    clearTimers();
    hideVictory();
    if (resetWins) state.wins = 0;
    swapRound();
}

function onCardClick(event) {
    if (state.locked) return;
    const card = event.target.closest('.card');
    if (!card) return;
    applyMove(Number(card.dataset.index));
    if (isSolved()) win();
}

function win() {
    setLocked(true);
    state.wins++;
    const upSide = state.cards[0].classList.contains('flipped') ? 'back' : 'front';
    showVictory(state.faces[upSide]);
}

function showVictory(asset) {
    const seconds = asset ? REWARD_BASE + state.wins : 1.2;
    document.body.classList.add('rewarding');

    if (asset) {
        el.victoryImg.src = asset.url;          // l'originale: le GIF ripartono e si animano
        el.victoryCount.textContent = String(seconds);
        el.victoryCount.classList.remove('show');
        later((seconds - 1) * 1000, () => el.victoryCount.classList.add('show'));
    } else {
        // nessuna immagine caricata: un lampo di conferma e via con la prossima
        el.victoryCount.textContent = '★';
        el.victoryCount.classList.add('show');
    }
    el.victory.hidden = false;

    // il puzzle nuovo viene montato mentre il premio è ancora sopra
    later(seconds * 1000 - HANDOVER_MS, startRound);
    later(seconds * 1000, hideVictory);
}

function hideVictory() {
    document.body.classList.remove('rewarding');
    el.victory.hidden = true;
    el.victoryCount.classList.remove('show');
    el.victoryImg.removeAttribute('src');
}

/******************************************
 * SEZIONE 7: INTERFACCIA
 ******************************************/
function setSize(size) {
    state.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
    state.wins = 0;                     // il premio riparte da capo a ogni cambio griglia
    el.sizeLabel.textContent = `${state.size}×${state.size}`;
    el.sizeButtons.querySelectorAll('.size-btn').forEach(btn => {
        btn.setAttribute('aria-pressed', String(Number(btn.dataset.size) === state.size));
    });

    clearTimers();
    hideVictory();
    buildGrid();
    relayout();
    startRound();
}

function buildSizeButtons() {
    const fragment = document.createDocumentFragment();
    for (let size = MIN_SIZE; size <= MAX_SIZE; size++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'size-btn';
        btn.dataset.size = String(size);
        btn.textContent = `${size}×${size}`;
        btn.setAttribute('aria-pressed', 'false');
        fragment.appendChild(btn);
    }
    el.sizeButtons.appendChild(fragment);
}

function setMenuOpen(open) {
    el.menu.hidden = !open;
    el.scrim.hidden = !open;
    el.menuToggle.setAttribute('aria-expanded', String(open));
    if (open) updatePoolInfo();
}

function updatePoolInfo() {
    const n = state.pool.length;
    if (progress.active) {
        el.poolInfo.textContent = `Carico… ${progress.done}/${progress.total}`;
    } else {
        el.poolInfo.textContent = n === 0
            ? 'Nessuna immagine caricata'
            : `${n} immagin${n === 1 ? 'e' : 'i'} in archivio`;
    }
}

/******************************************
 * SEZIONE 8: EVENTI
 ******************************************/
el.grid.addEventListener('click', onCardClick);

el.restart.addEventListener('click', () => newGame());

el.menuToggle.addEventListener('click', () => setMenuOpen(el.menu.hidden));
el.scrim.addEventListener('click', () => setMenuOpen(false));

el.newGame.addEventListener('click', () => {
    setMenuOpen(false);
    newGame();
});

el.sizeButtons.addEventListener('click', event => {
    const btn = event.target.closest('.size-btn');
    if (!btn) return;
    setMenuOpen(false);
    setSize(Number(btn.dataset.size));
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setMenuOpen(false);
});

// Easter egg: tre tocchi rapidi sul titolo aprono il caricamento immagini
let tapCount = 0;
let tapTimer = null;
el.title.addEventListener('click', () => {
    tapCount++;
    clearTimeout(tapTimer);
    el.title.classList.add('tapped');
    if (tapCount >= 3) {
        tapCount = 0;
        el.title.classList.remove('tapped');
        el.fileInput.click();
        return;
    }
    tapTimer = setTimeout(() => {
        tapCount = 0;
        el.title.classList.remove('tapped');
    }, TRIPLE_TAP_MS);
});

el.fileInput.addEventListener('change', event => {
    // la FileList è viva: va copiata prima di azzerare il campo
    const files = Array.from(event.target.files || []);
    event.target.value = '';            // così lo stesso file può essere ricaricato
    if (files.length) addFiles(files);
});

let resizeFrame = 0;
function onViewportChange() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(relayout);
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

/******************************************
 * SEZIONE 9: AVVIO
 ******************************************/
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    document.body.classList.add('capacitor');
}

buildSizeButtons();
setSize(DEFAULT_SIZE);
