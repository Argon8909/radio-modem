import { encodePacket } from '../src/packet.js';
import { modulate, Receiver } from '../src/modem.js';
import { noiseChannel } from '../src/channel.js';
const offsets = [0, -10, 10, -25, 25, -50, 50, -80, 80, -150, 150, -300, 300];
const text = 'Привет, эфир!';
const bytes = encodePacket(text, { id: 42 });
console.log('AWGN 10 dB relative to active signal power at 8 kHz; 8 fixed seeds per offset.');
const results = [];
for (const offset of offsets) {
  let detected = 0, decoded = 0, errors = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rx = new Receiver(event => {
      if (event.type === 'sync') detected++;
      if (event.type === 'packet' && event.packet.text === text) { decoded++; errors += Math.abs(event.offset - offset); }
    });
    rx.push(noiseChannel(modulate(bytes, { offset, delay: 0.15 + seed * 0.0037 }), { snr: 10, seed }));
  }
  results.push({ offset_Hz: offset, detected, decoded, trials: 8, PER: 1 - decoded / 8, mean_AFC_error_Hz: decoded ? +(errors / decoded).toFixed(3) : null });
}
console.table(results);
if (results.some(r => r.decoded !== r.trials)) process.exitCode = 1;
