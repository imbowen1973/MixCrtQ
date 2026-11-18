// Controller view. The mixer itself runs on the server; this page shows its
// deck and sends it commands. Closing this page does not stop the room.
//
// The one piece of audio work done here is listening to this laptop's own
// system sound (the meeting, playing remote speakers into the room) in order
// to tell the mixer when a remote person is speaking. Only that yes-or-no
// signal leaves the laptop.

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'mixcrtq.controller';

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* unavailable */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* unavailable */ } },
};

let ws = null;
let session = null; // { code, controlToken }
let saved = null; // a room remembered from before a reload
let ended = false;
let engineOnline = false;
let deck = null; // latest snapshot from the mixer
let lastDeckAt = 0;
let stale = false;

/** @type {Map<string, any>} */ const strips = new Map();
/** @type {Map<string, any>} */ const rows = new Map();

const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const relayParam = new URLSearchParams(location.search).get('relay') === '1' ? '&relay=1' : '';

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
const cmd = (action, id, value) => send({ type: 'cmd', action, id, value });

function banner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
}

// A control the person is touching must not be moved by an incoming snapshot.
function guard(input) {
  input.addEventListener('pointerdown', () => { input.dataset.busy = '1'; });
  const release = () => setTimeout(() => { delete input.dataset.busy; }, 400);
  input.addEventListener('pointerup', release);
  input.addEventListener('change', release);
  input.addEventListener('keydown', () => { input.dataset.busy = '1'; release(); });
}
const free = (input) => !input.dataset.busy;

// ---------------------------------------------------------------- start

try { saved = JSON.parse(store.get(SESSION_KEY) || 'null'); } catch { saved = null; }
if (saved?.code) $('start-btn').textContent = `Resume room ${saved.code}`;

fetch('/config').then((r) => r.json()).then((cfg) => {
  if (cfg.hostKeyRequired && !saved?.code) $('key-row').hidden = false;
}).catch(() => {});

$('start-btn').addEventListener('click', () => {
  $('start-btn').disabled = true;
  $('start-error').hidden = true;
  ended = false;
  connect();
});

function backToStart(message) {
  session = null;
  saved = null;
  deck = null;
  store.del(SESSION_KEY);
  for (const s of strips.values()) s.el.remove();
  for (const r of rows.values()) r.el.remove();
  strips.clear();
  rows.clear();
  $('deck').hidden = true;
  $('start-screen').hidden = false;
  $('start-error').hidden = !message;
  $('start-error').textContent = message || '';
  $('start-btn').disabled = false;
  $('start-btn').textContent = 'Start a room';
}

// ---------------------------------------------------------------- signalling

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    const s = session || saved;
    if (s?.code) send({ type: 'controller-resume', code: s.code, controlToken: s.controlToken });
    else send({ type: 'room-create', key: $('host-key').value });
  };
  sock.onclose = () => {
    if (ended || sock !== ws || !session) return;
    banner('The connection to the server dropped. The room carries on without this page; reconnecting.');
    setTimeout(connect, 2000);
  };
  sock.onmessage = (ev) => handle(sock, JSON.parse(ev.data));
}

function handle(sock, msg) {
  if (msg.type === 'controller-ready') {
    session = { code: msg.code, controlToken: msg.controlToken };
    store.set(SESSION_KEY, JSON.stringify(session));
    engineOnline = msg.engineOnline;
    $('start-screen').hidden = true;
    $('deck').hidden = false;
    $('code').textContent = msg.code;
    $('join-link').textContent = `${location.origin}/join?code=${msg.code}${relayParam}`;
    $('listen-code').textContent = msg.listenCode;
    $('listen-link').textContent = `${location.origin}/listen?code=${msg.listenCode}${relayParam}`;
    banner(engineOnline ? '' : 'Starting the mixer on the server.');
  } else if (msg.type === 'engine-status') {
    engineOnline = msg.online;
    banner(engineOnline ? '' : 'The mixer on the server stopped and is being restarted. Audio is interrupted until it returns.');
  } else if (msg.type === 'deck') {
    deck = msg.data;
    lastDeckAt = performance.now();
    if (stale) { stale = false; banner(''); }
    render();
  } else if (msg.type === 'session-closed') {
    ended = true;
    const why = {
      ended: '',
      idle: 'The room was closed after standing empty.',
      'engine-gone': 'The mixer on the server could not be restarted, so the room was closed.',
    };
    stopCapture();
    backToStart(msg.reason in why ? why[msg.reason] : 'The room has been closed.');
  } else if (msg.type === 'error') {
    if (msg.code === 'no-session' && !session) {
      // The remembered room has expired: start a new one on the same socket.
      saved = null;
      store.del(SESSION_KEY);
      send({ type: 'room-create', key: $('host-key').value });
    } else if (session) {
      banner(msg.message);
    } else {
      if (msg.code === 'bad-key') $('key-row').hidden = false;
      sock.onclose = null;
      sock.close();
      backToStart(msg.message);
    }
  }
}

// ---------------------------------------------------------------- deck

function makeStrip(c) {
  const el = $('strip-tpl').content.firstElementChild.cloneNode(true);
  const s = {
    el,
    name: el.querySelector('.name'),
    state: el.querySelector('.state'),
    tag: el.querySelector('.tag'),
    fill: el.querySelector('.fill'),
    floor: el.querySelector('.floor'),
    db: el.querySelector('.db'),
    fader: el.querySelector('.fader input'),
    mute: el.querySelector('.mute'),
    pin: el.querySelector('.pin'),
    data: c,
  };
  s.name.textContent = c.name;
  s.name.title = c.name;
  guard(s.fader);
  s.fader.addEventListener('input', () => {
    const v = Number(s.fader.value);
    s.db.textContent = `${v > 0 ? '+' : ''}${v} dB`;
    cmd('fader', c.id, v);
  });
  s.mute.addEventListener('click', () => cmd('mute', c.id, !s.data.muted));
  s.pin.addEventListener('click', () => cmd('pin', c.id, !s.data.pinned));
  el.querySelector('.remove').addEventListener('click', () => cmd('remove', c.id));
  $('strips').append(el);
  return s;
}

function makeRow(l) {
  const el = document.createElement('li');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = l.name;
  who.title = l.name;
  const state = document.createElement('span');
  state.className = 'lstate';
  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => cmd('remove', l.id));
  el.append(who, state, remove);
  $('listeners').append(el);
  return { el, state };
}

function render() {
  const d = deck;

  // room microphones
  const seen = new Set();
  for (const c of d.channels) {
    seen.add(c.id);
    let s = strips.get(c.id);
    if (!s) { s = makeStrip(c); strips.set(c.id, s); }
    s.data = c;
    s.fill.style.clipPath = `inset(${100 - pct(c.level)}% 0 0 0)`;
    s.floor.style.bottom = (c.thr === null ? 0 : pct(c.thr)) + '%';
    s.el.classList.toggle('live', c.live);
    s.el.classList.toggle('down', c.conn !== 'connected');
    s.tag.textContent = c.muted || c.selfMuted ? 'MUTED' : c.live ? 'LIVE' : 'STANDBY';
    const bad = c.conn === 'lost';
    s.state.classList.toggle('bad', bad);
    s.state.textContent = c.conn === 'connected' ? (c.selfMuted ? 'self-muted' : c.path === 'relay' ? 'via relay' : '') : bad ? 'connection lost' : 'connecting';
    s.mute.setAttribute('aria-pressed', String(c.muted));
    s.pin.setAttribute('aria-pressed', String(c.pinned));
    if (free(s.fader) && Number(s.fader.value) !== c.gainDb) {
      s.fader.value = c.gainDb;
      s.db.textContent = `${c.gainDb > 0 ? '+' : ''}${c.gainDb} dB`;
    }
  }
  for (const [id, s] of strips) if (!seen.has(id)) { s.el.remove(); strips.delete(id); }
  $('empty').hidden = strips.size > 0;
  $('count').textContent = `${d.channels.filter((c) => c.conn === 'connected').length} connected`;

  // remote listeners
  const heard = new Set();
  for (const l of d.listeners) {
    heard.add(l.id);
    let r = rows.get(l.id);
    if (!r) { r = makeRow(l); rows.set(l.id, r); }
    r.state.textContent = l.conn === 'connected' ? (l.path === 'relay' ? 'via relay' : 'listening') : l.conn === 'lost' ? 'connection lost' : 'connecting';
  }
  for (const [id, r] of rows) if (!heard.has(id)) { r.el.remove(); rows.delete(id); }
  $('no-listeners').hidden = rows.size > 0;

  // feed
  const feed = $('feed-state');
  feed.textContent = d.feedMuted ? (d.manualMute ? 'Feed muted by hand' : 'Feed muted: remote speaker') : 'Feed live';
  feed.classList.toggle('muted', d.feedMuted);
  $('onair-btn').setAttribute('aria-pressed', String(d.manualMute));
  $('master-level').style.width = pct(d.masterDb) + '%';

  // settings
  $('mode-auto').setAttribute('aria-pressed', String(d.settings.mode === 'auto'));
  $('mode-all').setAttribute('aria-pressed', String(d.settings.mode === 'all'));
  for (const key of ['threshold', 'margin', 'offLevel', 'masterGain']) {
    const input = $(key);
    if (free(input) && Number(input.value) !== d.settings[key]) {
      input.value = d.settings[key];
      $(key + '-out').textContent = `${d.settings[key]} dB`;
    }
  }
}

for (const key of ['threshold', 'margin', 'offLevel', 'masterGain']) {
  const input = $(key);
  guard(input);
  input.addEventListener('input', () => {
    $(key + '-out').textContent = `${Number(input.value)} dB`;
    cmd(key, undefined, Number(input.value));
  });
}
$('mode-auto').addEventListener('click', () => cmd('mode', undefined, 'auto'));
$('mode-all').addEventListener('click', () => cmd('mode', undefined, 'all'));
$('onair-btn').addEventListener('click', () => cmd('manualMute', undefined, !(deck && deck.manualMute)));

function copyButton(buttonId, sourceId, label) {
  $(buttonId).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(sourceId).textContent);
      $(buttonId).textContent = 'Copied';
      setTimeout(() => { $(buttonId).textContent = label; }, 1500);
    } catch { /* clipboard unavailable */ }
  });
}
copyButton('copy-btn', 'join-link', 'Copy join link');
copyButton('copy-listen-btn', 'listen-link', 'Copy listening link');

$('end-btn').addEventListener('click', () => {
  if (!confirm('End the room for everyone?')) return;
  send({ type: 'end' });
});

// ---------------------------------------------------------------- remote speech
//
// Captures this laptop's system audio and reports to the mixer whether the
// meeting is making sound. The report is driven by the audio thread's
// messages, not by a timer, because this tab will usually sit in the
// background behind the meeting, where timers are throttled.

const capture = { stream: null, ctx: null, thresholdDb: -50, active: false, lastSent: 0 };

async function startCapture() {
  // Browsers will not share system audio without a screen, so a video track
  // is requested at a token rate and never used or sent anywhere.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
  });
  const audio = stream.getAudioTracks()[0];
  if (!audio) {
    for (const t of stream.getTracks()) t.stop();
    banner('No system audio was shared. Choose the entire screen and tick the system audio box, then try again.');
    return;
  }
  banner('');
  await listenTo(stream);
  audio.addEventListener('ended', stopCapture);
}

/** Starts reporting from any stream; the end-to-end check calls this directly. */
async function listenTo(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  capture.stream = stream;
  capture.ctx = new Ctx();
  await capture.ctx.audioWorklet.addModule('/meter-worklet.js');
  const meter = new AudioWorkletNode(capture.ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 0 });
  capture.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(meter);
  meter.port.onmessage = (e) => {
    const db = e.data.rms > 1e-5 ? 20 * Math.log10(e.data.rms) : -100;
    $('ref-level').style.width = pct(db) + '%';
    const active = db > capture.thresholdDb;
    const now = performance.now();
    // Repeat "speaking" a few times a second so that the mixer can tell a
    // live report from a controller that has gone away; say "stopped" once.
    if (active && (!capture.active || now - capture.lastSent > 200)) {
      cmd('remoteActive', undefined, true);
      capture.lastSent = now;
    } else if (!active && capture.active) {
      cmd('remoteActive', undefined, false);
    }
    capture.active = active;
  };
  $('capture-btn').setAttribute('aria-pressed', 'true');
  $('capture-btn').textContent = 'Automatic muting is on';
  $('ref-row').hidden = false;
}

function stopCapture() {
  if (capture.stream) for (const t of capture.stream.getTracks()) t.stop();
  if (capture.ctx) capture.ctx.close().catch(() => {});
  if (capture.active) cmd('remoteActive', undefined, false);
  capture.stream = null;
  capture.ctx = null;
  capture.active = false;
  $('capture-btn').setAttribute('aria-pressed', 'false');
  $('capture-btn').textContent = 'Mute automatically from meeting audio';
  $('ref-row').hidden = true;
}

$('capture-btn').addEventListener('click', async () => {
  if (capture.stream) { stopCapture(); return; }
  try {
    await startCapture();
  } catch (err) {
    if (err.name !== 'NotAllowedError') banner('Meeting audio could not be captured: ' + (err.message || err.name));
  }
});

// A deck that has stopped updating means the mixer is not reporting.
setInterval(() => {
  if (session && engineOnline && deck && performance.now() - lastDeckAt > 5000 && !stale) {
    stale = true;
    banner('No levels are arriving from the mixer. Check the server.');
  }
}, 3000);

window.mixcrtqController = { listenTo, stopCapture, capture };
