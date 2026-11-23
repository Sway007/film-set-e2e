// Where the CineMap iframe's time goes, kept small for the job log (no per-frame dumps):
// - CPU profile (CDP Profiler, sampling) of the iframe's process per window, reduced to the top self-time functions, the top entry
//   points (first JS frame of each sample: which timer / rAF loop / event handler / fetch callback the time belongs to) and by script.
// - Network of the open: every request of the iframe, its editor and their workers (Playwright's network events, not Resource Timing,
//   which stops at 250 entries and misses workers), grouped by type and host, with the slowest and largest requests.
// - Frames while moving: real draws of the viewer (renderer.render calls), CPU ms per render, and GPU ms per render when the browser
//   exposes EXT_disjoint_timer_query_webgl2.
// URLs are reduced to host + path with the query dropped and id-like path segments replaced (public log).

/** Host + path, no query or hash, ids replaced by ':id'. */
export function cleanUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.split('/').map((s) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || (/^[A-Za-z0-9_-]{24,}$/.test(s) && /\d/.test(s)) ? ':id' : s)).join('/');
    return (x.protocol.startsWith('http') ? x.host : x.protocol) + p;
  } catch { return String(u).split(/[?#]/)[0].slice(0, 120); }
}
const short = (u) => { const c = cleanUrl(u); const i = c.indexOf('/'); return i > 0 ? c.slice(i) : c; };

/** Starts sampling on a CDP session (a page or an out-of-process iframe). */
export async function startProfile(session, intervalUs = 1000) {
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: intervalUs });
  await session.send('Profiler.start');
  return session;
}

/** Stops it and reduces the profile to a few lines. */
export async function stopProfile(session, top = 15) {
  const { profile } = await session.send('Profiler.stop');
  return summariseProfile(profile, top);
}

export function summariseProfile(profile, top = 15) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const root = profile.nodes.find((n) => !parent.has(n.id))?.id;
  const self = new Map(), entry = new Map(), script = new Map(); let total = 0;
  const special = { idle: 0, program: 0, gc: 0 };
  const key = (cf) => `${cf.functionName || '(anonymous)'} ${short(cf.url) || '(native)'}:${cf.lineNumber + 1}`;
  const firstUnderRoot = new Map();
  const entryOf = (id) => {
    if (firstUnderRoot.has(id)) return firstUnderRoot.get(id);
    let cur = id, prev = id; while (parent.has(cur) && parent.get(cur) !== root) { prev = cur; cur = parent.get(cur); }
    const e = parent.get(cur) === root ? cur : prev; firstUnderRoot.set(id, e); return e;
  };
  const ts = profile.timeDeltas || [];
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (ts[i + 1] ?? ts[i] ?? 0) / 1000; total += dt; // delta i+1 is how long sample i lasted
    const n = byId.get(profile.samples[i]); const cf = n.callFrame; const name = cf.functionName;
    if (name === '(idle)') { special.idle += dt; continue; }
    if (name === '(program)') { special.program += dt; continue; }
    if (name === '(garbage collector)') { special.gc += dt; continue; }
    const k = key(cf); self.set(k, (self.get(k) || 0) + dt);
    const s = cleanUrl(cf.url) || '(native)'; script.set(s, (script.get(s) || 0) + dt);
    const e = byId.get(entryOf(n.id)); const ek = key(e.callFrame); entry.set(ek, (entry.get(ek) || 0) + dt);
  }
  const busy = total - special.idle;
  const list = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, ms]) => `${ms.toFixed(0)}ms ${name}`);
  return {
    seconds: +(total / 1000).toFixed(1), busyMs: Math.round(busy), jsMs: Math.round(busy - special.program - special.gc), nativeMs: Math.round(special.program), gcMs: Math.round(special.gc),
    topSelf: list(self, top), topEntry: list(entry, 8), byScript: list(script, 8),
  };
}

/** Collects the network of the iframe page, its editor frame and workers between start() and stop(). */
export function netCollector(ctx, page) {
  let on = false; const reqs = [];
  const kindOf = (r) => { let f = null; try { f = r.frame(); } catch { return 'worker'; } if (!f) return 'worker'; if (f === page.mainFrame()) return 'page'; const u = f.url(); return /editor\.html/.test(u) ? 'viewer' : /\/p\/[^?]+\?embed=node/.test(u) ? 'iframe' : 'other'; };
  const onDone = async (r, failed) => {
    if (!on) return; const kind = kindOf(r); if (kind === 'page' || kind === 'other') return;
    const item = { kind, type: r.resourceType(), url: cleanUrl(r.url()), bytes: 0, ms: null, failed, cached: false };
    reqs.push(item);
    try { const t = r.timing(); if (t.responseEnd > 0) item.ms = Math.round(t.responseEnd); } catch {}
    try { const resp = await r.response(); if (resp) { item.cached = resp.fromServiceWorker() || (resp.headers()['x-from-cache'] === '1'); } } catch {}
    try { const s = await r.sizes(); item.bytes = s.responseBodySize || 0; } catch {}
  };
  ctx.on('requestfinished', (r) => onDone(r, false)); ctx.on('requestfailed', (r) => onDone(r, true));
  return {
    start() { on = true; reqs.length = 0; },
    async stop() {
      on = false; await new Promise((r) => setTimeout(r, 1500)); // sizes() resolve after the event
      const group = (f) => { const m = {}; for (const q of reqs) { const k = f(q); const g = (m[k] ||= { n: 0, MB: 0 }); g.n++; g.MB += q.bytes / 1048576; } for (const g of Object.values(m)) g.MB = +g.MB.toFixed(1); return Object.fromEntries(Object.entries(m).sort((a, b) => b[1].n - a[1].n).slice(0, 12)); };
      const ext = (u) => (u.match(/\.([a-z0-9]{1,6})$/i)?.[1] || '-').toLowerCase();
      // Same path asked more than once (no cache, or several kinds sharing a file).
      const dup = {}; for (const q of reqs) dup[q.url] = (dup[q.url] || 0) + 1;
      return {
        requests: reqs.length, MB: +(reqs.reduce((a, q) => a + q.bytes, 0) / 1048576).toFixed(1), failed: reqs.filter((q) => q.failed).length,
        byKind: group((q) => q.kind), byType: group((q) => q.type), byExt: group((q) => ext(q.url)), byHost: group((q) => q.url.split('/')[0]),
        slowest: reqs.filter((q) => q.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 10).map((q) => `${q.ms}ms ${(q.bytes / 1024).toFixed(0)}KB ${q.url}`),
        largest: [...reqs].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map((q) => `${(q.bytes / 1048576).toFixed(2)}MB ${q.ms ?? '?'}ms ${q.url}`),
        repeated: Object.entries(dup).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, n]) => `${n}x ${u}`),
      };
    },
  };
}

/** In the viewer frame: wraps renderer.render to count real draws, their CPU ms and (when exposed) GPU ms. read() returns and resets. */
export async function installFrameStats(frame) {
  return frame.evaluate(() => {
    const W = window.__workshop, R = W?.renderer; if (!R || R.__fsStats) return !!R?.__fsStats;
    const gl = R.getContext?.(); const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
    const st = (R.__fsStats = { n: 0, cpu: [], gpu: [], pending: [], t0: performance.now(), gpuTimer: !!ext, calls: 0, tris: 0, frames: 0 });
    W.frameHooks?.push?.(() => { st.frames++; });
    const render = R.render.bind(R);
    R.render = function (...a) {
      let q = null; if (ext && !st.active) { try { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); st.active = true; } catch { q = null; } }
      const t = performance.now(); try { return render(...a); } finally {
        st.cpu.push(performance.now() - t); st.n++; st.calls += R.info?.render?.calls ?? 0; st.tris += R.info?.render?.triangles ?? 0;
        if (q) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); st.pending.push(q); } catch {} st.active = false; }
        for (let i = st.pending.length - 1; i >= 0; i--) { const p = st.pending[i]; try { if (gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) st.gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(p); st.pending.splice(i, 1); } } catch { st.pending.splice(i, 1); } }
      }
    };
    return true;
  }).catch(() => false);
}
export async function readFrameStats(frame) {
  return frame.evaluate(() => {
    const st = window.__workshop?.renderer?.__fsStats; if (!st) return null;
    const secs = (performance.now() - st.t0) / 1000;
    const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
    const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
    const sum = (a) => a.reduce((x, y) => x + y, 0), f = st.frames || null;
    const out = { framesPerS: +(st.frames / secs).toFixed(1), rendersPerFrame: f && +(st.n / f).toFixed(1), renderCpuMsPerFrame: f && +(sum(st.cpu) / f).toFixed(1), renderCpuMsP95: pct(st.cpu, 0.95), gpuTimer: st.gpuTimer, gpuMsPerFrame: f && st.gpu.length ? +((sum(st.gpu) / st.gpu.length) * (st.n / f)).toFixed(1) : null, gpuMsP95PerRender: pct(st.gpu, 0.95), drawCallsAvg: st.n ? Math.round(st.calls / st.n) : null, trisAvgK: st.n ? Math.round(st.tris / st.n / 1000) : null };
    st.n = 0; st.frames = 0; st.cpu = []; st.gpu = []; st.calls = 0; st.tris = 0; st.t0 = performance.now();
    return out;
  }).catch((e) => ({ error: e.message.slice(0, 80) }));
}

/** What runs in a document besides rendering: running CSS / Web animations, and timer / rAF callbacks per second (counters in metrics.mjs). */
export async function backgroundWork(frame) {
  return frame.evaluate(() => {
    const a = document.getAnimations?.().filter((x) => x.playState === 'running') ?? [];
    const names = {}; for (const x of a) { const t = x.effect?.target; const k = `${x.animationName || x.constructor.name}@${t?.id ? '#' + t.id : t?.className ? '.' + String(t.className).split(' ')[0] : t?.tagName || '?'}`; names[k] = (names[k] || 0) + 1; }
    const c = window.__fsC || {};
    return { animations: a.length, animationNames: Object.entries(names).slice(0, 6).map(([k, n]) => `${n}x ${k}`), timers: { timeout: c.to || 0, interval: c.iv || 0, rafFrames: c.rafFrames || 0 } };
  }).catch((e) => ({ error: e.message.slice(0, 80) }));
}
