import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoMixer } from '../public/automix.js';

const STEP = 20; // ms per measurement

/** Run the mixer for durationMs with fixed levels per channel; returns live ids over time. */
function run(mixer, clock, levels, durationMs) {
  const history = [];
  for (let t = 0; t < durationMs; t += STEP) {
    clock.now += STEP;
    for (const [id, db] of Object.entries(levels)) mixer.update(id, db, STEP);
    history.push(mixer.tick(clock.now).live);
  }
  return history;
}

function setup(ids) {
  const mixer = new AutoMixer();
  for (const id of ids) mixer.add(id);
  return { mixer, clock: { now: 0 } };
}

test('keeps one microphone open when the room is silent', () => {
  const { mixer, clock } = setup(['a', 'b']);
  const h = run(mixer, clock, { a: -60, b: -60 }, 2000);
  assert.ok(h.at(-1) === 'a' || h.at(-1) === 'b');
  assert.equal(new Set(h.slice(10)).size, 1, 'the open microphone should not wander in silence');
});

test('opens the channel nearest the talker', () => {
  const { mixer, clock } = setup(['a', 'b', 'c']);
  run(mixer, clock, { a: -60, b: -60, c: -60 }, 1000);
  const h = run(mixer, clock, { a: -45, b: -25, c: -50 }, 500);
  assert.equal(h.at(-1), 'b');
});

test('is indifferent to differences in microphone gain', () => {
  // Channel a is 20 dB hotter overall. The talker is near b: b rises 30 dB
  // above its floor, a only 12 dB, although a is still louder in absolute terms.
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -40, b: -60 }, 1500);
  const h = run(mixer, clock, { a: -28, b: -30 }, 500);
  assert.equal(h.at(-1), 'b');
});

test('does not switch on a brief interjection', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  run(mixer, clock, { a: -25, b: -55 }, 600);
  assert.equal(mixer.live, 'a');
  // b leads for 60 ms only, less than switchMs
  const h = run(mixer, clock, { a: -60, b: -20 }, 60);
  assert.equal(h.at(-1), 'a');
});

test('hands over when another talker takes the floor', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  run(mixer, clock, { a: -25, b: -55 }, 600);
  const h = run(mixer, clock, { a: -58, b: -25 }, 800);
  assert.equal(h.at(-1), 'b');
});

test('needs a clear lead between two similar channels', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  run(mixer, clock, { a: -30, b: -45 }, 400);
  assert.equal(mixer.live, 'a');
  // b now 2 dB better than a: inside the 4 dB margin, so no switch
  const h = run(mixer, clock, { a: -30, b: -28 }, 600);
  assert.equal(h.at(-1), 'a');
});

test('never selects a muted or disconnected channel', () => {
  const { mixer, clock } = setup(['a', 'b', 'c']);
  run(mixer, clock, { a: -60, b: -60, c: -60 }, 1000);
  mixer.set('b', { muted: true });
  mixer.set('c', { active: false });
  const h = run(mixer, clock, { a: -55, b: -20, c: -20 }, 600);
  assert.ok(h.every((id) => id === 'a'));
});

test('pinned channels stay open alongside the live one', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  mixer.set('b', { pinned: true });
  run(mixer, clock, { a: -25, b: -60 }, 400);
  const { live, open } = mixer.tick(clock.now);
  assert.equal(live, 'a');
  assert.deepEqual([...open].sort(), ['a', 'b']);
});

test('all-open mode opens every eligible channel', () => {
  const { mixer, clock } = setup(['a', 'b', 'c']);
  mixer.mode = 'all';
  mixer.set('c', { muted: true });
  run(mixer, clock, { a: -60, b: -60, c: -60 }, 200);
  const { open } = mixer.tick(clock.now);
  assert.deepEqual([...open].sort(), ['a', 'b']);
});

test('digital silence does not corrupt the noise floor', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  // b mutes at source (digital silence) for five seconds, then unmutes into
  // the same room noise while a talks.
  run(mixer, clock, { a: -60, b: -100 }, 5000);
  const h = run(mixer, clock, { a: -30, b: -58 }, 600);
  assert.equal(h.at(-1), 'a');
});

test('adapts when the room noise rises', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -60, b: -60 }, 1000);
  // a projector starts beside a: its floor jumps 12 dB and stays there
  run(mixer, clock, { a: -48, b: -60 }, 60_000);
  const h = run(mixer, clock, { a: -46, b: -35 }, 600);
  assert.equal(h.at(-1), 'b', 'steady noise must not hold the floor against a real talker');
});

test('removing the live channel releases it', () => {
  const { mixer, clock } = setup(['a', 'b']);
  run(mixer, clock, { a: -30, b: -60 }, 600);
  mixer.remove('a');
  const h = run(mixer, clock, { b: -60 }, 100);
  assert.equal(h.at(-1), 'b');
});
