import { Resampler } from './resampler.js';

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate);
    this.pending = new Float32Array(512);
    this.used = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (const v of this.resampler.push(input)) {
        this.pending[this.used++] = v;
        if (this.used === 512) {
          this.port.postMessage(this.pending, [this.pending.buffer]);
          this.pending = new Float32Array(512);
          this.used = 0;
        }
      }
    }
    // Outputs remain silent: microphone audio must never feed the loudspeaker.
    return true;
  }
}
registerProcessor('rb-capture', Capture);
