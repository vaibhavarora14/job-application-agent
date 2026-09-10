import { chromeProfileDir, ensureDataDirs } from '../paths.mjs';

export async function withPage(env, fn) {
  ensureDataDirs(env);
  const { chromium } = await import('playwright');
  const headless = env.PLAYWRIGHT_HEADLESS !== '0';
  const context = await chromium.launchPersistentContext(chromeProfileDir(env), {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || await context.newPage();
  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

export async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '');
}

export async function fillMappedFields(page, mapped) {
  let filled = 0;
  for (const field of mapped) {
    const value = field.value;
    if (!value) continue;
    const locator = await locateField(page, field);
    if (!locator) continue;
    try {
      const type = await locator.evaluate((el) => (el.getAttribute('type') || el.tagName).toLowerCase());
      if (type === 'checkbox' || type === 'radio') {
        if (/^(yes|true|1|authorized)$/i.test(value)) await locator.check({ force: true }).catch(() => {});
      } else if (type === 'select' || type === 'select-one') {
        await locator.selectOption({ label: value }).catch(() => locator.selectOption({ value }).catch(() => {}));
      } else {
        await locator.fill(value, { timeout: 3000 });
      }
      filled += 1;
    } catch {
      // leftover fields become attention
    }
  }
  return filled;
}

export async function uploadResume(page, resumePath) {
  if (!resumePath) return false;
  const input = page.locator('input[type="file"]').first();
  if (await input.count() === 0) return false;
  await input.setInputFiles(resumePath);
  await page.waitForTimeout(1500);
  return true;
}

export async function restoreVerifiedFields(page, mapped) {
  for (const field of mapped) {
    if (!field.value || !['firstName', 'lastName', 'email', 'phone', 'name'].includes(field.key)) continue;
    const locator = await locateField(page, field);
    if (!locator) continue;
    try {
      const current = await locator.inputValue();
      if (current && current !== field.value) await locator.fill(field.value);
    } catch {
      // ignore
    }
  }
}

export async function clickSubmit(page) {
  const button = page.getByRole('button', { name: /submit|send application|apply now/i }).first();
  if (await button.count()) {
    await button.click({ timeout: 5000 });
    return true;
  }
  const fallback = page.locator('input[type="submit"], button[type="submit"]').first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 5000 });
    return true;
  }
  return false;
}

async function locateField(page, field) {
  const label = field.label || field.name || '';
  if (label) {
    const byLabel = page.getByLabel(new RegExp(escapeRe(label), 'i')).first();
    if (await byLabel.count()) return byLabel;
  }
  if (field.name) {
    const byName = page.locator(`[name="${cssEscape(field.name)}"]`).first();
    if (await byName.count()) return byName;
  }
  if (field.id) {
    const byId = page.locator(`#${cssEscape(field.id)}`).first();
    if (await byId.count()) return byId;
  }
  if (label) {
    const byPlaceholder = page.getByPlaceholder(new RegExp(escapeRe(label), 'i')).first();
    if (await byPlaceholder.count()) return byPlaceholder;
  }
  return null;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssEscape(value) {
  return String(value).replace(/"/g, '\\"');
}
