// Shared helpers: one persistent browser profile on this Mac, so the TapNow sign-in survives between runs.
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FE = process.env.FE_HOST || 'tapnow-pr-2178.cinemap.space';
export const BFF = process.env.BFF_ENV || 'pr-10837';
export const OUT = path.resolve(process.env.OUT_DIR || path.join(os.homedir(), '.film-set-e2e', 'results', process.env.RUN_TAG || `local-${Date.now()}`));
fs.mkdirSync(OUT, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const lines = [];
export const log = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`; lines.push(s); console.log(s); };
export const result = {};
export function save() {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n'));
  console.log('RESULT_JSON ' + JSON.stringify(result)); console.log('Screenshots and recording on this Mac: ' + OUT);
}

/** Opens the browser: Chrome with the Mac's GPU (or WebKit, Safari's engine), headed so the GPU is really used. */
export async function launch(browserName = process.env.BROWSER || 'chromium') {
  const dir = path.join(os.homedir(), '.film-set-e2e', `profile-${browserName}`);
  const headless = process.env.HEADLESS === '1';
  const opts = { viewport: { width: 1600, height: 1000 }, headless, recordVideo: { dir: OUT, size: { width: 1600, height: 1000 } } };
  const ctx = browserName === 'webkit'
    ? await webkit.launchPersistentContext(dir, opts)
    : await chromium.launchPersistentContext(dir, { ...opts, channel: process.env.CHROME_CHANNEL || undefined, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  result.browser = browserName; result.userAgent = await page.evaluate(() => navigator.userAgent);
  return { ctx, page };
}

/** Vercel share link (from the PR's preview comment) once, then TapNow sign-in from the repo secrets when the page asks for it. */
export async function signIn(page) {
  const share = process.env.VERCEL_SHARE;
  await page.goto(`https://${FE}/${share ? `?_vercel_share=${share}&` : '?'}bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // The share link and the app both redirect: wait until the page settles before looking at it.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(5000);
  const needsLogin = async () => { try { return /auth-login|\/login/.test(page.url()) || (await page.locator('text=Try Free').count()) > 0; } catch { await sleep(2000); return /auth-login|\/login/.test(page.url()); } };
  if (!(await needsLogin())) { log('already signed in'); return; }
  if (!process.env.T_USER || !process.env.T_PASS) throw new Error('Not signed in and no TAPNOW_USER / TAPNOW_PASS secrets');
  await page.keyboard.press('Escape');
  const tryFree = page.locator('text=Try Free');
  if (await tryFree.count().catch(() => 0)) { await tryFree.last().click(); await sleep(4000); }
  const got = page.getByRole('button', { name: /^Got it$/ }); if (await got.count().catch(() => 0)) await got.first().click({ force: true, timeout: 5000 }).catch(() => {});
  await page.getByPlaceholder(/Email address/i).fill(process.env.T_USER, { timeout: 60000 });
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.locator('input[type=password]').first().waitFor({ timeout: 60000 });
  await page.locator('input[type=password]').first().fill(process.env.T_PASS);
  await page.keyboard.press('Enter'); await sleep(10000);
  log('signed in');
}

export async function dismiss(page) {
  for (const name of ['Not now', 'Got it', 'Skip']) await page.getByRole('button', { name }).first().click({ timeout: 1500 }).catch(() => {});
  for (let i = 0; i < 4 && (await page.locator('[role="dialog"][data-state="open"]').count()); i++) { await page.keyboard.press('Escape'); await sleep(600); }
}

/** Counts WebGPU submits (the canvas's frames) from before the page loads. */
export async function countGpuFrames(page) {
  await page.addInitScript(() => {
    window.__fsSubmits = 0;
    const patch = () => { const Q = window.GPUQueue; if (Q && !Q.prototype.__fs) { const s = Q.prototype.submit; Q.prototype.submit = function (...a) { window.__fsSubmits++; return s.apply(this, a); }; Q.prototype.__fs = 1; } };
    patch(); queueMicrotask(patch);
  });
}

export const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 30000 }).catch((e) => log('screenshot skipped', name, e.message.slice(0, 80)));
