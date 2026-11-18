// The mixer engine. It runs in a headless browser on the server, one page
// per room: it receives one audio stream per room laptop, runs the gated
// automixer, and sends the mix to each remote listener. It has no interface;
// the controller page sends it commands and receives its meter levels.
//
// Signal path per channel:
//   source -> meter (pre-fader, drives the automixer and the display)
//   source -> fader -> gate -> bus -> duck -> master -> listeners

import { AutoMixer, rmsToDb, dbToGain } from '/automix.js';
import { rtcConfig, pathOf } from '/rtc-config.js';

const params = new URLSearchParams(location.hash.slice(1));
const session = { code: params.get('code'), token: params.get('token') };

const mixer = new AutoMixer();
/** @type {Map<string, any>} room microphones, keyed by participant id */
const channels = new Map();
/** @type {Map<string, any>} remote listeners, keyed by participant id */
const listeners = new Map();

const settings = { mode: 'auto', threshold: 9, margin: 4, offLevel: -30, masterGain: 0 };

let ctx, bus, duck, master, mixTap;
let ws = null;
let stopped = false;
let masterDb = -100;
let offGain = dbToGain(settings.offLevel);
let duckTarget = 1;
let feedMuted = false; // as last told to listeners
let manualMute = false; // the controller's "remote speaker on air" button
let deckCounter = 0;

// Remote speech, as reported by the controller laptop, which is the machine
// playing the meeting into the room. While a remote person speaks the room
// microphones hear the loudspeaker, so the mix is silenced; otherwise each
// remote voice would be returned to its owner. The hold must outlast the path
// from loudspeaker to microphone to this mixer. The expiry releases the mute
// if the controller vanishes while reporting speech.
const remote = { active: false, lastTrue: -1e9, lastSeen: -1e9, holdMs: 600, expiryMs: 3000 };

// ---------------------------------------------------------------- audio

async function startAudio() {
  ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  // The server has nothing to play through; render without an output device
  // where the browser allows it.
  try { await ctx.setSinkId({ type: 'none' }); } catch { /* keep the default sink */ }
  await ctx.audioWorklet.addModule('/meter-worklet.js');
  if (ctx.state === 'suspended') await ctx.resume();

  bus = ctx.createGain();
  duck = ctx.createGain();
  master = ctx.createGain();
  bus.connect(duck).connect(master);

  mixTap = ctx.createMediaStreamDestination();
  mixTap.channelCount = 1;
  master.connect(mixTap);

  // Keep the graph pulled even with no listener attached.
  const keepAlive = ctx.createGain();
  keepAlive.gain.value = 0;
  master.connect(keepAlive).connect(ctx.destination);

  const masterMeter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 0 });
  master.connect(masterMeter);
  masterMeter.port.onmessage = (e) => {
    masterDb = rmsToDb(e.data.rms);
    tick(); // the automixer runs on the audio clock, not on a timer
  };
}

// ---------------------------------------------------------------- channels

function addChannel(id, name) {
  if (channels.has(id)) return channels.get(id);
  const ch = {
    id, name,
    pc: null, sinkEl: null, source: null, meter: null,
    fader: ctx.createGain(),
    gate: ctx.createGain(),
    gainDb: 0,
    levelDb: -100,
    muted: false, selfMuted: false, pinned: false,
    conn: 'connecting',
    path: null,
    isLive: false,
    gateTarget: null,
    sent: null, // last state sent to the participant
  };
  ch.gate.gain.value = 0;
  ch.fader.connect(ch.gate).connect(bus);
  mixer.add(id);
  channels.set(id, ch);
  syncMixer(ch);
  return ch;
}

function syncMixer(ch) {
  mixer.set(ch.id, {
    muted: ch.muted || ch.selfMuted,
    pinned: ch.pinned,
    active: ch.conn === 'connected',
  });
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
  // Chrome only delivers a remote WebRTC track to Web Audio while the stream
  // is also attached to a media element, so park it on a muted one.
  ch.sinkEl = new Audio();
  ch.sinkEl.muted = true;
  ch.sinkEl.srcObject = stream;
  ch.sinkEl.play().catch(() => {});

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
  channels.delete(id);
  mixer.remove(id);
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
  ch.conn = 'connecting';
  syncMixer(ch);

  pc.ontrack = (e) => {
    // Ask for the shortest jitter buffer the network allows: every
    // millisecond here lengthens the mute that follows a remote speaker.
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
    ch.conn = s === 'connected' ? 'connected' : s === 'failed' || s === 'disconnected' ? 'lost' : 'connecting';
    syncMixer(ch);
    if (s === 'connected') pathOf(pc).then((p) => { if (pc === ch.pc) ch.path = p; });
  };

  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  send({ type: 'signal', to: ch.id, data: { description: pc.localDescription } });
}

// ---------------------------------------------------------------- listeners
//
// Each remote listener receives the mix over its own peer connection. The
// engine makes the offer, because it owns the stream.

function addListener(id, name) {
  if (listeners.has(id)) return listeners.get(id);
  const l = { id, name, pc: null, conn: 'connecting', path: null };
  listeners.set(id, l);
  return l;
}

async function offerTo(l) {
  if (l.pc) { l.pc.onconnectionstatechange = null; l.pc.close(); }
  const config = await rtcConfig();
  if (listeners.get(l.id) !== l) return; // left while the configuration was fetched
  const pc = new RTCPeerConnection(config);
  l.pc = pc;
  l.conn = 'connecting';
  l.path = null;
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
  listeners.delete(id);
}

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

    const key = `${ch.isLive ? 1 : 0}${ch.muted ? 1 : 0}`;
    if (key !== ch.sent && ch.conn === 'connected') {
      ch.sent = key;
      send({ type: 'state', to: ch.id, live: ch.isLive, hostMuted: ch.muted });
    }
  }

  // Silence the mix while a remote person is speaking: by hand, or on the
  // controller's report of meeting audio.
  if (remote.active && now - remote.lastSeen > remote.expiryMs) remote.active = false;
  const remoteSpeaking = remote.active || now - remote.lastTrue < remote.holdMs;
  const target = manualMute || remoteSpeaking ? 0 : 1;
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

  // Roughly ten times a second, publish the deck for the controller's display.
  if (++deckCounter >= 5) {
    deckCounter = 0;
    send({ type: 'deck', data: snapshot(remoteSpeaking) });
  }
}

function snapshot(remoteSpeaking) {
  return {
    settings,
    manualMute,
    remoteSpeaking,
    feedMuted,
    masterDb: Math.round(masterDb),
    channels: [...channels.values()].map((ch) => {
      const m = mixer.channels.get(ch.id);
      return {
        id: ch.id,
        name: ch.name,
        level: Math.round(ch.levelDb),
        thr: m && m.floor !== null ? Math.round(m.floor + mixer.opts.threshold) : null,
        live: !!ch.isLive,
        muted: ch.muted,
        selfMuted: ch.selfMuted,
        pinned: ch.pinned,
        conn: ch.conn,
        path: ch.path,
        gainDb: ch.gainDb,
      };
    }),
    listeners: [...listeners.values()].map((l) => ({ id: l.id, name: l.name, conn: l.conn, path: l.path })),
  };
}

// ---------------------------------------------------------------- commands

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

function command({ action, id, value }) {
  const ch = channels.get(String(id ?? ''));
  const t = ctx.currentTime;
  switch (action) {
    case 'fader':
      if (!ch) break;
      ch.gainDb = num(value, -30, 12, 0);
      ch.fader.gain.setTargetAtTime(dbToGain(ch.gainDb), t, 0.02);
      break;
    case 'mute':
      if (ch) { ch.muted = !!value; syncMixer(ch); }
      break;
    case 'pin':
      if (ch) { ch.pinned = !!value; syncMixer(ch); }
      break;
    case 'remove':
      if (ch || listeners.has(String(id ?? ''))) send({ type: 'remove', to: String(id) });
      break;
    case 'mode':
      settings.mode = value === 'all' ? 'all' : 'auto';
      mixer.mode = settings.mode;
      break;
    case 'threshold':
      settings.threshold = num(value, 3, 24, 9);
      mixer.opts.threshold = settings.threshold;
      break;
    case 'margin':
      settings.margin = num(value, 0, 12, 4);
      mixer.opts.margin = settings.margin;
      break;
    case 'offLevel':
      settings.offLevel = num(value, -60, -6, -30);
      offGain = dbToGain(settings.offLevel);
      for (const c of channels.values()) c.gateTarget = null; // reapply on the next tick
      break;
    case 'masterGain':
      settings.masterGain = num(value, -30, 12, 0);
      master.gain.setTargetAtTime(dbToGain(settings.masterGain), t, 0.02);
      break;
    case 'manualMute':
      manualMute = !!value;
      break;
    case 'remoteActive': {
      const now = performance.now();
      remote.active = !!value;
      remote.lastSeen = now;
      if (value) remote.lastTrue = now;
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- signalling

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => send({ type: 'host-resume', code: session.code, token: session.token });
  sock.onclose = () => {
    if (stopped || sock !== ws) return;
    setTimeout(connect, 1000);
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
    const present = new Set(msg.peers.map((p) => p.id));
    for (const id of [...channels.keys()]) if (!present.has(id)) removeChannel(id);
    for (const id of [...listeners.keys()]) if (!present.has(id)) removeListener(id);
    for (const p of msg.peers) {
      if (p.kind === 'listener') {
        if (!listeners.has(p.id)) await offerTo(addListener(p.id, p.name));
      } else if (!channels.has(p.id)) {
        // This engine is new to a room that already has people in it (it was
        // restarted): ask each microphone to offer afresh.
        addChannel(p.id, p.name);
        send({ type: 'signal', to: p.id, data: { reoffer: true } });
      }
    }
  } else if (msg.type === 'error' && msg.code === 'no-session') {
    // The room has been closed; this page has nothing left to do.
    stopped = true;
    ws.close();
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
  } else if (msg.type === 'cmd') {
    command(msg);
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
    if (description?.type === 'offer') await answer(ch, description);
    else if (candidate && ch.pc) await ch.pc.addIceCandidate(candidate);
  }
}

// ---------------------------------------------------------------- start

// Exposed for inspection and for attaching a recorder or forwarding server.
window.mixcrtq = {
  mixer, channels, listeners, settings, remote,
  get mixStream() { return mixTap ? mixTap.stream : null; },
  get feedMuted() { return feedMuted; },
};

if (session.code && session.token) {
  startAudio().then(connect).catch((err) => console.error('mixer failed to start:', err.message));
} else {
  console.error('mixer page opened without a room code and token');
}
