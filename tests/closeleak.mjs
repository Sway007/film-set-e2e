// Sway 11-27: does closing a film set's popup leave work or memory behind that makes the canvas page stutter?
// The canvas keeps the viewer of an entered set after close (paused, its iframe parked in an invisible lot) and warms viewers on
// hover; this measures what those parked pages still cost and whether letting them go frees the memory. Phases:
//   baseline (nothing opened, mouse off the cards) → hover on the set (prewarm) → open, picture, idle, close → closed window
//   (per-second timers / intervals / rAF callbacks and the busiest call sites in every CineMap frame, render-loop state, a CPU
//   profile of the CineMap process) → CYCLES more open / close (memory after each) → hover other sets → wait 130 s (prewarm
//   let-go) → wait until 10.5 min after the last close (kept let-go). Every window also reads the canvas page's frame cadence,
//   long tasks, WebGPU submits, CDP task / script time per process and the Chrome processes' CPU time and memory (ps).
// Only numbers, short labels and paths without query strings are printed (public repo).
import { execFileSync } from 'node:child_process';
import { FE, BFF, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot, watchOverview, focusBySearch } from './lib.mjs';
import { installCounters } from './metrics.mjs';
import { startProfile, stopProfile } from './profile.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || '.', 'i');
const CYCLES = Math.max(1, Math.min(10, Number(process.env.CYCLES || 4) || 4));
const KEPT_WAIT = process.env.KEPT_WAIT !== '0';

const { ctx, page } = await launch();
const isIframe = (f) => /\/p\/[^?]+\?embed=node/.test(f.url());
const isViewer = (f) => /editor\.html/.test(f.url());
const cmFrames = () => page.frames().filter((f) => !f.isDetached() && (isIframe(f) || isViewer(f)));
const label = (f) => { const kids = page.frames().filter(isIframe); if (isIframe(f)) return `iframe${kids.indexOf(f)}`; const p = f.parentFrame(); return `viewer${p ? kids.indexOf(p) : '?'}`; };

// ---- Chrome processes on this Mac (ps): CPU time and memory by process type, for this browser only ----
let rootPid = null;
function psRead() {
  let out = ''; try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; }
  const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], rssKB: +m[3], cpuS: m[4].split(':').reduce((a, x) => a * 60 + parseFloat(x), 0), cmd: m[5] }));
  if (!rootPid) rootPid = rows.find((r) => /\.film-set-e2e\/profile-/.test(r.cmd) && !/--type=/.test(r.cmd))?.pid ?? null;
  if (!rootPid) return null;
  const mine = new Set([rootPid]); let grew = true; while (grew) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  const procs = {}; for (const r of rows) if (mine.has(r.pid)) { const type = r.cmd.match(/--type=([a-z-]+)/)?.[1] || 'browser'; const sub = /--utility-sub-type=([\w.]+)/.exec(r.cmd)?.[1]?.split('.').pop(); procs[r.pid] = { type: sub ? `utility:${sub}` : type, rssMB: r.rssKB / 1024, cpuS: r.cpuS }; }
  return { at: Date.now(), procs };
}
function psDelta(a, b) {
  if (!a || !b) return null; const secs = (b.at - a.at) / 1000; const byType = {}; const renderers = [];
  for (const [pid, p] of Object.entries(b.procs)) {
    const cpu = Math.max(0, p.cpuS - (a.procs[pid]?.cpuS ?? 0)); const g = (byType[p.type] ||= { n: 0, rssMB: 0, cpuMsPerS: 0 }); g.n++; g.rssMB += p.rssMB; g.cpuMsPerS += (cpu * 1000) / secs;
    if (p.type === 'renderer') renderers.push({ rssMB: Math.round(p.rssMB), cpuMsPerS: Math.round((cpu * 1000) / secs), new: !a.procs[pid] });
  }
  for (const g of Object.values(byType)) { g.rssMB = Math.round(g.rssMB); g.cpuMsPerS = Math.round(g.cpuMsPerS); }
  const gone = Object.keys(a.procs).filter((pid) => !b.procs[pid]).map((pid) => `${a.procs[pid].type} ${Math.round(a.procs[pid].rssMB)}MB`);
  return { byType, renderers: renderers.sort((x, y) => y.rssMB - x.rssMB).slice(0, 8), gone, totalRssMB: Math.round(Object.values(b.procs).reduce((s, p) => s + p.rssMB, 0)) };
}
const psMem = () => { const s = psRead(); return s ? psDelta(s, s) : null; };

// ---- CDP sessions: the page, and every out-of-process CineMap iframe ----
const sessions = new Map();
const pageCdp = await ctx.newCDPSession(page); await pageCdp.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
async function sessionOf(f) {
  if (f === page.mainFrame()) return pageCdp;
  if (sessions.has(f)) return sessions.get(f);
  let s = null; try { s = await ctx.newCDPSession(f); await s.send('Performance.enable', { timeDomain: 'timeTicks' }); } catch { s = null; } // same process as its parent
  sessions.set(f, s); return s;
}
const cdpMetrics = async (s) => { try { const { metrics } = await s.send('Performance.getMetrics'); const m = Object.fromEntries(metrics.map((x) => [x.name, x.value])); return { task: m.TaskDuration, script: m.ScriptDuration, heapMB: Math.round((m.JSHeapUsedSize || 0) / 1048576), nodes: m.Nodes, docs: m.Documents, frames: m.Frames }; } catch { return null; } };
const gc = async (s) => { try { await s.send('HeapProfiler.collectGarbage'); } catch {} };

// ---- what a document says about itself ----
const counters = (f) => f.evaluate(() => { const c = window.__fsC || {}; return { to: c.to || 0, iv: c.iv || 0, raf: c.raf || 0, rafFrames: c.rafFrames || 0, longN: c.longN || 0, longMs: c.longMs || 0 }; }).catch(() => null);
const sitesOn = (f, on) => f.evaluate((v) => { window.__fsSiteOn = v; if (v && window.__fsC) window.__fsC.sites = {}; }, on).catch(() => {});
const sitesRead = (f, secs) => f.evaluate((s) => { const c = window.__fsC || {}; const out = Object.entries(c.sites || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${(n / s).toFixed(1)}/s ${k}`); c.sites = {}; return out; }, secs).catch(() => null);
const iframeState = (f) => f.evaluate(() => { const n = window.cmNode; return { state: n?.state ?? null, paused: n?.paused ?? null, polling: n?.polling ?? null, streaming: n?.streaming ?? null, hidden: document.hidden, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; }).catch((e) => ({ error: e.message.slice(0, 60) }));
const viewerState = (f) => f.evaluate(() => { const W = window.__workshop, R = W?.renderer, I = window.__nodeIdle; let lost = null; try { lost = R?.getContext?.()?.isContextLost?.() ?? null; } catch {}
  return { renderCalls: R?.info?.render?.frame ?? null, geometries: R?.info?.memory?.geometries ?? null, textures: R?.info?.memory?.textures ?? null, asleep: I?.asleep ?? null, idleFrames: I?.frames ?? null, sleeps: I?.sleeps ?? null, why: I?.why ?? null, canvas: R?.domElement ? [R.domElement.width, R.domElement.height] : null, contextLost: lost, objects: W?.objects?.length ?? null, hidden: document.hidden, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; }).catch((e) => ({ error: e.message.slice(0, 60) }));
const domIframes = () => page.evaluate(() => { const all = [...document.querySelectorAll('iframe')].filter((e) => /embed=node/.test(e.src)); const lot = document.querySelector('[data-testid="cinemap-viewer-keeper"]'); return { embedNode: all.length, parked: all.filter((e) => lot?.contains(e)).length, iframesTotal: document.querySelectorAll('iframe').length }; }).catch(() => null);
const pageHeap = () => page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);

/** rAF interval sampler + long tasks in the canvas page (what the eye sees as stutter). */
const startRaf = () => page.evaluate(() => { const s = (window.__clRaf = { d: [], last: performance.now(), on: true, ln: 0, lms: 0, lmax: 0 }); const tick = (t) => { if (!s.on) return; s.d.push(t - s.last); s.last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  try { s.o = new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.ln++; s.lms += e.duration; s.lmax = Math.max(s.lmax, e.duration); } }); s.o.observe({ type: 'longtask', buffered: false }); } catch {} }).catch(() => {});
const stopRaf = () => page.evaluate(() => { const s = window.__clRaf; if (!s) return null; s.on = false; s.o?.disconnect(); const d = s.d.slice(1).sort((a, b) => a - b); const p = (q) => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(1) : null); const sum = d.reduce((a, b) => a + b, 0);
  return { fps: d.length ? +(d.length / (sum / 1000)).toFixed(1) : null, p50: p(0.5), p95: p(0.95), p99: p(0.99), maxMs: d.length ? Math.round(d[d.length - 1]) : null, over33: d.filter((x) => x > 33.4).length, over50: d.filter((x) => x > 50).length, longTasks: s.ln, longMs: Math.round(s.lms), longMaxMs: Math.round(s.lmax) }; }).catch((e) => ({ error: e.message.slice(0, 60) }));

/** One measuring window of `secs` seconds. sites: count call sites in the CineMap frames; profile: CPU profile of each CineMap process. */
async function measure(name, secs, { sites = false, profile = false } = {}) {
  const frames = cmFrames();
  const before = { ps: psRead(), gpu: await page.evaluate(() => window.__fsSubmits ?? null).catch(() => null), page: await cdpMetrics(pageCdp), docs: new Map(), cdp: new Map() };
  for (const f of frames) { before.docs.set(f, await counters(f)); const s = await sessionOf(f); if (s) before.cdp.set(f, await cdpMetrics(s)); if (sites) await sitesOn(f, true); }
  const profs = []; if (profile) for (const f of frames) { const s = await sessionOf(f); if (s && isIframe(f)) { try { await startProfile(s); profs.push([f, s]); } catch {} } }
  await startRaf();
  const t0 = Date.now(); await sleep(secs * 1000); const real = (Date.now() - t0) / 1000;
  const out = { seconds: +real.toFixed(1), canvasPage: await stopRaf() };
  const gpu1 = await page.evaluate(() => window.__fsSubmits ?? null).catch(() => null);
  if (before.gpu != null && gpu1 != null) out.canvasPage.gpuSubmitsPerS = +((gpu1 - before.gpu) / real).toFixed(1);
  const pm = await cdpMetrics(pageCdp); if (pm && before.page) out.canvasPage.cpu = { taskMsPerS: Math.round(((pm.task - before.page.task) * 1000) / real), scriptMsPerS: Math.round(((pm.script - before.page.script) * 1000) / real), heapMB: pm.heapMB, domNodes: pm.nodes, frames: pm.frames };
  out.cinemap = {};
  for (const f of frames) {
    if (f.isDetached()) { out.cinemap[label(f)] = 'detached'; continue; }
    const a = before.docs.get(f), b = await counters(f); const o = {};
    if (a && b) Object.assign(o, { timeoutsPerS: +((b.to - a.to) / real).toFixed(1), intervalsPerS: +((b.iv - a.iv) / real).toFixed(1), rafCallbacksPerS: +((b.raf - a.raf) / real).toFixed(1), rafFramesPerS: +((b.rafFrames - a.rafFrames) / real).toFixed(1), longTasks: b.longN - a.longN, longMs: Math.round(b.longMs - a.longMs) });
    const s = sessions.get(f); const cb = before.cdp.get(f); if (s && cb) { const ca = await cdpMetrics(s); if (ca) o.processCpu = { taskMsPerS: Math.round(((ca.task - cb.task) * 1000) / real), scriptMsPerS: Math.round(((ca.script - cb.script) * 1000) / real), heapMB: ca.heapMB }; }
    if (sites) { o.sites = await sitesRead(f, real); await sitesOn(f, false); }
    o.state = isIframe(f) ? await iframeState(f) : await viewerState(f);
    out.cinemap[label(f)] = o;
  }
  // render calls during the window: read state at start too
  for (const [f, s] of profs) out.cinemap[label(f)].profile = await stopProfile(s, 12).catch((e) => ({ error: e.message.slice(0, 60) }));
  out.processes = psDelta(before.ps, psRead());
  out.dom = await domIframes();
  log(name, JSON.stringify({ fps: out.canvasPage.fps, p95: out.canvasPage.p95, long: out.canvasPage.longTasks, cm: Object.fromEntries(Object.entries(out.cinemap).map(([k, v]) => [k, v.timeoutsPerS != null ? `${v.timeoutsPerS}to ${v.intervalsPerS}iv ${v.rafCallbacksPerS}raf` : v])), dom: out.dom }));
  return out;
}

/** Memory snapshot after GC: iframe elements, each CineMap process heap, page heap, Chrome processes. */
async function memory(name) {
  await gc(pageCdp); for (const f of cmFrames()) { const s = await sessionOf(f); if (s) await gc(s); }
  await sleep(1500);
  const out = { dom: await domIframes(), pageHeapMB: await pageHeap(), cinemap: {} };
  for (const f of cmFrames()) { const s = sessions.get(f); const m = s ? await cdpMetrics(s) : null; const st = isIframe(f) ? await iframeState(f) : await viewerState(f); out.cinemap[label(f)] = { processHeapMB: m?.heapMB ?? null, ...st }; }
  out.processes = psMem();
  log(name, JSON.stringify({ dom: out.dom, pageHeapMB: out.pageHeapMB, renderers: out.processes?.byType?.renderer, gpu: out.processes?.byType?.['gpu-process'] }));
  return out;
}

/** Measures the render calls of each viewer frame over a few seconds (is its loop running?). */
async function renderRate(secs = 4) {
  const vs = cmFrames().filter(isViewer); const a = new Map(); for (const v of vs) a.set(v, (await viewerState(v)).renderCalls);
  await sleep(secs * 1000); const out = {}; for (const v of vs) { const b = (await viewerState(v)).renderCalls; out[label(v)] = a.get(v) != null && b != null ? +((b - a.get(v)) / secs).toFixed(1) : null; } return out;
}

async function openPopup(at) {
  const t0 = Date.now();
  const viaButton = await page.evaluate(({ x, y }) => { const bs = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].map((e) => { const r = e.getBoundingClientRect(); return { e, d: Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y), ok: r.width > 0 }; }).filter((b) => b.ok && b.d < 400).sort((a, b) => a.d - b.d); if (bs[0]) { bs[0].e.click(); return true; } return false; }, at);
  if (!viaButton) await page.mouse.dblclick(at.x, at.y);
  let state = null, pictureMs = null;
  for (let k = 0; k < 240; k++) {
    state = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]') || document.querySelector('[data-testid="cinemap-world-detail"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return { dialog: !!d, iframe: !!d?.querySelector('iframe'), coverShown: c?.hasAttribute('data-shown') ?? null, failed: !!d?.querySelector('[data-testid="cinemap-world-preview-failed"],[data-testid="cinemap-world-frame-error"]'), inTab: !!d?.querySelector('[data-testid="cinemap-world-open-in-tab"]') }; }).catch(() => ({}));
    if (state.iframe && state.coverShown === false) { pictureMs = Date.now() - t0; break; }
    if (state.failed || state.inTab) break;
    await sleep(250);
  }
  return { opened: viaButton ? 'button' : 'double click', pictureMs, state };
}
async function closePopup() {
  await page.keyboard.press('Escape'); await sleep(800);
  let closed = !(await page.locator('[data-testid="cinemap-world-detail-dialog"]').count());
  if (!closed) { await page.mouse.click(10, 10); await page.keyboard.press('Escape'); await sleep(1000); closed = !(await page.locator('[data-testid="cinemap-world-detail-dialog"]').count()); }
  return closed;
}

try {
  await countGpuFrames(page); await installCounters(page);
  const overview = watchOverview(page);
  if (process.env.CM_SHARE) { await page.goto(`https://pr-11305.cinemap.space/?_vercel_share=${process.env.CM_SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(3000); }
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  result.env = await page.evaluate(() => ({ webgpu: !!navigator.gpu, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null, moveBefore: typeof Element.prototype.moveBefore === 'function' }));
  const text = (n) => `${n.data.title || ''} ${n.data.cinemap.title || ''} ${n.data.cinemap.brief || ''}`;
  const ready = overview.nodes.filter((n) => n.data.cinemap.status === 'ready');
  const target = ready.find((n) => MATCH.test(text(n))) || overview.nodes.find((n) => MATCH.test(text(n)));
  result.nodesOnCanvas = overview.nodes.length; result.readySets = ready.length;
  if (!target) throw new Error(`no film set matching ${MATCH} (${overview.nodes.length} film set nodes)`);
  const name = (n) => String(n.data.title || n.data.cinemap.title || n.data.cinemap.brief || '').slice(0, 30);
  const at = await focusBySearch(page, name(target));
  if (!at) throw new Error('could not bring the set to the middle of the canvas');
  const pane = await page.evaluate(() => { const r = document.querySelector('.react-flow')?.getBoundingClientRect(); return r ? { x: r.left + 30, y: r.bottom - 30 } : { x: 30, y: 900 }; });
  await page.mouse.move(pane.x, pane.y); await sleep(5000);
  log('env', JSON.stringify(result.env), 'sets', overview.nodes.length, 'ready', ready.length);

  // 1. baseline: nothing opened, mouse off the card
  result.memBaseline = await memory('mem baseline');
  result.baseline = await measure('baseline', 15, { sites: false });

  // 2. hover the set: prewarm (a parked viewer before any open)
  await page.mouse.move(at.x, at.y); await sleep(8000);
  result.hover = { dom: await domIframes(), renderRate: await renderRate() };
  await page.mouse.move(pane.x, pane.y); await sleep(1000);
  result.afterHover = await measure('after hover (prewarmed, parked)', 12, { sites: true });

  // 3. open, picture, idle 5 s, close, then 20 s closed
  await page.mouse.move(at.x, at.y);
  result.open1 = await openPopup(at); log('open 1', JSON.stringify(result.open1));
  await shot(page, '1-open');
  result.open1.renderRateOpen = await renderRate(3);
  result.open1.memOpen = await memory('mem open 1');
  await sleep(2000);
  result.open1.closed = await closePopup(); const closedAt = Date.now();
  await page.mouse.move(pane.x, pane.y); await sleep(1500);
  result.closed1 = await measure('closed 1', 20, { sites: true, profile: true });
  result.closed1.renderRate = await renderRate();
  await shot(page, '2-closed');

  // 4. more open / close cycles, memory after each
  result.cycles = []; let lastClose = closedAt;
  result.cycles.push({ cycle: 1, pictureMs: result.open1.pictureMs, closed: result.open1.closed, mem: await memory('mem after close 1') });
  for (let c = 2; c <= CYCLES; c++) {
    await page.mouse.move(at.x, at.y); await sleep(500);
    const o = await openPopup(at); await sleep(5000);
    const closed = await closePopup(); lastClose = Date.now(); await page.mouse.move(pane.x, pane.y); await sleep(3000);
    result.cycles.push({ cycle: c, pictureMs: o.pictureMs, opened: o.opened, closed, mem: await memory(`mem after close ${c}`) });
  }
  result.afterCycles = await measure('after cycles', 15, { sites: true });

  // 5. hover other finished sets (prewarm), up to 3
  const others = ready.filter((n) => n !== target).slice(0, 3); result.otherHovers = [];
  for (const n of others) {
    const p = await focusBySearch(page, name(n)).catch(() => null); if (!p) { result.otherHovers.push({ found: false }); continue; }
    await page.mouse.move(p.x, p.y); await sleep(6000); await page.mouse.move(pane.x, pane.y); await sleep(1000);
    result.otherHovers.push({ found: true, dom: await domIframes() });
  }
  if (others.length) { result.memAfterHovers = await memory('mem after other hovers'); result.afterHovers = await measure('after other hovers', 15, { sites: true }); }
  // back to the first set so the canvas view matches the baseline's
  await focusBySearch(page, name(target)).catch(() => null); await page.mouse.move(pane.x, pane.y);

  // 6. wait past the prewarm let-go (2 min)
  await sleep(130000);
  result.memAfter130s = await memory('mem +130 s');
  result.after130s = await measure('+130 s', 15, { sites: true });

  // 7. wait past the kept let-go (10 min after the last close)
  if (KEPT_WAIT) {
    const wait = lastClose + 10.5 * 60000 - Date.now(); if (wait > 0) { log('waiting for the kept let-go', Math.round(wait / 1000), 's'); await sleep(wait); }
    result.memAfterKeptLetGo = await memory('mem after kept let-go');
    result.afterKeptLetGo = await measure('after kept let-go', 15, { sites: true });
  }
  await shot(page, '3-end');
} catch (e) { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
