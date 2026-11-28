// Sway 11-28 (Ethan's report: a canvas with many shot clips gets laggy): what on the canvas page actually costs. Opens CANVAS_ID,
// then for each view (as loaded, then fit to screen with F) samples for PLAY_SECONDS:
//   - <video> elements: on the page, playing, with a decoded frame, preload=auto; poster images shown / failed to load;
//   - iframes: all, CineMap ones by kind (clip render = render=clips, node viewer = embed=node, other), and hidden or not;
//   - the page's rAF rate (p50 / p95 / frames over 50 ms), long tasks, JS heap; each CineMap frame's own rAF rate and long tasks;
//   - video bytes fetched while sampling.
// Then, as a check of cause, the same sample with every CineMap iframe hidden (display:none: Chromium stops drawing them).
// Only numbers and short labels are printed (public repo); screenshots stay on the Mac.
import { FE, BFF, OUT, launch, dismiss, sleep, log, result, save, shot } from './lib.mjs';

let CANVAS = process.env.CANVAS_ID; const SHARE_URL = process.env.SHARE_URL || '';
if (!CANVAS && !SHARE_URL) throw new Error('CANVAS_ID or SHARE_URL input is required');
const SECONDS = Math.max(6, Number(process.env.PLAY_SECONDS || 20));

const { ctx, page } = await launch();
const kindOf = (u) => { try { const x = new URL(u); if (!/cinemap/.test(x.host)) return null; return x.searchParams.get('render') === 'clips' ? 'clipRender' : x.searchParams.get('embed') === 'node' ? 'nodeViewer' : 'other'; } catch { return null; } };
const cmFrames = () => page.frames().filter((f) => f !== page.mainFrame() && kindOf(f.url()));

const startProbe = (frame) => frame.evaluate(() => {
  const s = (window.__cl = { d: [], last: performance.now(), on: true, n: 0, ms: 0, max: 0 });
  const tick = (t) => { if (!s.on) return; s.d.push(t - s.last); s.last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  try { s.o = new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.n++; s.ms += e.duration; s.max = Math.max(s.max, e.duration); } }); s.o.observe({ type: 'longtask', buffered: false }); } catch {}
  s.res0 = performance.getEntriesByType('resource').length;
}).catch(() => {});
const stopProbe = (frame) => frame.evaluate(() => {
  const s = window.__cl; if (!s) return null; s.on = false; s.o?.disconnect();
  const d = s.d.slice(1).sort((a, b) => a - b); const sum = d.reduce((a, b) => a + b, 0); const p = (q) => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(1) : null);
  const vids = performance.getEntriesByType('resource').slice(s.res0).filter((r) => r.initiatorType === 'video' || /\.(mp4|webm|mov)(\?|$)/.test(r.name));
  return { fps: d.length ? +(d.length / (sum / 1000)).toFixed(1) : null, p50: p(0.5), p95: p(0.95), over50: d.filter((x) => x > 50).length, longTasks: s.n, longMs: Math.round(s.ms), longMax: Math.round(s.max),
    videoFetches: vids.length, videoKB: Math.round(vids.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
}).catch((e) => ({ error: e.message.slice(0, 80) }));

const census = () => page.evaluate(() => {
  const v = [...document.querySelectorAll('video')];
  const posters = [...document.querySelectorAll('img[data-testid="video-poster"]')];
  const frames = [...document.querySelectorAll('iframe')].map((f) => { let kind = 'other'; try { const x = new URL(f.src, location.href); if (/cinemap/.test(x.host)) kind = x.searchParams.get('render') === 'clips' ? 'clipRender' : x.searchParams.get('embed') === 'node' ? 'nodeViewer' : 'cinemapOther'; else kind = 'nonCinemap'; } catch {} const r = f.getBoundingClientRect(); return { kind, w: Math.round(r.width), h: Math.round(r.height), hidden: getComputedStyle(f).display === 'none' }; });
  const byKind = {}; for (const f of frames) { const k = (byKind[f.kind] ||= { n: 0, sizes: [] }); k.n++; if (k.sizes.length < 4) k.sizes.push(`${f.w}x${f.h}${f.hidden ? ' hidden' : ''}`); }
  return { videos: v.length, playing: v.filter((x) => !x.paused).length, decoded: v.filter((x) => x.readyState >= 2).length, preloadAuto: v.filter((x) => x.preload === 'auto').length,
    videoSizes: v.slice(0, 6).map((x) => `${x.videoWidth}x${x.videoHeight}${x.paused ? '' : ' playing'}`),
    posters: posters.length, postersFailed: posters.filter((i) => i.complete && i.naturalWidth === 0).length,
    iframes: frames.length, byKind, nodes: document.querySelectorAll('.react-flow__node').length };
}).catch((e) => ({ error: e.message.slice(0, 80) }));

async function sample(name) {
  const frames = cmFrames();
  await startProbe(page.mainFrame()); for (const f of frames) await startProbe(f);
  const before = await census();
  await sleep(SECONDS * 1000);
  const out = { before, after: await census(), page: await stopProbe(page.mainFrame()), cinemapFrames: [] };
  for (const f of frames) out.cinemapFrames.push({ kind: kindOf(f.url()), ...(await stopProbe(f)) });
  log(name, JSON.stringify(out));
  await shot(page, name);
  return out;
}

try {
  if (process.env.CM_SHARE) { await page.goto(`https://pr-11305.cinemap.space/?_vercel_share=${process.env.CM_SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(3000); }
  // Sway 11-28: a share link instead of a canvas id: clone it into the signed-in account (克隆项目 / Clone Project) and measure the copy.
  if (SHARE_URL) {
    await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    log('opened the share link — sign in in this window if asked; waiting up to 30 min for the Clone Project button');
    const btn = page.getByRole('button', { name: /^(克隆项目|Clone Project)$/ });
    const until = Date.now() + 30 * 60_000;
    while (Date.now() < until && !(await btn.count().catch(() => 0))) await sleep(3000);
    if (!(await btn.count().catch(() => 0))) throw new Error('no Clone Project button on the share page within 30 min');
    await sleep(3000); await btn.first().click();
    const got = await page.waitForURL(/\/(canvas|p)\/[0-9a-f-]{36}/, { timeout: 120000 }).then(() => true).catch(() => false);
    const m = page.url().match(/\/(?:canvas|p)\/([0-9a-f-]{36})/);
    if (!got || !m) throw new Error('clone did not open a new canvas');
    CANVAS = m[1];
    (await import('node:fs')).writeFileSync((await import('node:path')).join(OUT, 'cloned-canvas.txt'), CANVAS + '\n');
    result.clonedCanvas = CANVAS.slice(0, 8); log('cloned into canvas', CANVAS.slice(0, 8));
  }
  // Sway 11-28: no sign-in by script. The window opens on the canvas; whoever is at the Mac signs in to Vercel and TapNow there
  // (up to 30 min, coming back to the canvas once signed in). Measuring starts once the canvas shows its nodes.
  const url = `https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  log('opened the canvas — sign in to Vercel and TapNow in this window if asked; the test waits up to 30 min');
  const deadline = Date.now() + 30 * 60_000; let ready = false, lastNudge = 0;
  while (Date.now() < deadline) {
    const onCanvas = (() => { try { const u = new URL(page.url()); return u.host === FE && u.pathname.includes(`/p/${CANVAS}`); } catch { return false; } })();
    const nodes = onCanvas ? await page.locator('.react-flow__node').count().catch(() => 0) : 0;
    if (nodes > 0) { ready = true; break; }
    // signed in somewhere else on TapNow (home page): go back to the canvas, at most every 20 s
    try { const u = new URL(page.url()); if (u.host === FE && !onCanvas && !/login|auth/.test(u.pathname) && Date.now() - lastNudge > 20000) { lastNudge = Date.now(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}); } } catch {}
    await sleep(3000);
  }
  if (!ready) throw new Error('canvas never showed its nodes (not signed in within 30 min, or no access to this canvas)');
  log('canvas loaded, settling 25 s');
  await sleep(25000); await dismiss(page);
  result.env = await page.evaluate(() => ({ dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, w: innerWidth, h: innerHeight })).catch(() => null);
  result.asLoaded = await sample('1-as-loaded');
  await page.mouse.move(result.env?.w ? result.env.w * 0.7 : 900, 400); await page.keyboard.press('f').catch(() => {}); await sleep(4000);
  result.fit = await sample('2-fit');
  // Cause check: hide every CineMap iframe and sample again.
  result.hiddenCount = await page.evaluate(() => { let n = 0; for (const f of document.querySelectorAll('iframe')) { try { if (/cinemap/.test(new URL(f.src, location.href).host)) { f.dataset.clHid = f.style.display; f.style.display = 'none'; n++; } } catch {} } return n; });
  await sleep(2000);
  result.cinemapHidden = await sample('3-cinemap-hidden');
  await page.evaluate(() => { for (const f of document.querySelectorAll('iframe[data-cl-hid]')) { f.style.display = f.dataset.clHid; delete f.dataset.clHid; } }).catch(() => {});
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
