// Two isolated browser profiles. Web Audio output is routed to the other profile's virtual
// microphone, then through the real AudioWorklet/resampler/Worker. No transport shortcuts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Receiver } from '../src/modem.js';
import { decodeReliable } from '../src/reliable-protocol.js';
const { chromium } = await import(process.env.RB_PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['tools/serve.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  const [line] = await once(server.stdout, 'data'); const port = /:(\d+)/.exec(line.toString())[1];
  browser = await chromium.launch({ executablePath: process.env.RB_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pages = {}, errors = [], frames = [];
  let dropData = true, dropReport = true;
  for (const role of ['BASE', 'FIELD']) {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
    const page = await context.newPage(); pages[role] = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('routeAudio', async (samples, rate) => {
      const events = [], rx = new Receiver(e => events.push(e)); rx.push(Float32Array.from(samples));
      const packet = events.find(e => e.type === 'packet')?.packet;
      if (!packet) throw new Error('Outgoing audio did not decode');
      const frame = decodeReliable(packet); frames.push(frame);
      console.log(`${role} TX ${frame.kind}${frame.kind === 'DATA' ? ` ${frame.index}` : ''}`);
      if (frame.kind === 'DATA' && frame.index === 1 && dropData) { dropData = false; console.log('TEST: lost DATA 1'); return; }
      if (frame.kind === 'REPORT' && dropReport) { dropReport = false; console.log('TEST: lost REPORT'); return; }
      await pages[frame.to].evaluate(({ samples, rate }) => {
        const ctx = window.testAudioContext, mic = window.testMicrophone;
        const buffer = ctx.createBuffer(1, samples.length, rate); buffer.copyToChannel(Float32Array.from(samples), 0);
        const input = ctx.createBufferSource(); input.testInjection = true; input.buffer = buffer; input.connect(mic); input.start();
        input.onended = () => input.disconnect();
      }, { samples, rate });
    });
    await page.addInitScript(() => {
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        constructor(...args) { super(...args); window.testAudioContext = this; }
        createBufferSource() {
          const source = super.createBufferSource(), start = source.start.bind(source);
          source.start = (...args) => {
            if (!source.testInjection) window.routeAudio([...source.buffer.getChannelData(0)], source.buffer.sampleRate).catch(e => { throw e; });
            return start(...args);
          };
          return source;
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        window.testMicrophone = window.testAudioContext.createMediaStreamDestination();
        return window.testMicrophone.stream;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#from').selectOption(role);
    await page.locator('#listen').click();
    await page.waitForFunction(() => document.querySelector('#listen').textContent === 'Выключить связь');
  }
  const text = 'a' + 'Привет 👋! '.repeat(3); // UTF-8 crosses block boundaries.
  await pages.BASE.locator('#text').fill(text); await pages.BASE.locator('#send').click();
  await pages.BASE.waitForFunction(() => Boolean(document.querySelector('.queue-item[data-state=delivered]')), null, { timeout: 180000 });
  assert.equal(await pages.FIELD.locator('.message.rx p').textContent(), text);
  assert.equal(frames.filter(f => f.kind === 'DATA' && f.index === 0).length, 1);
  assert.equal(frames.filter(f => f.kind === 'DATA' && f.index === 1).length, 2);
  assert.equal(await pages.FIELD.locator('.message.rx').count(), 1);
  console.log('PASS two-browser audio handshake, selective retry and ACK loss');
  await pages.BASE.locator('#listen').click(); await pages.FIELD.locator('#listen').click();
  for (const page of Object.values(pages)) {
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.includes('сохранены'));
    await page.context().setOffline(true); await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await page.locator('#listen').textContent(), 'Включить связь');
  }
  assert.equal(await pages.BASE.locator('.queue-item[data-state=delivered]').count(), 1);
  assert.equal(await pages.FIELD.locator('.message.rx p').textContent(), text);
  assert.deepEqual(errors, []);
  console.log('PASS durable completed outbox/inbox after offline reload, audio remains off');
} finally { await browser?.close(); server.kill('SIGTERM'); }
