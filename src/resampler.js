// Streaming windowed-sinc low-pass resampler. 63 taps, 128 fractional phases.
// Input clock differences are preserved: frequency AFC and timing tracking handle them.
export class Resampler {
  constructor(inputRate, outputRate = 8000) {
    this.ratio = inputRate / outputRate;
    this.buffer = new Float32Array(8192);
    this.count = 0;
    this.position = 31;
    const cutoff = 0.45 * Math.min(1, outputRate / inputRate);
    this.filters = Array.from({ length: 128 }, (_, phase) => {
      const taps = new Float64Array(63);
      let sum = 0;
      for (let k = 0; k < 63; k++) {
        const t = k - 31 - phase / 128;
        const sinc = Math.abs(t) < 1e-10 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
        const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / 62) + 0.08 * Math.cos(4 * Math.PI * k / 62);
        taps[k] = sinc * window;
        sum += taps[k];
      }
      return taps.map(v => v / sum);
    });
  }

  push(input) {
    const out = [];
    for (const v of input) {
      this.buffer[this.count++ & 8191] = v;
      while (Math.floor(this.position) + 31 < this.count) {
        const base = Math.floor(this.position);
        const taps = this.filters[Math.min(127, Math.floor((this.position - base) * 128))];
        let sample = 0;
        for (let k = 0; k < 63; k++) sample += this.buffer[(base - 31 + k) & 8191] * taps[k];
        out.push(sample);
        this.position += this.ratio;
      }
    }
    return Float32Array.from(out);
  }
}
