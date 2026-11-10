#!/usr/bin/env node
/**
 * Record the README review-each demo on the owned Greenhouse fixture.
 *
 *   npm run record:review-each-demo
 *   node scripts/record-review-each-demo.mjs --frames /tmp/review-each-frames
 *
 * Serves job-application-agent/fixtures on 127.0.0.1, fills the dummy profile
 * below, attaches a generated file named example-resume.pdf, and stops before
 * Submit. Playwright screenshots are assembled with ffmpeg into
 * docs/review-each-demo.gif.
 *
 * Requires Google Chrome, ffmpeg, and ffprobe. Any request that is not the
 * local fixture server is aborted and fails the run.
 */

import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright-core';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gifPath = join(root, 'docs', 'review-each-demo.gif');
const MAX_GIF_BYTES = 3 * 1024 * 1024;
const VIEW = { width: 800, height: 960 };
const TYPE_DELAY_MS = 90;

export const DEMO_CAPTION = 'Stopped before Submit';
export const DEMO_META = 'Example Co · Remote · Example posting';
export const CAPTION_HOLD_MS = 4000;
export const DEMO_PROFILE = {
  first: 'Example',
  last: 'Person',
  email: 'person@example.test',
  phone: '555-0100',
  location: 'Example City',
  country: 'US',
  resumeName: 'example-resume.pdf',
};

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.2 1.1 1.2 12.4 4.3 9.7 6.6 14.6 8.3 13.8 6.1 8.9 10.6 8.8Z" fill="#0f172a" stroke="#ffffff" stroke-width="0.9" stroke-linejoin="round"/></svg>`;

const DEMO_CSS = `
  html, body { min-height: 100%; }
  body { min-height: 100vh; }
  #demo-cursor {
    position: fixed; left: 0; top: 0; z-index: 10001; width: 22px; height: 22px;
    pointer-events: none; filter: drop-shadow(0 1px 1px rgba(15, 23, 42, 0.45));
  }
  #demo-caption {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 10000;
    margin: 0; padding: 8px 16px; border: 1px solid #e0b15a; border-radius: 999px;
    background: #0f172a; color: #f8fafc; white-space: nowrap; pointer-events: none;
    font: 600 15px/1.2 "IBM Plex Sans", "Segoe UI", sans-serif; letter-spacing: 0.01em;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.28);
  }
`;

export function isLocalFixtureRequest(url, port) {
  return url === 'about:blank'
    || url.startsWith('data:')
    || url.startsWith('blob:')
    || url.startsWith(`http://127.0.0.1:${port}/`);
}

export function exampleResumePdf() {
  const stream = 'BT /F1 18 Tf 72 720 Td (Example Person) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body);
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    trailer += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body + trailer);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function framesDirFromArgs(argv) {
  const index = argv.indexOf('--frames');
  if (index === -1) return process.env.DEMO_FRAMES_DIR || '';
  const value = argv[index + 1];
  if (!value) throw new Error('--frames needs a directory.');
  return value;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not allocate a local port.'));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function startFixtureServer(port) {
  let stderr = '';
  const child = spawn(process.execPath, [join(root, 'job-application-agent/scripts/serve-apply-fixtures.mjs')], {
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

async function waitForFixture(port, server) {
  const deadline = Date.now() + 8000;
  let lastError = new Error('Fixture server did not start.');
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/fixtures/greenhouse/`);
      if (response.ok) return;
      lastError = new Error(`Fixture server status ${response.status}.`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await pause(80);
  }
  const detail = server.stderr().trim();
  throw new Error(detail ? `${lastError.message} ${detail}` : lastError.message);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    pause(1000).then(() => {
      if (server.child.exitCode === null) server.child.kill('SIGKILL');
    }),
  ]);
}

const CHROME_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
];

async function launchChrome() {
  const attempts = [
    { channel: 'chrome', headless: true, timeout: 20000, args: CHROME_ARGS },
    { channel: 'chrome', headless: true, timeout: 20000, args: [...CHROME_ARGS, '--no-sandbox', '--disable-gpu'] },
  ];
  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function capture(page, tape, durationMs) {
  const file = join(tape.dir, `frame-${String(tape.files.length).padStart(4, '0')}.png`);
  await page.screenshot({ path: file });
  tape.files.push({ file, duration: durationMs / 1000 });
  return file;
}

async function placeCursor(page, x, y) {
  await page.evaluate(({ left, top }) => {
    document.getElementById('demo-cursor').style.transform = `translate(${left}px, ${top}px)`;
  }, { left: Math.round(x), top: Math.round(y) });
}

async function moveCursor(page, tape, x, y) {
  const target = { x: Math.round(x), y: Math.round(y) };
  const start = tape.cursor;
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    const left = Math.round(start.x + (target.x - start.x) * (step / steps));
    const top = Math.round(start.y + (target.y - start.y) * (step / steps));
    await placeCursor(page, left, top);
    await capture(page, tape, 70);
  }
  tape.cursor = target;
}

async function pointAt(page, tape, selector, dx, dyRatio) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing ${selector}.`);
  await moveCursor(page, tape, box.x + dx, box.y + box.height * dyRatio);
  return box;
}

async function fillText(page, tape, selector, value) {
  await pointAt(page, tape, selector, 16, 0.5);
  await page.locator(selector).focus();
  for (const character of value) {
    await page.keyboard.insertText(character);
    await capture(page, tape, TYPE_DELAY_MS);
  }
  await capture(page, tape, 200);
}

async function fitFixture(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (overflow <= 1) return;
    const zoom = await page.evaluate(() => Number(document.documentElement.style.zoom || '1'));
    await page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, Math.max(0.78, Number((zoom * 0.96).toFixed(3))));
  }
}

async function showCaption(page) {
  await page.evaluate((text) => {
    const button = document.querySelector('[data-testid="submit-application"]');
    const caption = document.createElement('p');
    caption.id = 'demo-caption';
    caption.textContent = text;
    const gap = window.innerHeight - button.getBoundingClientRect().bottom;
    if (gap < 56) {
      caption.style.top = '12px';
      caption.style.bottom = 'auto';
    }
    document.body.appendChild(caption);
  }, DEMO_CAPTION);
}

function assertDemoState(state, foreign) {
  if (foreign.length > 0) throw new Error(`Blocked a non-local request: ${foreign[0]}`);
  if (!state.href.startsWith('http://127.0.0.1:') || !state.href.includes('/fixtures/greenhouse')) {
    throw new Error('Recording left the local Greenhouse fixture.');
  }
  if (state.href.includes('confirmation')) throw new Error('Submit was activated.');
  if (state.submitText !== 'Submit application') throw new Error('Submit button is not on the final frame.');
  if (state.linkedin !== '') throw new Error('LinkedIn was filled.');
  if (state.badge !== '' || state.note !== '') throw new Error('Demo mode left prove copy on screen.');
  if (state.meta !== DEMO_META) throw new Error('Demo subline was not the example posting.');
  if (state.title !== 'Senior Software Engineer') throw new Error('Role title changed.');
  if (state.cursorOnForm) throw new Error('Cursor still overlaps the form.');
  if (CAPTION_HOLD_MS < 2000) throw new Error('Caption hold is under 2s.');
  const expected = {
    first: DEMO_PROFILE.first,
    last: DEMO_PROFILE.last,
    email: DEMO_PROFILE.email,
    phone: DEMO_PROFILE.phone,
    location: DEMO_PROFILE.location,
    country: DEMO_PROFILE.country,
    resume: DEMO_PROFILE.resumeName,
    caption: DEMO_CAPTION,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) throw new Error(`Field ${key} was not the dummy profile value.`);
  }
}

async function publishGif(tempGif) {
  await mkdir(join(root, 'docs'), { recursive: true });
  const staged = join(root, 'docs', `.review-each-demo.${process.pid}.gif`);
  try {
    await copyFile(tempGif, staged);
    await rename(staged, gifPath);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

async function writeGif(tape) {
  const duration = tape.files.reduce((total, frame) => total + frame.duration, 0);
  if (!(duration >= 10 && duration <= 20)) throw new Error(`GIF duration ${duration.toFixed(2)}s is outside 10-20s.`);
  const listPath = join(tape.dir, 'frames.txt');
  const tempGif = join(tape.dir, 'review-each-demo.gif');
  const lines = ['ffconcat version 1.0'];
  for (const frame of tape.files) {
    lines.push(`file '${frame.file}'`, `duration ${frame.duration.toFixed(3)}`);
  }
  lines.push(`file '${tape.files.at(-1).file}'`);
  await writeFile(listPath, `${lines.join('\n')}\n`);
  const passes = [
    'fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=full[p];[s1][p]paletteuse=dither=none',
    'fps=8,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
  ];
  let bytes = MAX_GIF_BYTES;
  for (const filter of passes) {
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', filter, '-loop', '0', tempGif,
    ], { timeout: 60000 });
    bytes = (await stat(tempGif)).size;
    if (bytes < MAX_GIF_BYTES) {
      await publishGif(tempGif);
      return { bytes, duration };
    }
  }
  await rm(tempGif, { force: true });
  throw new Error(`GIF is ${bytes} bytes, above the 3 MB limit.`);
}

async function record(browser, port, work, framesDir) {
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const tape = { dir: work, files: [], cursor: { x: 0, y: 0 } };
  const foreign = [];
  const origin = `http://127.0.0.1:${port}/`;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocalFixtureRequest(url, port)) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!isLocalFixtureRequest(url, port)) foreign.push(url);
  });
  try {
    await page.goto(`${origin}fixtures/greenhouse/?demo=1`, { waitUntil: 'load' });
    await page.addStyleTag({ content: DEMO_CSS });
    await fitFixture(page);
    const title = await page.locator('h1').boundingBox();
    if (!title) throw new Error('Fixture title is missing.');
    tape.cursor = { x: Math.round(title.x + 8), y: Math.round(title.y + title.height / 2) };
    await page.evaluate(({ html, x, y }) => {
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.innerHTML = html;
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      document.body.appendChild(cursor);
    }, { html: CURSOR_SVG, x: tape.cursor.x, y: tape.cursor.y });
    await capture(page, tape, 1600);
    await fillText(page, tape, '#first_name', DEMO_PROFILE.first);
    await fillText(page, tape, '#last_name', DEMO_PROFILE.last);
    await fillText(page, tape, '#email', DEMO_PROFILE.email);
    await fillText(page, tape, '#phone', DEMO_PROFILE.phone);
    await fillText(page, tape, '#location', DEMO_PROFILE.location);
    await pointAt(page, tape, '#country', 18, 0.5);
    await page.locator('#country').selectOption(DEMO_PROFILE.country);
    await capture(page, tape, 360);
    await pointAt(page, tape, '#resume', 28, 0.5);
    await page.locator('#resume').setInputFiles({
      name: DEMO_PROFILE.resumeName,
      mimeType: 'application/pdf',
      buffer: exampleResumePdf(),
    });
    await capture(page, tape, 700);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const form = await page.locator('#gh-apply').boundingBox();
    if (!form) throw new Error('Form is missing.');
    const restX = 12;
    const restY = Math.round(form.y + 8);
    if (restX + 22 >= form.x) throw new Error('Cursor rest would sit on the form.');
    await moveCursor(page, tape, restX, restY);
    const filled = await capture(page, tape, 1300);
    if (framesDir) await copyFile(filled, join(framesDir, 'filled-form.png'));
    await showCaption(page);
    const stopped = await capture(page, tape, CAPTION_HOLD_MS);
    if (framesDir) await copyFile(stopped, join(framesDir, 'stopped-before-submit.png'));
    const state = await page.evaluate(() => {
      const submit = document.querySelector('[data-testid="submit-application"]');
      const resume = document.querySelector('#resume');
      return {
        href: location.href,
        first: document.querySelector('#first_name').value,
        last: document.querySelector('#last_name').value,
        email: document.querySelector('#email').value,
        phone: document.querySelector('#phone').value,
        location: document.querySelector('#location').value,
        country: document.querySelector('#country').value,
        resume: resume.files[0] ? resume.files[0].name : '',
        linkedin: document.querySelector('#linkedin').value,
        submitText: submit ? submit.textContent.trim() : '',
        caption: document.querySelector('#demo-caption') ? document.querySelector('#demo-caption').textContent : '',
        badge: document.querySelector('.badge') ? document.querySelector('.badge').textContent : '',
        note: document.querySelector('.note') ? document.querySelector('.note').textContent : '',
        meta: document.querySelector('.meta') ? document.querySelector('.meta').textContent : '',
        title: document.querySelector('h1') ? document.querySelector('h1').textContent : '',
        cursorOnForm: (() => {
          const cursor = document.getElementById('demo-cursor').getBoundingClientRect();
          const card = document.getElementById('gh-apply').getBoundingClientRect();
          return cursor.right > card.left && cursor.left < card.right && cursor.bottom > card.top && cursor.top < card.bottom;
        })(),
      };
    });
    assertDemoState(state, foreign);
    const encoded = await writeGif(tape);
    return { path: gifPath, ...encoded };
  } finally {
    await context.close();
  }
}

async function main() {
  const framesDir = framesDirFromArgs(process.argv.slice(2));
  if (framesDir) await mkdir(framesDir, { recursive: true });
  const port = await freePort();
  let server;
  let work;
  let browser;
  try {
    work = await mkdtemp(join(tmpdir(), 'review-each-demo-'));
    server = startFixtureServer(port);
    await waitForFixture(port, server);
    browser = await launchChrome();
    const gif = await record(browser, port, work, framesDir);
    process.stdout.write(`${gif.path} ${gif.bytes} bytes ${gif.duration.toFixed(1)}s\n`);
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
    if (work) await rm(work, { recursive: true, force: true });
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
