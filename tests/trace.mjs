// A Performance-panel summary without the panel: a Chrome trace recorded over CDP (browser-wide, so the CineMap frames'
// renderer processes too) and folded as it streams in, so nothing large is kept and nothing private is printed.
// Per renderer main thread: busy ms per 5 s slice, long tasks (> 50 ms), and the heaviest work by kind and script
// (host + path, ids and hashes replaced): script evaluation / compile, function calls, layout, style, paint, GC.
const CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'v8', 'blink.user_timing'].join(',');
const norm = (u) => { if (!u) return ''; try { const x = new URL(u); return `${x.host}${x.pathname}`.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/[0-9a-f]{12,}/gi, ':h').replace(/\/v\/[^/]+\//, '/v/:v/'); } catch { return String(u).slice(0, 60); } };
const KIND = { EvaluateScript: 'eval', 'v8.compile': 'compile', 'v8.compileModule': 'compile', 'V8.CompileCode': 'compile', FunctionCall: 'call', TimerFire: 'timer', FireAnimationFrame: 'raf', EventDispatch: 'event', Layout: 'layout', UpdateLayoutTree: 'style', Paint: 'paint', PrePaint: 'paint', Layerize: 'paint', MajorGC: 'gc', MinorGC: 'gc', 'V8.GC_MARK_COMPACTOR': 'gc', ParseHTML: 'parse', ParseAuthorStyleSheet: 'parse', XHRReadyStateChange: 'xhr', 'v8.run': 'eval', ResourceReceivedData: 'net' };

export async function startTrace(ctx, page, t0ref) {
  const cdp = await ctx.newCDPSession(page);
  const names = {}; const threads = {}; const frames = {}; const S = { main: new Map(), events: 0 };
  const key = (e) => `${e.pid}:${e.tid}`;
  const mainOf = (e) => { let m = S.main.get(key(e)); if (!m) { m = { slices: new Map(), long: 0, longMs: 0, busy: 0, work: new Map() }; S.main.set(key(e), m); } return m; };
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const e of value) {
      S.events++;
      if (S.base == null && e.ts) S.base = e.ts / 1000;
      const fr = e.args?.data?.frames; if (Array.isArray(fr)) for (const f of fr) if (f.frame && f.url) frames[f.frame] = f.url;
      if (e.name === 'FrameCommittedInBrowser' && e.args?.data?.frame && e.args.data.url) frames[e.args.data.frame] = e.args.data.url;
      if (e.ph === 'M') { if (e.name === 'process_name') names[e.pid] = e.args?.name; if (e.name === 'thread_name') threads[key(e)] = e.args?.name; continue; }
      if (e.ph !== 'X' || !e.dur) continue;
      const tn = threads[key(e)]; if (tn && tn !== 'CrRendererMain') continue;
      const m = mainOf(e); const ms = e.dur / 1000;
      if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') {
        m.busy += ms; if (ms > 50) { m.long++; m.longMs += ms; }
        const s = Math.floor((e.ts / 1000 - S.base) / 5000); if (Number.isFinite(s)) m.slices.set(s, (m.slices.get(s) || 0) + ms);
        continue;
      }
      const k = KIND[e.name]; if (!k || ms < 1) continue;
      const d = e.args?.data || {}; const where = norm(d.url || d.scriptName || d.stackTrace?.[0]?.url || '');
      const fn = k === 'call' || k === 'timer' || k === 'raf' || k === 'event' ? (d.functionName || d.type || '') : '';
      const pos = k === 'call' && d.lineNumber != null ? `:${d.lineNumber}:${d.columnNumber}` : '';
      const fu = frames[d.frame]; let doc = '';
      if (fu) { try { const x = new URL(fu); doc = `[${x.host.split('.')[0]}${x.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}${[...x.searchParams.keys()].filter((q) => /runner|stage|embed|lite/.test(q)).map((q) => `?${q}=${x.searchParams.get(q)}`).join('')}] `; } catch {} }
      const w = `${doc}${k} ${where}${pos}${fn ? ' ' + fn : ''}`.trim();
      const cur = m.work.get(w) || { ms: 0, n: 0, max: 0 }; cur.ms += ms; cur.n++; cur.max = Math.max(cur.max, ms); m.work.set(w, cur);
    }
  });
  // the trace's clock (µs) for "now": first RunTask seen is close enough; slices are relative to the start call
  S.base = null;
  await cdp.send('Tracing.start', { categories: CATS, transferMode: 'ReportEvents', options: 'sampling-frequency=10000' });
  const startedWall = Date.now();
  return async function stop() {
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end'); await done;
    const out = { events: S.events, wallS: Math.round((Date.now() - startedWall) / 1000), threads: [] };
    for (const [k, m] of S.main) {
      if (m.busy < 200) continue;
      const pid = k.split(':')[0];
      const slices = [...m.slices.entries()].sort((a, b) => a[0] - b[0]);
      const s0 = slices.length ? slices[0][0] : 0;
      out.threads.push({
        process: String(names[pid] || pid), busyMs: Math.round(m.busy), longTasks: m.long, longMs: Math.round(m.longMs),
        busyPer5s: slices.map(([s, v]) => `${(s - s0) * 5}s:${Math.round(v)}`).join(' '),
        top: [...m.work.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40).map(([w, v]) => `${Math.round(v.ms)}ms n${v.n} max${Math.round(v.max)} ${w}`),
      });
    }
    out.threads.sort((a, b) => b.busyMs - a.busyMs);
    return out;
  };
}
