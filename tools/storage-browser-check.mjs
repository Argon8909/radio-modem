import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const { chromium } = await import(process.env.RB_PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['tools/serve.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  const [line] = await once(server.stdout, 'data'); const port = /:(\d+)/.exec(line.toString())[1];
  browser = await chromium.launch({ executablePath: process.env.RB_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/src/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('radiobridge', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'key', autoIncrement: true });
    request.onerror = () => reject(request.error.message);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').add({ from: 'FIELD', to: 'BASE', text: 'Старый журнал', id: 7, at: Date.now(), direction: 'rx' });
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.unroute('**/src/app.js'); await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.locator('.message p').textContent(), 'Старый журнал');
  console.log('PASS actual IndexedDB v1→v2 migration preserves old history');
  await page.locator('#transfer-settings').evaluate(el => { el.open = true; });
  await page.locator('#block-size').selectOption('32');
  await page.locator('#max-blocks').evaluate(el => { el.value = '64'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#retry-count').fill('2'); await page.locator('#retry-interval').fill('15');
  await page.locator('#text').fill('a'.repeat(49));
  assert.equal(await page.locator('#send').isEnabled(), true);
  assert.equal(await page.locator('#byte-count').textContent(), '49 / 2048 байт');
  // Two same-turn clicks must create only one durable outgoing message.
  await page.locator('#send').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1 && document.querySelector('#listen').textContent === 'Выключить связь');
  await page.locator('#listen').click();
  await page.waitForFunction(() => document.querySelector('.queue-item')?.dataset.state === 'queued');
  const editor = page.locator('.retry-editor'); await editor.locator('summary').click();
  await editor.locator('input').nth(0).fill('4'); await editor.locator('input').nth(1).fill('25');
  await editor.locator('button').click();
  await page.waitForFunction(() => document.querySelector('.queue-item')?.textContent.includes('0/4'));
  await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.locator('.queue-item').count(), 1);
  assert.ok((await page.locator('.queue-item').textContent()).includes('0/4'));
  assert.equal(await page.locator('.retry-editor input').nth(1).inputValue(), '25');
  assert.equal(await page.locator('#block-size').inputValue(), '32');
  assert.equal(await page.locator('#max-blocks').inputValue(), '64');
  assert.equal(await page.locator('#retry-interval').inputValue(), '15');
  assert.equal(await page.locator('#listen').textContent(), 'Включить связь');
  assert.deepEqual(errors, []);
  console.log('PASS queue, individual retry policy, defaults and paused audio survive reload; no double-click duplicate');
} finally { await browser?.close(); server.kill('SIGTERM'); }
