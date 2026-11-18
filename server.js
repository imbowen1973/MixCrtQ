// MixCrtQ server.
//
// Serves the pages, relays WebRTC signalling, and hosts each room's mixer.
// The mixer runs in a headless browser on this machine (see engine.js), so
// every room laptop and every remote listener connects to the server and no
// laptop in the room carries the meeting. A controller page is only a view:
// it sends commands and receives meter levels.
//
// Four kinds of WebSocket client:
//   controller  a person running the room (room-create / controller-resume)
//   engine      the mixer page in the headless browser (host-resume)
//   mic         a laptop in the room (join, with the room code)
//   listener    a remote person (listen, with the listening code)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS || 32);
const MAX_LISTENERS = Number(process.env.MAX_LISTENERS || 20);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 3);
const ENGINE_GRACE_MS = Number(process.env.ENGINE_GRACE_MS || 60_000);
const IDLE_MS = Number(process.env.IDLE_MS || 30 * 60_000);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const CODE_LENGTH = 6;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Short-lived TURN credentials (the "TURN REST API" scheme that coturn
// implements as use-auth-secret): the username is an expiry timestamp and the
// password is an HMAC of it under a secret shared with the TURN server, so no
// long-lived relay password is ever published by /config.
function turnServer() {
  const urls = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
  const secret = process.env.TURN_SECRET;
  if (!urls.length || !secret) return null;
  const ttl = Number(process.env.TURN_TTL || 24 * 3600);
  const username = `${Math.floor(Date.now() / 1000) + ttl}:mixcrtq`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential };
}

function iceServers() {
  const turn = turnServer();
  if (turn) return [{ urls: 'stun:stun.l.google.com:19302' }, turn];
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch {
      console.error('ICE_SERVERS is not valid JSON; falling back to the default STUN server.');
    }
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function makeCode(taken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return name || 'Guest';
}

function cleanCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/**
 * @param {{ launchEngine?: (url: string) => Promise<{ close: () => Promise<void> | void }> }} options
 *   launchEngine opens the mixer page; tests replace it with a stub.
 */
export function createServer({ launchEngine } = {}) {
  const sessions = new Map(); // room code -> session
  // A second code per session admits remote listeners, who receive the room
  // mix but never send audio. It is distinct so that the audience cannot
  // join as a microphone.
  const listenCodes = new Map();
  const taken = (code) => sessions.has(code) || listenCodes.has(code);
  const peerList = (s) => [...s.peers.values()].map((p) => ({ id: p.id, name: p.name, kind: p.kind }));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/config') {
        res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          iceServers: iceServers(),
          iceTransportPolicy: process.env.ICE_POLICY === 'relay' ? 'relay' : 'all',
          hostKeyRequired: !!process.env.HOST_KEY,
        }));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      if (rel === '/host') rel = '/host.html';
      if (rel === '/join') rel = '/index.html';
      if (rel === '/listen') rel = '/listen.html';
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  function toControllers(session, msg) {
    for (const c of session.controllers) send(c, msg);
  }

  async function startEngine(session) {
    if (session.closed || !launchEngine) return;
    const port = server.address().port;
    // The token travels in the fragment, which is never sent in a request.
    const url = `http://127.0.0.1:${port}/mixer.html#code=${session.code}&token=${session.token}`;
    try {
      const handle = await launchEngine(url);
      if (session.closed) {
        await handle.close();
        return;
      }
      session.engine = handle;
      console.log(`Room ${session.code}: mixer started${session.restarts ? ` (restart ${session.restarts})` : ''}`);
    } catch (err) {
      if (session.closed) return; // the room was ended while its mixer was starting
      console.error(`Room ${session.code}: the mixer could not be started:`, err.message.split('\n')[0]);
      toControllers(session, {
        type: 'error',
        code: 'engine-failed',
        message: 'The mixer could not be started on the server: ' + err.message,
      });
    }
  }

  async function stopEngine(session) {
    const handle = session.engine;
    session.engine = null;
    if (handle) {
      try { await handle.close(); } catch { /* already gone */ }
    }
  }

  function closeSession(session, reason) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.graceTimer);
    clearTimeout(session.restartTimer);
    for (const peer of session.peers.values()) {
      send(peer.ws, { type: 'session-closed', reason });
      peer.ws.close();
    }
    for (const c of session.controllers) {
      send(c, { type: 'session-closed', reason });
      c.close();
    }
    if (session.host) session.host.close();
    sessions.delete(session.code);
    listenCodes.delete(session.listenCode);
    stopEngine(session);
    console.log(`Room ${session.code}: closed (${reason})`);
  }

  function controllerReady(ws, s) {
    send(ws, {
      type: 'controller-ready',
      code: s.code,
      listenCode: s.listenCode,
      controlToken: s.controlToken,
      engineOnline: !!s.host,
    });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let session = null;
    let role = null; // 'controller' | 'engine' | 'peer'
    let peerId = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      // ---- first message decides the role -------------------------------
      if (!role) {
        if (msg.type === 'room-create') {
          if (process.env.HOST_KEY && !sameSecret(msg.key, process.env.HOST_KEY)) {
            send(ws, { type: 'error', code: 'bad-key', message: 'That host key is not correct.' });
            return;
          }
          if (sessions.size >= MAX_ROOMS) {
            send(ws, { type: 'error', code: 'busy', message: 'The server is already running as many rooms as it allows.' });
            return;
          }
          const code = makeCode(taken);
          const s = {
            code,
            listenCode: null,
            token: randomBytes(16).toString('hex'), // held by the mixer engine
            controlToken: randomBytes(16).toString('hex'), // held by controllers
            host: null, // the engine's socket
            engine: null, // the engine's browser page
            controllers: new Set([ws]),
            peers: new Map(),
            graceTimer: null,
            restartTimer: null,
            restarts: 0,
            closed: false,
            idleSince: Date.now(),
          };
          sessions.set(code, s);
          s.listenCode = makeCode(taken);
          listenCodes.set(s.listenCode, s);
          session = s;
          role = 'controller';
          controllerReady(ws, s);
          startEngine(s);
          return;
        }
        if (msg.type === 'controller-resume') {
          const s = sessions.get(cleanCode(msg.code));
          if (!s || !sameSecret(msg.controlToken, s.controlToken)) {
            send(ws, { type: 'error', code: 'no-session', message: 'That room no longer exists.' });
            return;
          }
          s.controllers.add(ws);
          session = s;
          role = 'controller';
          controllerReady(ws, s);
          return;
        }
        if (msg.type === 'host-resume') {
          // the mixer engine, identifying itself with the token it was launched with
          const s = sessions.get(cleanCode(msg.code));
          if (!s || !sameSecret(msg.token, s.token)) {
            send(ws, { type: 'error', code: 'no-session', message: 'That session no longer exists.' });
            return;
          }
          if (s.host && s.host !== ws) s.host.close();
          clearTimeout(s.graceTimer);
          s.host = ws;
          session = s;
          role = 'engine';
          send(ws, { type: 'host-ready', code: s.code, listenCode: s.listenCode, peers: peerList(s) });
          for (const p of s.peers.values()) send(p.ws, { type: 'host-status', online: true });
          toControllers(s, { type: 'engine-status', online: true });
          return;
        }
        if (msg.type === 'join' || msg.type === 'listen') {
          // 'join' adds a room microphone; 'listen' adds a remote listener.
          const kind = msg.type === 'join' ? 'mic' : 'listener';
          const code = cleanCode(msg.code);
          const s = kind === 'mic' ? sessions.get(code) : listenCodes.get(code);
          if (!s) {
            const wrongDoor = kind === 'mic' ? listenCodes.has(code) : sessions.has(code);
            if (wrongDoor && kind === 'mic') {
              send(ws, { type: 'error', code: 'listen-code', message: 'That is a listening code. Opening the listening page.' });
            } else if (wrongDoor) {
              send(ws, { type: 'error', code: 'room-code', message: 'That code is for people in the room. Ask the host for the listening code.' });
            } else {
              send(ws, { type: 'error', code: 'no-session', message: 'No room with that code. Check it and try again.' });
            }
            return;
          }
          const count = [...s.peers.values()].filter((p) => p.kind === kind).length;
          if (count >= (kind === 'mic' ? MAX_PARTICIPANTS : MAX_LISTENERS)) {
            send(ws, { type: 'error', code: 'full', message: 'That room is full.' });
            return;
          }
          session = s;
          role = 'peer';
          peerId = randomBytes(6).toString('hex');
          const name = cleanName(msg.name);
          s.peers.set(peerId, { id: peerId, name, kind, ws });
          // Listeners are told only the code they used, never the room code.
          send(ws, { type: 'joined', id: peerId, name, kind, code, hostOnline: !!s.host });
          send(s.host, { type: 'peer-joined', id: peerId, name, kind });
          return;
        }
        return;
      }

      if (session.closed) return;

      // ---- relaying ------------------------------------------------------
      if (role === 'peer') {
        if (msg.type === 'signal') {
          send(session.host, { type: 'signal', from: peerId, data: msg.data });
        } else if (msg.type === 'status') {
          send(session.host, { type: 'peer-status', id: peerId, muted: !!msg.muted });
        }
        return;
      }

      if (role === 'controller') {
        if (msg.type === 'cmd' && typeof msg.action === 'string') {
          send(session.host, { type: 'cmd', action: msg.action, id: msg.id, value: msg.value });
        } else if (msg.type === 'end') {
          closeSession(session, 'ended');
        }
        return;
      }

      if (role === 'engine') {
        if (msg.type === 'deck') {
          // meter levels and state, for the controller's display
          toControllers(session, { type: 'deck', data: msg.data });
          return;
        }
        const target = session.peers.get(String(msg.to ?? ''));
        if (msg.type === 'signal' && target) {
          send(target.ws, { type: 'signal', data: msg.data });
        } else if (msg.type === 'state' && target) {
          // microphones learn whether they are live or muted by the host;
          // listeners learn whether the feed is muted for a remote speaker
          if (target.kind === 'listener') send(target.ws, { type: 'state', feedMuted: !!msg.feedMuted });
          else send(target.ws, { type: 'state', live: !!msg.live, hostMuted: !!msg.hostMuted });
        } else if (msg.type === 'remove' && target) {
          send(target.ws, { type: 'session-closed', reason: 'removed' });
          target.ws.close();
        }
      }
    });

    ws.on('close', () => {
      if (!session || session.closed) return;
      const s = session;
      if (role === 'peer') {
        if (s.peers.get(peerId)?.ws === ws) {
          s.peers.delete(peerId);
          send(s.host, { type: 'peer-left', id: peerId });
        }
      } else if (role === 'controller') {
        s.controllers.delete(ws);
      } else if (role === 'engine' && s.host === ws) {
        // The mixer went away (a crash, or the browser was killed). Tell
        // everyone, start a fresh one, and give up if it does not return.
        s.host = null;
        console.error(`Room ${s.code}: the mixer disconnected`);
        for (const p of s.peers.values()) send(p.ws, { type: 'host-status', online: false });
        toControllers(s, { type: 'engine-status', online: false });
        s.graceTimer = setTimeout(() => {
          if (!s.host) closeSession(s, 'engine-gone');
        }, ENGINE_GRACE_MS);
        if (s.restarts < 5) {
          s.restarts += 1;
          s.restartTimer = setTimeout(async () => {
            await stopEngine(s);
            startEngine(s);
          }, 1000);
        }
      }
      if (!s.controllers.size && !s.peers.size) s.idleSince = Date.now();
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    // A room nobody is using is closed, so that its mixer does not run for ever.
    for (const s of [...sessions.values()]) {
      if (s.controllers.size || s.peers.size) s.idleSince = Date.now();
      else if (Date.now() - s.idleSince > IDLE_MS) closeSession(s, 'idle');
    }
  }, 20_000);

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const s of [...sessions.values()]) closeSession(s, 'shutdown');
  });

  return { server, wss, sessions, listenCodes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { launchEngine, shutdownEngines } = await import('./engine.js');
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createServer({ launchEngine });
  server.listen(port, host, () => {
    console.log(`MixCrtQ listening on http://${host}:${port}`);
  });
  const stop = async () => {
    server.close();
    await shutdownEngines();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
