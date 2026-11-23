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

/**
 * The canvas's film set nodes from its overview (read when the canvas loads), and a way to bring one under the mouse: on the
 * WebGPU canvas an idle card may be drawn by the GPU with no DOM element, so it is found by its position, not its text.
 */
export function watchOverview(page) {
  const box = { nodes: [] };
  page.on('response', async (r) => {
    if (!/\/canvases\/[^/]+\/overview/.test(r.url())) return;
    try { const d = await r.json(); const out = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.type === 'cinemap-world' && o.data?.cinemap) out.push(o); Object.values(o).forEach(walk); } }; walk(d); box.nodes = out; } catch {}
  });
  return box;
}

/** Absolute flow position of a node (adds its parents' positions). */
function flowPos(node, byId) { let x = node.position?.x ?? 0, y = node.position?.y ?? 0, p = node.parent_id || node.parentId; while (p && byId[p]) { x += byId[p].position?.x ?? 0; y += byId[p].position?.y ?? 0; p = byId[p].parent_id || byId[p].parentId; } return { x, y }; }

/** Pans the canvas until the node's centre is in the middle of the pane; returns that screen point. */
export async function centreNode(page, node, all) {
  const byId = Object.fromEntries(all.map((n) => [n.id, n]));
  const { x, y } = flowPos(node, byId);
  const w = node.measured?.width ?? 888, h = node.measured?.height ?? 500;
  for (let i = 0; i < 8; i++) {
    const t = await page.evaluate(() => { const v = document.querySelector('.react-flow__viewport'); const m = v && getComputedStyle(v).transform; const pane = document.querySelector('.react-flow')?.getBoundingClientRect(); if (!m || !pane) return null; const a = new DOMMatrix(m); return { k: a.a, tx: a.e, ty: a.f, px: pane.left, py: pane.top, pw: pane.width, ph: pane.height }; });
    if (!t) return null;
    const sx = t.px + t.tx + (x + w / 2) * t.k, sy = t.py + t.ty + (y + h / 2) * t.k;
    const cx = t.px + t.pw / 2, cy = t.py + t.ph / 2;
    if (Math.abs(sx - cx) < 30 && Math.abs(sy - cy) < 30) return { x: sx, y: sy, zoom: t.k };
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(Math.max(-1500, Math.min(1500, sx - cx)), Math.max(-1500, Math.min(1500, sy - cy)));
    await sleep(700);
  }
  return null;
}
