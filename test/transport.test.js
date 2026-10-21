import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.js';
import { encodeReliable, decodeReliable, DEFAULTS, STATES, RESPONSE_MS, crc32 } from '../src/reliable-protocol.js';
import { decodePacket } from '../src/packet.js';
import { Receiver, modulate } from '../src/modem.js';
import { noiseChannel } from '../src/channel.js';

function memoryStore() {
  const data = new Map();
  return { data, load: async key => structuredClone(data.get(key)), save: async (key, value) => { data.set(key, structuredClone(value)); } };
}
async function pair({ fault = () => null, audio = false, store = memoryStore() } = {}) {
  const h = { time: 1000000, frames: [], wire: [], nodes: {}, store, fault, corruptions: 0 };
  h.create = async device => {
    const node = new Transport({ device, store, now: () => h.time, random: () => 0,
      transmit: async frame => {
        h.frames.push(structuredClone(frame));
        const action = h.fault(frame, h);
        if (action === 'drop') return;
        const bytes = encodeReliable(frame);
        if (action === 'corrupt') bytes[bytes.length - 3] ^= 1;
        let packet;
        if (audio) {
          const events = [], rx = new Receiver(e => events.push(e));
          rx.push(noiseChannel(modulate(bytes, { offset: frame.from === 'BASE' ? 80 : -25, delay: 0.173125 }), { snr: 10, seed: h.frames.length }));
          packet = events.find(e => e.type === 'packet')?.packet;
        } else {
          try { packet = decodePacket(bytes); } catch { h.corruptions++; }
        }
        if (packet) { h.wire.push(decodeReliable(packet)); if (action === 'duplicate') h.wire.push(decodeReliable(packet)); }
      }
    });
    await node.init(); h.nodes[device] = node; return node;
  };
  h.drain = async () => { while (h.wire.length) { const frame = h.wire.shift(); await h.nodes[frame.to].receive(frame); } };
  h.step = async (ms = 0) => { h.time += ms; for (const node of Object.values(h.nodes)) await node.tick(); await h.drain(); };
  h.until = async (predicate, max = 200) => {
    for (let i = 0; i < max && !predicate(); i++) await h.step(1000);
    assert.ok(predicate(), JSON.stringify(Object.values(h.nodes).map(n => n.state.outbox)));
  };
  await h.create('BASE'); await h.create('FIELD');
  await h.nodes.BASE.start(); await h.nodes.FIELD.start();
  return h;
}

test('CRC-32 standard check value', () => assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926));

for (const length of [47, 48, 49, 96, 640, 2048]) test(`reliable delivery of ${length} ASCII bytes, bounded blocks`, async () => {
  const h = await pair();
  await h.nodes.BASE.enqueue('x'.repeat(length), 'FIELD', { blockSize: 32, maxBlocks: 64 });
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
  assert.equal(h.nodes.FIELD.state.inbox[0].text, 'x'.repeat(length));
  assert.ok(h.frames.filter(f => f.kind === 'DATA').every(f => f.data.length <= 32));
});

test('UTF-8 split inside a code point, acoustic frames in both directions, damaged block and lost REPORT', async () => {
  let damaged = false, lostReport = false;
  const h = await pair({ audio: true, fault: f => {
    if (f.kind === 'DATA' && f.index === 1 && !damaged) { damaged = true; return 'corrupt'; }
    if (f.kind === 'REPORT' && !lostReport) { lostReport = true; return 'drop'; }
  } });
  const text = 'a' + 'Привет 👋, эфир! '.repeat(3);
  await h.nodes.BASE.enqueue(text, 'FIELD');
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
  assert.equal(h.nodes.FIELD.state.inbox[0].text, text);
  const sent = h.frames.filter(f => f.kind === 'DATA').map(f => f.index);
  assert.equal(sent.filter(i => i === 1).length, 2);
  assert.equal(sent.filter(i => i === 0).length, 1);
  assert.ok(h.frames.filter(f => f.kind === 'CHECK').length > 1);
});

test('lost final ACK: delayed query confirms delivery without retransmitting text or duplicating inbox', async () => {
  let drop = true;
  const h = await pair({ fault: f => drop && ['REPORT', 'READY'].includes(f.kind) && f.state === STATES.COMPLETE ? 'drop' : null });
  await h.nodes.BASE.enqueue('saved remotely', 'FIELD', { retries: 2, interval: 5, requestRetries: 0 });
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'deferred');
  const job = h.nodes.BASE.state.outbox[0], dataCount = h.frames.filter(f => f.kind === 'DATA').length;
  assert.equal(h.nodes.FIELD.state.inbox[0].complete, true);
  const previous = h.frames.length;
  await h.step(4000); assert.equal(h.frames.length, previous);
  drop = false;
  await h.until(() => job.status === 'delivered');
  assert.equal(h.frames.filter(f => f.kind === 'DATA').length, dataCount);
  assert.equal(h.nodes.FIELD.state.inbox.length, 1);
  assert.equal(job.retriesUsed, 1);
});

test('both devices reload: partial blocks persist and resume after interval with same ID', async () => {
  let drop = true;
  const h = await pair({ fault: f => drop && f.kind === 'DATA' && f.index === 1 ? 'drop' : null });
  await h.nodes.BASE.enqueue('z'.repeat(55), 'FIELD', { requestRetries: 0, retries: 2, interval: 30 });
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'deferred');
  const id = h.nodes.BASE.state.outbox[0].id;
  const before = h.frames.filter(f => f.kind === 'DATA' && f.index === 0).length;
  await h.create('BASE'); await h.create('FIELD');
  assert.equal(h.nodes.BASE.enabled, false);
  assert.equal(h.nodes.FIELD.state.inbox[0].blocks[0].length, 20);
  await h.nodes.BASE.start(); await h.nodes.FIELD.start(); drop = false;
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
  assert.equal(h.nodes.BASE.state.outbox[0].id, id);
  assert.equal(h.frames.filter(f => f.kind === 'DATA' && f.index === 0).length, before);
});

test('configurable retry count, minimum interval, stop without deletion, manual resume', async () => {
  let unavailable = true;
  const h = await pair({ fault: () => unavailable ? 'drop' : null });
  const id = await h.nodes.BASE.enqueue('queued', 'FIELD', { retries: 2, interval: 5, requestRetries: 1 });
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'stopped');
  assert.equal(h.frames.filter(f => f.kind === 'OFFER').length, 6); // 1+2 sessions, 1+1 requests/session.
  assert.equal(h.nodes.BASE.state.outbox[0].text, 'queued');
  const total = h.frames.length;
  await h.step(600000); assert.equal(h.frames.length, total);
  await h.nodes.BASE.updateRetryPolicy(id, 3, 10);
  await h.nodes.BASE.resume(id); unavailable = false;
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
});

test('duplicate DATA, CHECK and final OFFER never duplicate completed message', async () => {
  const h = await pair({ fault: f => ['DATA', 'CHECK'].includes(f.kind) ? 'duplicate' : null });
  await h.nodes.BASE.enqueue('once only', 'FIELD');
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
  const offer = h.frames.find(f => f.kind === 'OFFER');
  await h.nodes.FIELD.receive(offer); await h.drain();
  assert.equal(h.nodes.FIELD.state.inbox.filter(s => s.complete).length, 1);
});

test('wrong/stale confirmation cannot mark a message delivered', async () => {
  const h = await pair({ fault: () => 'drop' });
  await h.nodes.BASE.enqueue('proof', 'FIELD'); await h.step();
  const a = h.nodes.BASE.active, job = a.job;
  const reply = { kind: 'READY', from: 'FIELD', to: 'BASE', id: job.id, request: a.pending.frame.request, count: job.meta.count,
    state: STATES.COMPLETE, checksum: job.meta.checksum, received: [true] };
  await h.nodes.BASE.receive({ ...reply, request: (reply.request + 1) & 65535 });
  await h.nodes.BASE.receive({ ...reply, checksum: reply.checksum ^ 1 });
  await h.step(); assert.notEqual(job.status, 'delivered');
});

test('receiver persists before confirming; storage failure produces no ACK', async () => {
  const store = memoryStore(), save = store.save;
  const h = await pair({ store });
  store.save = async (device, value) => { if (device === 'FIELD' && value.inbox.some(s => s.complete)) throw new Error('disk full'); await save(device, value); };
  await h.nodes.BASE.enqueue('durable', 'FIELD', { retries: 0, requestRetries: 0 });
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'stopped');
  assert.equal(h.frames.filter(f => ['READY', 'REPORT'].includes(f.kind) && f.state === STATES.COMPLETE).length, 0);
  assert.equal(store.data.get('FIELD').inbox[0].complete, false);
  await assert.rejects(h.nodes.FIELD.start(), /disk full/);
  assert.equal(h.nodes.FIELD.enabled, false);
  store.save = save;
  await h.nodes.FIELD.start();
  assert.equal(store.data.get('FIELD').inbox[0].complete, true);
  await h.nodes.BASE.resume(h.nodes.BASE.state.outbox[0].id);
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
});

test('unsupported OFFER is explicitly rejected without allocating an inbox', async () => {
  const h = await pair();
  await h.nodes.FIELD.receive({ kind: 'OFFER', from: 'BASE', to: 'FIELD', id: '0000000000000001', request: 1,
    meta: { size: 100, blockSize: 100, count: 1, window: 4, checksum: 1 } });
  assert.equal(h.nodes.FIELD.state.inbox.length, 0);
  assert.equal(h.frames.at(-1).state, STATES.REJECTED);
});

test('whole-message CRC catches valid-frame corruption and selective retransmission recovers', async () => {
  let changed = false;
  const h = await pair({ fault: f => { if (f.kind === 'DATA' && !changed) { f.data[0] ^= 1; changed = true; } } });
  await h.nodes.BASE.enqueue('whole message CRC', 'FIELD');
  await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
  assert.equal(h.nodes.FIELD.state.inbox[0].text, 'whole message CRC');
  assert.equal(h.frames.filter(f => f.kind === 'DATA').length, 2);
});

test('simultaneous outgoing messages eventually deliver in both directions', async () => {
  const h = await pair();
  await h.nodes.BASE.enqueue('outbound', 'FIELD'); await h.nodes.FIELD.enqueue('return', 'BASE');
  await h.until(() => Object.values(h.nodes).every(n => n.state.outbox[0].status === 'delivered'));
  assert.equal(h.nodes.BASE.state.inbox[0].text, 'return');
  assert.equal(h.nodes.FIELD.state.inbox[0].text, 'outbound');
});

test('paused or offline queue emits nothing; expired deadlines are evaluated only when enabled', async () => {
  const h = await pair(); const id = await h.nodes.BASE.enqueue('pause', 'FIELD');
  await h.nodes.BASE.pause(id); await h.step(60000); assert.equal(h.frames.length, 0);
  await h.nodes.BASE.resume(id); await h.nodes.BASE.stop(); await h.step(60000); assert.equal(h.frames.length, 0);
  await h.nodes.BASE.start(); await h.until(() => h.nodes.BASE.state.outbox[0].status === 'delivered');
});
