#!/usr/bin/env node
// Capture screenshots for visual QA with headless Chrome (no dependencies; Node >= 22).
//
// Usage: node capture_screens.mjs <shots.json> <out-dir>
//
// shots.json:
// {
//   "baseUrl": "http://127.0.0.1:3000",
//   "shots": [
//     { "name": "01-home-desktop-light", "path": "/#/" },
//     { "name": "02-study-answer-phone-dark", "path": "/#/study/1", "viewport": "phone", "theme": "dark",
//       "actions": "document.querySelector('.show-answer').click()", "wait": 600, "fullPage": false }
//   ]
// }
//
// viewport: "desktop" (1280x860, default), "tablet" (820x1180), "phone" (375x812) or {"width","height"}.
//   Phone and tablet also emulate touch (hover: none, pointer: coarse), so touch-only UI shows up.
// theme: "light" (default) or "dark" (prefers-color-scheme).
// actions: JavaScript run in the page after it loads (may use await), e.g. clicks or form input.
// wait: ms to wait after loading and after actions (default 700). fullPage: default true.
// Each shot loads about:blank first, so revisiting the same URL always re-renders the page.
// The browser binary comes from CHROME_PATH or the usual install locations.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [planFile, outDir] = process.argv.slice(2);
if (!planFile || !outDir) {
  console.error('usage: node capture_screens.mjs <shots.json> <out-dir>');
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
mkdirSync(outDir, { recursive: true });

const candidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = candidates.find((p) => existsSync(p));
if (!chromePath) {
  console.error('ERROR: no Chrome/Chromium/Edge found. Set CHROME_PATH to a Chromium-based browser.');
  process.exit(1);
}

const VIEWPORTS = { desktop: [1280, 860, false], tablet: [820, 1180, true], phone: [375, 812, true] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mm-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  let target;
  for (let i = 0; i < 75 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');

  for (const shot of plan.shots) {
    const vp = typeof shot.viewport === 'object' ? [shot.viewport.width, shot.viewport.height, false] : VIEWPORTS[shot.viewport ?? 'desktop'];
    if (!vp) throw new Error(`unknown viewport "${shot.viewport}" in ${shot.name}`);
    const [width, height, touch] = vp;
    const dark = shot.theme === 'dark';
    const wait = shot.wait ?? 700;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: touch });
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
      { name: 'hover', value: touch ? 'none' : 'hover' }, { name: 'any-hover', value: touch ? 'none' : 'hover' },
      { name: 'pointer', value: touch ? 'coarse' : 'fine' }, { name: 'any-pointer', value: touch ? 'coarse' : 'fine' },
    ] });
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    await send('Page.navigate', { url: new URL(shot.path ?? '/', plan.baseUrl).href });
    await sleep(wait);
    if (shot.actions) {
      const res = await send('Runtime.evaluate', { expression: `(async () => { ${shot.actions} })()`, awaitPromise: true });
      if (res.exceptionDetails) {
        console.error(`WARN ${shot.name}: actions threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
        exitCode = 1;
      }
      await sleep(wait);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: shot.fullPage ?? true });
    writeFileSync(join(outDir, `${shot.name}.png`), Buffer.from(data, 'base64'));
    console.log(`saved ${shot.name}.png (${width}x${height}${touch ? ', touch' : ''}, ${dark ? 'dark' : 'light'})`);
  }
  ws.close();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
