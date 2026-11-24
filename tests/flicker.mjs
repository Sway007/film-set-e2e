// Ethan 11-24: a building film set card goes blank for one frame when it is picked and then the empty canvas is clicked.
// On a new canvas (made in CANVAS_ID's team) one set is started; once its card shows a picture (the stage or the live
// picture), the card is clicked, then the empty canvas, CYCLES times. Every compositor frame of the page is taken with
// CDP's screencast and the card's area is measured (mean brightness, how much of it is the dark card ground): a frame
// darker than half the card's own usual brightness counts as blank. What the card's DOM did meanwhile (elements added
// or removed in the card: the live picture, its canvas, the stage frame) is counted from a MutationObserver.
// Prints only counts and timings (public repo); frames are measured in memory, nothing of the canvas is saved but the
// usual screenshots on this Mac.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, typeIntoEmptyCard } from './lib.mjs';

const SENTENCE = process.env.SENTENCE || 'A quiet harbour at noon with one white steamship at the pier';
const CANVAS = process.env.CANVAS_ID || '';
const CYCLES = Math.max(1, Math.min(20, Number(process.env.CYCLES || 6)));
const { ctx, page } = await launch();
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);

// The card's DOM changes, from before the app loads: elements added / removed inside a film set card's face.
await page.addInitScript(() => {
  window.__fl = { muts: [] };
  const tag = (n) => (n.nodeType !== 1 ? null : (n.getAttribute('data-testid') || n.tagName.toLowerCase()));
  const inFace = (n) => n && n.nodeType === 1 && (n.closest?.('[data-testid="cinemap-world-face"]') || n.querySelector?.('[data-testid="cinemap-world-face"]'));
  const start = () => new MutationObserver((list) => {
    const t = performance.now();
    for (const m of list) {
      for (const n of m.addedNodes) if (inFace(n) || inFace(m.target)) window.__fl.muts.push({ t, k: '+', tag: tag(n) });
      for (const n of m.removedNodes) if (inFace(m.target) || (n.nodeType === 1 && n.querySelector?.('[data-testid="cinemap-world-face"]')) || tag(n) === 'cinemap-world-face') window.__fl.muts.push({ t, k: '-', tag: tag(n) });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) start(); else addEventListener('DOMContentLoaded', start);
});

/** What the card shows now, and where it is on screen (CSS px). */
const cardState = () => page.evaluate(() => {
  const faces = [...document.querySelectorAll('[data-testid="cinemap-world-face"]')].filter((f) => f.getBoundingClientRect().width > 50);
  const f = faces[faces.length - 1]; if (!f) return null;
  const r = f.getBoundingClientRect();
  const frame = f.querySelector('iframe');
  const live = f.querySelector('[data-testid="cinemap-world-live-frame"]');
  const motion = f.querySelector('[data-testid="cinemap-world-live-motion"]');
  return {
    x: r.x, y: r.y, w: r.width, h: r.height, faces: faces.length,
    stage: frame ? Number(getComputedStyle(frame).opacity) : null,
    live: !!live, motion: motion ? motion.getAttribute('data-motion') : null,
    inPlane: !!f.closest('[data-plane-layout]'), text: (f.closest('.react-flow__node, [data-id]')?.textContent || '').slice(0, 60),
  };
});

try {
  if (!CANVAS) throw new Error('CANVAS_ID input is required');
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(15000);
  const sw = page.getByRole('button', { name: /^Switch to / });
  if (await sw.count().catch(() => 0)) { log('switching team'); await sw.first().click(); await sleep(20000); }
  await dismiss(page);
  const u0 = page.url();
  await page.getByText('Canvases', { exact: true }).locator('xpath=..').locator('button').first().click({ timeout: 20000 });
  for (let i = 0; i < 30 && page.url() === u0; i++) await sleep(1000);
  if (page.url() === u0) throw new Error('no new canvas');
  await sleep(20000); await dismiss(page);
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  await page.getByTestId('add-node-3d-world').click(); await sleep(4000); await dismiss(page);
  await typeIntoEmptyCard(page, SENTENCE);
  await page.keyboard.press('Enter'); const sent = at(); log('sent');

  // Wait for a picture on the card: the stage shown, or the live picture with its moving canvas on.
  let s = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000); s = await cardState();
    if (s && ((s.stage != null && s.stage > 0.5) || (s.live && s.motion === 'on'))) break;
    if (i % 6 === 5) log('waiting', JSON.stringify({ stage: s?.stage, live: s?.live, motion: s?.motion }));
  }
  result.pictureAfterS = at() - sent;
  result.picture = s ? { stage: s.stage, live: s.live, motion: s.motion, inPlane: s.inPlane } : null;
  log('picture', JSON.stringify(result.picture));
  if (!s) throw new Error('no card');
  await sleep(8000); s = await cardState(); await shot(page, 'picture');

  // Every compositor frame, measured in a second page (an <img> drawn on a canvas): the card's mean brightness.
  const meter = await ctx.newPage();
  await meter.setContent('<canvas id=c></canvas>');
  const cdp = await ctx.newCDPSession(page);
  const vp = page.viewportSize();
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data, w: f.metadata.deviceWidth });
  });
  const pane = await page.evaluate(() => { const r = document.querySelector('.react-flow')?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const card = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  // Empty canvas: the pane's corner farthest from the card.
  const empty = { x: card.x > pane.x + pane.w / 2 ? pane.x + 60 : pane.x + pane.w - 60, y: card.y > pane.y + pane.h / 2 ? pane.y + 90 : pane.y + pane.h - 60 };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
  await sleep(1500);
  const clicks = [];
  const pageNow = () => page.evaluate(() => performance.timeOrigin + performance.now());
  for (let c = 0; c < CYCLES; c++) {
    await page.mouse.click(card.x, card.y); clicks.push({ k: 'pick', t: await pageNow() }); await sleep(1200);
    await page.mouse.click(empty.x, empty.y); clicks.push({ k: 'off', t: await pageNow() }); await sleep(1800);
  }
  await cdp.send('Page.stopScreencast');
  const muts = await page.evaluate(() => window.__fl.muts.map((m) => ({ ...m, t: performance.timeOrigin + m.t })));

  // Measure: card rect in frame pixels (frames are CSS px scaled by w / viewport width).
  const lum = [];
  for (const f of frames) {
    const v = await meter.evaluate(async ({ data, r: r0, vw }) => {
      const img = new Image(); img.src = `data:image/jpeg;base64,${data}`; await img.decode();
      const k = img.naturalWidth / vw; const r = { x: r0.x * k, y: r0.y * k, w: r0.w * k, h: r0.h * k };
      const c = document.getElementById('c'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const x = Math.round(r.x + r.w * 0.1), y = Math.round(r.y + r.h * 0.15), w = Math.round(r.w * 0.8), h = Math.round(r.h * 0.7);
      const d = g.getImageData(x, y, w, h).data; let sum = 0; for (let i = 0; i < d.length; i += 16) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return sum / (d.length / 16);
    }, { data: f.data, r: { x: s.x, y: s.y, w: s.w, h: s.h }, vw: vp.width });
    lum.push({ t: f.t, v });
  }
  const sorted = lum.map((l) => l.v).sort((a, b) => a - b); const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const blank = lum.filter((l) => l.v < median * 0.5);
  // Which click each blank frame follows, and how long after it.
  const after = (t) => { let best = null; for (const c of clicks) if (c.t <= t && (!best || c.t > best.t)) best = c; return best ? { k: best.k, ms: Math.round(t - best.t) } : null; };
  result.frames = lum.length; result.medianBrightness = Math.round(median); result.blankFrames = blank.length;
  result.blank = blank.map((b) => ({ v: Math.round(b.v), ...after(b.t) }));
  result.blankAfterPick = result.blank.filter((b) => b.k === 'pick').length;
  result.blankAfterOff = result.blank.filter((b) => b.k === 'off').length;
  // DOM in the card per click: what was added / removed in the 300 ms after it.
  result.domPerClick = clicks.map((c) => {
    const near = muts.filter((m) => m.t >= c.t - 50 && m.t <= c.t + 300);
    const by = {}; for (const m of near) { const key = `${m.k}${m.tag}`; by[key] = (by[key] || 0) + 1; }
    return { k: c.k, ...by };
  });
  result.cycles = CYCLES; result.afterState = await cardState().then((x) => x && { stage: x.stage, live: x.live, motion: x.motion, inPlane: x.inPlane, faces: x.faces });
  log('frames', lum.length, 'median', Math.round(median), 'blank', blank.length, JSON.stringify(result.blank));
  log('dom per click', JSON.stringify(result.domPerClick));
  await meter.close();
  // Stop the build: this canvas is a test canvas.
  await page.getByRole('button', { name: /^Stop$/ }).first().click({ timeout: 5000 }).catch(() => {});
} catch (e) { result.error = String(e?.message || e).slice(0, 300); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
