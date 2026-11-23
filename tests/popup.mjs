// Opens a finished Film set's popup on the TapNow canvas: time to the first picture, the light viewer, the canvas holding still,
// the card videos pausing, the shot buttons, memory.
import { FE, BFF, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot, watchOverview, centreNode } from './lib.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
try {
  await countGpuFrames(page);
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  const gpu = await page.evaluate(() => ({ webgpu: !!navigator.gpu, surface: !!document.querySelector('[data-webgpu-surface]'), deviceMemory: navigator.deviceMemory ?? null }));
  result.gpu = gpu; log('gpu', JSON.stringify(gpu));
  const vids = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="cinemap-world-turntable-video"]')].map((v) => ({ playing: !v.paused, w: v.videoWidth, h: v.videoHeight, seconds: Math.round(v.duration || 0) })));
  const frames = () => page.evaluate(() => window.__fsSubmits ?? null);
  // Find the set in the canvas data (on the WebGPU canvas an idle card can have no DOM element), centre it, then open it.
  const target = overview.nodes.find((n) => n.data.cinemap.status === 'ready' && MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no finished set matching ${MATCH} on the canvas (${overview.nodes.length} film set nodes)`);
  const at = await centreNode(page, target, overview.nodes);
  if (!at) throw new Error('could not bring the set to the middle of the canvas');
  log('centred', JSON.stringify(at));
  await page.mouse.move(at.x, at.y); await sleep(5000);
  result.cardsBefore = await vids();
  const f0 = await frames(); await page.mouse.move(at.x + 40, at.y + 20, { steps: 10 }); await sleep(2000);
  result.framesOnHoverBeforeOpen = (await frames()) - f0;
  const t0 = Date.now();
  // The hover button when the card has its DOM, else a double click on the card (opens the same view).
  const viaButton = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].find((e) => { const r = e.getBoundingClientRect(); return r.width && r.x > 0 && r.y > 0 && r.x < innerWidth && r.y < innerHeight; }); if (b) { b.click(); return true; } return false; });
  if (!viaButton) await page.mouse.dblclick(at.x, at.y);
  const clicked = `${target.data.title || target.data.cinemap.brief || target.id}`.slice(0, 40) + (viaButton ? ' (button)' : ' (double click)');
  result.set = clicked; log('opened', clicked);
  let ready = null, state = null;
  for (let i = 0; i < 120; i++) {
    state = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return { dialog: !!d, iframe: !!d?.querySelector('iframe'), inTab: !!d?.querySelector('[data-testid="cinemap-world-open-in-tab"]'), coverShown: c?.hasAttribute('data-shown') ?? null, failed: !!d?.querySelector('[data-testid="cinemap-world-preview-failed"]') }; });
    if (state.iframe && state.coverShown === false) { ready = (Date.now() - t0) / 1000; break; }
    if (state.failed || state.inTab) break;
    await sleep(500);
  }
  result.popup = { ...state, readySeconds: ready }; log('popup', JSON.stringify(result.popup));
  await sleep(3000); await shot(page, '1-popup');
  for (const f of page.frames()) { try { const r = await f.evaluate(() => (window.__workshop ? { lite: !!window.__nodeLite, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null } : null)); if (r) result.viewer = r; } catch {} }
  result.topHeapMB = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  // The canvas behind the popup: frames while open (expect 0), videos paused.
  const f1 = await frames(); await page.setViewportSize({ width: 1500, height: 950 }); await sleep(4000);
  result.framesWhileOpen = (await frames()) - f1; result.cardsWhileOpen = await vids();
  // Turn the camera in the viewer (drag + wheel), then try the first shot button.
  const stage = page.locator('[data-testid="cinemap-world-stage"]');
  const bb = await stage.boundingBox();
  if (bb) { await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 250, bb.y + bb.height / 2 + 40, { steps: 20 }); await page.mouse.up(); await page.mouse.wheel(0, -300); await sleep(2000); await shot(page, '2-turned'); }
  const shotBtn = page.locator('[data-testid="cinemap-world-shots"] button').first();
  if (await shotBtn.count()) { await shotBtn.click(); await sleep(4000); await shot(page, '3-shot'); result.shotButton = 'clicked'; } else result.shotButton = 'none';
  await page.keyboard.press('Escape'); await sleep(3000);
  const f2 = await frames(); await page.setViewportSize({ width: 1600, height: 1000 }); await sleep(3000);
  result.framesAfterClose = (await frames()) - f2; result.cardsAfterClose = await vids();
  await shot(page, '4-closed');
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
