// Seeded, reproducible AWGN. SNR is relative to active signal power, not padded silence.
export function noiseChannel(input, { snr = Infinity, seed = 12345, gain = 1 } = {}) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 1) / 4294967297; };
  const active = input.filter(v => Math.abs(v) > 1e-8);
  const power = active.reduce((sum, v) => sum + v * v, 0) / Math.max(1, active.length);
  const sigma = Math.sqrt(power / 10 ** (snr / 10));
  return Float32Array.from(input, v => gain * (v + sigma * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())));
}
