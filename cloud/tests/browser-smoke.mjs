// Explicit opt-in browser check; all HTTP requests are fulfilled from a local test server.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTesterServer } from '../src/tester-server.mjs';
import { joinUrl, registerTester } from '../src/tester-access.mjs';

const root = await mkdtemp(join(tmpdir(), 'tester-browser-'));
const env = { CLOUD_TESTER_HOSTED: '1', CLOUD_TESTER_ORIGIN: 'https://invites.example.test', CLOUD_TESTER_DATA_DIR: join(root, 'testers'), HOST: '127.0.0.1', PORT: '0' };
const server = startTesterServer(env, { embedWorker: false });
const { port } = await server.ready;
const browser = await chromium.launch({ executablePath: process.env.CLOUD_TEST_BROWSER || undefined, timeout: 15000 });
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  const errors = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, env.CLOUD_TESTER_ORIGIN, 'No external requests allowed in this test');
    const headers = { ...await request.allHeaders() };
    delete headers.host;
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() || undefined });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.goto(joinUrl(env));
  await page.getByLabel('Email', { exact: true }).fill('browser@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/workspace');
  await page.getByText('Signed in as browser@example.test.', { exact: false }).waitFor();
  for (const [label, value] of Object.entries({ Name: 'Browser Tester', 'Application email': 'browser@example.test', Phone: '+1 555 0100', Location: 'Toronto, Canada', 'Work authorization': 'Canada', 'Skills, separated by commas': 'TypeScript, React', 'Role families, separated by commas': 'full-stack', 'Seniority, separated by commas': 'senior', 'Target locations, separated by commas': 'Canada', 'Work modes, separated by commas': 'remote', 'Years of experience': '6' })) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByLabel('Résumé PDF (up to 5 MB)').setInputFiles({ name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/onboard'));
  await page.getByRole('button', { name: 'Save profile and résumé' }).click();
  assert.equal((await savedResponse).status(), 200, await (await savedResponse).text());
  await page.getByText('Saved.', { exact: true }).waitFor();
  await page.getByText('Résumé saved.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Find Greenhouse jobs' }).click();
  await page.getByText('Round queued.', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Signed in as browser@example.test.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Browser Tester');
  assert.doesNotMatch(await page.locator('body').innerText(), /Lever|Ashby|live browser|laptop/i);
  await page.screenshot({ path: join(root, 'workspace.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/sign-in');
  for (let i = 1; i < 25; i++) await registerTester(`browser${i}@example.test`, 'browser-test-password', env);
  await page.goto(joinUrl(env));
  await page.getByText('Sign-up is closed. All 25 tester accounts have been created.', { exact: true }).waitFor();
  assert.equal(await page.locator('#auth').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`Browser smoke passed: join, sign-in, profile/PDF, round, reload, mobile layout, logout, closed join. Screenshot: ${join(root, 'workspace.png')}`);
} finally {
  await browser.close();
  await server.close();
}
