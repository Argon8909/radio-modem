import { encodeFrame } from './packet.js';
import { duration } from './modem.js';

export const DEFAULTS = Object.freeze({ blockSize: 20, maxBlocks: 32, window: 4, retries: 3, interval: 30, requestRetries: 3 });
export const BLOCK_SIZES = [12, 16, 20, 24, 32];
export const STATES = { PARTIAL: 0, COMPLETE: 1, UNKNOWN: 2, REJECTED: 3, BUSY: 4 };
export const TURNAROUND_MS = 500;
// Worst-case READY/REPORT plus audio/worker/turnaround margin.
export const RESPONSE_MS = Math.ceil(duration(new Uint8Array(34)) * 1000 + 3500);

export function settings(values = {}) {
  const s = { ...DEFAULTS, ...values };
  if (!BLOCK_SIZES.includes(s.blockSize)) throw new Error('Размер блока: 12, 16, 20, 24 или 32 байта.');
  for (const [key, min, max] of [['maxBlocks', 1, 64], ['window', 1, 8], ['retries', 0, 10], ['interval', 5, 3600], ['requestRetries', 0, 5]]) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`Неверное значение ${key}.`);
  }
  return s;
}
// CRC-32/ISO-HDLC over the entire UTF-8 message.
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const b of bytes) {
    value ^= b;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function newId() { return [...crypto.getRandomValues(new Uint8Array(8))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export function metaFor(bytes, s) {
  return { size: bytes.length, blockSize: s.blockSize, count: Math.ceil(bytes.length / s.blockSize), window: s.window, checksum: crc32(bytes) };
}
export function validMeta(m) {
  return Number.isInteger(m.size) && m.size > 0 && m.size <= 2048 && BLOCK_SIZES.includes(m.blockSize) &&
    Number.isInteger(m.count) && m.count >= 1 && m.count <= 64 && m.count === Math.ceil(m.size / m.blockSize) &&
    Number.isInteger(m.window) && m.window >= 1 && m.window <= 8 && Number.isInteger(m.checksum) && m.checksum >= 0 && m.checksum <= 0xffffffff;
}
export function encodeReliable(f) {
  if (!/^[0-9a-f]{16}$/.test(f.id)) throw new Error('Неверный ID передачи.');
  let length = 8;
  if (f.kind === 'OFFER') { if (!validMeta(f.meta)) throw new Error('Неверное предложение.'); length = 17; }
  else if (f.kind === 'DATA') {
    if (!Number.isInteger(f.index) || f.index < 0 || f.index >= 64 || !f.data?.length || f.data.length > 32) throw new Error('Неверный блок.');
    length = 9 + f.data.length;
  } else if (['READY', 'REPORT'].includes(f.kind)) {
    if (!Object.values(STATES).includes(f.state) || !Number.isInteger(f.count) || f.count < 0 || f.count > 64 || !Number.isInteger(f.checksum) || f.checksum < 0 || f.checksum > 0xffffffff) throw new Error('Неверное подтверждение.');
    length = 22;
  } else if (f.kind !== 'CHECK') throw new Error('Неизвестная команда.');
  const p = new Uint8Array(length), view = new DataView(p.buffer);
  for (let i = 0; i < 8; i++) p[i] = parseInt(f.id.slice(i * 2, i * 2 + 2), 16);
  if (f.kind === 'OFFER') {
    view.setUint16(8, f.meta.size); p[10] = f.meta.blockSize; p[11] = f.meta.count; p[12] = f.meta.window; view.setUint32(13, f.meta.checksum);
  } else if (f.kind === 'DATA') { p[8] = f.index; p.set(f.data, 9); }
  else if (['READY', 'REPORT'].includes(f.kind)) {
    p[8] = f.state; p[9] = f.count; view.setUint32(10, f.checksum);
    for (let i = 0; i < f.count; i++) if (f.received?.[i]) p[14 + (i >> 3)] |= 1 << (i & 7);
  }
  return encodeFrame(f.kind, p, { from: f.from, to: f.to, request: f.request ?? 0 });
}
export function decodeReliable(packet) {
  if (packet.version !== 2) throw new Error('Требуется протокол v2.');
  const p = packet.payload, view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const f = { kind: packet.kind, from: packet.from, to: packet.to, request: packet.request,
    id: [...p.slice(0, 8)].map(n => n.toString(16).padStart(2, '0')).join('') };
  if (f.kind === 'OFFER') {
    if (p.length !== 17) throw new Error('Неверная длина OFFER.');
    f.meta = { size: view.getUint16(8), blockSize: p[10], count: p[11], window: p[12], checksum: view.getUint32(13) };
    // The transport validates these bounds before allocating, and can return REJECTED.
  } else if (f.kind === 'DATA') {
    if (p.length < 10 || p.length > 41 || p[8] >= 64) throw new Error('Неверный блок.');
    f.index = p[8]; f.data = [...p.slice(9)];
  } else if (['READY', 'REPORT'].includes(f.kind)) {
    if (p.length !== 22 || !Object.values(STATES).includes(p[8]) || p[9] > 64) throw new Error('Неверный отчёт.');
    f.state = p[8]; f.count = p[9]; f.checksum = view.getUint32(10);
    f.received = Array.from({ length: f.count }, (_, i) => Boolean(p[14 + (i >> 3)] & (1 << (i & 7))));
    if (f.state === STATES.COMPLETE && (!f.count || f.received.some(v => !v))) throw new Error('Неполное подтверждение доставки.');
  } else if (f.kind !== 'CHECK' || p.length !== 8) throw new Error('Неверный запрос.');
  return f;
}
export function estimateSeconds(byteLength, s) {
  if (!byteLength) return 0;
  const count = Math.ceil(byteLength / s.blockSize), windows = Math.ceil(count / s.window);
  const frameSeconds = n => duration(new Uint8Array(n + 12)) + TURNAROUND_MS / 1000;
  let time = frameSeconds(17) + frameSeconds(22);
  for (let i = 0; i < count; i++) time += frameSeconds(9 + Math.min(s.blockSize, byteLength - i * s.blockSize));
  return time + windows * (frameSeconds(8) + frameSeconds(22));
}
