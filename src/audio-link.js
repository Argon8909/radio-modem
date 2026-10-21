import { modulate, PROFILE } from './modem.js';
import { TURNAROUND_MS, encodeReliable } from './reliable-protocol.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class AudioLink {
  constructor(onEvent) {
    this.onEvent = onEvent; this.opened = false; this.transmitting = false; this.epoch = 0; this.mutedUntil = 0;
  }
  resetReceiver() {
    this.epoch++;
    this.worker?.postMessage({ type: 'reset', epoch: this.epoch });
  }
  async open() {
    if (this.opened) return;
    try {
      this.context ??= new AudioContext({ latencyHint: 'interactive' });
      await this.context.resume();
      if (this.context.state !== 'running') throw new Error('Браузер приостановил звук. Нажмите «Включить связь» снова.');
      if (navigator.locks) {
        let acquired;
        const ready = new Promise(resolve => { acquired = resolve; });
        const release = new Promise(resolve => { this.releaseLock = resolve; });
        navigator.locks.request('radiobridge-audio', { ifAvailable: true }, async lock => {
          acquired(Boolean(lock)); if (lock) await release;
        }).catch(() => acquired(false));
        if (!await ready) throw new Error('Связь уже включена в другой вкладке RadioBridge.');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      await this.context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      this.worker = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => { if (this.opened && !this.transmitting && data.epoch === this.epoch) this.onEvent(data); };
      this.worker.onerror = () => this.onEvent({ type: 'fatal', message: 'Ошибка аудиоприёмника. Перезагрузите страницу.' });
      this.microphone = this.context.createMediaStreamSource(this.stream);
      this.capture = new AudioWorkletNode(this.context, 'rb-capture');
      this.capture.port.onmessage = ({ data }) => {
        if (this.opened && !this.transmitting && performance.now() >= this.mutedUntil) this.worker.postMessage({ type: 'samples', samples: data, epoch: this.epoch }, [data.buffer]);
      };
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.microphone.connect(this.capture); this.capture.connect(this.silent); this.silent.connect(this.context.destination);
      this.opened = true; this.resetReceiver();
      this.context.onstatechange = () => {
        if (this.opened && this.context.state !== 'running') this.onEvent({ type: 'fatal', message: 'Браузер остановил аудио. Очередь сохранена; включите связь снова.' });
      };
      for (const track of this.stream.getTracks()) track.onended = () => {
        if (this.opened) this.onEvent({ type: 'fatal', message: 'Микрофон отключён. Очередь сохранена.' });
      };
      try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Foreground use still works. */ }
      this.onEvent({ type: 'opened', rate: this.context.sampleRate });
    } catch (error) { this.close(); throw error; }
  }
  async send(frame, isCurrent = () => true) {
    await sleep(TURNAROUND_MS);
    if (!this.opened || !isCurrent() || this.context.state !== 'running') throw new Error('Связь приостановлена.');
    this.transmitting = true; this.resetReceiver(); this.onEvent({ type: 'transmitting', frame });
    const samples = modulate(encodeReliable(frame));
    const buffer = this.context.createBuffer(1, samples.length, PROFILE.rate); buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.source = source; let interrupted = false;
    this.cancelTransmit = () => { interrupted = true; try { source.stop(); } catch { /* Already stopped. */ } };
    try {
      await new Promise((resolve, reject) => {
        source.onended = resolve;
        try { source.start(); } catch (error) { reject(error); }
      });
      if (interrupted || !isCurrent()) throw new Error('Передача приостановлена.');
    } finally {
      source.disconnect(); this.source = null; this.cancelTransmit = null;
      this.mutedUntil = performance.now() + 150; this.resetReceiver(); this.transmitting = false;
      this.onEvent({ type: 'listening' });
    }
  }
  close() {
    this.opened = false; this.cancelTransmit?.();
    this.capture?.disconnect(); this.microphone?.disconnect(); this.silent?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.worker?.terminate(); this.worker = null;
    this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    this.releaseLock?.(); this.releaseLock = null;
    this.resetReceiver();
  }
}
