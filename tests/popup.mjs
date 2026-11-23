// Opens a finished Film set's popup on the TapNow canvas: time to the first picture, the light viewer, the canvas holding still,
// the card videos pausing, the shot buttons, memory.
import { FE, BFF, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot } from './lib.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
try {
  await countGpuFrames(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  const gpu = await page.evaluate(() => ({ webgpu: !!navigator.gpu, surface: !!document.querySelector('[data-webgpu-surface]'), deviceMemory: navigator.deviceMemory ?? null }));
  result.gpu = gpu; log('gpu', JSON.stringify(gpu));
  const vids = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="cinemap-world-turntable-video"]')].map((v) => ({ playing: !v.paused, w: v.videoWidth, h: v.videoHeight, seconds: Math.round(v.duration || 0) })));
  const frames = () => page.evaluate(() => window.__fsSubmits ?? null);
  // Bring the set's card into view so its video plays.
  await page.evaluate((src) => { const re = new RegExp(src, 'i'); for (const n of document.querySelectorAll('.react-flow__node')) if (re.test(n.textContent)) { n.scrollIntoView({ block: 'center' }); return; } }, MATCH.source);
  await sleep(5000);
  result.cardsBefore = await vids();
  const f0 = await frames(); await page.mouse.move(900, 500); await page.mouse.wheel(0, 200); await sleep(2000);
  result.framesOnPanBeforeOpen = (await frames()) - f0;
  const t0 = Date.now();
  const clicked = await page.evaluate((src) => { const re = new RegExp(src, 'i'); for (const n of document.querySelectorAll('.react-flow__node')) { const b = n.querySelector('[data-testid="cinemap-world-enter"]'); if (b && re.test(n.textContent)) { b.click(); return n.textContent.slice(0, 40); } } return null; }, MATCH.source);
  if (!clicked) throw new Error(`no finished set matching ${MATCH} on the canvas`);
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
