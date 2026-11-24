// Self-check for the two gaps Ethan hit on 11-23 that the other tests missed:
//  1. A new film set on a slow computer: a fresh canvas, the CPU slowed down (THROTTLE, default 4x), then one sentence. The old
//     runner failed this with AGENT_UNAVAILABLE (it waited for the whole world to open and its assistant socket parked after 60 s
//     idle). Records how long each step took, not only whether it ended well.
//  2. Media on the canvas really loads: every video / image URL the canvas nodes point at is fetched (range GET) and its status
//     counted per host. A clip delivered with the wrong File Hub host answered 404 while the card looked fine.
// Prints only states, timings and host/status counts (public repo); screenshots stay on this Mac.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, watchOverview } from './lib.mjs';

const SENTENCE = process.env.SENTENCE || 'A quiet bus stop at dusk with one bench and a streetlight';
const THROTTLE = Math.max(1, Math.min(20, Number(process.env.THROTTLE || 4)));
const CANVAS = process.env.CANVAS_ID || '';
const { ctx, page } = await launch();
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);

async function mediaCheck(label) {
  const urls = new Set();
  for (const n of overview.nodes.concat(overview.all)) {
    const walk = (o) => { if (typeof o === 'string') { if (/^https:\/\/[^ ]+\.(mp4|webm|mov|png|jpe?g|webp)(\?|$)|\/storage\/uploads\//i.test(o)) urls.add(o); } else if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') Object.values(o).forEach(walk); };
    walk(n.data);
  }
  for (const u of await page.evaluate(() => [...document.querySelectorAll('.react-flow__node video, .react-flow__node img')].map((e) => e.currentSrc || e.src).filter((s) => /^https:/.test(s)))) urls.add(u);
  const byHost = {};
  for (const u of urls) {
    let host = '?'; try { host = new URL(u).host; } catch {}
    const r = await page.request.get(u, { headers: { Range: 'bytes=0-1023' }, timeout: 30000, failOnStatusCode: false }).then((x) => x.status()).catch(() => 'error');
    const k = `${host} ${r}`; byHost[k] = (byHost[k] || 0) + 1;
  }
  const bad = Object.entries(byHost).filter(([k]) => !/ 20[06]$/.test(k));
  result[label] = { urls: urls.size, byHost, bad: bad.length };
  log(label, JSON.stringify(result[label]));
}

const overview = watchOverview(page);
overview.all = [];
page.on('response', async (r) => { if (!/\/canvases\/[^/]+\/overview/.test(r.url())) return; try { const d = await r.json(); const out = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id && o.type && o.data) out.push(o); Object.values(o).forEach(walk); } }; walk(d); overview.all = out; } catch {} });

try {
  await signIn(page);
  // The world's job as the canvas polls it: status / stage / error code, each change once, with the failure code.
  const states = []; let last = '';
  page.on('response', async (r) => {
    if (!/cinemap-worlds?\//.test(r.url()) || r.request().method() !== 'GET') return;
    try { const d = await r.json(); const w = d?.data ?? d; const s = [w?.status, w?.progress?.stage ?? w?.stage, w?.failure_code ?? w?.error_code].filter(Boolean).join('/');
      if (s && s !== last) { last = s; states.push({ t: at(), s, error: w?.error ? String(w.error).slice(0, 200) : undefined }); log('world', s); } } catch {}
  });
  // The runner frame's own log lines (claim / submit / fail) without any ids.
  page.on('console', (m) => { const t = m.text(); if (/runner|AGENT_UNAVAILABLE|did not open|park/i.test(t)) log('console', t.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').slice(0, 200)); });

  // With a canvas id: only the media check on that canvas (it already has a film set; one per canvas).
  if (CANVAS) {
    await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(25000); await dismiss(page); await mediaCheck('media'); throw Object.assign(new Error('media only'), { done: true });
  } else {
    await page.goto(`https://${FE}/?bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await sleep(8000); await dismiss(page);
    const u0 = page.url();
    const plus = page.getByText('Canvases', { exact: true }).locator('xpath=..').locator('button').first();
    await plus.click({ timeout: 20000 });
    for (let i = 0; i < 30 && page.url() === u0; i++) await sleep(1000);
    result.newCanvas = page.url() !== u0; log('new canvas', result.newCanvas);
  }
  await sleep(20000); await dismiss(page);

  // Slow computer from here on (Chrome only): the film set's own runner frame is slowed too.
  if (result.browser === 'chromium' && THROTTLE > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); result.throttle = THROTTLE; log('cpu throttle', THROTTLE); }

  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  await page.getByTestId('add-node-3d-world').click(); await sleep(4000); await dismiss(page);
  const box = page.locator('[data-testid="cinemap-world-empty-brief"]').last();
  await box.scrollIntoViewIfNeeded(); await box.click(); await box.fill(SENTENCE);
  await shot(page, 'added');
  const sent = at(); await page.keyboard.press('Enter'); log('sent'); result.sentence = SENTENCE;

  let firstBuilding = null, end = null, cardText = '';
  for (let i = 0; i < 180; i++) {
    await sleep(10000);
    const card = await page.evaluate((s) => { for (const n of document.querySelectorAll('.react-flow__node')) if (n.textContent.includes(s.slice(0, 18))) { const v = n.querySelector('[data-testid="cinemap-world-turntable-video"]'); return { text: n.textContent.slice(0, 160), video: !!(v && v.videoWidth) }; } return null; }, SENTENCE);
    cardText = card?.text || cardText;
    if (firstBuilding == null && (/build|搭建|\d+%/i.test(cardText) && !/queued|排队/i.test(cardText) || /^running|^building/.test(last))) { firstBuilding = at() - sent; log('building after', firstBuilding, 's'); }
    if (i % 6 === 5) await shot(page, `wait-${i}`);
    if (card?.video) { end = 'ready'; break; }
    if (/failed|失败|did not open|out of tapies/i.test(cardText) || /^(failed|cancelled)/.test(last)) { end = 'failed'; break; }
  }
  result.firstBuildingS = firstBuilding; result.endS = at() - sent; result.end = end || 'timeout';
  result.cardText = end === 'failed' ? cardText.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>') : undefined;
  result.states = states; await shot(page, 'end');

  // Lift the throttle, reload so the overview is read fresh, then check every media URL on the canvas.
  if (result.throttle) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(25000); await dismiss(page);
  await mediaCheck('media');
} catch (e) { if (e.done) { log('media only'); } else { result.error = String(e?.message || e).slice(0, 300); log('ERROR', result.error); await shot(page, 'error'); } }
finally { save(); await ctx.close(); }
