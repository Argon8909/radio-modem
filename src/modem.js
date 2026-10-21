import { HEADER_BYTES, decodePacket, packetLength } from './packet.js';

export const PROFILE = Object.freeze({ rate: 8000, baud: 25, samples: 320, tones: [1200, 1250, 1300, 1350] });
// Balanced, nonrepeating training sequence; all four tones establish absolute tone identity.
export const PREAMBLE = Uint8Array.from([0, 3, 1, 0, 2, 1, 3, 2, 0, 1, 2, 3, 1, 3, 0, 2, 3, 2, 1, 0, 2, 0, 3, 1]);
export const SYNC = bytesToSymbols(Uint8Array.from([0xd3, 0x91, 0xc5, 0xa7]));
const N = PROFILE.samples;
const HOP = 80;
const GRID = 12.5;
const MIN_F = 900;
const BINS = 61;

export function bytesToSymbols(bytes) {
  const out = new Uint8Array(bytes.length * 4);
  for (let i = 0; i < bytes.length; i++) for (let s = 0; s < 4; s++) out[i * 4 + s] = (bytes[i] >>> (6 - 2 * s)) & 3;
  return out;
}

export function duration(bytes) { return 0.27 + (PREAMBLE.length + SYNC.length + bytes.length * 4) / PROFILE.baud; }

export function modulate(bytes, { offset = 0, drift = 0, amplitude = 0.65, delay = 0.15, tail = 0.12, rate = PROFILE.rate } = {}) {
  const symbols = Uint8Array.from([...PREAMBLE, ...SYNC, ...bytesToSymbols(bytes)]);
  const lead = Math.round(delay * rate);
  const count = Math.round(symbols.length * rate / PROFILE.baud);
  const out = new Float32Array(lead + count + Math.round(tail * rate));
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const symbol = symbols[Math.min(symbols.length - 1, Math.floor(i * PROFILE.baud / rate))];
    const f = PROFILE.tones[symbol] + offset + drift * i / rate;
    const ramp = Math.min(1, i / (rate * 0.005), (count - 1 - i) / (rate * 0.005));
    out[lead + i] = amplitude * ramp * Math.sin(phase);
    phase = (phase + 2 * Math.PI * f / rate) % (2 * Math.PI);
  }
  return out;
}

// Goertzel with an arbitrary (not integer FFT-bin) analysis frequency.
function energy(read, start, frequency) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / PROFILE.rate);
  let a = 0, b = 0;
  for (let i = 0; i < N; i++) { const v = read(start + i) + k * a - b; b = a; a = v; }
  return Math.max(0, a * a + b * b - k * a * b);
}

export class Receiver {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.buffer = new Float32Array(32768);
    this.read = (index) => this.buffer[Math.floor(index) & 32767];
    this.total = 0;
    this.next = 0;
    this.columns = [];
    this.lock = null;
    this.lastDiagnostic = 0;
  }

  push(samples) {
    // Process bounded chunks even if the caller supplies a complete recording.
    for (let p = 0; p < samples.length; p += 512) {
      const end = Math.min(samples.length, p + 512);
      for (let j = p; j < end; j++) this.buffer[this.total++ & 32767] = samples[j];
      this.process();
    }
  }

  process() {
    while (true) {
      if (this.lock) {
        if (this.lock.cursor + N + 16 > this.total) break;
        this.receiveSymbol();
      } else {
        if (this.next + N > this.total) break;
        this.search();
        this.next += HOP;
      }
    }
    if (this.total - this.lastDiagnostic >= 4000) {
      this.lastDiagnostic = this.total;
      let sum = 0;
      for (let i = this.total - Math.min(512, this.total); i < this.total; i++) sum += this.read(i) ** 2;
      this.onEvent({ type: 'level', rms: Math.sqrt(sum / Math.min(512, this.total)), offset: this.lock?.offset ?? null });
    }
  }

  search() {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += this.read(this.next + i) ** 2;
    const powers = new Float32Array(BINS);
    if (sum > 1e-10) for (let b = 0; b < BINS; b++) powers[b] = energy(this.read, this.next, MIN_F + b * GRID) / (N * sum);
    this.columns.push({ start: this.next, powers });
    const span = (PREAMBLE.length - 1) * 4 + 1;
    if (this.columns.length > span) this.columns.shift();
    if (this.columns.length < span) return;
    let best = null;
    for (let shift = 0; shift <= 48; shift++) {
      let score = 0, strength = 0, hits = 0;
      for (let s = 0; s < PREAMBLE.length; s++) {
        const ps = this.columns[s * 4].powers;
        let total = 1e-20, max = -1, which = -1;
        for (let tone = 0; tone < 4; tone++) {
          const v = ps[shift + tone * 4]; total += v;
          if (v > max) { max = v; which = tone; }
        }
        const wanted = ps[shift + PREAMBLE[s] * 4];
        score += wanted / total;
        strength += wanted;
        if (which === PREAMBLE[s]) hits++;
      }
      if (hits >= 22 && score / PREAMBLE.length > 0.72 && strength / PREAMBLE.length > 0.12 && (!best || strength > best.strength)) best = { offset: -300 + shift * GRID, strength };
    }
    if (!best) return;
    let start = this.columns[0].start;
    let offset = best.offset;
    let peak = -Infinity;
    // Refine timing and frequency independently of stream/chunk boundaries.
    for (let dt = -HOP; dt <= HOP; dt += 8) {
      const candidate = start + dt;
      if (candidate < 0 || candidate + PREAMBLE.length * N > this.total) continue;
      for (let df = -6.25; df <= 6.25; df += 3.125) {
        let score = 0;
        for (let s = 0; s < PREAMBLE.length; s++) score += energy(this.read, candidate + s * N, PROFILE.tones[PREAMBLE[s]] + best.offset + df);
        if (score > peak) { peak = score; offset = best.offset + df; best.start = candidate; }
      }
    }
    start = best.start ?? start;
    this.lock = { cursor: start + PREAMBLE.length * N, offset, sync: [], symbols: [], bytes: [], expected: null, previous: null };
    this.onEvent({ type: 'sync', offset, start });
    this.columns = [];
  }

  receiveSymbol() {
    const lock = this.lock;
    const powers = PROFILE.tones.map(f => energy(this.read, lock.cursor, f + lock.offset));
    const symbol = powers.indexOf(Math.max(...powers));
    const f = PROFILE.tones[symbol] + lock.offset;
    const center = powers[symbol];
    const left = energy(this.read, lock.cursor, f - 6.25);
    const right = energy(this.read, lock.cursor, f + 6.25);
    const curve = left - 2 * center + right;
    if (curve < -1e-9) lock.offset += Math.max(-1, Math.min(1, 0.18 * 3.125 * (left - right) / curve));

    // Early/late timing correction at tone transitions; bounded to one sample/symbol.
    if (lock.previous !== null && lock.previous !== symbol) {
      const measure = (dt) => energy(this.read, lock.cursor + dt, f) + energy(this.read, lock.cursor - N + dt, PROFILE.tones[lock.previous] + lock.offset);
      const early = measure(-8), on = measure(0), late = measure(8);
      const bend = early - 2 * on + late;
      if (bend < -1e-9) lock.cursor += Math.max(-1, Math.min(1, 0.15 * 4 * (early - late) / bend));
    }
    lock.previous = symbol;
    lock.cursor += N;
    if (lock.sync.length < SYNC.length) {
      lock.sync.push(symbol);
      if (symbol !== SYNC[lock.sync.length - 1]) this.reset('Не совпало синхрослово.');
      return;
    }
    lock.symbols.push(symbol);
    if (lock.symbols.length !== 4) return;
    lock.bytes.push(lock.symbols.reduce((value, s) => (value << 2) | s, 0));
    lock.symbols = [];
    try {
      if (lock.bytes.length === HEADER_BYTES) lock.expected = packetLength(lock.bytes);
      if (lock.expected && lock.bytes.length === lock.expected) {
        const packet = decodePacket(Uint8Array.from(lock.bytes));
        this.onEvent({ type: 'packet', packet, offset: lock.offset });
        this.reset();
      }
    } catch (error) { this.reset(error.message); }
  }

  reset(error) {
    if (error) this.onEvent({ type: 'error', message: error });
    this.next = Math.max(this.next, Math.floor(this.lock?.cursor ?? this.total));
    this.lock = null;
    this.columns = [];
    this.onEvent({ type: 'search' });
  }
}
