import { MAX_BYTES, encodePacket } from './packet.js';
import { PROFILE, duration, modulate } from './modem.js';
import { readMessages, saveMessage, clearMessages } from './storage.js';

const $ = id => document.getElementById(id);
let context, capture, stream, microphone, silent, source, wakeLock;
let receiving = false, sending = false, testing = false, requesting = false;
let passed = 0, failed = 0;
let messageId = Math.floor(Math.random() * 65536);
let worker = makeWorker();

function status(text, mode = '') { $('status').textContent = text; $('status-dot').className = `dot ${mode}`; }
function warning(text) { $('context-warning').hidden = false; $('context-warning').textContent = text; }
function makeWorker() {
  const instance = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });
  instance.onmessage = ({ data }) => {
    if (data.type === 'test-result') {
      testing = false;
      $('test-result').textContent = data.ok ? `Самопроверка пройдена: текст восстановлен, CRC верна. AFC: ${data.offset.toFixed(1)} Гц. Это программный тест; микрофон не использовался.` : 'Самопроверка не пройдена.';
      controls(); return;
    }
    if (!receiving) return;
    if (data.type === 'level') {
      $('level').value = data.rms;
      $('level-value').textContent = `${(20 * Math.log10(Math.max(data.rms, 1e-6))).toFixed(0)} dBFS`;
      if (data.offset !== null) $('afc').textContent = `${data.offset.toFixed(1)} Гц`;
    }
    if (data.type === 'sync') {
      $('afc').textContent = `${data.offset.toFixed(1)} Гц`;
      $('sync').textContent = 'Преамбула найдена · принимаю пакет';
      status('Принимаю сообщение…', 'active');
    }
    if (data.type === 'error') { failed++; $('sync').textContent = data.message; updateCounts(); }
    if (data.type === 'search') status('Слушаю эфир', 'active');
    if (data.type === 'packet') {
      passed++; updateCounts();
      $('sync').textContent = 'Пакет принят · CRC верна';
      if (data.packet.to === $('from').value || data.packet.to === 'ALL') addMessage({ ...data.packet, direction: 'rx', at: Date.now(), offset: data.offset });
      else $('sync').textContent = `Пакет для ${data.packet.to} · пропущен`;
    }
  };
  instance.onerror = () => {
    if (receiving) stopListening();
    testing = false; controls();
    status('Ошибка приёмника. Перезагрузите страницу.');
  };
  return instance;
}
function updateCounts() { $('counts').textContent = `${passed} / ${failed}`; }
function controls() {
  const n = new TextEncoder().encode($('text').value).length;
  $('byte-count').textContent = `${n} / ${MAX_BYTES} байт`;
  $('byte-count').className = n > MAX_BYTES ? 'over' : '';
  $('duration').textContent = n && n <= MAX_BYTES ? `≈ ${duration(new Uint8Array(n + 12)).toFixed(1)} с` : '—';
  $('send').disabled = sending || requesting || testing || n === 0 || n > MAX_BYTES || !window.AudioContext;
  $('listen').disabled = sending || requesting || testing || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode;
  $('listen').textContent = requesting ? 'Доступ к микрофону…' : receiving ? 'Остановить приём' : 'Слушать';
  $('selftest').disabled = sending || receiving || requesting || testing;
  $('from').disabled = $('to').disabled = sending || receiving || requesting;
  $('text').disabled = sending;
  $('stop-tx').hidden = !sending;
  document.querySelector('.receive').classList.toggle('listening', receiving);
}
async function audio() {
  context ??= new AudioContext({ latencyHint: 'interactive' });
  await context.resume();
  if (context.state !== 'running') throw new Error('Браузер приостановил звук. Нажмите кнопку ещё раз.');
  $('audio-rate').textContent = `${context.sampleRate} → ${PROFILE.rate} Гц`;
  return context;
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Foreground use is still possible. */ }
}
function stopListening() {
  receiving = false;
  capture?.disconnect(); microphone?.disconnect(); silent?.disconnect();
  stream?.getTracks().forEach(track => track.stop());
  capture = microphone = silent = stream = undefined;
  worker.postMessage({ type: 'reset' });
  wakeLock?.release().catch(() => {}); wakeLock = undefined;
  $('level').value = 0; $('level-value').textContent = '—';
  $('sync').textContent = 'Ожидание';
  status('Приём остановлен'); controls();
}
async function startListening() {
  if (receiving || requesting) return;
  requesting = true; controls();
  try {
    const ctx = await audio();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    worker.postMessage({ type: 'reset' });
    microphone = ctx.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(ctx, 'rb-capture');
    capture.port.onmessage = ({ data }) => { if (receiving) worker.postMessage({ type: 'samples', samples: data }, [data.buffer]); };
    silent = ctx.createGain(); silent.gain.value = 0;
    microphone.connect(capture); capture.connect(silent); silent.connect(ctx.destination);
    receiving = true;
    await keepAwake();
    $('sync').textContent = 'Поиск преамбулы'; status('Слушаю эфир', 'active');
  } catch (error) {
    stopListening();
    status(error.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в настройках сайта.' : `Не удалось включить приём: ${error.message}`);
  } finally { requesting = false; controls(); }
}
async function send() {
  if (sending || requesting || testing) return;
  const packet = { text: $('text').value, from: $('from').value, to: $('to').value, id: messageId++ & 65535 };
  let bytes;
  try { bytes = encodePacket(packet.text, packet); } catch (error) { status(error.message); return; }
  if (receiving) stopListening();
  sending = true; controls(); status('Подготавливаю передачу…', 'tx');
  try {
    const ctx = await audio();
    const samples = modulate(bytes);
    const buffer = ctx.createBuffer(1, samples.length, PROFILE.rate);
    buffer.copyToChannel(samples, 0);
    source = ctx.createBufferSource(); source.buffer = buffer; source.connect(ctx.destination);
    let interrupted = false;
    $('stop-tx').onclick = () => { interrupted = true; source?.stop(); };
    const done = new Promise(resolve => { source.onended = resolve; });
    source.start(); status(`Передаю… ≈ ${duration(bytes).toFixed(1)} с`, 'tx');
    await done;
    source.disconnect(); source = undefined;
    if (!interrupted) await addMessage({ ...packet, direction: 'tx', at: Date.now() });
    status(interrupted ? 'Передача прервана' : 'Звук передан. Приём на другом устройстве не подтверждён.');
  } catch (error) { status(`Ошибка передачи: ${error.message}`); }
  finally { sending = false; controls(); }
}
function renderMessage(message, prepend = true) {
  const item = document.createElement('li'); item.className = `message ${message.direction}`;
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const type = document.createElement('strong'); type.textContent = message.direction === 'rx' ? 'ПРИНЯТО · CRC ✓' : 'ЗВУК ПЕРЕДАН';
  const route = document.createElement('span'); route.textContent = `${message.from} → ${message.to} · #${message.id}`;
  const time = document.createElement('time'); time.dateTime = new Date(message.at).toISOString(); time.textContent = new Date(message.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  meta.append(type, route, time);
  const body = document.createElement('p'); body.textContent = message.text;
  item.append(meta, body);
  $('messages')[prepend ? 'prepend' : 'append'](item);
  while ($('messages').children.length > 100) $('messages').lastChild.remove();
  $('empty').hidden = true;
}
async function addMessage(message) {
  renderMessage(message);
  try { await saveMessage(message); } catch { warning('Сообщения отображаются, но браузер не разрешил сохранить журнал локально.'); }
}

$('text').addEventListener('input', controls);
$('send').onclick = send;
$('listen').onclick = () => receiving ? stopListening() : startListening();
$('from').onchange = () => {
  $('to').value = $('from').value === 'BASE' ? 'FIELD' : 'BASE';
  try { localStorage.setItem('rb-device', $('from').value); } catch { /* Optional preference. */ }
};
$('clear').onclick = async () => {
  try { await clearMessages(); $('messages').replaceChildren(); $('empty').hidden = false; }
  catch { warning('Браузер не разрешил очистить локальный журнал.'); }
};
$('selftest').onclick = () => {
  testing = true; controls(); $('test-result').textContent = 'Проверяю модем…';
  worker.postMessage({ type: 'selftest', text: 'Привет, RadioBridge!' });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && receiving) {
    keepAwake();
    if (context?.state !== 'running') { stopListening(); status('Звук приостановлен. Нажмите «Слушать» снова.'); }
  }
});
window.addEventListener('pagehide', () => { if (receiving) stopListening(); source?.stop(); });

try { const saved = localStorage.getItem('rb-device'); if (saved === 'BASE' || saved === 'FIELD') { $('from').value = saved; $('to').value = saved === 'BASE' ? 'FIELD' : 'BASE'; } } catch { /* Optional preference. */ }
try { for (const message of (await readMessages()).slice(-100)) renderMessage(message); } catch { warning('Локальное хранилище недоступно. Журнал сохранится только до закрытия страницы.'); }
if (!window.isSecureContext) warning('Для микрофона на Android откройте страницу по HTTPS с доверенным сертификатом. Обычный HTTP по адресу ноутбука не даёт доступ к микрофону. На самом ноутбуке подходит localhost.');
else if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) warning('Этот браузер не поддерживает необходимый аудиоввод. Используйте актуальный Chrome на Android или ноутбуке.');
controls();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).then(async registration => {
    await navigator.serviceWorker.ready;
    const active = registration.active ?? navigator.serviceWorker.controller;
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => { if (data === 'offline-ready') $('offline-status').textContent = 'Файлы приложения сохранены для работы без интернета.'; };
    active?.postMessage('offline-status', [channel.port2]);
  }).catch(() => { $('offline-status').textContent = 'Офлайн-кэш недоступен. Пока не закрывайте страницу без сети.'; });
}
