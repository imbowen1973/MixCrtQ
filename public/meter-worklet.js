// Posts the RMS and peak of its input roughly every 21 ms (8 render quanta
// at 48 kHz). The host page drives the automixer from these messages rather
// than from timers, because timers are throttled when the tab is in the
// background and the tab will usually sit behind the conferencing client.

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.peak = 0;
    this.count = 0;
    this.blocks = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const s = channel[i];
        this.sum += s * s;
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
      }
      this.count += channel.length;
    } else {
      this.count += 128;
    }
    if (++this.blocks >= 8) {
      this.port.postMessage({
        rms: Math.sqrt(this.sum / Math.max(1, this.count)),
        peak: this.peak,
        ms: (this.count / sampleRate) * 1000,
      });
      this.sum = 0;
      this.peak = 0;
      this.count = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('meter', MeterProcessor);
