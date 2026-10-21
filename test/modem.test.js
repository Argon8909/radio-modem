import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, encodePacket, decodePacket, MAX_BYTES } from '../src/packet.js';
import { modulate, Receiver } from '../src/modem.js';
import { noiseChannel } from '../src/channel.js';
import { Resampler } from '../src/resampler.js';
import { readFile } from 'node:fs/promises';

test('committed packet reference vector', async () => {
  const vector = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url), 'utf8')).packet;
  assert.equal(Buffer.from(encodePacket(vector.text, vector)).toString('hex'), vector.hex);
});

function receive(signal, chunk = 997) {
  const events = [];
  const rx = new Receiver(event => events.push(event));
  for (let i = 0; i < signal.length; i += chunk) rx.push(signal.subarray(i, i + chunk));
  return events;
}
const packets = events => events.filter(e => e.type === 'packet');

test('CRC published check vector, UTF-8 and packet validation', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1);
  const bytes = encodePacket('Привет 👋', { from: 'FIELD', to: 'BASE', id: 513 });
  assert.deepEqual(decodePacket(bytes), { from: 'FIELD', to: 'BASE', id: 513, text: 'Привет 👋' });
  bytes[10] ^= 1;
  assert.throws(() => decodePacket(bytes), /CRC/);
  assert.throws(() => encodePacket('я'.repeat(49)), /байт/);
  assert.throws(() => encodePacket(''), /байт/);
});

for (const offset of [0, -10, 10, -25, 25, -50, 50, -80, 80, -150, 150, -300, 300]) {
  test(`stream RX: unknown offset ${offset} Hz, unknown onset, UTF-8`, () => {
    const bytes = encodePacket('Привет, эфир!', { id: 42 });
    const events = receive(modulate(bytes, { offset, delay: 0.173125 }));
    const received = packets(events);
    assert.equal(received.length, 1, JSON.stringify(events.filter(e => e.type !== 'level')));
    assert.equal(received[0].packet.text, 'Привет, эфир!');
    assert.ok(Math.abs(received[0].offset - offset) < 5, `offset=${received[0].offset}`);
  });
}

test('seeded 10 dB AWGN, gain 0.08, fractional-grid frequency offset', () => {
  for (const seed of [7, 42, 2026]) {
    const bytes = encodePacket('Тест 123');
    const events = receive(noiseChannel(modulate(bytes, { offset: 83.7, delay: 0.187 }), { snr: 10, gain: 0.08, seed }));
    assert.equal(packets(events)[0]?.packet.text, 'Тест 123', `seed ${seed}`);
  }
});

test('maximum payload, ±200 ppm device clock error and ±0.5 Hz/s drift', () => {
  for (const sign of [-1, 1]) {
    const text = 'a'.repeat(MAX_BYTES);
    const signal = modulate(encodePacket(text), { rate: 8000 * (1 + sign * 200e-6), offset: 80, drift: sign * 0.5, delay: 0.193 });
    assert.equal(packets(receive(signal))[0]?.packet.text, text);
  }
});

test('44.1 and 48 kHz capture resampling, arbitrary audio chunks', () => {
  for (const rate of [44100, 48000]) {
    const signal = modulate(encodePacket('Android ↔ ноутбук'), { rate, offset: -80, delay: 0.157 });
    const resampler = new Resampler(rate);
    const events = [];
    const rx = new Receiver(e => events.push(e));
    for (let i = 0; i < signal.length; i += 128) rx.push(resampler.push(signal.subarray(i, i + 128)));
    assert.equal(packets(events)[0]?.packet.text, 'Android ↔ ноутбук', `rate ${rate}`);
  }
});

test('silence, seeded noise and a steady tone produce no lock or text', () => {
  const sources = [new Float32Array(8000 * 5), noiseChannel(new Float32Array(8000 * 5).fill(0.1), { snr: -20, seed: 55 }),
    Float32Array.from({ length: 8000 * 5 }, (_, i) => Math.sin(2 * Math.PI * 1250 * i / 8000))];
  for (const signal of sources) {
    const events = receive(signal);
    assert.equal(packets(events).length, 0);
    assert.equal(events.filter(e => e.type === 'sync').length, 0);
  }
});

test('CRC rejects corrupted payload audio; receiver recovers for next packet', () => {
  const signal = modulate(encodePacket('bad payload'));
  // Preamble + sync + header = 80 symbols. Replace one payload symbol with another tone.
  const start = Math.round(0.15 * 8000) + 80 * 320;
  for (let i = 0; i < 320; i++) signal[start + i] = 0.65 * Math.sin(2 * Math.PI * 1350 * i / 8000);
  const good = modulate(encodePacket('Следующий'));
  const joined = new Float32Array(signal.length + good.length);
  joined.set(signal); joined.set(good, signal.length);
  const events = receive(joined);
  assert.ok(events.some(e => e.type === 'error' && /CRC/.test(e.message)));
  assert.deepEqual(packets(events).map(e => e.packet.text), ['Следующий']);
});
