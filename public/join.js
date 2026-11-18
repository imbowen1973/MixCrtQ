// Participant page: captures this laptop's microphone and sends it to the
// host over a single peer connection.

const $ = (id) => document.getElementById(id);
const form = $('join-form');
const liveCard = $('live-card');
const lamp = $('lamp');
const statusBox = $('status');
const joinError = $('join-error');

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
let micStream = null;
let iceServers = [];
let session = null; // { name, code }
let left = false;
let selfMuted = false;
let state = { live: false, hostMuted: false };
let hostOnline = true;
let connected = false;
let retryTimer = null;
let wakeLock = null;

function showStatus(text, kind = '') {
  statusBox.hidden = !text;
  statusBox.textContent = text || '';
  statusBox.className = 'notice' + (kind ? ' ' + kind : '');
}

function renderLamp() {
  lamp.classList.remove('live', 'muted');
  if (selfMuted || state.hostMuted) {
    lamp.classList.add('muted');
    lamp.textContent = state.hostMuted && !selfMuted ? 'MUTED BY HOST' : 'MUTED';
  } else if (!connected) {
    lamp.textContent = 'CONNECTING';
  } else if (state.live) {
    lamp.classList.add('live');
    lamp.textContent = 'LIVE';
  } else {
    lamp.textContent = 'STANDBY';
  }
}

async function getMic() {
  // Echo cancellation is off deliberately: this laptop plays nothing, so the
  // browser's canceller has no reference and can only distort. Automatic
  // gain is off so that the host's noise-floor tracking sees stable levels.
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    video: false,
  });
}

function startLevelMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const bar = $('level');
  (function draw() {
    if (left) { ctx.close(); return; }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6);
    bar.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
    requestAnimationFrame(draw);
  })();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function closePeer() {
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.onicecandidate = null;
    pc.close();
    pc = null;
  }
  connected = false;
}

async function startPeer() {
  closePeer();
  const conn = new RTCPeerConnection({ iceServers });
  pc = conn;
  for (const track of micStream.getAudioTracks()) conn.addTrack(track, micStream);
  conn.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', data: { candidate: e.candidate } });
  };
  conn.onconnectionstatechange = () => {
    if (conn !== pc) return;
    connected = conn.connectionState === 'connected';
    if (conn.connectionState === 'failed') {
      showStatus('Connection to the host was lost. Reconnecting.', 'bad');
      scheduleRejoin();
    } else if (connected && hostOnline) {
      showStatus('');
    }
    renderLamp();
  };
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
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
  sock.onopen = () => send({ type: 'join', code: session.code, name: session.name });
  sock.onclose = () => {
    if (left || sock !== ws) return;
    // A rejoin issues a new participant id, so the peer connection is rebuilt
    // with it. Resuming the existing connection is a later refinement.
    showStatus('Signalling connection lost. Reconnecting.', 'bad');
    scheduleRejoin();
  };
  // Handled strictly in order, so that a candidate never overtakes the answer.
  let chain = Promise.resolve();
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handleMessage(sock, msg));
  };
}

async function handleMessage(sock, msg) {
  {
    try {
      if (msg.type === 'joined') {
        hostOnline = msg.hostOnline;
        $('who').textContent = msg.name;
        $('room').textContent = 'room ' + msg.code;
        form.hidden = true;
        liveCard.hidden = false;
        showStatus(hostOnline ? '' : 'Waiting for the host to come back.');
        send({ type: 'status', muted: selfMuted });
        await startPeer();
      } else if (msg.type === 'signal' && pc) {
        const { description, candidate, reoffer } = msg.data || {};
        if (reoffer) await startPeer();
        else if (description) await pc.setRemoteDescription(description);
        else if (candidate) await pc.addIceCandidate(candidate);
      } else if (msg.type === 'state') {
        state = { live: msg.live, hostMuted: msg.hostMuted };
        renderLamp();
      } else if (msg.type === 'host-status') {
        hostOnline = msg.online;
        showStatus(hostOnline ? '' : 'The host has disconnected. Waiting for it to return.');
      } else if (msg.type === 'session-closed') {
        leave(msg.reason === 'removed' ? 'The host removed you from the room.' : 'The room has been closed.');
      } else if (msg.type === 'error') {
        if (liveCard.hidden) {
          sock.onclose = null;
          sock.close();
          stopMic();
          left = true; // stops the level meter; cleared again on the next submit
          joinError.hidden = false;
          joinError.className = 'notice bad';
          joinError.textContent = msg.message;
          $('join-btn').disabled = false;
        } else {
          leave(msg.message);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
}

function stopMic() {
  if (micStream) for (const t of micStream.getTracks()) t.stop();
  micStream = null;
}

function leave(message) {
  left = true;
  clearTimeout(retryTimer);
  if (ws) ws.close();
  closePeer();
  stopMic();
  if (wakeLock) wakeLock.release().catch(() => {});
  lamp.classList.remove('live', 'muted');
  lamp.textContent = 'LEFT';
  showStatus(message || 'You have left the room. Reload the page to join again.');
  $('mute-btn').disabled = true;
  $('leave-btn').disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  joinError.hidden = true;
  const name = $('name').value.trim();
  const code = $('code').value.trim().toUpperCase();
  if (!name || code.length < 6) return;
  $('join-btn').disabled = true;
  try {
    micStream = await getMic();
  } catch (err) {
    joinError.hidden = false;
    joinError.className = 'notice bad';
    joinError.textContent = 'The microphone could not be opened (' + err.name + '). Allow microphone access for this site and try again.';
    $('join-btn').disabled = false;
    return;
  }
  store.set('mixcrtq.name', name);
  session = { name, code };
  left = false;
  try {
    const cfg = await (await fetch('/config')).json();
    iceServers = cfg.iceServers || [];
  } catch { iceServers = []; }
  startLevelMeter(micStream);
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
  connect();
});

$('mute-btn').addEventListener('click', () => {
  selfMuted = !selfMuted;
  if (micStream) for (const t of micStream.getAudioTracks()) t.enabled = !selfMuted;
  $('mute-btn').setAttribute('aria-pressed', String(selfMuted));
  $('mute-btn').textContent = selfMuted ? 'Unmute' : 'Mute';
  send({ type: 'status', muted: selfMuted });
  renderLamp();
});

$('leave-btn').addEventListener('click', () => leave());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock && wakeLock.released && !left) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
});
