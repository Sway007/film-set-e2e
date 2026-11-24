// What the TapNow canvas page pays while a film set builds, with the runner in the page (today) versus elsewhere
// (the cloud runner, simulated on this Mac by a second, separate browser that opens CineMap's ordinary runner page).
//   MODE=frame  : today's path, the runner iframe inside the canvas page.
//   MODE=cloud  : the canvas tab runs with ?cinemap_runner=off (no in-page runner); browser B (its own processes, headless)
//                 opens /p/<scene>?runner=1&job=<job> top-level and builds. OPEN_VIEW=1 also keeps the set's opened view
//                 (CineMap's live viewer, reloading on each new revision) on screen in the canvas tab while it builds.
// Measures the canvas browser only (all its processes): CPU seconds and peak / mean RSS from `ps`, sampled every 2 s, and a
// Performance-panel summary of its renderer main threads (trace.mjs). Browser B's own cost is reported apart (the server's).
// Prints numbers and states only (public repo); screenshots stay on this Mac.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, typeIntoEmptyCard } from './lib.mjs';
import { startTrace } from './trace.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MODE = process.env.MODE === 'cloud' ? 'cloud' : 'frame';
const OPEN_VIEW = process.env.OPEN_VIEW === '1';
const SENTENCE = process.env.SENTENCE || 'A quiet bus stop at dusk with one bench and a streetlight';
const LIMIT_S = Number(process.env.LIMIT_S || 600);
const CM = process.env.CM_HOST || 'pr-2178.cinemap.space';
result.mode = MODE; result.openView = OPEN_VIEW;

/** All processes of the browser whose user-data-dir is `dir` (or whose root pid is `root`): cpu seconds and rss MB. */
function psTree(match) {
  let out = ''; try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; }
  const rows = out.split('\n').filter(Boolean).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], time: m[4], cmd: m[5] }; }).filter(Boolean);
  const roots = rows.filter((r) => match(r) && !/--type=/.test(r.cmd)).map((r) => r.pid);
  if (!roots.length) return null;
  const keep = new Set(roots); let grew = true;
  while (grew) { grew = false; for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; } }
  const secs = (t) => { const p = t.split(/[-:]/).map(Number); let s = 0; if (t.includes('-')) { const [d, rest] = t.split('-'); const q = rest.split(':').map(Number); return +d * 86400 + q.reduce((a, v) => a * 60 + v, 0); } return p.reduce((a, v) => a * 60 + v, 0); };
  let cpu = 0, rss = 0; for (const r of rows) if (keep.has(r.pid)) { cpu += secs(r.time); rss += r.rss; }
  return { cpu, rssMB: Math.round(rss / 1024), n: keep.size };
}

const { ctx, page } = await launch();
const profileDir = path.join(os.homedir(), '.film-set-e2e', `profile-${process.env.BROWSER || 'chromium'}`);
const canvasProcs = () => psTree((r) => r.cmd.includes(profileDir));
let runnerBrowser = null; const runnerPid = { v: 0 };
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);
try {
  await signIn(page);
  const q = `bff_env=${BFF}${MODE === 'cloud' ? '&cinemap_runner=off' : ''}`;
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(15000);
  const sw = page.getByRole('button', { name: /^Switch to / });
  if (await sw.count().catch(() => 0)) { log('switching team'); await sw.first().click(); await sleep(20000); }
  await dismiss(page);
  const u0 = page.url();
  await page.getByText('Canvases', { exact: true }).locator('xpath=..').locator('button').first().click({ timeout: 20000 });
  for (let i = 0; i < 30 && page.url() === u0; i++) await sleep(1000);
  if (page.url() === u0) throw new Error('no new canvas');
  if (MODE === 'cloud' && !page.url().includes('cinemap_runner=off')) await page.goto(page.url() + (page.url().includes('?') ? '&' : '?') + 'cinemap_runner=off', { waitUntil: 'domcontentloaded' });
  await sleep(20000); await dismiss(page);
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  await page.getByTestId('add-node-3d-world').click(); await sleep(4000); await dismiss(page);
  const nodeId = await page.locator('[data-testid="cinemap-world-empty"]').last().evaluate((el) => el.closest('.react-flow__node')?.getAttribute('data-id') || '').catch(() => '');
  await typeIntoEmptyCard(page, SENTENCE);

  // the job and its world, from the canvas's own reads
  const job = { id: null, scene: null, status: '' };
  page.on('response', async (r) => {
    const m = r.url().match(/\/cinemap\/jobs\/([0-9a-f-]{36})/i); if (!m || r.request().method() !== 'GET') return;
    job.id = job.id || m[1];
    try { const d = await r.json(); const w = d?.data ?? d; if (w?.scene_id) job.scene = job.scene || w.scene_id; if (w?.status && w.status !== job.status) { job.status = w.status; log('job', w.status, w?.progress?.stage ?? ''); } } catch {}
  });

  // let the canvas settle, then take the baseline of its browser
  await sleep(3000);
  const base = canvasProcs(); log('canvas browser before', JSON.stringify(base));
  const stopTrace = await startTrace(ctx, page);
  const samples = []; let peak = 0;
  const sampler = setInterval(() => { const s = canvasProcs(); if (s) { samples.push(s); peak = Math.max(peak, s.rssMB); } }, 2000);
  const sentAt = Date.now(); await page.keyboard.press('Enter'); log('sent', MODE);

  if (MODE === 'cloud') {
    for (let i = 0; i < 60 && !(job.id && job.scene); i++) await sleep(1000);
    if (!job.id || !job.scene) throw new Error('no job id / scene from the canvas reads');
    // browser B = the "server": its own processes, the canvas browser's CineMap cookies (same person), headless
    runnerBrowser = await chromium.launch({ headless: true, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
    const cookies = (await ctx.cookies()).filter((c) => /cinemap\.space$/.test(c.domain.replace(/^\./, '')));
    const rctx = await runnerBrowser.newContext({ viewport: { width: 960, height: 540 } }); await rctx.addCookies(cookies);
    const rp = await rctx.newPage();
    await rp.goto(`https://${CM}/p/${job.scene}?runner=1&job=${job.id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    log('runner browser opened the runner page');
    runnerPid.v = runnerBrowser.process?.()?.pid || 0;
    result.runnerStates = [];
    (async () => { let last = ''; while (runnerBrowser) { const s = await rp.evaluate(() => { const d = document.documentElement.dataset; return d.cinemapRunnerState ? `${d.cinemapRunnerState}:${d.cinemapRunnerMessage || ''}` : ''; }).catch(() => ''); if (s && s !== last) { last = s; result.runnerStates.push(`${Math.round((Date.now() - sentAt) / 1000)}s ${s.slice(0, 80)}`); } await sleep(2000); } })();
  }
  if (OPEN_VIEW) {
    await sleep(8000);
    const ok = await page.evaluate((id) => { for (const n of document.querySelectorAll('.react-flow__node')) if (n.getAttribute('data-id') === id) { n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; } return false; }, nodeId);
    log('opened view', ok);
  }
  let end = 'timeout';
  for (let i = 0; i < LIMIT_S / 5; i++) {
    await sleep(5000);
    if (/^(succeeded|failed|cancelled)$/.test(job.status)) { end = job.status; break; }
    if (i % 12 === 11) await shot(page, `${MODE}-${i}`);
  }
  clearInterval(sampler);
  const tr = await stopTrace();
  const wall = (Date.now() - sentAt) / 1000;
  const last = samples.at(-1) || base;
  result.end = end; result.buildS = Math.round(wall);
  result.canvas = {
    cpuSeconds: last && base ? last.cpu - base.cpu : null,
    cpuPctOfOneCore: last && base ? Math.round(100 * (last.cpu - base.cpu) / wall) : null,
    rssBeforeMB: base?.rssMB, rssPeakMB: peak, rssMeanMB: samples.length ? Math.round(samples.reduce((a, s) => a + s.rssMB, 0) / samples.length) : null, processes: last?.n,
    mainThreads: tr.threads.map((t) => ({ process: t.process, busyMs: t.busyMs, busyPerMin: Math.round(t.busyMs / wall * 60), longTasks: t.longTasks, longMs: t.longMs })),
    top: tr.threads[0]?.top?.slice(0, 12),
  };
  if (runnerPid.v) { const r = psTree((x) => x.pid === runnerPid.v); result.runnerBrowser = r; }
  log('result', JSON.stringify({ end, buildS: result.buildS, canvas: { ...result.canvas, top: undefined }, runnerBrowser: result.runnerBrowser }));
  await shot(page, `${MODE}-end`);
} catch (e) { result.error = String(e?.message || e).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').slice(0, 300); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); if (runnerBrowser) { const b = runnerBrowser; runnerBrowser = null; await b.close().catch(() => {}); } await ctx.close(); }
