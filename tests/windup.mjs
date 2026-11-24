// Where the wind-up goes: from the press of Send on a new film set to the first thing on its card. On a fresh canvas in
// canvas_id's team (no CPU slow-down), records:
//  - the first time each request path is seen after Send, from the canvas page and every frame in it (ids and hashes
//    replaced, no query strings): a waterfall of claim, editor load, world open, agent hand-over, first build step;
//  - the card's visible state each second (its words, whether the runner frame is up, whether a live picture shows);
//  - the job's states as the canvas reads them.
// Prints only paths, timings and states (public repo); screenshots stay on this Mac.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, typeIntoEmptyCard } from './lib.mjs';
import { startTrace } from './trace.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const SENTENCE = process.env.SENTENCE || 'A small harbour at dawn with two fishing boats and a wooden pier';
const LIMIT_S = Number(process.env.LIMIT_S || 300);
const { ctx, page } = await launch();
const norm = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\/[0-9a-f]{16,}/gi, '/:hash').replace(/\/v\/[^/]+\//, '/v/:v/').replace(/\/\d{3,}(?=\/|$)/g, '/:n'); } catch { return '?'; } };

try {
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

  let t0 = 0; const ms = () => Date.now() - t0;
  const first = new Map(); const counts = new Map();
  ctx.on('request', (r) => { if (!t0) return; const k = `${r.method()} ${norm(r.url())}`; counts.set(k, (counts.get(k) || 0) + 1); if (!first.has(k)) first.set(k, ms()); });
  const states = []; let last = '';
  page.on('response', async (r) => {
    if (!t0 || !/cinemap-worlds?\/|\/api\/tapnow\/jobs\//.test(r.url()) || r.request().method() !== 'GET') return;
    try { const d = await r.json(); const w = d?.data ?? d; const s = [w?.status, w?.progress?.stage ?? w?.stage, w?.failure_code ?? w?.error_code].filter(Boolean).join('/'); if (s && s !== last) { last = s; states.push({ ms: ms(), s }); } } catch {}
  });
  const marks = []; let prev = '';
  const stopTrace = process.env.TRACE === '0' ? null : await startTrace(ctx, page);
  t0 = Date.now(); await page.keyboard.press('Enter'); log('sent');
  for (let i = 0; i < LIMIT_S; i++) {
    await sleep(1000);
    const m = await page.evaluate(() => {
      const frame = !!document.querySelector('[data-testid="cinemap-runner-frame"]');
      for (const n of document.querySelectorAll('.react-flow__node')) if (n.querySelector('[data-testid^="cinemap-world"]')) {
        const lf = n.querySelector('[data-testid="cinemap-world-live-frame"]'); const live = !!(lf && (lf.tagName === 'IMG' ? lf.naturalWidth : (lf.querySelector('img')?.naturalWidth || lf.querySelector('canvas'))));
        return { frame, live, text: n.textContent.replace(/\s+/g, ' ').slice(0, 70) };
      }
      return { frame, live: false, text: '' };
    });
    let rs = '';
    for (const f of page.frames()) { if (!/cinemap\.space/.test(f.url()) || /tapnow-pr-/.test(f.url())) continue; const d = await f.evaluate(() => { const x = document.documentElement.dataset; return x.cinemapRunnerState ? `${x.cinemapRunnerState}:${x.cinemapRunnerMessage || ''}` : ''; }).catch(() => ''); if (d) { rs = d; break; } }
    const k = `${m.frame ? 'frame' : '-'} | ${m.live ? 'LIVE' : '-'} | runner ${rs.slice(0, 60)} | ${m.text}`;
    if (k !== prev) { prev = k; marks.push({ ms: ms(), k }); log('card', (ms() / 1000).toFixed(1), k); }
    if (m.live && !result.firstLiveMs) { result.firstLiveMs = ms(); await shot(page, 'first-live'); }
    if (result.firstLiveMs && ms() - result.firstLiveMs > 20000) break;
    if (/^(failed|cancelled)/.test(last)) break;
    if (i % 30 === 29) await shot(page, `w-${i}`);
  }
  if (stopTrace) { const tr = await stopTrace(); result.trace = tr; log('trace', JSON.stringify({ events: tr.events, wallS: tr.wallS }));
    for (const t of tr.threads) log(`thread ${t.process} busy ${t.busyMs}ms long ${t.longTasks}/${t.longMs}ms\n  per5s ${t.busyPer5s}\n  ` + t.top.join('\n  ')); }
  result.states = states; result.card = marks;
  result.requests = [...first.entries()].sort((a, b) => a[1] - b[1]).slice(0, 160).map(([k, t]) => `${(t / 1000).toFixed(1)}s x${counts.get(k)} ${k}`);
  log('waterfall\n' + result.requests.join('\n'));
} catch (e) { result.error = String(e?.message || e).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').slice(0, 300); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
