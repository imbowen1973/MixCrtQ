// Listener page: a remote person hears the room mix. Nothing is captured
// here; the host offers a receive-only audio connection and this page
// answers it.

import { rtcConfig } from '/rtc-config.js';

const $ = (id) => document.getElementById(id);
const form = $('listen-form');
const liveCard = $('live-card');
const lamp = $('lamp');
const player = $('player');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const params = new URLSearchParams(location.search);
$('name').value = store.get('mixcrtq.name') || '';
$('code').value = (params.get('code') || '').toUpperCase().slice(0, 6);
($('name').value ? $('code') : $('name')).focus();

let ws = null;
let pc = null;
let session = null;
let left = false;
let connected = false;
let feedMuted = false;
let hostOnline = true;
let retryTimer = null;
let meterCtx = null;
let analyser = null;

function showStatus(text, kind = '') {
  $('status').hidden = !text;
  $('status').textContent = text || '';
  $('status').className = 'notice' + (kind ? ' ' + kind : '');
}

function renderLamp() {
  lamp.classList.remove('live', 'muted');
  if (!connected) {
    lamp.textContent = 'CONNECTING';
  } else if (feedMuted) {
    lamp.textContent = 'REMOTE SPEAKER';
  } else {
    lamp.classList.add('live');
    lamp.textContent = 'LISTENING';
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function closePeer() {
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    pc = null;
  }
  connected = false;
}

function meter(stream) {
  // The level display reads the stream directly; playback is the <audio>
  // element's job, so nothing here is connected to the speakers.
  if (!meterCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    meterCtx = new Ctx();
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    const buf = new Float32Array(analyser.fftSize);
    const bar = $('level');
    (function draw() {
      if (left) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6);
      window.__levelDb = db; // read by the end-to-end check
      bar.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
      requestAnimationFrame(draw);
    })();
  }
  meterCtx.resume().catch(() => {});
  meterCtx.createMediaStreamSource(stream).connect(analyser);
}

async function answer(offer) {
  closePeer();
  const conn = new RTCPeerConnection(await rtcConfig());
  if (left) { conn.close(); return; }
  pc = conn;
  conn.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    player.srcObject = stream;
    player.play().catch(() => showStatus('Click anywhere on the page to start the sound.', 'bad'));
    meter(stream);
  };
  conn.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', data: { candidate: e.candidate } });
  };
  conn.onconnectionstatechange = () => {
    if (conn !== pc) return;
    connected = conn.connectionState === 'connected';
    if (conn.connectionState === 'failed') {
      showStatus('The connection was lost. Reconnecting.', 'bad');
      scheduleRejoin();
    } else if (connected && hostOnline) {
      showStatus('');
    }
    renderLamp();
  };
  await conn.setRemoteDescription(offer);
  await conn.setLocalDescription(await conn.createAnswer());
  send({ type: 'signal', data: { description: conn.localDescription } });
}

function scheduleRejoin() {
  if (left || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (ws) { ws.onclose = null; ws.close(); }
    closePeer();
    connect();
  }, 2000);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => send({ type: 'listen', code: session.code, name: session.name });
  sock.onclose = () => {
    if (left || sock !== ws) return;
    showStatus('Signalling connection lost. Reconnecting.', 'bad');
    scheduleRejoin();
  };
  let chain = Promise.resolve();
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handle(sock, msg)).catch((err) => console.error(err));
  };
}

async function handle(sock, msg) {
  if (msg.type === 'joined') {
    hostOnline = msg.hostOnline;
    $('who').textContent = msg.name;
    form.hidden = true;
    liveCard.hidden = false;
    showStatus(hostOnline ? '' : 'Waiting for the host to come back.');
    renderLamp();
  } else if (msg.type === 'signal') {
    const { description, candidate } = msg.data || {};
    if (description?.type === 'offer') await answer(description);
    else if (candidate && pc) await pc.addIceCandidate(candidate);
  } else if (msg.type === 'state') {
    feedMuted = !!msg.feedMuted;
    renderLamp();
  } else if (msg.type === 'host-status') {
    hostOnline = msg.online;
    showStatus(hostOnline ? '' : 'The host has disconnected. Waiting for it to return.');
  } else if (msg.type === 'session-closed') {
    leave(msg.reason === 'removed' ? 'The host removed you.' : 'The room has been closed.');
  } else if (msg.type === 'error') {
    if (liveCard.hidden) {
      sock.onclose = null;
      sock.close();
      $('listen-error').hidden = false;
      $('listen-error').className = 'notice bad';
      $('listen-error').textContent = msg.message;
      $('listen-btn').disabled = false;
    } else {
      leave(msg.message);
    }
  }
}

function leave(message) {
  left = true;
  clearTimeout(retryTimer);
  if (ws) ws.close();
  closePeer();
  player.srcObject = null;
  if (meterCtx) meterCtx.close().catch(() => {});
  lamp.classList.remove('live', 'muted');
  lamp.textContent = 'STOPPED';
  showStatus(message || 'You have stopped listening. Reload the page to listen again.');
  $('leave-btn').disabled = true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  $('listen-error').hidden = true;
  const name = $('name').value.trim();
  const code = $('code').value.trim().toUpperCase();
  if (!name || code.length < 6) return;
  $('listen-btn').disabled = true;
  store.set('mixcrtq.name', name);
  session = { name, code };
  // This click is the user gesture that lets the browser play sound later.
  player.play().catch(() => {});
  connect();
});

$('volume').addEventListener('input', (e) => { player.volume = Number(e.target.value) / 100; });
$('leave-btn').addEventListener('click', () => leave());
