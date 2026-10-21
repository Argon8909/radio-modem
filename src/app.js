import { readMessages, saveMessage, clearMessages, reliableStore } from './storage.js';
import { Transport } from './transport.js';
import { AudioLink } from './audio-link.js';
import { DEFAULTS, settings, decodeReliable, estimateSeconds } from './reliable-protocol.js';

const $ = id => document.getElementById(id);
const fields = { blockSize: 'block-size', maxBlocks: 'max-blocks', window: 'window-size', retries: 'retry-count', interval: 'retry-interval', requestRetries: 'request-retries' };
const labels = { OFFER: 'Рукопожатие', READY: 'Готовность к приёму', DATA: 'Блок данных', CHECK: 'Запрос подтверждения', REPORT: 'Подтверждение блоков' };
let engine, legacy = [], requesting = false, queueing = false, testing = false, passed = 0, failed = 0, txLabel = '', deviceRevision = 0;
const link = new AudioLink(onAudio);
function status(text, mode = '') { $('status').textContent = text; $('status-dot').className = `dot ${mode}`; }
function warning(text) { $('context-warning').hidden = false; $('context-warning').textContent = text; }
function currentSettings() { return settings(Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, Number($(id).value)]))); }
function controls() {
  let s;
  try { s = currentSettings(); } catch (error) { $('send').disabled = true; $('duration').textContent = error.message; return; }
  const n = new TextEncoder().encode($('text').value).length, max = s.blockSize * s.maxBlocks;
  $('byte-count').textContent = `${n} / ${max} байт`; $('byte-count').className = n > max ? 'over' : '';
  $('max-blocks-value').textContent = `${s.maxBlocks} · лимит ${max} байт`;
  const seconds = Math.ceil(estimateSeconds(n, s));
  $('duration').textContent = n && n <= max ? `${Math.ceil(n / s.blockSize)} блоков · ≈ ${seconds < 60 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`} без повторов` : '—';
  $('send').disabled = !engine || queueing || requesting || testing || n === 0 || n > max || $('to').value === $('from').value;
  $('listen').disabled = !engine || requesting || testing || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode;
  $('listen').textContent = requesting ? 'Доступ к микрофону…' : link.opened ? 'Выключить связь' : 'Включить связь';
  $('selftest').disabled = link.opened || requesting || testing;
  $('from').disabled = link.opened || requesting || queueing;
  $('stop-tx').hidden = !engine?.active;
  document.querySelector('.receive').classList.toggle('listening', link.opened && !link.transmitting);
}
function overallStatus() {
  if (link.transmitting) { status(`Передаю: ${txLabel}`, 'tx'); return; }
  if (!link.opened) { status('Связь выключена · очередь сохранена'); return; }
  if (engine?.active) {
    status(engine.active.job.status === 'waiting' ? 'Жду подтверждение второго устройства…' : 'Передача сообщения…', 'active');
  } else status('Связь включена · слушаю', 'active');
}
async function stopConnection(message) {
  const stopping = engine?.stop(); link.close();
  try { await stopping; } catch (error) { warning(`Не удалось сохранить состояние: ${error.message}`); }
  $('level').value = 0; $('level-value').textContent = '—';
  controls(); overallStatus(); if (message) status(message);
}
async function startConnection() {
  if (link.opened || requesting) return;
  requesting = true; controls();
  try { await link.open(); await engine.start(); }
  catch (error) { link.close(); warning(error.name === 'NotAllowedError' ? 'Разрешите микрофон в настройках сайта. Сообщение остаётся в очереди.' : error.message); }
  finally { requesting = false; controls(); overallStatus(); }
  engine.tick();
}
async function onAudio(event) {
  if (event.type === 'opened') $('audio-rate').textContent = `${event.rate} → 8000 Гц`;
  if (event.type === 'level') {
    $('level').value = event.rms;
    $('level-value').textContent = `${(20 * Math.log10(Math.max(event.rms, 1e-6))).toFixed(0)} dBFS`;
    if (event.offset !== null) $('afc').textContent = `${event.offset.toFixed(1)} Гц`;
  }
  if (event.type === 'sync') { $('afc').textContent = `${event.offset.toFixed(1)} Гц`; $('sync').textContent = 'Преамбула найдена · принимаю пакет'; }
  if (event.type === 'error') { failed++; $('sync').textContent = event.message; }
  if (event.type === 'fatal') { warning(event.message); await stopConnection(event.message); }
  if (event.type === 'packet') {
    passed++; $('sync').textContent = 'CRC пакета верна';
    if (event.packet.version === 2) {
      try {
        const frame = decodeReliable(event.packet);
        $('protocol-event').textContent = `RX ${frame.kind} · #${frame.id.slice(-6)}`;
        await engine.receive(frame); engine.tick();
      } catch (error) { failed++; $('sync').textContent = error.message; }
    } else if (event.packet.to === $('from').value || event.packet.to === 'ALL') {
      const message = { ...event.packet, direction: 'rx', at: Date.now() };
      legacy.push(message); renderMessages();
      try { await saveMessage(message); } catch (error) { warning(error.message); }
      warning('Принят пакет старого прототипа 0.1 без подтверждения. Для нового обмена обновите обе станции до 0.2.');
    }
  }
  if (event.type === 'transmitting') txLabel = event.frame.kind === 'DATA' ? `блок ${event.frame.index + 1}` : labels[event.frame.kind];
  $('counts').textContent = `${passed} / ${failed}`;
  controls(); if (event.type !== 'fatal') overallStatus();
}
async function useDevice() {
  const revision = ++deviceRevision;
  engine = null; controls();
  const device = $('from').value;
  const candidate = new Transport({ device, store: reliableStore, transmit: (frame, valid) => link.send(frame, valid),
    onChange: () => { if (engine === candidate) { renderQueue(); renderMessages(); controls(); overallStatus(); } },
    onEvent: event => {
      if (event.frame) $('protocol-event').textContent = `${event.type.toUpperCase()} ${event.frame.kind} · #${event.frame.id.slice(-6)}`;
      if (event.type === 'warning') warning(event.message);
      if (event.type === 'error') { warning(event.message); stopConnection(event.message); }
    }
  });
  await candidate.init(); if (revision !== deviceRevision) return; engine = candidate;
  renderQueue(); renderMessages(); controls(); overallStatus();
}
function element(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
}
const stateNames = { queued: 'В очереди', sending: 'Передача', waiting: 'Ожидание подтверждения', deferred: 'Ожидание следующей попытки',
  paused: 'Приостановлено', stopped: 'Доставка не подтверждена · повторы закончились', delivered: 'Доставлено · подтверждено получателем' };
function renderQueue() {
  if (!engine) return;
  $('outbox').replaceChildren();
  const jobs = engine.state.outbox;
  $('queue-empty').hidden = jobs.length > 0;
  for (const job of [...jobs].reverse()) {
    const item = element('li', undefined, 'queue-item'); item.dataset.id = job.id; item.dataset.state = job.status;
    const head = element('div', undefined, 'message-meta');
    head.append(element('strong', stateNames[job.status]), element('span', `${job.from} → ${job.to} · #${job.id.slice(-6)}`));
    item.append(head, element('p', job.text, 'queue-text'));
    const count = job.received.filter(Boolean).length;
    item.append(element('p', `Подтверждено ${count}/${job.meta.count} блоков · повторные сеансы ${job.retriesUsed}/${job.settings.retries}`, 'hint'));
    if (job.reason) item.append(element('p', job.reason, 'hint'));
    if (job.status === 'deferred') {
      const countdown = element('p', '', 'hint countdown'); countdown.dataset.next = job.nextAttemptAt; item.append(countdown);
    }
    if (job.status !== 'delivered') {
      const actions = element('div', undefined, 'queue-actions');
      const paused = ['paused', 'stopped'].includes(job.status);
      const action = element('button', paused ? 'Продолжить' : 'Пауза', 'secondary small');
      action.onclick = async () => {
        try {
          if (paused) { await engine.resume(job.id); if (!link.opened) await startConnection(); }
          else { const active = engine.active?.job.id === job.id; await engine.pause(job.id); if (active) link.cancelTransmit?.(); }
        } catch (error) { warning(error.message); }
      };
      actions.append(action);
      const details = element('details', undefined, 'retry-editor'); details.append(element('summary', 'Изменить повторы'));
      const retries = element('input'); retries.type = 'number'; retries.min = '0'; retries.max = '10'; retries.value = job.settings.retries;
      const interval = element('input'); interval.type = 'number'; interval.min = '5'; interval.max = '3600'; interval.value = job.settings.interval;
      const a = element('label', 'Повторов после паузы'); a.append(retries);
      const b = element('label', 'Интервал, секунд'); b.append(interval);
      const save = element('button', 'Сохранить', 'quiet');
      save.onclick = () => engine.updateRetryPolicy(job.id, Number(retries.value), Number(interval.value)).catch(e => warning(e.message));
      details.append(a, b, save); actions.append(details); item.append(actions);
    }
    $('outbox').append(item);
  }
  updateCountdowns();
}
function updateCountdowns() {
  for (const el of document.querySelectorAll('.countdown')) el.textContent = link.opened
    ? `Следующая попытка через ${Math.max(0, Math.ceil((Number(el.dataset.next) - Date.now()) / 1000))} с`
    : 'Повторы продолжатся после включения связи';
}
function renderMessages() {
  if (!engine) return;
  $('messages').replaceChildren();
  const incoming = engine.state.inbox.filter(s => s.complete && !s.hidden).map(s => ({ ...s, direction: 'rx', at: s.completed, reliable: true }));
  const messages = [...legacy, ...incoming].sort((a, b) => b.at - a.at).slice(0, 100);
  $('empty').hidden = messages.length > 0;
  for (const message of messages) {
    const item = element('li', undefined, `message ${message.direction}`);
    const meta = element('div', undefined, 'message-meta');
    meta.append(element('strong', message.reliable ? 'ПРИНЯТО · CRC СООБЩЕНИЯ ✓' : 'ЖУРНАЛ v0.1'),
      element('span', `${message.from} → ${message.to} · #${String(message.id).slice(-6)}`),
      element('time', new Date(message.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })));
    item.append(meta, element('p', message.text)); $('messages').append(item);
  }
  const partial = engine.state.inbox.filter(s => !s.complete);
  $('partial').textContent = partial.map(s => `Получение #${s.id.slice(-6)}: ${s.blocks.filter(Boolean).length}/${s.meta.count} блоков сохранено`).join(' · ');
}

$('text').addEventListener('input', controls);
$('to').addEventListener('change', controls);
$('send').onclick = async () => {
  if (queueing || !engine) return;
  queueing = true; controls(); const text = $('text').value;
  try {
    await engine.enqueue(text, $('to').value, currentSettings());
    if ($('text').value === text) $('text').value = ''; controls();
    if (!link.opened) await startConnection(); else engine.tick();
  } catch (error) { warning(`Сообщение не отправлено: ${error.message}`); }
  finally { queueing = false; controls(); }
};
$('listen').onclick = () => link.opened ? stopConnection() : startConnection();
$('stop-tx').onclick = async () => {
  if (engine.active) { await engine.pause(engine.active.job.id); link.cancelTransmit?.(); }
};
$('from').onchange = async () => {
  $('to').value = $('from').value === 'BASE' ? 'FIELD' : 'BASE';
  try { localStorage.setItem('rb-device', $('from').value); await useDevice(); } catch (error) { warning(error.message); }
};
for (const id of Object.values(fields)) $(id).addEventListener('input', () => {
  controls(); try { localStorage.setItem('rb-reliable-settings', JSON.stringify(currentSettings())); } catch { /* Incomplete input or unavailable preferences. */ }
});
$('clear').onclick = async () => {
  try { await clearMessages(); await engine.clearHistory(); legacy = []; renderMessages(); }
  catch (error) { warning(error.message); }
};
$('selftest').onclick = () => {
  testing = true; controls(); $('test-result').textContent = 'Проверяю физический модем…';
  const worker = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });
  const finish = text => { $('test-result').textContent = text; testing = false; worker.terminate(); controls(); };
  worker.onmessage = ({ data }) => {
    if (data.type === 'test-result') finish(data.ok ? `Самопроверка пройдена: текст и CRC верны, AFC ${data.offset.toFixed(1)} Гц. Это программный тест, без микрофона.` : 'Самопроверка не пройдена.');
  };
  worker.onerror = () => finish('Ошибка загрузки самопроверки.');
  worker.postMessage({ type: 'selftest', text: 'Привет, RadioBridge!' });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && link.opened) stopConnection('Связь приостановлена при сворачивании. Очередь сохранена.');
});
window.addEventListener('pagehide', () => { engine?.stop().catch(() => {}); link.close(); });
setInterval(() => { engine?.tick(); updateCountdowns(); }, 250);

try {
  let saved = DEFAULTS;
  try { saved = settings(JSON.parse(localStorage.getItem('rb-reliable-settings') || '{}')); } catch { /* Defaults. */ }
  for (const [key, id] of Object.entries(fields)) $(id).value = saved[key];
  try {
    const device = localStorage.getItem('rb-device');
    if (['BASE', 'FIELD'].includes(device)) { $('from').value = device; $('to').value = device === 'BASE' ? 'FIELD' : 'BASE'; }
  } catch { /* Optional. */ }
  legacy = await readMessages(); await useDevice(); document.body.dataset.ready = 'true';
} catch (error) { warning(`Хранилище недоступно: ${error.message}. Связь не включена, чтобы не подтверждать несохранённые данные.`); }
if (!window.isSecureContext) warning('Микрофон требует HTTPS или localhost. На Android можно использовать HTTPS-сайт либо локальный сервер/ADB.');
controls();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).then(async () => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => { if (data === 'offline-ready') $('offline-status').textContent = 'Файлы приложения сохранены для работы без интернета.'; };
    registration.active?.postMessage('offline-status', [channel.port2]);
  }).catch(() => { $('offline-status').textContent = 'Офлайн-кэш недоступен.'; });
}
