import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../server.js';

async function start() {
  const app = createServer();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  return { ...app, port, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

async function stop(app) {
  for (const c of app.wss.clients) c.terminate();
  app.wss.close();
  app.server.close();
  await once(app.server, 'close');
}

/** A socket with a queue, so that no message is lost between awaits. */
async function client(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  await once(ws, 'open');
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    close: () => ws.close(),
  };
}

test('serves the pages and the ICE configuration', async () => {
  const app = await start();
  try {
    for (const p of ['/', '/host', '/join', '/listen', '/style.css', '/automix.js']) {
      const res = await fetch(app.base + p);
      assert.equal(res.status, 200, p);
    }
    const cfg = await (await fetch(app.base + '/config')).json();
    assert.ok(Array.isArray(cfg.iceServers));
    assert.equal((await fetch(app.base + '/../server.js')).status, 404);
    assert.equal((await fetch(app.base + '/%2e%2e/server.js')).status, 404);
  } finally {
    await stop(app);
  }
});

test('host creates a session, a participant joins by code and name, signalling relays', async () => {
  const app = await start();
  try {
    const host = await client(app.wsUrl);
    host.send({ type: 'host-create' });
    const ready = await host.next();
    assert.equal(ready.type, 'host-ready');
    assert.match(ready.code, /^[A-HJ-NP-Z2-9]{6}$/);

    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code.toLowerCase(), name: '  Ada Lovelace  ' });
    const joined = await peer.next();
    assert.equal(joined.type, 'joined');
    assert.equal(joined.name, 'Ada Lovelace');

    const pj = await host.next();
    assert.deepEqual(pj, { type: 'peer-joined', id: joined.id, name: 'Ada Lovelace', kind: 'mic' });

    peer.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'x' } } });
    const offer = await host.next();
    assert.equal(offer.from, joined.id);
    assert.equal(offer.data.description.type, 'offer');

    host.send({ type: 'signal', to: joined.id, data: { description: { type: 'answer', sdp: 'y' } } });
    assert.equal((await peer.next()).data.description.type, 'answer');

    host.send({ type: 'state', to: joined.id, live: true, hostMuted: false });
    assert.deepEqual(await peer.next(), { type: 'state', live: true, hostMuted: false });

    peer.send({ type: 'status', muted: true });
    assert.deepEqual(await host.next(), { type: 'peer-status', id: joined.id, muted: true });

    peer.close();
    assert.deepEqual(await host.next(), { type: 'peer-left', id: joined.id });
    host.close();
  } finally {
    await stop(app);
  }
});

test('rejects an unknown code', async () => {
  const app = await start();
  try {
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: 'ZZZZZZ', name: 'Nobody' });
    const msg = await peer.next();
    assert.equal(msg.type, 'error');
    assert.equal(msg.code, 'no-session');
    peer.close();
  } finally {
    await stop(app);
  }
});

test('host can resume with its token, and not without it', async () => {
  const app = await start();
  try {
    const host = await client(app.wsUrl);
    host.send({ type: 'host-create' });
    const ready = await host.next();

    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Grace' });
    const joined = await peer.next();
    await host.next(); // peer-joined

    host.close();
    assert.deepEqual(await peer.next(), { type: 'host-status', online: false });

    const thief = await client(app.wsUrl);
    thief.send({ type: 'host-resume', code: ready.code, token: 'wrong' });
    assert.equal((await thief.next()).type, 'error');
    thief.close();

    const host2 = await client(app.wsUrl);
    host2.send({ type: 'host-resume', code: ready.code, token: ready.token });
    const again = await host2.next();
    assert.equal(again.type, 'host-ready');
    assert.deepEqual(again.peers, [{ id: joined.id, name: 'Grace', kind: 'mic' }]);
    assert.deepEqual(await peer.next(), { type: 'host-status', online: true });
    host2.close();
    peer.close();
  } finally {
    await stop(app);
  }
});

test('ending the room closes every participant', async () => {
  const app = await start();
  try {
    const host = await client(app.wsUrl);
    host.send({ type: 'host-create' });
    const ready = await host.next();
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Alan' });
    await peer.next();
    await host.next();
    host.send({ type: 'end' });
    assert.deepEqual(await peer.next(), { type: 'session-closed', reason: 'ended' });
    await once(peer.ws, 'close');
    assert.equal(app.sessions.size, 0);
  } finally {
    await stop(app);
  }
});

test('issues short-lived TURN credentials when a relay is configured', async () => {
  const { createHmac } = await import('node:crypto');
  process.env.TURN_URLS = 'turn:turn.example.org:3478?transport=udp, turns:turn.example.org:443?transport=tcp';
  process.env.TURN_SECRET = 'test-secret';
  process.env.ICE_POLICY = 'relay';
  const app = await start();
  try {
    const cfg = await (await fetch(app.base + '/config')).json();
    assert.equal(cfg.iceTransportPolicy, 'relay');
    const turn = cfg.iceServers.find((s) => s.username);
    assert.deepEqual(turn.urls, ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp']);
    const expiry = Number(turn.username.split(':')[0]);
    assert.ok(expiry > Date.now() / 1000 + 3600, 'credentials should outlast a meeting');
    assert.equal(turn.credential, createHmac('sha1', 'test-secret').update(turn.username).digest('base64'));
  } finally {
    delete process.env.TURN_URLS;
    delete process.env.TURN_SECRET;
    delete process.env.ICE_POLICY;
    await stop(app);
  }
});

test('listeners join with the separate listening code and cannot use the room code', async () => {
  const app = await start();
  try {
    const host = await client(app.wsUrl);
    host.send({ type: 'host-create' });
    const ready = await host.next();
    assert.match(ready.listenCode, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.notEqual(ready.listenCode, ready.code);

    const wrong = await client(app.wsUrl);
    wrong.send({ type: 'listen', code: ready.code, name: 'Eve' });
    assert.equal((await wrong.next()).code, 'room-code');
    wrong.send({ type: 'join', code: ready.listenCode, name: 'Eve' });
    assert.equal((await wrong.next()).code, 'listen-code');
    wrong.close();

    const listener = await client(app.wsUrl);
    listener.send({ type: 'listen', code: ready.listenCode, name: 'Remote Rita' });
    const joined = await listener.next();
    assert.equal(joined.kind, 'listener');
    assert.equal(joined.code, ready.listenCode, 'a listener is never told the room code');
    assert.deepEqual(await host.next(), { type: 'peer-joined', id: joined.id, name: 'Remote Rita', kind: 'listener' });

    host.send({ type: 'signal', to: joined.id, data: { description: { type: 'offer', sdp: 'x' } } });
    assert.equal((await listener.next()).data.description.type, 'offer');
    host.send({ type: 'state', to: joined.id, feedMuted: true, live: true });
    assert.deepEqual(await listener.next(), { type: 'state', feedMuted: true });

    host.send({ type: 'end' });
    assert.equal((await listener.next()).type, 'session-closed');
    await once(listener.ws, 'close');
    assert.equal(app.listenCodes.size, 0);
  } finally {
    await stop(app);
  }
});
