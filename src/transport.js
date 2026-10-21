import { DEFAULTS, STATES, RESPONSE_MS, crc32, metaFor, newId, settings, validMeta } from './reliable-protocol.js';

const ACTIVE = ['sending', 'waiting'];
const RUNNABLE = ['queued', 'deferred'];
const sameMeta = (a, b) => ['size', 'blockSize', 'count', 'window', 'checksum'].every(key => a[key] === b[key]);

// Transport has no DOM/audio dependencies. tick() uses a clock; receive() takes CRC-validated frames.
export class Transport {
  constructor({ device, store, transmit, now = Date.now, random = Math.random, onChange = () => {}, onEvent = () => {} }) {
    this.device = device; this.store = store; this.transmit = transmit; this.now = now; this.random = random;
    this.onChange = onChange; this.onEvent = onEvent;
    this.state = { outbox: [], inbox: [] }; this.enabled = false; this.active = null; this.lease = null;
    this.epoch = 0; this.sequence = Math.floor(random() * 65536); this.ticking = false;
    this.saves = Promise.resolve(); this.incoming = Promise.resolve(); this.transmissions = Promise.resolve();
  }
  async init() {
    this.state = await this.store.load(this.device) ?? { outbox: [], inbox: [] };
    for (const job of this.state.outbox) if (ACTIVE.includes(job.status)) job.status = 'queued';
    await this.persist();
  }
  persist() {
    const snapshot = structuredClone(this.state);
    const saved = this.saves.then(() => this.store.save(this.device, snapshot));
    this.saves = saved.catch(() => {});
    return saved.then(() => this.onChange(structuredClone(this.state)));
  }
  async enqueue(text, to, values = DEFAULTS) {
    const s = settings(values), bytes = [...new TextEncoder().encode(text)];
    if (!bytes.length || bytes.length > s.blockSize * s.maxBlocks) throw new Error(`Лимит сообщения: ${s.blockSize * s.maxBlocks} байт.`);
    if (!['BASE', 'FIELD'].includes(to) || to === this.device) throw new Error('Выберите второе устройство.');
    const job = { id: newId(), from: this.device, to, text, bytes, meta: metaFor(bytes, s), settings: s, created: this.now(),
      status: 'queued', received: Array(Math.ceil(bytes.length / s.blockSize)).fill(false), retriesUsed: 0, nextAttemptAt: this.now(), reason: '' };
    this.state.outbox.push(job);
    try { await this.persist(); } catch (error) { this.state.outbox = this.state.outbox.filter(j => j !== job); throw error; }
    return job.id;
  }
  async start() {
    const epoch = this.epoch;
    await this.persist(); // Recommit any in-memory changes left by an earlier storage error.
    if (epoch === this.epoch) this.enabled = true;
  }
  async stop() {
    this.enabled = false; this.epoch++; this.active = null; this.lease = null;
    for (const job of this.state.outbox) if (ACTIVE.includes(job.status)) job.status = 'queued';
    await this.persist();
  }
  async pause(id) {
    const job = this.state.outbox.find(j => j.id === id);
    if (!job || job.status === 'delivered') return;
    if (this.active?.job === job) { this.epoch++; this.active = null; }
    job.status = 'paused'; job.reason = 'Приостановлено пользователем'; await this.persist();
  }
  async resume(id) {
    const job = this.state.outbox.find(j => j.id === id);
    if (!job || job.status === 'delivered' || this.active?.job === job) return;
    job.status = 'queued'; job.retriesUsed = 0; job.nextAttemptAt = this.now(); job.reason = ''; await this.persist();
  }
  async updateRetryPolicy(id, retries, interval) {
    const job = this.state.outbox.find(j => j.id === id);
    if (!job || job.status === 'delivered') return;
    job.settings = settings({ ...job.settings, retries, interval });
    if (job.status === 'deferred') job.nextAttemptAt = this.now() + interval * 1000;
    await this.persist();
  }
  async clearHistory() {
    for (const session of this.state.inbox) if (session.complete) session.hidden = true;
    await this.persist(); // Keep receipt checkpoints: clearing the display must not allow duplicates.
  }
  async send(frame, epoch = this.epoch) {
    const task = this.transmissions.then(async () => {
      if (!this.enabled || epoch !== this.epoch) throw new Error('Передача приостановлена.');
      this.onEvent({ type: 'tx', frame });
      await this.transmit(frame, () => this.enabled && epoch === this.epoch);
      if (!this.enabled || epoch !== this.epoch) throw new Error('Передача приостановлена.');
    });
    this.transmissions = task.catch(() => {});
    return task;
  }
  async tick() {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    const epoch = this.epoch;
    try {
      if (this.lease && this.lease.until <= this.now()) this.lease = null;
      if (!this.active) {
        if (this.lease) return;
        const job = this.state.outbox.find(j => RUNNABLE.includes(j.status) && j.nextAttemptAt <= this.now());
        if (!job) return;
        if (job.status === 'deferred') {
          if (job.retriesUsed >= job.settings.retries) { job.status = 'stopped'; await this.persist(); return; }
          job.retriesUsed++;
        }
        job.status = 'sending'; job.reason = '';
        this.active = { job, attempts: Array(job.meta.count).fill(0), pending: null, response: null, unknowns: 0 };
        await this.persist();
        if (!this.enabled || epoch !== this.epoch) return;
        await this.request('OFFER'); return;
      }
      const active = this.active;
      if (active.response) {
        const f = active.response; active.response = null;
        if (f.state === STATES.BUSY || f.state === STATES.REJECTED) {
          await this.defer(f.state === STATES.BUSY ? 'Получатель занят' : 'Получатель отклонил параметры'); return;
        }
        if (f.state === STATES.UNKNOWN) {
          if (++active.unknowns > active.job.settings.requestRetries + 1) { await this.defer('Получатель не сохраняет состояние'); return; }
          await this.request('OFFER'); return;
        }
        active.job.received = [...f.received];
        if (f.state === STATES.COMPLETE) {
          active.job.status = 'delivered'; active.job.delivered = this.now(); active.job.reason = ''; active.job.nextAttemptAt = null;
          await this.persist(); this.active = null; return;
        }
        await this.persist();
        if (!this.enabled || epoch !== this.epoch || this.active !== active) return;
        await this.batch(); return;
      }
      if (active.pending && active.pending.deadline <= this.now()) {
        if (active.pending.tries > active.job.settings.requestRetries) { await this.defer('Ответ не получен'); return; }
        active.pending.tries++;
        await this.send(active.pending.frame, epoch);
        if (this.active === active) active.pending.deadline = this.now() + RESPONSE_MS;
      }
    } catch (error) {
      if (epoch === this.epoch && this.enabled) {
        try { await this.defer(error.message); }
        catch (storageError) { this.enabled = false; this.epoch++; this.onEvent({ type: 'error', message: storageError.message }); }
      }
    } finally { this.ticking = false; }
  }
  async request(kind) {
    const active = this.active, job = active.job, epoch = this.epoch;
    const frame = { kind, id: job.id, from: this.device, to: job.to, request: this.sequence++ & 65535 };
    if (kind === 'OFFER') frame.meta = job.meta;
    active.pending = { frame, tries: 1, deadline: Infinity }; active.response = null;
    job.status = 'waiting'; await this.persist();
    if (this.active !== active) return;
    await this.send(frame, epoch);
    if (this.active === active) active.pending.deadline = this.now() + RESPONSE_MS;
  }
  async batch() {
    const active = this.active, job = active.job, epoch = this.epoch;
    const missing = job.received.map((ok, i) => ok ? -1 : i).filter(i => i >= 0).slice(0, job.meta.window);
    if (!missing.length) { await this.request('CHECK'); return; }
    if (missing.some(i => active.attempts[i] >= job.settings.requestRetries + 1)) { await this.defer('Исчерпаны повторы повреждённых блоков'); return; }
    job.status = 'sending'; await this.persist();
    for (const index of missing) {
      if (this.active !== active || !this.enabled || epoch !== this.epoch) return;
      active.attempts[index]++;
      await this.send({ kind: 'DATA', from: this.device, to: job.to, id: job.id, index,
        data: job.bytes.slice(index * job.meta.blockSize, (index + 1) * job.meta.blockSize) }, epoch);
    }
    if (this.active === active) await this.request('CHECK');
  }
  async defer(reason) {
    const job = this.active?.job;
    if (!job) return;
    job.reason = reason;
    if (job.retriesUsed < job.settings.retries) {
      job.status = 'deferred';
      // The configured interval is a minimum. Up to 10% jitter separates competing stations.
      job.nextAttemptAt = this.now() + job.settings.interval * 1000 * (1 + this.random() * 0.1);
    } else { job.status = 'stopped'; job.nextAttemptAt = null; }
    this.active = null; await this.persist();
  }
  receive(frame) {
    const task = this.incoming.then(() => this.handle(frame));
    this.incoming = task.catch(error => {
      this.enabled = false; this.epoch++; this.active = null;
      this.onEvent({ type: 'error', message: `Приём не подтверждён: ${error.message}` });
    });
    return this.incoming;
  }
  async handle(f) {
    if (!this.enabled || f.to !== this.device || f.from === this.device || !['BASE', 'FIELD'].includes(f.from)) return;
    this.onEvent({ type: 'rx', frame: f });
    if (f.kind === 'READY' || f.kind === 'REPORT') {
      const a = this.active;
      if (!a?.pending || f.id !== a.job.id || f.from !== a.job.to || f.request !== a.pending.frame.request ||
          f.kind !== (a.pending.frame.kind === 'OFFER' ? 'READY' : 'REPORT')) return;
      if ([STATES.PARTIAL, STATES.COMPLETE].includes(f.state) && (f.count !== a.job.meta.count || f.checksum !== a.job.meta.checksum || f.received.length !== a.job.meta.count)) return;
      if (f.state === STATES.COMPLETE && f.received.some(v => !v)) return;
      a.response = f; return;
    }
    let session = this.state.inbox.find(s => s.id === f.id && s.from === f.from);
    if (f.kind === 'OFFER') {
      if (!validMeta(f.meta) || (session && !sameMeta(session.meta, f.meta))) { await this.report(f, null, STATES.REJECTED); return; }
      if (this.active) {
        // If both stations offer together, BASE takes this turn. FIELD retains its queued message.
        if (this.device === 'FIELD' && this.active.pending?.frame.kind === 'OFFER') {
          this.active.job.status = 'queued'; this.active.job.nextAttemptAt = this.now() + 15000; this.active = null;
          await this.persist();
        } else { await this.report(f, null, STATES.BUSY); return; }
      }
      if (!session) {
        if (this.state.inbox.filter(s => !s.complete).length >= 32) { await this.report(f, null, STATES.BUSY); return; }
        session = { id: f.id, from: f.from, to: this.device, meta: f.meta, blocks: Array(f.meta.count).fill(null), complete: false, created: this.now() };
        this.state.inbox.push(session);
      }
      this.lease = { id: f.id, from: f.from, until: this.now() + 120000 };
      await this.persist(); await this.report(f, session); return;
    }
    if (f.kind === 'DATA') {
      if (!session || session.complete || f.index >= session.meta.count || f.index < 0) return;
      const expected = Math.min(session.meta.blockSize, session.meta.size - f.index * session.meta.blockSize);
      if (f.data.length !== expected) return;
      this.lease = { id: f.id, from: f.from, until: this.now() + 120000 };
      session.blocks[f.index] = [...f.data];
      if (session.blocks.every(Boolean)) {
        const bytes = Uint8Array.from(session.blocks.flat());
        if (crc32(bytes) === session.meta.checksum) {
          try { session.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); session.complete = true; session.completed = this.now(); }
          catch { session.blocks.fill(null); }
        } else { session.blocks.fill(null); this.onEvent({ type: 'warning', message: 'CRC сообщения не совпала; блоки будут запрошены заново.' }); }
      }
      await this.persist(); return;
    }
    if (f.kind === 'CHECK') await this.report(f, session, session ? undefined : STATES.UNKNOWN);
  }
  async report(query, session, state) {
    if (session) await this.persist(); // Never acknowledge data that only exists in memory.
    await this.send({ kind: query.kind === 'OFFER' ? 'READY' : 'REPORT', from: this.device, to: query.from, id: query.id, request: query.request,
      state: state ?? (session.complete ? STATES.COMPLETE : STATES.PARTIAL), count: session?.meta.count ?? 0,
      checksum: session?.meta.checksum ?? 0, received: session?.blocks.map(Boolean) ?? [] });
    if (session?.complete && this.lease?.id === session.id) this.lease = null;
  }
}
