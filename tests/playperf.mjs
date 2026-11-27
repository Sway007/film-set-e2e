// Sway 11-27: a finished film set on one canvas (CANVAS_ID, SET_MATCH) — why opening its popup is slow, and why playing it in the
// popup stutters. Records, per open (the first with Chrome's HTTP cache cleared, then OPENS-1 more with it warm, closing in between):
//   - time from the click to: the dialog, the iframe's navigation, the viewer frame, the picture (cover lifted), and what the
//     iframe and viewer frames say about their own loading (navigation + resource timing: count, bytes, slowest, by type);
//   - the network the popup pulled (netCollector) and, with FULL_TRACE=1, a Chrome trace of the open (DevTools Performance panel).
// Then in the last open, playback: the play button in the popup, PLAY_SECONDS of it with a rAF interval sampler in the viewer
// (p50 / p95 / frames over 33 and 50 ms), the renderer's frame stats, a CPU profile of the CineMap process and (FULL_TRACE) a trace.
// Only numbers, paths without query strings and short labels are printed (public repo); traces and screenshots stay on the Mac.
import { FE, BFF, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot, watchOverview, focusBySearch } from './lib.mjs';
import { startTrace, stopTrace } from './perf.mjs';
import { startProfile, stopProfile, netCollector, installFrameStats, readFrameStats } from './profile.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || '.', 'i');
const OPENS = Math.max(1, Number(process.env.OPENS || 2));
const PLAY_SECONDS = Math.max(4, Number(process.env.PLAY_SECONDS || 12));
const FULL_TRACE = process.env.FULL_TRACE === '1';

const { ctx, page } = await launch();
let cdp = null;
const inFrame = (re) => page.frames().find((f) => re.test(f.url()));
const iframeOf = () => inFrame(/\/p\/[^?]+\?embed=node/);
const viewerOf = () => inFrame(/editor\.html/);

/** What a frame says about its own loading: navigation timing and resources (bytes, slowest, by initiator type). */
const selfTiming = (frame) => frame?.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const by = {}; let bytes = 0, decoded = 0, cached = 0;
  for (const r of res) { const k = r.initiatorType || 'other'; const g = (by[k] ||= { n: 0, KB: 0, ms: 0 }); g.n++; g.KB += (r.transferSize || 0) / 1024; g.ms = Math.max(g.ms, Math.round(r.responseEnd)); bytes += r.transferSize || 0; decoded += r.decodedBodySize || 0; if (r.transferSize === 0 && r.decodedBodySize > 0) cached++; }
  for (const g of Object.values(by)) g.KB = Math.round(g.KB);
  const clean = (u) => { try { const x = new URL(u); return x.host.split('.')[0] + x.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>').slice(0, 90); } catch { return '?'; } };
  const slow = [...res].sort((a, b) => b.duration - a.duration).slice(0, 8).map((r) => `${Math.round(r.startTime)}+${Math.round(r.duration)}ms ${Math.round((r.transferSize || 0) / 1024)}KB ${clean(r.name)}`);
  const lastEnd = res.reduce((m, r) => Math.max(m, r.responseEnd), 0);
  const marks = performance.getEntriesByType('mark').filter((m) => !/^phase:/.test(m.name)).slice(0, 30).map((m) => `${m.name}@${Math.round(m.startTime)}`);
  return { nav: nav ? { ttfb: Math.round(nav.responseStart), domInteractive: Math.round(nav.domInteractive), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), KB: Math.round((nav.transferSize || 0) / 1024) } : null,
    resources: res.length, transferMB: +(bytes / 1048576).toFixed(1), decodedMB: +(decoded / 1048576).toFixed(1), fromCache: cached, lastResponseEndMs: Math.round(lastEnd), byType: by, slowest: slow, marks,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
}).catch((e) => ({ error: e.message.slice(0, 80) }));

/** rAF interval sampler in a frame (the viewer): what the eye sees as stutter. */
const startRaf = (frame) => frame?.evaluate(() => { const s = (window.__fsRaf = { d: [], last: performance.now(), on: true }); const tick = (t) => { if (!s.on) return; s.d.push(t - s.last); s.last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }).catch(() => {});
const stopRaf = (frame) => frame?.evaluate(() => { const s = window.__fsRaf; if (!s) return null; s.on = false; const d = s.d.slice(1).sort((a, b) => a - b); const p = (q) => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(1) : null); const sum = d.reduce((a, b) => a + b, 0);
  return { frames: d.length, fps: d.length ? +(d.length / (sum / 1000)).toFixed(1) : null, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: d.length ? +d[d.length - 1].toFixed(0) : null, over33: d.filter((x) => x > 33.4).length, over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length }; }).catch((e) => ({ error: e.message.slice(0, 80) }));

/** Long tasks in a frame (PerformanceObserver), counted from now. */
const startLong = (frame) => frame?.evaluate(() => { const s = (window.__fsLong = { n: 0, ms: 0, max: 0 }); try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.n++; s.ms += e.duration; s.max = Math.max(s.max, e.duration); } }); o.observe({ type: 'longtask', buffered: false }); s.o = o; } catch {} }).catch(() => {});
const stopLong = (frame) => frame?.evaluate(() => { const s = window.__fsLong; if (!s) return null; s.o?.disconnect(); return { longTasks: s.n, longMs: Math.round(s.ms), maxMs: Math.round(s.max) }; }).catch(() => null);

try {
  await countGpuFrames(page);
  const overview = watchOverview(page);
  // CineMap's own preview (Vercel Authentication) once in this profile, so the popup's iframe is not sent to the login page.
  if (process.env.CM_SHARE) { await page.goto(`https://pr-11305.cinemap.space/?_vercel_share=${process.env.CM_SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(3000); }
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  result.gpu = await page.evaluate(() => ({ webgpu: !!navigator.gpu, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency }));
  const target = overview.nodes.find((n) => n.data.cinemap.status === 'ready' && MATCH.test(`${n.data.title || ''} ${n.data.cinemap.title || ''} ${n.data.cinemap.brief || ''}`))
    || overview.nodes.find((n) => MATCH.test(`${n.data.title || ''} ${n.data.cinemap.title || ''} ${n.data.cinemap.brief || ''}`));
  result.nodesOnCanvas = overview.nodes.length;
  if (!target) throw new Error(`no film set matching ${MATCH} (${overview.nodes.length} film set nodes)`);
  result.set = { status: target.data.cinemap.status, stats: target.data.cinemap.stats ?? null, shots: Array.isArray(target.data.cinemap.shots) ? target.data.cinemap.shots.length : null };
  const label = String(target.data.title || target.data.cinemap.title || target.data.cinemap.brief || '').slice(0, 30);
  const at = await focusBySearch(page, label);
  if (!at) throw new Error('could not bring the set to the middle of the canvas');
  await page.mouse.move(at.x, at.y); await sleep(4000);
  await shot(page, '0-focused');

  const net = netCollector(ctx, page);
  const page0 = await ctx.newCDPSession(page);
  result.opens = [];
  for (let i = 0; i < OPENS; i++) {
    const cold = i === 0;
    if (cold) { await page0.send('Network.clearBrowserCache').catch(() => {}); }
    if (FULL_TRACE && cold) cdp = await startTrace(ctx, page);
    net.start();
    const marks = {}; const t0 = Date.now();
    const onNav = (f) => { const u = f.url(); if (!marks.iframeNav && /\/p\/[^?]+\?embed=node/.test(u)) marks.iframeNav = Date.now() - t0; if (!marks.viewerNav && /editor\.html/.test(u)) marks.viewerNav = Date.now() - t0; };
    page.on('framenavigated', onNav);
    let prof = null;
    const onAttach = (f) => { if (!prof && /\/p\/[^?]+\?embed=node/.test(f.url())) prof = ctx.newCDPSession(f).then((s) => startProfile(s).then(() => s)).catch(() => null); };
    if (cold) page.on('framenavigated', onAttach);
    const viaButton = await page.evaluate(({ x, y }) => { const bs = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].map((e) => { const r = e.getBoundingClientRect(); return { e, d: Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y), ok: r.width > 0 }; }).filter((b) => b.ok && b.d < 400).sort((a, b) => a.d - b.d); if (bs[0]) { bs[0].e.click(); return true; } return false; }, at);
    if (!viaButton) await page.mouse.dblclick(at.x, at.y);
    let state = null;
    for (let k = 0; k < 240; k++) {
      state = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]') || document.querySelector('[data-testid="cinemap-world-detail"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return { dialog: !!d, iframe: !!d?.querySelector('iframe'), loading: !!d?.querySelector('[data-testid="cinemap-world-viewer-loading"]'), coverShown: c?.hasAttribute('data-shown') ?? null, failed: !!d?.querySelector('[data-testid="cinemap-world-preview-failed"],[data-testid="cinemap-world-frame-error"]'), inTab: !!d?.querySelector('[data-testid="cinemap-world-open-in-tab"]') }; });
      if (state.dialog && !marks.dialog) marks.dialog = Date.now() - t0;
      if (state.iframe && !marks.iframeEl) marks.iframeEl = Date.now() - t0;
      if (state.iframe && state.coverShown === false) { marks.picture = Date.now() - t0; break; }
      if (state.failed || state.inTab) break;
      await sleep(250);
    }
    page.off('framenavigated', onNav); page.off('framenavigated', onAttach);
    const open = { cold, opened: viaButton ? 'button' : 'double click', marksMs: marks, state };
    await sleep(3000); // let the last loads land before reading resource timing
    open.iframeSelf = await selfTiming(iframeOf());
    open.viewerSelf = await selfTiming(viewerOf());
    open.net = await net.stop();
    const s = prof && (await prof);
    if (s) open.openProfile = await stopProfile(s, 15).catch((e) => ({ error: e.message.slice(0, 80) }));
    if (cdp) { open.trace = await stopTrace(cdp, 'trace-open-cold'); cdp = null; }
    log(`open ${i + 1} (${cold ? 'cold' : 'warm'})`, JSON.stringify(marks));
    await shot(page, `1-open-${i + 1}`);
    result.opens.push(open);
    if (i < OPENS - 1) { await page.keyboard.press('Escape'); await sleep(800); if (await page.locator('[data-testid="cinemap-world-detail-dialog"]').count()) { await page.mouse.click(10, 10); await page.keyboard.press('Escape'); } await sleep(4000); }
  }

  // Playback in the open popup.
  const viewer = viewerOf(), iframe = iframeOf();
  const toggle = page.locator('[data-testid="cinemap-world-playback-toggle"]').first();
  result.playback = { toggle: await toggle.count() };
  if (viewer && (await toggle.count())) {
    await sleep(3000);
    await installFrameStats(viewer); await readFrameStats(viewer);
    // idle reference: same samplers with nothing playing
    await startRaf(viewer); await startLong(viewer); await sleep(3000);
    result.playback.idle = { raf: await stopRaf(viewer), long: await stopLong(viewer), render: await readFrameStats(viewer) };
    let psess = null; if (iframe) { psess = await ctx.newCDPSession(iframe).catch(() => null); if (psess) await startProfile(psess).catch(() => { psess = null; }); }
    if (FULL_TRACE) cdp = await startTrace(ctx, page);
    await startRaf(viewer); await startLong(viewer); await startRaf(page.mainFrame());
    const v0 = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, q: v.getVideoPlaybackQuality?.() })).length);
    await toggle.click();
    await sleep(PLAY_SECONDS * 1000);
    result.playback.playing = {
      seconds: PLAY_SECONDS,
      clock: await page.locator('[data-testid="cinemap-world-playback-clock"]').first().innerText().catch(() => null),
      viewerRaf: await stopRaf(viewer), viewerLong: await stopLong(viewer), render: await readFrameStats(viewer),
      pageRaf: await stopRaf(page.mainFrame()), pageLong: await stopLong(page.mainFrame()),
      videosOnPage: v0,
      viewerHeapMB: await viewer.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null),
      info: await viewer.evaluate(() => { const R = window.__workshop?.renderer; const c = R?.domElement; return { canvas: c ? [c.width, c.height] : null, pixelRatio: R?.getPixelRatio?.() ?? null, shadows: R?.shadowMap?.enabled ?? null, calls: R?.info?.render?.calls ?? null, tris: R?.info?.render?.triangles ?? null, geometries: R?.info?.memory?.geometries ?? null, textures: R?.info?.memory?.textures ?? null, objects: window.__workshop?.objects?.length ?? null, idle: window.__nodeIdle ? { asleep: window.__nodeIdle.asleep } : null }; }).catch((e) => ({ error: e.message.slice(0, 80) })),
    };
    if (psess) result.playback.profile = await stopProfile(psess, 20).catch((e) => ({ error: e.message.slice(0, 80) }));
    if (cdp) { result.playback.trace = await stopTrace(cdp, 'trace-playback'); cdp = null; }
    await shot(page, '2-playing');
    await toggle.click().catch(() => {});
  }
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { if (cdp) await stopTrace(cdp, 'trace-end').catch(() => {}); save(); await ctx.close(); }
