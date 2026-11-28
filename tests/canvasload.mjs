// Sway 11-28 (Ethan's report: a canvas with many shot clips gets laggy): what on the canvas page actually costs. Opens CANVAS_ID,
// then for each view (as loaded, then fit to screen with F) samples for PLAY_SECONDS:
//   - <video> elements: on the page, playing, with a decoded frame, preload=auto; poster images shown / failed to load;
//   - iframes: all, CineMap ones by kind (clip render = render=clips, node viewer = embed=node, other), and hidden or not;
//   - the page's rAF rate (p50 / p95 / frames over 50 ms), long tasks, JS heap; each CineMap frame's own rAF rate and long tasks;
//   - video bytes fetched while sampling.
// Then, as a check of cause, the same sample with every CineMap iframe hidden (display:none: Chromium stops drawing them).
// Only numbers and short labels are printed (public repo); screenshots stay on the Mac.
import { FE, BFF, OUT, launch, dismiss, sleep, log, result, save, shot } from './lib.mjs';

let CANVAS = process.env.CANVAS_ID; const SHARE_URL = process.env.SHARE_URL || '';
if (!CANVAS && !SHARE_URL) throw new Error('CANVAS_ID or SHARE_URL input is required');
const SECONDS = Math.max(6, Number(process.env.PLAY_SECONDS || 20));

const { ctx, page } = await launch();
// Every node stamped data.cinemap, as the canvas's overview answers carry them (latest answer wins).
const cmNodes = { list: [] };
page.on('response', async (r) => { if (!/\/canvases\/[^/]+\/overview/.test(r.url())) return; try { const d = await r.json(); const out = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.data?.cinemap && (o.id || o.node_id)) out.push(o); Object.values(o).forEach(walk); } }; walk(d); if (out.length) cmNodes.list = out; } catch {} });
const kindOf = (u) => { try { const x = new URL(u); if (!/cinemap/.test(x.host)) return null; return x.searchParams.get('render') === 'clips' ? 'clipRender' : x.searchParams.get('embed') === 'node' ? 'nodeViewer' : 'other'; } catch { return null; } };
const cmFrames = () => page.frames().filter((f) => f !== page.mainFrame() && kindOf(f.url()));

const startProbe = (frame) => frame.evaluate(() => {
  const s = (window.__cl = { d: [], last: performance.now(), on: true, n: 0, ms: 0, max: 0 });
  const tick = (t) => { if (!s.on) return; s.d.push(t - s.last); s.last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  try { s.o = new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.n++; s.ms += e.duration; s.max = Math.max(s.max, e.duration); } }); s.o.observe({ type: 'longtask', buffered: false }); } catch {}
  s.res0 = performance.getEntriesByType('resource').length;
}).catch(() => {});
const stopProbe = (frame) => frame.evaluate(() => {
  const s = window.__cl; if (!s) return null; s.on = false; s.o?.disconnect();
  const d = s.d.slice(1).sort((a, b) => a - b); const sum = d.reduce((a, b) => a + b, 0); const p = (q) => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(1) : null);
  const vids = performance.getEntriesByType('resource').slice(s.res0).filter((r) => r.initiatorType === 'video' || /\.(mp4|webm|mov)(\?|$)/.test(r.name));
  return { fps: d.length ? +(d.length / (sum / 1000)).toFixed(1) : null, p50: p(0.5), p95: p(0.95), over50: d.filter((x) => x > 50).length, longTasks: s.n, longMs: Math.round(s.ms), longMax: Math.round(s.max),
    videoFetches: vids.length, videoKB: Math.round(vids.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
}).catch((e) => ({ error: e.message.slice(0, 80) }));

const census = () => page.evaluate(() => {
  const v = [...document.querySelectorAll('video')];
  const posters = [...document.querySelectorAll('img[data-testid="video-poster"]')];
  const frames = [...document.querySelectorAll('iframe')].map((f) => { let kind = 'other'; try { const x = new URL(f.src, location.href); if (/cinemap/.test(x.host)) kind = x.searchParams.get('render') === 'clips' ? 'clipRender' : x.searchParams.get('embed') === 'node' ? 'nodeViewer' : 'cinemapOther'; else kind = 'nonCinemap'; } catch {} const r = f.getBoundingClientRect(); return { kind, w: Math.round(r.width), h: Math.round(r.height), hidden: getComputedStyle(f).display === 'none' }; });
  const byKind = {}; for (const f of frames) { const k = (byKind[f.kind] ||= { n: 0, sizes: [] }); k.n++; if (k.sizes.length < 4) k.sizes.push(`${f.w}x${f.h}${f.hidden ? ' hidden' : ''}`); }
  return { videos: v.length, playing: v.filter((x) => !x.paused).length, decoded: v.filter((x) => x.readyState >= 2).length, preloadAuto: v.filter((x) => x.preload === 'auto').length,
    videoSizes: v.slice(0, 6).map((x) => `${x.videoWidth}x${x.videoHeight}${x.paused ? '' : ' playing'}`),
    posters: posters.length, postersFailed: posters.filter((i) => i.complete && i.naturalWidth === 0).length,
    iframes: frames.length, byKind, nodes: document.querySelectorAll('.react-flow__node').length };
}).catch((e) => ({ error: e.message.slice(0, 80) }));

async function sample(name) {
  const frames = cmFrames();
  await startProbe(page.mainFrame()); for (const f of frames) await startProbe(f);
  const before = await census();
  await sleep(SECONDS * 1000);
  const out = { before, after: await census(), page: await stopProbe(page.mainFrame()), cinemapFrames: [] };
  for (const f of frames) out.cinemapFrames.push({ kind: kindOf(f.url()), ...(await stopProbe(f)) });
  log(name, JSON.stringify(out));
  await shot(page, name);
  return out;
}

try {
  if (process.env.CM_SHARE) { await page.goto(`https://pr-11305.cinemap.space/?_vercel_share=${process.env.CM_SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(3000); }
  // Sway 11-28: a share link instead of a canvas id: clone it into the signed-in account (克隆项目 / Clone Project) and measure the copy.
  // RESHOOT reuses the newest clone this Mac made (cloned-canvas.txt of an earlier run) instead of cloning again.
  if (SHARE_URL && process.env.MODE === 'reshoot' && !CANVAS) {
    const fs = await import('node:fs'), path = await import('node:path'); const root = path.dirname(OUT);
    const found = fs.readdirSync(root).map((d) => path.join(root, d, 'cloned-canvas.txt')).filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (found) { CANVAS = fs.readFileSync(found, 'utf8').trim().split(/\s+/)[0]; result.reusedClone = CANVAS.slice(0, 8); log('reusing clone', CANVAS.slice(0, 8)); }
  }
  if (SHARE_URL && !CANVAS) {
    await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    log('opened the share link — sign in in this window if asked; waiting up to 30 min for the Clone Project button');
    const btn = page.getByRole('button', { name: /^(克隆项目|Clone Project)$/ });
    const until = Date.now() + 30 * 60_000;
    while (Date.now() < until && !(await btn.count().catch(() => 0))) await sleep(3000);
    if (!(await btn.count().catch(() => 0))) throw new Error('no Clone Project button on the share page within 30 min');
    await sleep(3000); await btn.first().click();
    const got = await page.waitForURL(/\/(canvas|p)\/[0-9a-f-]{36}/, { timeout: 120000 }).then(() => true).catch(() => false);
    const m = page.url().match(/\/(?:canvas|p)\/([0-9a-f-]{36})/);
    if (!got || !m) throw new Error('clone did not open a new canvas');
    CANVAS = m[1];
    (await import('node:fs')).writeFileSync((await import('node:path')).join(OUT, 'cloned-canvas.txt'), CANVAS + '\n');
    result.clonedCanvas = CANVAS.slice(0, 8); log('cloned into canvas', CANVAS.slice(0, 8));
  }
  // Sway 11-28: no sign-in by script. The window opens on the canvas; whoever is at the Mac signs in to Vercel and TapNow there
  // (up to 30 min, coming back to the canvas once signed in). Measuring starts once the canvas shows its nodes.
  const AGENT_ENV = process.env.AGENT_ENV || ''; if (AGENT_ENV && !/^[a-z0-9-]+$/.test(AGENT_ENV)) throw new Error('bad agent_env');
  const url = `https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}${AGENT_ENV ? `&agent_team=project&agent_env=${AGENT_ENV}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  log('opened the canvas — sign in to Vercel and TapNow in this window if asked; the test waits up to 30 min');
  const deadline = Date.now() + 30 * 60_000; let ready = false, lastNudge = 0;
  while (Date.now() < deadline) {
    const onCanvas = (() => { try { const u = new URL(page.url()); return u.host === FE && u.pathname.includes(`/p/${CANVAS}`); } catch { return false; } })();
    const nodes = onCanvas ? await page.locator('.react-flow__node').count().catch(() => 0) : 0;
    if (nodes > 0) { ready = true; break; }
    // signed in somewhere else on TapNow (home page): go back to the canvas, at most every 20 s
    try { const u = new URL(page.url()); if (u.host === FE && !onCanvas && !/login|auth/.test(u.pathname) && Date.now() - lastNudge > 20000) { lastNudge = Date.now(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}); } } catch {}
    await sleep(3000);
  }
  if (!ready) throw new Error('canvas never showed its nodes (not signed in within 30 min, or no access to this canvas)');
  log('canvas loaded, settling 25 s');
  await sleep(25000); await dismiss(page);
  if (process.env.MODE === 'clipinfo') {
    // Sway 11-28: what the shot cards say about their clips (state, code, the runner's reason), the groups per job. Ids cut to 8, no names,
    // URLs taken out of the reasons.
    const cut = (v) => (typeof v === 'string' ? v.slice(0, 8) : v ?? null);
    const clean = (v) => (typeof v === 'string' ? v.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200) : v ?? null);
    result.cinemapNodes = cmNodes.list.map((n) => { const c = n.data.cinemap; const clip = c.clip || null;
      return { node: cut(n.id || n.node_id), type: n.type, role: c.role ?? (n.type === 'cinemap-world' ? 'world' : null), status: c.status ?? null, pending: c.pending ?? null, job: cut(c.job_id), shot: cut(c.shot_id), render: cut(c.render_id), scene: cut(c.scene_id), parent: cut(n.parent_id || n.parentId),
        hasSrc: !!n.data.src, clip: clip ? { state: clip.state, code: clip.code ?? null, reason: clean(clip.reason), pct: clip.pct ?? null, at: clip.at ?? null, attempts: clip.attempts ?? null } : null,
        error: clean(c.error ?? c.error_code ?? null) }; });
    log('cinemap nodes', JSON.stringify(result.cinemapNodes));
    await shot(page, 'clipinfo');
    throw Object.assign(new Error('clipinfo done'), { done: true });
  }
  result.env = await page.evaluate(() => ({ dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, w: innerWidth, h: innerHeight })).catch(() => null);
  result.asLoaded = await sample('1-as-loaded');
  if (process.env.MODE === 'reshoot') {
    // Sway 11-28: measure while a clip renders. Ask the canvas agent (SENTENCE) to reshoot one shot, then sample back to back
    // (SECONDS each) until the clip render frame has come and gone (+1 sample), or 15 min.
    if (await page.getByText('Front desk', { exact: true }).nth(1).isVisible().catch(() => false)) { await page.mouse.click(631, 40); await sleep(1500); }
    // What happened after the sentence: agent-gateway calls (status, run id prefix) and CineMap / world API calls (method, path, status).
    const diag = (result.diag = { gateway: [], runs: [], cinemap: [] });
    const pathOf = (u) => { try { const x = new URL(u); return x.host.split('.')[0] + x.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>').slice(0, 80); } catch { return '?'; } };
    page.on('response', (r) => { const u = r.url(); const t = Math.round((Date.now() - (globalThis.__tSent || Date.now())) / 1000);
      if (/agent-gateway/.test(u) && diag.gateway.length < 40) diag.gateway.push(`${t}s ${r.status()} ${r.request().method()} ${pathOf(u)}`);
      else if (/cinemap|world/i.test(u) && !/\.(js|css|png|jpg|webp|woff2?)(\?|$)/.test(u) && diag.cinemap.length < 60) diag.cinemap.push(`${t}s ${r.status()} ${r.request().method()} ${pathOf(u)}`); });
    page.on('request', (r) => { const m = r.url().match(/runs\/([0-9a-f-]{36})/); if (m && !diag.runs.includes(m[1].slice(0, 8))) diag.runs.push(m[1].slice(0, 8)); });
    const input = page.locator('textarea, [contenteditable="true"]').last();
    await page.mouse.click(700, 450); await page.keyboard.press('/'); await sleep(1500);
    diag.focus = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}${a.getAttribute('contenteditable') ? '[ce]' : ''}` : null; });
    await page.keyboard.type(process.env.SENTENCE, { delay: 20 }); await sleep(500);
    diag.typedChars = await page.evaluate(() => { const a = document.activeElement; return a ? (a.value ?? a.textContent ?? '').length : 0; });
    await page.keyboard.press('Enter'); await shot(page, 'r-sent');
    globalThis.__tSent = Date.now();
    const tSent = Date.now(); log('sent the reshoot sentence', JSON.stringify({ focus: diag.focus, typed: diag.typedChars }));
    void input;
    result.timeline = []; let seen = false, goneAfter = 0;
    const RESHOOT_MS = Number(process.env.CYCLES || 15) * 60_000; // reshoot mode: CYCLES = minutes to wait for the render
    while (Date.now() - tSent < RESHOOT_MS) {
      const o = await sample(`r-${Math.round((Date.now() - tSent) / 1000)}s`);
      const kinds = o.after?.byKind || {}; const render = (kinds.clipRender?.n || 0) > 0;
      const cr = o.cinemapFrames.find((f) => f.kind === 'clipRender');
      result.timeline.push({ t: Math.round((Date.now() - tSent) / 1000), render, iframes: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.n])),
        fps: o.page?.fps, p95: o.page?.p95, over50: o.page?.over50, longMs: o.page?.longMs, longMax: o.page?.longMax, heapMB: o.page?.heapMB,
        renderFps: cr?.fps ?? null, renderLongMs: cr?.longMs ?? null });
      if (render) seen = true; else if (seen && ++goneAfter >= 2) break;
    }
    result.renderSeen = seen; log('diag', JSON.stringify(diag));
    await shot(page, 'r-end');
  }
  await page.mouse.move(result.env?.w ? result.env.w * 0.7 : 900, 400); await page.keyboard.press('f').catch(() => {}); await sleep(4000);
  result.fit = await sample('2-fit');
  // Cause check: hide every CineMap iframe and sample again.
  result.hiddenCount = await page.evaluate(() => { let n = 0; for (const f of document.querySelectorAll('iframe')) { try { if (/cinemap/.test(new URL(f.src, location.href).host)) { f.dataset.clHid = f.style.display; f.style.display = 'none'; n++; } } catch {} } return n; });
  await sleep(2000);
  result.cinemapHidden = await sample('3-cinemap-hidden');
  await page.evaluate(() => { for (const f of document.querySelectorAll('iframe[data-cl-hid]')) { f.style.display = f.dataset.clHid; delete f.dataset.clHid; } }).catch(() => {});
} catch (e) { if (e?.done) { log('done'); } else { result.error = String(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); } }
finally { save(); await ctx.close(); }
