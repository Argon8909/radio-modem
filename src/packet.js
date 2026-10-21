export const MAX_BYTES = 96;
export const HEADER_BYTES = 10;
export const IDS = { ALL: 0, BASE: 1, FIELD: 2 };
export const NAMES = ['ALL', 'BASE', 'FIELD'];

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xffff, no reflection/xorout.
export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function encodePacket(text, { from = 'BASE', to = 'FIELD', id = 0 } = {}) {
  const payload = new TextEncoder().encode(text);
  if (!payload.length || payload.length > MAX_BYTES) throw new Error(`Сообщение должно содержать от 1 до ${MAX_BYTES} байт UTF-8.`);
  if (!(from in IDS) || from === 'ALL' || !(to in IDS)) throw new Error('Неизвестный адрес.');
  const bytes = new Uint8Array(HEADER_BYTES + payload.length + 2);
  bytes.set([0x52, 0x42, 1, IDS[from], IDS[to], 0, id >>> 8, id & 255, 0, payload.length]);
  bytes.set(payload, HEADER_BYTES);
  const crc = crc16(bytes.subarray(0, -2));
  bytes.set([crc >>> 8, crc & 255], bytes.length - 2);
  return bytes;
}

export function packetLength(header) {
  if (header.length < HEADER_BYTES || header[0] !== 0x52 || header[1] !== 0x42 || header[2] !== 1 ||
      header[3] < 1 || header[3] > 2 || header[4] > 2 || header[5] !== 0 || header[8] !== 0 ||
      header[9] < 1 || header[9] > MAX_BYTES) throw new Error('Неверный заголовок пакета.');
  return HEADER_BYTES + header[9] + 2;
}

export function decodePacket(bytes) {
  if (bytes.length !== packetLength(bytes)) throw new Error('Неверная длина пакета.');
  if (crc16(bytes.subarray(0, -2)) !== ((bytes.at(-2) << 8) | bytes.at(-1))) throw new Error('Ошибка CRC: пакет повреждён.');
  return {
    from: NAMES[bytes[3]], to: NAMES[bytes[4]], id: (bytes[6] << 8) | bytes[7],
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES, -2))
  };
}
