// Opens a finished Film set's popup on the TapNow canvas and records a Chrome performance trace (as the DevTools Performance
// panel) through these phases: canvas idle → opening until the 3D view is ready → popup idle → orbit drag → WASD → after close.
// Also: the light viewer, canvas frames and card videos while the popup is open, hover highlight, shot button, memory.
import { FE, BFF, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot, watchOverview, focusBySearch } from './lib.mjs';
import { startTrace, stopTrace } from './perf.mjs';
import { installCounters, openSessions, createRecorder } from './metrics.mjs';
import { startProfile, stopProfile, netCollector, installFrameStats, readFrameStats, backgroundWork, siteCounting } from './profile.mjs';
const FULL_TRACE = process.env.FULL_TRACE === '1';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
let cdp = null;
try {
  await countGpuFrames(page); await installCounters(page);
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  result.gpu = await page.evaluate(() => ({ webgpu: !!navigator.gpu, surface: !!document.querySelector('[data-webgpu-surface]'), deviceMemory: navigator.deviceMemory ?? null }));
  log('gpu', JSON.stringify(result.gpu));
  const vids = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="cinemap-world-turntable-video"]')].map((v) => ({ playing: !v.paused, w: v.videoWidth, h: v.videoHeight, seconds: Math.round(v.duration || 0) })));
  const frames = () => page.evaluate(() => window.__fsSubmits ?? null);
  const target = overview.nodes.find((n) => n.data.cinemap.status === 'ready' && MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no finished set matching ${MATCH} on the canvas (${overview.nodes.length} film set nodes)`);
  result.set = target.data.title || target.data.cinemap.brief; result.stats = target.data.cinemap.stats ?? null;
  const at = await focusBySearch(page, String(result.set).slice(0, 30));
  if (!at) throw new Error('could not bring the set to the middle of the canvas');
  await shot(page, '0-focused');
  await page.mouse.move(at.x, at.y); await sleep(5000);
  result.cardsBefore = await vids();

  if (FULL_TRACE) cdp = await startTrace(ctx, page);
  const rec = createRecorder(page); rec.attach(await openSessions(ctx, page));
  const mark = (_p, name) => rec.mark(name);
  await mark(page, 'canvas-idle'); const f0 = await frames(); await sleep(5000); result.canvasFramesIdle5s = (await frames()) - f0;

  // Profile the iframe's process from the moment it exists (its own process: it is created by the click below), and log its network.
  const net = netCollector(ctx, page); let openProf = null;
  const onNav = (f) => { if (!openProf && /\/p\/[^?]+\?embed=node/.test(f.url())) openProf = ctx.newCDPSession(f).then((s) => startProfile(s)).catch((e) => ({ error: e.message.slice(0, 80) })); };
  page.on('framenavigated', onNav);
  net.start();
  await mark(page, 'open-until-ready'); const t0 = Date.now();
  // The set is in the middle now: its hover button when the card has its DOM (the nearest one to the middle), else a double click.
  const viaButton = await page.evaluate(({ x, y }) => { const bs = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].map((e) => { const r = e.getBoundingClientRect(); return { e, d: Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y), ok: r.width > 0 }; }).filter((b) => b.ok && b.d < 400).sort((a, b) => a.d - b.d); if (bs[0]) { bs[0].e.click(); return true; } return false; }, at);
  if (!viaButton) await page.mouse.dblclick(at.x, at.y);
  let state = null;
  for (let i = 0; i < 180; i++) {
    state = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return { dialog: !!d, iframe: !!d?.querySelector('iframe'), inTab: !!d?.querySelector('[data-testid="cinemap-world-open-in-tab"]'), coverShown: c?.hasAttribute('data-shown') ?? null, failed: !!d?.querySelector('[data-testid="cinemap-world-preview-failed"]') }; });
    if (state.iframe && state.coverShown === false) break;
    if (state.failed || state.inTab) break;
    await sleep(500);
  }
  result.popup = { ...state, readySeconds: state.iframe && state.coverShown === false ? (Date.now() - t0) / 1000 : null, opened: viaButton ? 'button' : 'double click' };
  log('popup', JSON.stringify(result.popup));
  page.off('framenavigated', onNav);
  const prof = await openProf; let profSession = prof && !prof.error ? prof : null;
  if (profSession) result.openProfile = await stopProfile(profSession).catch((e) => ({ error: e.message.slice(0, 80) })); else result.openProfile = prof?.error ?? 'iframe not out of process';
  result.openNet = await net.stop();
  const profileFor = async (ms, fn) => { if (!profSession) return null; await startProfile(profSession); const extra = fn ? await fn() : await sleep(ms); return { ...(await stopProfile(profSession, 12).catch((e) => ({ error: e.message.slice(0, 80) }))), ...(extra || {}) }; };
  await shot(page, '1-popup');
  rec.attach(await openSessions(ctx, page));
  const viewerFrame = page.frames().find((f) => /editor\.html/.test(f.url()));
  const viewerInfo = async () => (viewerFrame ? viewerFrame.evaluate(() => ({ lite: !!window.__nodeLite, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, info: window.__workshop?.renderer?.info?.render ? { calls: window.__workshop.renderer.info.render.calls, triangles: window.__workshop.renderer.info.render.triangles } : null })).catch((e) => ({ error: e.message.slice(0, 80) })) : null);
  result.viewer = await viewerInfo();

  const idleState = () => viewerFrame?.evaluate(() => { const I = window.__nodeIdle, R = window.__nodeRoam; return { idle: I ? { asleep: I.asleep, sleeps: I.sleeps, frames: I.frames, why: I.why ?? null } : null, indoor: !!window.__interior?.inside, roam: !!R, roamMoving: R ? !!R.moving : null, hasFocus: document.hasFocus() }; }).catch((e) => ({ error: e.message.slice(0, 80) }));
  result.idleAtReady = await idleState();
  await mark(page, 'popup-idle'); const f1 = await frames(); await sleep(10000);
  result.idleAfter10s = await idleState();
  // Asleep: what still costs (timers, polling, CSS animations, other loops).
  if (viewerFrame) {
    const iframeFrame = page.frames().find((f) => /\/p\/[^?]+\?embed=node/.test(f.url()));
    const bg0 = { viewer: await backgroundWork(viewerFrame), iframe: iframeFrame ? await backgroundWork(iframeFrame) : null };
    for (const f of [viewerFrame, iframeFrame]) if (f) await siteCounting(f, true);
    await mark(page, 'popup-asleep');
    const p = await profileFor(5000);
    for (const f of [viewerFrame, iframeFrame]) if (f) await siteCounting(f, false);
    const bg1 = { viewer: await backgroundWork(viewerFrame), iframe: iframeFrame ? await backgroundWork(iframeFrame) : null };
    const per5 = (k) => (bg1[k] && bg0[k]?.timers ? { sites: bg1[k].sites, animations: bg1[k].animations, animationNames: bg1[k].animationNames, timeouts5s: bg1[k].timers.timeout - bg0[k].timers.timeout, intervals5s: bg1[k].timers.interval - bg0[k].timers.interval, rafFrames5s: bg1[k].timers.rafFrames - bg0[k].timers.rafFrames } : bg1[k]);
    result.asleep = { state: await idleState(), profile: p, viewer: per5('viewer'), iframe: per5('iframe') };
  }
  if (viewerFrame) await installFrameStats(viewerFrame);
  result.canvasFramesWhilePopupIdle10s = (await frames()) - f1; result.cardsWhileOpen = await vids();
  const stage = await page.locator('[data-testid="cinemap-world-stage"]').boundingBox();
  if (stage) {
    const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
    if (viewerFrame) await readFrameStats(viewerFrame);
    await mark(page, 'popup-hover'); for (let i = 0; i < 40; i++) { await page.mouse.move(cx - 300 + i * 15, cy - 100 + (i % 5) * 40); await sleep(100); } await shot(page, '2-hover');
    result.hoverFrames = viewerFrame ? await readFrameStats(viewerFrame) : null;
    await mark(page, 'popup-orbit');
    result.orbit = await profileFor(0, async () => { await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 400, cy + 60, { steps: 60 }); await page.mouse.up(); await page.mouse.wheel(0, -400); await sleep(1500); return { frames: viewerFrame ? await readFrameStats(viewerFrame) : null }; });
    await shot(page, '3-orbit');
    await mark(page, 'popup-wasd'); await page.mouse.click(cx, cy); const before = await viewerFrame?.evaluate(() => window.__workshop?.camera?.position?.toArray?.() ?? null).catch(() => null);
    result.beforeKeys = await idleState();
    result.focusedFrame = await page.evaluate(() => document.activeElement?.tagName + (document.activeElement?.title ? `:${document.activeElement.title}` : ''));
    if (viewerFrame) await readFrameStats(viewerFrame);
    result.wasdProfile = await profileFor(0, async () => { await page.keyboard.down('w'); await sleep(700); result.whileW = await idleState(); await sleep(800); await page.keyboard.up('w'); await page.keyboard.down('d'); await sleep(1000); await page.keyboard.up('d'); return { frames: viewerFrame ? await readFrameStats(viewerFrame) : null }; });
    const after = await viewerFrame?.evaluate(() => window.__workshop?.camera?.position?.toArray?.() ?? null).catch(() => null);
    result.wasd = { before, after, moved: !!(before && after && before.some((v, i) => Math.abs(v - after[i]) > 0.01)) }; await shot(page, '4-wasd');
  }
  const shotBtn = page.locator('[data-testid="cinemap-world-shots"] button').first();
  if (await shotBtn.count()) { await shotBtn.click(); await sleep(3000); await shot(page, '5-shot'); result.shotButton = 'clicked'; } else result.shotButton = 'none';
  result.viewerEnd = await viewerInfo();
  result.topHeapMB = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

  await mark(page, 'after-close'); await page.keyboard.press('Escape'); await sleep(1000);
  if (await page.locator('[data-testid="cinemap-world-detail-dialog"]').count()) { result.escapeClosedFromViewer = false; await page.mouse.click(10, 10); await page.keyboard.press('Escape'); await sleep(1000); } else result.escapeClosedFromViewer = true;
  const f2 = await frames(); await sleep(5000); result.canvasFramesAfterClose5s = (await frames()) - f2; result.cardsAfterClose = await vids();
  await mark(page, 'end');
  result.phases = rec.report();
  if (cdp) { result.trace = await stopTrace(cdp, 'trace-popup'); cdp = null; }
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { if (cdp) await stopTrace(cdp, 'trace-popup').then((t) => { result.trace = t; }).catch(() => {}); save(); await ctx.close(); }
