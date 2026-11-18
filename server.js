// MixCrtQ signalling server.
//
// Serves the static pages and relays WebRTC signalling between one host
// (the laptop that feeds the conferencing client) and the participants in
// the same room. No audio passes through this process: media flows peer to
// peer between each participant and the host.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS || 16);
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS || 60_000);
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

function makeCode(sessions) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!sessions.has(code)) return code;
  }
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return name || 'Guest';
}

function cleanCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function createServer() {
  /** @type {Map<string, {code:string, token:string, host:any, peers:Map<string, {id:string,name:string,ws:any}>, timer:any}>} */
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/config') {
        res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          iceServers: iceServers(),
          iceTransportPolicy: process.env.ICE_POLICY === 'relay' ? 'relay' : 'all',
        }));
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

  function closeSession(session, reason) {
    clearTimeout(session.timer);
    for (const peer of session.peers.values()) {
      send(peer.ws, { type: 'session-closed', reason });
      peer.ws.close();
    }
    sessions.delete(session.code);
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    /** role state for this socket */
    let session = null;
    let role = null; // 'host' | 'peer'
    let peerId = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      // ---- joining -------------------------------------------------------
      if (!role) {
        if (msg.type === 'host-create') {
          const code = makeCode(sessions);
          session = { code, token: randomBytes(16).toString('hex'), host: ws, peers: new Map(), timer: null };
          sessions.set(code, session);
          role = 'host';
          send(ws, { type: 'host-ready', code, token: session.token, peers: [] });
          return;
        }
        if (msg.type === 'host-resume') {
          const s = sessions.get(cleanCode(msg.code));
          if (!s || s.token !== msg.token) {
            send(ws, { type: 'error', code: 'no-session', message: 'That session no longer exists.' });
            return;
          }
          if (s.host && s.host !== ws) s.host.close();
          clearTimeout(s.timer);
          s.host = ws;
          session = s;
          role = 'host';
          send(ws, {
            type: 'host-ready',
            code: s.code,
            token: s.token,
            peers: [...s.peers.values()].map((p) => ({ id: p.id, name: p.name })),
          });
          for (const p of s.peers.values()) send(p.ws, { type: 'host-status', online: true });
          return;
        }
        if (msg.type === 'join') {
          const s = sessions.get(cleanCode(msg.code));
          if (!s) {
            send(ws, { type: 'error', code: 'no-session', message: 'No room with that code. Check it and try again.' });
            return;
          }
          if (s.peers.size >= MAX_PARTICIPANTS) {
            send(ws, { type: 'error', code: 'full', message: 'That room is full.' });
            return;
          }
          session = s;
          role = 'peer';
          peerId = randomBytes(6).toString('hex');
          const name = cleanName(msg.name);
          s.peers.set(peerId, { id: peerId, name, ws });
          send(ws, { type: 'joined', id: peerId, name, code: s.code, hostOnline: !!s.host });
          send(s.host, { type: 'peer-joined', id: peerId, name });
          return;
        }
        return;
      }

      // ---- relaying ------------------------------------------------------
      if (role === 'peer') {
        if (msg.type === 'signal') {
          send(session.host, { type: 'signal', from: peerId, data: msg.data });
        } else if (msg.type === 'status') {
          // self-mute and similar, shown on the host's deck
          send(session.host, { type: 'peer-status', id: peerId, muted: !!msg.muted });
        }
        return;
      }

      if (role === 'host') {
        const target = session.peers.get(String(msg.to ?? ''));
        if (msg.type === 'signal' && target) {
          send(target.ws, { type: 'signal', data: msg.data });
        } else if (msg.type === 'state' && target) {
          // tells a participant whether they are live and whether the host muted them
          send(target.ws, { type: 'state', live: !!msg.live, hostMuted: !!msg.hostMuted });
        } else if (msg.type === 'remove' && target) {
          send(target.ws, { type: 'session-closed', reason: 'removed' });
          target.ws.close();
        } else if (msg.type === 'end') {
          closeSession(session, 'ended');
          ws.close();
        }
      }
    });

    ws.on('close', () => {
      if (!session) return;
      if (role === 'peer') {
        if (session.peers.get(peerId)?.ws === ws) {
          session.peers.delete(peerId);
          send(session.host, { type: 'peer-left', id: peerId });
        }
      } else if (role === 'host' && session.host === ws) {
        session.host = null;
        for (const p of session.peers.values()) send(p.ws, { type: 'host-status', online: false });
        const s = session;
        s.timer = setTimeout(() => {
          if (!s.host && sessions.get(s.code) === s) closeSession(s, 'host-gone');
        }, HOST_GRACE_MS);
      }
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
  }, 20_000);

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const s of sessions.values()) clearTimeout(s.timer);
  });

  return { server, wss, sessions };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createServer();
  server.listen(port, host, () => {
    console.log(`MixCrtQ listening on http://${host}:${port}`);
  });
}
