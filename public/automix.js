// Gated automixer decision logic, free of any Web Audio dependency so that it
// can be unit tested under Node.
//
// The design is selection diversity, not coherent summation: laptops on
// independent clocks cannot be beamformed, so the mixer opens the channel
// that hears the current talker best and holds the rest at a closed-mic
// level. Each channel is scored by how far its level sits above its own
// tracked noise floor, which makes the choice indifferent to differences in
// microphone gain between laptops.

export const DEFAULTS = Object.freeze({
  threshold: 9, // dB above the channel's noise floor that counts as speech
  margin: 4, // dB by which a challenger must beat the live channel
  switchMs: 120, // how long the challenger must keep that lead
  attackMs: 10, // envelope attack time constant
  releaseMs: 250, // envelope release time constant
  floorFallMs: 150, // floor follows a falling envelope quickly
  floorRiseQuiet: 3, // dB per second while the channel is below threshold
  floorRiseLoud: 0.3, // dB per second while the channel is above threshold
  minDb: -100, // at or near this level the input is treated as digital silence
});

export class AutoMixer {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.channels = new Map();
    this.mode = 'auto'; // 'auto' | 'all'
    this.live = null;
    this._challenger = null;
    this._challengerSince = 0;
  }

  add(id) {
    if (!this.channels.has(id)) {
      this.channels.set(id, {
        id,
        env: null,
        floor: null,
        score: 0,
        muted: false,
        pinned: false,
        active: true, // false while the connection is down
      });
    }
    return this.channels.get(id);
  }

  remove(id) {
    this.channels.delete(id);
    if (this.live === id) this.live = null;
    if (this._challenger === id) this._challenger = null;
  }

  set(id, props) {
    const ch = this.channels.get(id);
    if (ch) Object.assign(ch, props);
  }

  /** Forget a channel's envelope and noise floor, for example after an unmute. */
  reset(id) {
    const ch = this.channels.get(id);
    if (ch) {
      ch.env = null;
      ch.floor = null;
      ch.score = 0;
    }
  }

  /** Feed one level measurement (dBFS RMS) covering dtMs of audio. */
  update(id, levelDb, dtMs) {
    const ch = this.channels.get(id);
    if (!ch) return;
    const o = this.opts;
    const db = Math.max(o.minDb, Number.isFinite(levelDb) ? levelDb : o.minDb);

    // Digital silence (a muted track, or a stream that has not started) says
    // nothing about the room's noise floor, so it must not drag the floor
    // down; otherwise the channel would win every selection after unmuting.
    if (db <= o.minDb + 5) {
      if (ch.env !== null) ch.env = db;
      ch.score = 0;
      return;
    }

    if (ch.env === null || ch.floor === null) {
      ch.env = db;
      ch.floor = db;
    } else {
      const tc = db > ch.env ? o.attackMs : o.releaseMs;
      ch.env += (db - ch.env) * (1 - Math.exp(-dtMs / tc));
    }

    if (ch.env < ch.floor) {
      ch.floor += (ch.env - ch.floor) * (1 - Math.exp(-dtMs / o.floorFallMs));
    } else {
      const rate = ch.env - ch.floor > o.threshold ? o.floorRiseLoud : o.floorRiseQuiet;
      ch.floor = Math.min(ch.env, ch.floor + (rate * dtMs) / 1000);
    }
    ch.score = ch.env - ch.floor;
  }

  _eligible(ch) {
    return ch.active && !ch.muted && ch.env !== null;
  }

  /**
   * Decide which channels are open at time nowMs.
   * Returns { live, open } where open is a Set of channel ids.
   */
  tick(nowMs) {
    const o = this.opts;
    const open = new Set();
    const eligible = [...this.channels.values()].filter((ch) => this._eligible(ch));

    if (this.mode === 'all') {
      for (const ch of eligible) open.add(ch.id);
      this.live = null;
      this._challenger = null;
      return { live: null, open };
    }

    let live = this.channels.get(this.live);
    if (live && !this._eligible(live)) live = null;

    let best = null;
    for (const ch of eligible) {
      if (ch.score > o.threshold && (!best || ch.score > best.score)) best = ch;
    }

    if (!live) {
      // Nothing is live: take the best talker, or failing that keep one
      // microphone open so that the room never goes acoustically dead.
      live = best || eligible[0] || null;
      this._challenger = null;
    } else if (best && best !== live && best.score > live.score + o.margin) {
      if (this._challenger !== best.id) {
        this._challenger = best.id;
        this._challengerSince = nowMs;
      } else if (nowMs - this._challengerSince >= o.switchMs) {
        live = best;
        this._challenger = null;
      }
    } else {
      this._challenger = null;
    }

    this.live = live ? live.id : null;
    if (live) open.add(live.id);
    for (const ch of eligible) if (ch.pinned) open.add(ch.id);
    return { live: this.live, open };
  }
}

export function rmsToDb(rms) {
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100;
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}
