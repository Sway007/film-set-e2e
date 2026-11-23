// Builds a new Film set on the canvas, opens its popup while it builds (the viewer should follow the build), then checks the
// finished card's turntable video: 1280×720, about 30 s per turn, file size.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot } from './lib.mjs';

const CANVAS = process.env.CANVAS_ID || '81438291-cfbc-4915-aea6-e773b8a53b26';
const SENTENCE = process.env.SENTENCE || 'A quiet bus stop at dusk with one bench and a streetlight';
const { ctx, page } = await launch();
try {
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}&perf=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1200);
  await page.getByTestId('add-node-3d-world').click(); await sleep(3000); await dismiss(page);
  const box = page.locator('[data-testid="cinemap-world-empty-brief"]').last();
  await box.scrollIntoViewIfNeeded(); await box.click(); await box.fill(SENTENCE);
  const t0 = Date.now(); await page.keyboard.press('Enter'); log('sent', SENTENCE);
  result.sentence = SENTENCE;
  // While it builds: open its popup once building has started, and take a picture every 20 s for 2 minutes.
  let opened = false; const pics = [];
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    const card = await page.evaluate((s) => { for (const n of document.querySelectorAll('.react-flow__node')) if (n.textContent.includes(s.slice(0, 18))) { const st = n.querySelector('[data-testid*="status"]')?.textContent || ''; const v = n.querySelector('[data-testid="cinemap-world-turntable-video"]'); return { status: st, video: v ? { w: v.videoWidth, h: v.videoHeight, seconds: Math.round(v.duration || 0), src: v.currentSrc } : null, enter: !!n.querySelector('[data-testid="cinemap-world-enter"]'), text: n.textContent.slice(0, 80) }; } return null; }, SENTENCE);
    if (i % 6 === 0) log('card', JSON.stringify(card && { ...card, video: card.video && { ...card.video, src: undefined } }));
    if (!opened && card && /build|搭建|%/i.test(card.text) && !/queued/i.test(card.text)) {
      const ok = await page.evaluate((s) => { for (const n of document.querySelectorAll('.react-flow__node')) if (n.textContent.includes(s.slice(0, 18))) { n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; } return false; }, SENTENCE);
      if (ok) { opened = true; result.liveOpenedAtS = Math.round((Date.now() - t0) / 1000); log('opened popup while building'); for (let k = 0; k < 6; k++) { await sleep(20000); await shot(page, `live-${k}`); pics.push(k); } await page.keyboard.press('Escape'); }
    }
    if (card?.video?.w) { result.video = { w: card.video.w, h: card.video.h, seconds: card.video.seconds }; const bytes = await page.evaluate((u) => fetch(u, { method: 'HEAD' }).then((r) => Number(r.headers.get('content-length')) || null).catch(() => null), card.video.src); result.video.bytes = bytes; result.builtInS = Math.round((Date.now() - t0) / 1000); log('video', JSON.stringify(result.video)); await sleep(8000); await shot(page, 'finished-card'); break; }
    if (card && /failed|失败/i.test(card.text)) { result.failed = card.text; log('failed', card.text); await shot(page, 'failed'); break; }
  }
  result.livePictures = pics.length;
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
