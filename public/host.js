// Host mixer: receives one audio stream per participant, runs the gated
// automixer, and sends the mix to an output device (a virtual audio cable
// that the conferencing client then uses as its microphone).
//
// Signal path per channel:
//   source -> meter (pre-fader, drives the automixer and the display)
//   source -> fader -> gate -> bus -> duck -> master -> outGate -> sink
//
// The output is deliberately an interchangeable sink and the far-end
// reference an optional input (see window.mixcrtq at the foot of the file),
// so that a remote WebRTC link can replace the virtual cable later without
// touching the room side.

import { AutoMixer, rmsToDb, dbToGain } from '/automix.js';
import { rtcConfig, pathOf } from '/rtc-config.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'mixcrtq.host';
const SINK_KEY = 'mixcrtq.sink';
const CABLE_PATTERN = /cable input|vb-audio|voicemeeter|blackhole|loopback/i;

const store = {
  get(area, k) { try { return area.getItem(k); } catch { return null; } },
  set(area, k, v) { try { area.setItem(k, v); } catch { /* unavailable */ } },
  del(area, k) { try { area.removeItem(k); } catch { /* unavailable */ } },
};

const mixer = new AutoMixer();
/** @type {Map<string, any>} */
const channels = new Map();

let ctx = null;
let bus, duck, master, outGate, mixTap;
let fallbackEl = null; // used when AudioContext.setSinkId is unavailable
let ws = null;
let session = null; // { code, token }
let ended = false;
let offGain = dbToGain(-30);
let sinkChosen = false;
let masterDb = -100;
let hostMicStream = null;

/** @type {Map<string, any>} remote listeners, keyed by id */
const listeners = new Map();
let manualMute = false; // the host's "remote speaker on air" button
let feedMuted = false; // whether the feed is currently silenced, as told to listeners
let duckTarget = 1;
let captureStream = null;

// Far-end reference: the audio of the meeting (remote people speaking through
// the room loudspeaker). While it is active the room mix is silenced, because
// the room microphones are hearing that loudspeaker and would return each
// remote voice to its owner. The hold must outlast the path from loudspeaker
// to microphone to mixer, which includes a network hop and a jitter buffer.
const reference = { node: null, meter: null, env: -100, lastActive: -1e9, thresholdDb: -50, duckDb: -60, holdMs: 600 };

// ---------------------------------------------------------------- start

const saved = (() => {
  try { return JSON.parse(store.get(sessionStorage, SESSION_KEY) || 'null'); } catch { return null; }
})();
if (saved?.code) $('start-btn').textContent = `Resume room ${saved.code}`;

$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  $('start-error').hidden = true;
  try {
    await startAudio();
    $('start-screen').hidden = true;
    $('deck').hidden = false;
    connect();
    requestAnimationFrame(draw);
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
  } catch (err) {
    console.error(err);
    $('start-error').hidden = false;
    $('start-error').textContent = 'The mixer could not start: ' + (err.message || err.name);
    $('start-btn').disabled = false;
  }
});

async function startAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
  await ctx.audioWorklet.addModule('/meter-worklet.js');
  if (ctx.state === 'suspended') await ctx.resume();

  bus = ctx.createGain();
  duck = ctx.createGain();
  master = ctx.createGain();
  outGate = ctx.createGain();
  outGate.gain.value = 0; // silent until an output device is chosen
  bus.connect(duck).connect(master).connect(outGate);

  // The mix as a MediaStream, for a future remote link in place of the cable.
  mixTap = ctx.createMediaStreamDestination();
  mixTap.channelCount = 1;
  master.connect(mixTap);

  if (typeof ctx.setSinkId === 'function') {
    outGate.connect(ctx.destination);
  } else {
    const dest = ctx.createMediaStreamDestination();
    outGate.connect(dest);
    fallbackEl = new Audio();
    fallbackEl.srcObject = dest.stream;
    fallbackEl.play().catch(() => {});
  }

  const masterMeter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 0 });
  master.connect(masterMeter);
  masterMeter.port.onmessage = (e) => {
    masterDb = rmsToDb(e.data.rms);
    tick(); // the automixer runs on the audio clock, not on a timer
  };

  // Device labels are only exposed once microphone permission is granted.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of probe.getTracks()) t.stop();
  } catch {
    banner('Microphone permission was refused, so output devices cannot be listed by name. Allow it and reload.');
  }
  await refreshSinks();
  navigator.mediaDevices.addEventListener('devicechange', refreshSinks);
}

// ---------------------------------------------------------------- output

async function refreshSinks() {
  const select = $('sink');
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const current = sinkChosen ? select.value : (store.get(localStorage, SINK_KEY) || '');
  select.replaceChildren(new Option('None (mix is silent)', ''));
  for (const d of devices) select.add(new Option(d.label || 'Output device', d.deviceId));

  let pick = devices.find((d) => d.deviceId === current);
  if (!pick && !sinkChosen) pick = devices.find((d) => CABLE_PATTERN.test(d.label));
  select.value = pick ? pick.deviceId : '';
  await applySink();
}

async function applySink() {
  const select = $('sink');
  const id = select.value;
  const label = select.selectedOptions[0]?.textContent || '';
  const note = $('sink-note');
  const t = ctx.currentTime;
  if (!id) {
    outGate.gain.setTargetAtTime(0, t, 0.01);
    note.className = 'notice';
    note.textContent = 'Not needed when the remote side uses the listening link. Choose a virtual cable here only to feed the mix into a meeting as its microphone; never choose the laptop speakers.';
    return;
  }
  try {
    if (typeof ctx.setSinkId === 'function') await ctx.setSinkId(id);
    else if (fallbackEl?.setSinkId) await fallbackEl.setSinkId(id);
    else throw new Error('This browser cannot choose an output device. Use Chrome or Edge on the host.');
    outGate.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
    store.set(localStorage, SINK_KEY, id);
    if (CABLE_PATTERN.test(label)) {
      note.className = 'notice ok';
      note.textContent = 'Sending the mix to the virtual cable. Select the matching cable as the microphone in the meeting.';
    } else {
      note.className = 'notice bad';
      note.textContent = 'This does not look like a virtual cable. If it is a loudspeaker in the room, the room will hear itself.';
    }
  } catch (err) {
    outGate.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    select.value = '';
    note.className = 'notice bad';
    note.textContent = 'That output could not be opened: ' + (err.message || err.name);
  }
}

$('sink').addEventListener('change', () => { sinkChosen = true; applySink(); });

$('tone-btn').addEventListener('click', () => {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = 440;
  g.gain.value = dbToGain(-20);
  osc.connect(g).connect(outGate);
  osc.start();
  osc.stop(ctx.currentTime + 2);
  osc.onended = () => g.disconnect();
});

// ---------------------------------------------------------------- controls

function bindSlider(id, unit, apply) {
  const input = $(id);
  const out = $(id + '-out');
  const update = () => {
    const v = Number(input.value);
    out.textContent = `${v} ${unit}`;
    apply(v);
  };
  input.addEventListener('input', update);
  update();
}

function bindControls() {
  bindSlider('master-gain', 'dB', (v) => master?.gain.setTargetAtTime(dbToGain(v), ctx.currentTime, 0.02));
  bindSlider('threshold', 'dB', (v) => { mixer.opts.threshold = v; });
  bindSlider('margin', 'dB', (v) => { mixer.opts.margin = v; });
  bindSlider('off-level', 'dB', (v) => {
    offGain = dbToGain(v);
    for (const ch of channels.values()) ch.gateTarget = null; // reapply on the next tick
  });
}

function setMode(mode) {
  mixer.mode = mode;
  $('mode-auto').setAttribute('aria-pressed', String(mode === 'auto'));
  $('mode-all').setAttribute('aria-pressed', String(mode === 'all'));
}
$('mode-auto').addEventListener('click', () => setMode('auto'));
$('mode-all').addEventListener('click', () => setMode('all'));

$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('join-link').textContent);
    $('copy-btn').textContent = 'Copied';
    setTimeout(() => { $('copy-btn').textContent = 'Copy join link'; }, 1500);
  } catch { /* clipboard unavailable */ }
});

$('end-btn').addEventListener('click', () => {
  if (!confirm('End the room for everyone?')) return;
  ended = true;
  send({ type: 'end' });
  store.del(sessionStorage, SESSION_KEY);
  setTimeout(() => location.reload(), 200);
});

$('hostmic-btn').addEventListener('click', async () => {
  const btn = $('hostmic-btn');
  if (hostMicStream) {
    removeChannel('host');
    for (const t of hostMicStream.getTracks()) t.stop();
    hostMicStream = null;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = "Add this laptop's microphone";
    return;
  }
  try {
    hostMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    });
    const ch = addChannel('host', 'This laptop', { local: true });
    attachStream(ch, hostMicStream);
    setConn(ch, 'connected');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = "Remove this laptop's microphone";
  } catch (err) {
    banner('The host microphone could not be opened: ' + err.name);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!ended && (channels.size || listeners.size)) e.preventDefault();
});

function banner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
}

// ---------------------------------------------------------------- channels

function addChannel(id, name, { local = false } = {}) {
  if (channels.has(id)) return channels.get(id);
  const el = $('strip-tpl').content.firstElementChild.cloneNode(true);
  const ch = {
    id, name, local, el,
    pc: null, sinkEl: null, source: null, meter: null,
    fader: ctx.createGain(),
    gate: ctx.createGain(),
    levelDb: -100,
    muted: false, selfMuted: false, pinned: false,
    conn: 'connecting',
    gateTarget: null,
    sent: null, // last state sent to the participant
    ui: {
      state: el.querySelector('.state'),
      tag: el.querySelector('.tag'),
      fill: el.querySelector('.fill'),
      floor: el.querySelector('.floor'),
      db: el.querySelector('.db'),
      mute: el.querySelector('.mute'),
      pin: el.querySelector('.pin'),
    },
  };
  ch.gate.gain.value = 0;
  ch.fader.connect(ch.gate).connect(bus);

  el.querySelector('.name').textContent = name;
  el.querySelector('.name').title = name;
  el.querySelector('.fader input').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    ch.fader.gain.setTargetAtTime(dbToGain(v), ctx.currentTime, 0.02);
    ch.ui.db.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  });
  ch.ui.mute.addEventListener('click', () => {
    ch.muted = !ch.muted;
    ch.ui.mute.setAttribute('aria-pressed', String(ch.muted));
    syncMixer(ch);
  });
  ch.ui.pin.addEventListener('click', () => {
    ch.pinned = !ch.pinned;
    ch.ui.pin.setAttribute('aria-pressed', String(ch.pinned));
    syncMixer(ch);
  });
  const remove = el.querySelector('.remove');
  if (local) remove.hidden = true;
  else remove.addEventListener('click', () => send({ type: 'remove', to: id }));

  mixer.add(id);
  channels.set(id, ch);
  syncMixer(ch);
  $('empty').hidden = true;
  $('strips').append(el);
  updateCount();
  return ch;
}

function syncMixer(ch) {
  mixer.set(ch.id, {
    muted: ch.muted || ch.selfMuted,
    pinned: ch.pinned,
    active: ch.conn === 'connected',
  });
}

function setConn(ch, conn) {
  ch.conn = conn;
  syncMixer(ch);
  updateCount();
}

function detachStream(ch) {
  if (ch.source) ch.source.disconnect();
  if (ch.meter) { ch.meter.port.onmessage = null; ch.meter.disconnect(); }
  if (ch.sinkEl) { ch.sinkEl.srcObject = null; ch.sinkEl = null; }
  ch.source = null;
  ch.meter = null;
  ch.levelDb = -100;
}

function attachStream(ch, stream) {
  detachStream(ch);
  if (!ch.local) {
    // Chrome only delivers a remote WebRTC track to Web Audio while the
    // stream is also attached to a media element, so park it on a muted one.
    ch.sinkEl = new Audio();
    ch.sinkEl.muted = true;
    ch.sinkEl.srcObject = stream;
    ch.sinkEl.play().catch(() => {});
  }
  ch.source = ctx.createMediaStreamSource(stream);
  ch.meter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 0 });
  ch.source.connect(ch.meter);
  ch.source.connect(ch.fader);
  ch.meter.port.onmessage = (e) => {
    ch.levelDb = rmsToDb(e.data.rms);
    mixer.update(ch.id, ch.levelDb, e.data.ms);
  };
  mixer.reset(ch.id);
}

function removeChannel(id) {
  const ch = channels.get(id);
  if (!ch) return;
  detachStream(ch);
  ch.fader.disconnect();
  ch.gate.disconnect();
  if (ch.pc) { ch.pc.onconnectionstatechange = null; ch.pc.ontrack = null; ch.pc.close(); }
  ch.el.remove();
  channels.delete(id);
  mixer.remove(id);
  $('empty').hidden = channels.size > 0;
  updateCount();
}

function updateCount() {
  const n = [...channels.values()].filter((c) => c.conn === 'connected').length;
  $('count').textContent = `${n} connected`;
}

// ---------------------------------------------------------------- listeners
//
// Remote listeners receive the room mix (taken after the duck stage) over one
// peer connection each. The host makes the offer, because it owns the stream.

function addListener(id, name) {
  if (listeners.has(id)) return listeners.get(id);
  const el = document.createElement('li');
  const label = document.createElement('span');
  label.className = 'who';
  label.textContent = name;
  label.title = name;
  const state = document.createElement('span');
  state.className = 'lstate';
  state.textContent = 'connecting';
  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => send({ type: 'remove', to: id }));
  el.append(label, state, remove);
  const l = { id, name, el, state, pc: null, conn: 'connecting', path: null };
  listeners.set(id, l);
  $('listeners').append(el);
  $('no-listeners').hidden = true;
  return l;
}

async function offerTo(l) {
  if (l.pc) { l.pc.onconnectionstatechange = null; l.pc.close(); }
  const config = await rtcConfig();
  if (listeners.get(l.id) !== l) return; // left while the configuration was fetched
  const pc = new RTCPeerConnection(config);
  l.pc = pc;
  l.conn = 'connecting';
  for (const track of mixTap.stream.getAudioTracks()) pc.addTrack(track, mixTap.stream);
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', to: l.id, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc !== l.pc) return;
    const s = pc.connectionState;
    l.conn = s === 'connected' ? 'connected' : s === 'failed' || s === 'disconnected' ? 'lost' : 'connecting';
    if (s === 'connected') {
      send({ type: 'state', to: l.id, feedMuted });
      pathOf(pc).then((p) => { if (pc === l.pc) l.path = p; });
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  send({ type: 'signal', to: l.id, data: { description: pc.localDescription } });
}

function removeListener(id) {
  const l = listeners.get(id);
  if (!l) return;
  if (l.pc) { l.pc.onconnectionstatechange = null; l.pc.close(); }
  l.el.remove();
  listeners.delete(id);
  $('no-listeners').hidden = listeners.size > 0;
}

$('onair-btn').addEventListener('click', () => {
  manualMute = !manualMute;
  $('onair-btn').setAttribute('aria-pressed', String(manualMute));
});

$('capture-btn').addEventListener('click', async () => {
  const btn = $('capture-btn');
  if (captureStream) {
    for (const t of captureStream.getTracks()) t.stop();
    stopCapture();
    return;
  }
  try {
    // Only the audio is wanted, but browsers will not share system audio
    // without a screen, so the video track is requested at a token rate and
    // never used or sent anywhere.
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
    captureStream = stream;
    audio.addEventListener('ended', stopCapture);
    window.mixcrtq.setReferenceStream(new MediaStream([audio]));
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Automatic muting is on';
    $('ref-row').hidden = false;
  } catch (err) {
    if (err.name !== 'NotAllowedError') banner('Meeting audio could not be captured: ' + (err.message || err.name));
  }
});

function stopCapture() {
  if (captureStream) for (const t of captureStream.getTracks()) t.stop();
  captureStream = null;
  window.mixcrtq.setReferenceStream(null);
  $('capture-btn').setAttribute('aria-pressed', 'false');
  $('capture-btn').textContent = 'Mute automatically from meeting audio';
  $('ref-row').hidden = true;
}

$('copy-listen-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('listen-link').textContent);
    $('copy-listen-btn').textContent = 'Copied';
    setTimeout(() => { $('copy-listen-btn').textContent = 'Copy listening link'; }, 1500);
  } catch { /* clipboard unavailable */ }
});

// ---------------------------------------------------------------- automix

function tick() {
  const now = performance.now();
  const { live, open } = mixer.tick(now);
  const t = ctx.currentTime;

  for (const ch of channels.values()) {
    const silenced = ch.muted || ch.selfMuted || ch.conn !== 'connected';
    const isOpen = open.has(ch.id);
    const target = silenced ? 0 : isOpen ? 1 : offGain;
    if (target !== ch.gateTarget) {
      // open quickly so that word onsets survive; close gently
      ch.gate.gain.setTargetAtTime(target, t, target >= (ch.gateTarget ?? 0) ? 0.008 : 0.06);
      ch.gateTarget = target;
    }
    ch.isLive = mixer.mode === 'all' ? isOpen && !silenced : ch.id === live || (isOpen && ch.pinned);

    if (!ch.local) {
      const key = `${ch.isLive ? 1 : 0}${ch.muted ? 1 : 0}`;
      if (key !== ch.sent && ch.conn === 'connected') {
        ch.sent = key;
        send({ type: 'state', to: ch.id, live: ch.isLive, hostMuted: ch.muted });
      }
    }
  }

  // Silence the mix while a remote person is speaking: by hand, or
  // automatically when a reference stream reports meeting audio.
  if (reference.node && reference.env > reference.thresholdDb) reference.lastActive = now;
  const refActive = !!reference.node && now - reference.lastActive < reference.holdMs;
  const target = manualMute ? 0 : refActive ? dbToGain(reference.duckDb) : 1;
  if (target !== duckTarget) {
    duck.gain.setTargetAtTime(target, t, target < duckTarget ? 0.01 : 0.08);
    duckTarget = target;
  }
  const muted = target < 1;
  if (muted !== feedMuted) {
    feedMuted = muted;
    for (const l of listeners.values()) {
      if (l.conn === 'connected') send({ type: 'state', to: l.id, feedMuted });
    }
  }
}

// ---------------------------------------------------------------- drawing

const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function draw() {
  for (const ch of channels.values()) {
    const m = mixer.channels.get(ch.id);
    ch.ui.fill.style.clipPath = `inset(${100 - pct(ch.levelDb)}% 0 0 0)`;
    ch.ui.floor.style.bottom = (m && m.floor !== null ? pct(m.floor + mixer.opts.threshold) : 0) + '%';
    ch.el.classList.toggle('live', !!ch.isLive);
    ch.el.classList.toggle('down', ch.conn !== 'connected');
    ch.ui.tag.textContent = ch.muted || ch.selfMuted ? 'MUTED' : ch.isLive ? 'LIVE' : 'STANDBY';
    const bad = ch.conn === 'lost';
    ch.ui.state.classList.toggle('bad', bad);
    ch.ui.state.textContent = ch.conn === 'connected' ? (ch.selfMuted ? 'self-muted' : ch.path === 'relay' ? 'via relay' : '') : bad ? 'connection lost' : 'connecting';
  }
  for (const l of listeners.values()) {
    l.state.textContent = l.conn === 'connected' ? (l.path === 'relay' ? 'via relay' : 'listening') : l.conn === 'lost' ? 'connection lost' : 'connecting';
  }
  const feed = $('feed-state');
  feed.textContent = feedMuted ? (manualMute ? 'Feed muted by hand' : 'Feed muted: remote speaker') : 'Feed live';
  feed.classList.toggle('muted', feedMuted);
  if (reference.node) $('ref-level').style.width = pct(reference.env) + '%';
  $('master-level').style.width = pct(masterDb) + '%';
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- signalling

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    const s = session || saved;
    send(s?.code ? { type: 'host-resume', code: s.code, token: s.token } : { type: 'host-create' });
  };
  sock.onclose = () => {
    if (ended || sock !== ws) return;
    banner('The signalling connection dropped. Audio already flowing is unaffected; reconnecting.');
    setTimeout(connect, 2000);
  };
  // Messages are handled strictly in order, so that an ICE candidate can
  // never overtake the offer it belongs to.
  let chain = Promise.resolve();
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handle(msg)).catch((err) => console.error(err));
  };
}

async function handle(msg) {
  if (msg.type === 'host-ready') {
    session = { code: msg.code, token: msg.token };
    store.set(sessionStorage, SESSION_KEY, JSON.stringify(session));
    $('code').textContent = msg.code;
    const relay = new URLSearchParams(location.search).get('relay') === '1' ? '&relay=1' : '';
    $('join-link').textContent = `${location.origin}/join?code=${msg.code}${relay}`;
    $('listen-code').textContent = msg.listenCode;
    $('listen-link').textContent = `${location.origin}/listen?code=${msg.listenCode}${relay}`;
    banner('');
    const present = new Set(msg.peers.map((p) => p.id));
    for (const ch of [...channels.values()]) {
      if (!ch.local && !present.has(ch.id)) removeChannel(ch.id);
    }
    for (const id of [...listeners.keys()]) if (!present.has(id)) removeListener(id);
    for (const p of msg.peers) {
      if (p.kind === 'listener') {
        if (!listeners.has(p.id)) await offerTo(addListener(p.id, p.name));
      } else if (!channels.has(p.id)) {
        // The page was reloaded: ask the participant to offer afresh.
        addChannel(p.id, p.name);
        send({ type: 'signal', to: p.id, data: { reoffer: true } });
      }
    }
  } else if (msg.type === 'error' && msg.code === 'no-session') {
    // The stored session expired on the server: open a new room.
    session = null;
    store.del(sessionStorage, SESSION_KEY);
    for (const ch of [...channels.values()]) if (!ch.local) removeChannel(ch.id);
    for (const id of [...listeners.keys()]) removeListener(id);
    send({ type: 'host-create' });
  } else if (msg.type === 'peer-joined') {
    if (msg.kind === 'listener') await offerTo(addListener(msg.id, msg.name));
    else addChannel(msg.id, msg.name);
  } else if (msg.type === 'peer-left') {
    removeChannel(msg.id);
    removeListener(msg.id);
  } else if (msg.type === 'peer-status') {
    const ch = channels.get(msg.id);
    if (ch) {
      if (ch.selfMuted && !msg.muted) mixer.reset(ch.id);
      ch.selfMuted = msg.muted;
      syncMixer(ch);
    }
  } else if (msg.type === 'signal') {
    const { description, candidate } = msg.data || {};
    const l = listeners.get(msg.from);
    if (l) {
      if (description?.type === 'answer' && l.pc) await l.pc.setRemoteDescription(description);
      else if (candidate && l.pc) await l.pc.addIceCandidate(candidate);
      return;
    }
    const ch = channels.get(msg.from);
    if (!ch) return;
    if (description?.type === 'offer') {
      await answer(ch, description);
    } else if (candidate && ch.pc) {
      await ch.pc.addIceCandidate(candidate);
    }
  }
}

async function answer(ch, offer) {
  if (ch.pc) {
    ch.pc.onconnectionstatechange = null;
    ch.pc.ontrack = null;
    ch.pc.close();
    detachStream(ch);
  }
  const pc = new RTCPeerConnection(await rtcConfig());
  ch.pc = pc;
  ch.path = null;
  ch.sent = null;
  setConn(ch, 'connecting');

  pc.ontrack = (e) => {
    // Ask for the shortest jitter buffer the network allows: every
    // millisecond here widens the echo problem at the far end.
    try {
      if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
      else if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
    } catch { /* not supported */ }
    attachStream(ch, e.streams[0] || new MediaStream([e.track]));
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', to: ch.id, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc !== ch.pc) return;
    const s = pc.connectionState;
    setConn(ch, s === 'connected' ? 'connected' : s === 'failed' || s === 'disconnected' ? 'lost' : 'connecting');
    if (s === 'connected') pathOf(pc).then((p) => { if (pc === ch.pc) ch.path = p; });
  };

  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  send({ type: 'signal', to: ch.id, data: { description: pc.localDescription } });
}

// ---------------------------------------------------------------- hooks

bindControls();

// Extension points. setReferenceStream accepts the far-end audio (a loopback
// capture of the conferencing client's output today, a remote WebRTC stream
// later) and ducks the room mix while the remote side is speaking. mixStream
// is the room mix as a MediaStream, for a sink other than the virtual cable.
window.mixcrtq = {
  mixer,
  channels,
  listeners,
  reference,
  get feedMuted() { return feedMuted; },
  get mixStream() { return mixTap ? mixTap.stream : null; },
  setReferenceStream(stream) {
    if (reference.node) { reference.node.disconnect(); reference.meter.disconnect(); }
    reference.node = null;
    reference.env = -100;
    if (!stream) return; // the next tick releases the mute
    reference.node = ctx.createMediaStreamSource(stream);
    reference.meter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 0 });
    reference.node.connect(reference.meter);
    reference.meter.port.onmessage = (e) => { reference.env = rmsToDb(e.data.rms); };
  },
};
