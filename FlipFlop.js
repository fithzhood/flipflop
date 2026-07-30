/******************************************
 * FlipFlop
 * Puzzle "lights out" su due immagini: ogni tocco gira una carta e le quattro
 * adiacenti. Quando tutte le carte mostrano la stessa faccia hai vinto e la
 * GIF vincente viene mostrata intera, per un numero di secondi che cresce a
 * ogni vittoria consecutiva.
 *
 * Easter egg: triplo tocco sul titolo -> carica immagini / GIF / archivi ZIP.
 ******************************************/
'use strict';

/******************************************
 * SEZIONE 1: COSTANTI E STATO
 ******************************************/
const MIN_SIZE = 3;
const MAX_SIZE = 10;
const DEFAULT_SIZE = 6;
const SCRAMBLE_MIN = 10;
const SCRAMBLE_MAX = 15;
const REWARD_BASE = 9;          // secondi di premio = REWARD_BASE + vittorie consecutive
const HUD_HEIGHT = 44;          // altezza della barra titolo/comandi
const TRIPLE_TAP_MS = 600;
const FLIP_MS = 500;            // deve combaciare con la transizione CSS delle carte
const STORAGE_KEY = 'flipflop.size';

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|webp|avif)$/i;
const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', avif: 'image/avif'
};

const el = {};
[
    'stage', 'grid', 'title', 'restart', 'menuToggle', 'sizeLabel', 'menu', 'scrim',
    'sizeButtons', 'newGame', 'poolInfo', 'victory', 'victoryImg', 'victoryCount',
    'toast', 'fileInput'
].forEach(id => { el[id] = document.getElementById(id); });

const state = {
    size: DEFAULT_SIZE,
    cards: [],            // gli elementi .card, in ordine di indice
    pool: [],             // tutte le immagini caricate (File)
    queue: [],            // immagini non ancora usate nel giro corrente
    faces: { front: null, back: null },
    wins: 0,              // vittorie consecutive (allunga il premio)
    locked: true          // true = i tocchi sulle carte sono ignorati
};

// geometria calcolata a ogni layout
let geom = { side: 0, card: 0, gap: 0, left: 0, top: 0 };

const timers = new Set();
let roundToken = 0;       // invalida i round in corso quando se ne avvia un altro

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

/******************************************
 * SEZIONE 3: IMMAGINI
 * Ogni file viene decodificato una sola volta e messo in cache:
 *  - url    -> l'immagine originale (le GIF si animano): serve per il premio
 *  - still  -> il primo fotogramma congelato: serve per le carte
 ******************************************/
const assetCache = new Map();   // File -> Promise<asset>

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

function loadAsset(file) {
    if (!file) return Promise.resolve(null);
    if (assetCache.has(file)) return assetCache.get(file);

    const promise = (async () => {
        const url = URL.createObjectURL(file);
        try {
            const img = await decodeImage(url);
            const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
            const still = isGif ? (await freezeFirstFrame(img)) || url : url;
            return { url, still, ratio: img.naturalWidth / img.naturalHeight };
        } catch (err) {
            URL.revokeObjectURL(url);
            console.warn('FlipFlop: scarto', file.name, err.message);
            return null;
        }
    })();

    assetCache.set(file, promise);
    return promise;
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

async function extractZip(file) {
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
        return await Promise.all(entries.map(async entry => {
            const blob = await entry.async('blob');
            return new File([blob], entry.name, { type: mimeFor(entry.name) });
        }));
    } catch (err) {
        console.error('FlipFlop: ZIP illeggibile', err);
        toast('ZIP illeggibile');
        return [];
    }
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
function nextPair() {
    if (state.pool.length === 0) return [null, null];
    if (state.pool.length === 1) return [state.pool[0], null];
    if (state.queue.length < 2) state.queue = shuffled(state.pool);
    return [state.queue.pop(), state.queue.pop()];
}

async function newRound() {
    const token = ++roundToken;
    clearTimers();
    setLocked(true);
    hideVictory();

    const [fileA, fileB] = nextPair();
    const [front, back] = await Promise.all([loadAsset(fileA), loadAsset(fileB)]);
    if (token !== roundToken) return;

    state.faces.front = front;
    state.faces.back = back;

    state.cards.forEach(card => card.classList.remove('flipped'));
    relayout();

    // lasciamo finire l'animazione di reset prima di mescolare
    later(FLIP_MS + 80, () => {
        if (token !== roundToken) return;
        scramble();
        setLocked(false);
    });
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
    const seconds = REWARD_BASE + state.wins;
    document.body.classList.add('rewarding');

    if (!asset) {
        // nessuna immagine caricata: un lampo di conferma e via con la prossima
        el.victoryCount.textContent = '★';
        el.victoryCount.classList.add('show');
        el.victory.hidden = false;
        later(1200, newRound);
        return;
    }

    el.victoryImg.src = asset.url;      // l'originale: le GIF ripartono e si animano
    el.victoryCount.textContent = String(seconds);
    el.victoryCount.classList.remove('show');
    el.victory.hidden = false;

    later((seconds - 1) * 1000, () => el.victoryCount.classList.add('show'));
    later(seconds * 1000, newRound);
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
function setSize(size, { restart = true } = {}) {
    state.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
    state.wins = 0;                     // il premio riparte da capo a ogni cambio griglia
    el.sizeLabel.textContent = `${state.size}×${state.size}`;
    el.sizeButtons.querySelectorAll('.size-btn').forEach(btn => {
        btn.setAttribute('aria-pressed', String(Number(btn.dataset.size) === state.size));
    });
    try { localStorage.setItem(STORAGE_KEY, String(state.size)); } catch (_) { /* modalità privata */ }

    buildGrid();
    relayout();
    if (restart) newRound();
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
    el.poolInfo.textContent = n === 0
        ? 'Nessuna immagine caricata'
        : `${n} immagin${n === 1 ? 'e' : 'i'} in archivio`;
}

async function addFiles(files) {
    if (!files.length) return;

    const added = [];
    for (const file of files) {
        if (isZip(file)) added.push(...await extractZip(file));
        else if (isImage(file)) added.push(file);
    }

    if (!added.length) {
        toast('Nessuna immagine trovata');
        return;
    }

    state.pool.push(...added);
    state.queue = [];
    updatePoolInfo();
    toast(`+${added.length} · ${state.pool.length} in archivio`);
    newRound();
}

/******************************************
 * SEZIONE 8: EVENTI
 ******************************************/
el.grid.addEventListener('click', onCardClick);

el.restart.addEventListener('click', () => { state.wins = 0; newRound(); });

el.menuToggle.addEventListener('click', () => setMenuOpen(el.menu.hidden));
el.scrim.addEventListener('click', () => setMenuOpen(false));

el.newGame.addEventListener('click', () => {
    setMenuOpen(false);
    state.wins = 0;
    newRound();
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
    addFiles(files);
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

let savedSize = DEFAULT_SIZE;
try {
    savedSize = Number(localStorage.getItem(STORAGE_KEY)) || DEFAULT_SIZE;
} catch (_) { /* modalità privata */ }

setSize(savedSize);
