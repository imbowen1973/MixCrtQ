import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { createServer } from '../server.js';

// The real engine is a headless browser. Here it is replaced by a stub that
// records the page it was asked to open; the test then plays the engine's
// part over a plain socket, using the token from that address.
async function start() {
  const launches = [];
  const app = createServer({
    launchEngine: async (url) => {
      const handle = { url, closed: false, close: async () => { handle.closed = true; } };
      launches.push(handle);
      return handle;
    },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  return { ...app, launches, port, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
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

const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
};

/** Controller creates a room; the stub engine then connects as the mixer. */
async function room(app) {
  const controller = await client(app.wsUrl);
  controller.send({ type: 'room-create' });
  const ready = await controller.next();
  assert.equal(ready.type, 'controller-ready');
  await until(() => app.launches.length > 0);
  const launch = app.launches.at(-1);
  const frag = new URLSearchParams(new URL(launch.url).hash.slice(1));
  const engine = await client(app.wsUrl);
  engine.send({ type: 'host-resume', code: frag.get('code'), token: frag.get('token') });
  const hostReady = await engine.next();
  assert.equal(hostReady.type, 'host-ready');
  assert.deepEqual(await controller.next(), { type: 'engine-status', online: true });
  return { controller, engine, ready, launch, frag };
}

test('serves the pages and the ICE configuration', async () => {
  const app = await start();
  try {
    for (const p of ['/', '/host', '/join', '/listen', '/mixer.html', '/style.css', '/automix.js']) {
      const res = await fetch(app.base + p);
      assert.equal(res.status, 200, p);
    }
    const cfg = await (await fetch(app.base + '/config')).json();
    assert.ok(Array.isArray(cfg.iceServers));
    assert.equal(cfg.hostKeyRequired, false);
    assert.equal((await fetch(app.base + '/../server.js')).status, 404);
    assert.equal((await fetch(app.base + '/%2e%2e/server.js')).status, 404);
  } finally {
    await stop(app);
  }
});

test('creating a room starts a mixer on the server for it', async () => {
  const app = await start();
  try {
    const { ready, launch, frag } = await room(app);
    assert.match(ready.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.match(ready.listenCode, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.notEqual(ready.code, ready.listenCode);
    assert.equal(frag.get('code'), ready.code);
    assert.ok(new URL(launch.url).pathname.endsWith('/mixer.html'));
    assert.notEqual(frag.get('token'), ready.controlToken, 'the controller is not handed the engine token');
  } finally {
    await stop(app);
  }
});

test('a participant joins by code and name, and signalling relays to the mixer', async () => {
  const app = await start();
  try {
    const { engine, ready } = await room(app);

    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code.toLowerCase(), name: '  Ada Lovelace  ' });
    const joined = await peer.next();
    assert.equal(joined.type, 'joined');
    assert.equal(joined.name, 'Ada Lovelace');
    assert.deepEqual(await engine.next(), { type: 'peer-joined', id: joined.id, name: 'Ada Lovelace', kind: 'mic' });

    peer.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'x' } } });
    const offer = await engine.next();
    assert.equal(offer.from, joined.id);

    engine.send({ type: 'signal', to: joined.id, data: { description: { type: 'answer', sdp: 'y' } } });
    assert.equal((await peer.next()).data.description.type, 'answer');

    engine.send({ type: 'state', to: joined.id, live: true, hostMuted: false });
    assert.deepEqual(await peer.next(), { type: 'state', live: true, hostMuted: false });

    peer.send({ type: 'status', muted: true });
    assert.deepEqual(await engine.next(), { type: 'peer-status', id: joined.id, muted: true });

    peer.close();
    assert.deepEqual(await engine.next(), { type: 'peer-left', id: joined.id });
  } finally {
    await stop(app);
  }
});

test('commands flow from controller to mixer, and the deck flows back', async () => {
  const app = await start();
  try {
    const { controller, engine } = await room(app);
    controller.send({ type: 'cmd', action: 'mute', id: 'abc', value: true, extra: 'dropped' });
    assert.deepEqual(await engine.next(), { type: 'cmd', action: 'mute', id: 'abc', value: true });
    engine.send({ type: 'deck', data: { channels: [], listeners: [] } });
    assert.deepEqual(await controller.next(), { type: 'deck', data: { channels: [], listeners: [] } });
  } finally {
    await stop(app);
  }
});

test('a participant cannot send commands or pose as the mixer', async () => {
  const app = await start();
  try {
    const { engine, ready } = await room(app);
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Mallory' });
    await peer.next();
    await engine.next(); // peer-joined
    peer.send({ type: 'cmd', action: 'mute', id: 'x', value: true });
    peer.send({ type: 'status', muted: false });
    assert.equal((await engine.next()).type, 'peer-status', 'the command was not relayed');

    const fake = await client(app.wsUrl);
    fake.send({ type: 'host-resume', code: ready.code, token: 'wrong' });
    assert.equal((await fake.next()).type, 'error');
    fake.send({ type: 'controller-resume', code: ready.code, controlToken: 'wrong' });
    assert.equal((await fake.next()).type, 'error');
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
  } finally {
    await stop(app);
  }
});

test('the room outlives its controller, which can resume with its token', async () => {
  const app = await start();
  try {
    const { controller, engine, ready } = await room(app);
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Grace' });
    await peer.next();
    await engine.next();

    controller.close();
    await once(controller.ws, 'close');
    assert.equal(app.sessions.size, 1, 'closing the controller does not close the room');

    const again = await client(app.wsUrl);
    again.send({ type: 'controller-resume', code: ready.code, controlToken: ready.controlToken });
    const back = await again.next();
    assert.equal(back.type, 'controller-ready');
    assert.equal(back.engineOnline, true);
    assert.equal(back.listenCode, ready.listenCode);
  } finally {
    await stop(app);
  }
});

test('a mixer that dies is restarted, and everyone is told', async () => {
  const app = await start();
  try {
    const { controller, engine, ready } = await room(app);
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Alan' });
    const joined = await peer.next();
    await engine.next();

    engine.close();
    assert.deepEqual(await peer.next(), { type: 'host-status', online: false });
    assert.deepEqual(await controller.next(), { type: 'engine-status', online: false });
    await until(() => app.launches.length === 2);
    assert.equal(app.launches[0].closed, true, 'the dead page is cleaned up');

    const frag = new URLSearchParams(new URL(app.launches[1].url).hash.slice(1));
    const engine2 = await client(app.wsUrl);
    engine2.send({ type: 'host-resume', code: frag.get('code'), token: frag.get('token') });
    const hostReady = await engine2.next();
    assert.deepEqual(hostReady.peers, [{ id: joined.id, name: 'Alan', kind: 'mic' }]);
    assert.deepEqual(await peer.next(), { type: 'host-status', online: true });
    assert.deepEqual(await controller.next(), { type: 'engine-status', online: true });
  } finally {
    await stop(app);
  }
});

test('ending the room closes everyone and stops its mixer', async () => {
  const app = await start();
  try {
    const { controller, engine, ready, launch } = await room(app);
    const peer = await client(app.wsUrl);
    peer.send({ type: 'join', code: ready.code, name: 'Alan' });
    await peer.next();
    await engine.next();
    controller.send({ type: 'end' });
    assert.deepEqual(await peer.next(), { type: 'session-closed', reason: 'ended' });
    assert.deepEqual(await controller.next(), { type: 'session-closed', reason: 'ended' });
    await once(peer.ws, 'close');
    await until(() => launch.closed);
    assert.equal(app.sessions.size, 0);
    assert.equal(app.listenCodes.size, 0);
  } finally {
    await stop(app);
  }
});

test('listeners join with the separate listening code and cannot use the room code', async () => {
  const app = await start();
  try {
    const { engine, ready } = await room(app);

    const wrong = await client(app.wsUrl);
    wrong.send({ type: 'listen', code: ready.code, name: 'Eve' });
    assert.equal((await wrong.next()).code, 'room-code');
    wrong.send({ type: 'join', code: ready.listenCode, name: 'Eve' });
    assert.equal((await wrong.next()).code, 'listen-code');

    const listener = await client(app.wsUrl);
    listener.send({ type: 'listen', code: ready.listenCode, name: 'Remote Rita' });
    const joined = await listener.next();
    assert.equal(joined.kind, 'listener');
    assert.equal(joined.code, ready.listenCode, 'a listener is never told the room code');
    assert.deepEqual(await engine.next(), { type: 'peer-joined', id: joined.id, name: 'Remote Rita', kind: 'listener' });

    engine.send({ type: 'signal', to: joined.id, data: { description: { type: 'offer', sdp: 'x' } } });
    assert.equal((await listener.next()).data.description.type, 'offer');
    engine.send({ type: 'state', to: joined.id, feedMuted: true, live: true });
    assert.deepEqual(await listener.next(), { type: 'state', feedMuted: true });
  } finally {
    await stop(app);
  }
});

test('a host key, when set, is needed to create a room', async () => {
  process.env.HOST_KEY = 'open-sesame';
  const app = await start();
  try {
    assert.equal((await (await fetch(app.base + '/config')).json()).hostKeyRequired, true);
    const c = await client(app.wsUrl);
    c.send({ type: 'room-create', key: 'guess' });
    assert.equal((await c.next()).code, 'bad-key');
    assert.equal(app.launches.length, 0);
    c.send({ type: 'room-create', key: 'open-sesame' });
    assert.equal((await c.next()).type, 'controller-ready');
  } finally {
    delete process.env.HOST_KEY;
    await stop(app);
  }
});

test('issues short-lived TURN credentials when a relay is configured', async () => {
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
