// Chrome performance trace (the same data as the DevTools Performance panel), summarised per phase: main-thread busy time of
// the TapNow page and of the CineMap iframe (separate processes), GPU process time, frames drawn, top scripts by time.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, log } from './lib.mjs';

const CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'v8.execute', 'blink.user_timing', 'gpu', 'viz', 'disabled-by-default-v8.cpu_profiler'].join(',');

export async function startTrace(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Tracing.start', { categories: CATS, transferMode: 'ReturnAsStream', options: 'sampling-frequency=1000' });
  return cdp;
}

/** Marks a phase boundary in the trace (shows in the Performance panel's Timings track). */
export const mark = (page, name) => page.evaluate((n) => performance.mark(`phase:${n}`), name).catch(() => {});

export async function stopTrace(cdp, name) {
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  const file = path.join(OUT, `${name}.json`);
  const out = fs.createWriteStream(file);
  for (;;) { const { data, eof, base64Encoded } = await cdp.send('IO.read', { handle: stream, size: 4 << 20 }); out.write(base64Encoded ? Buffer.from(data, 'base64') : data); if (eof) break; }
  await new Promise((r) => out.end(r)); await cdp.send('IO.close', { handle: stream });
  log('trace saved (open it in Chrome DevTools > Performance > Load profile):', file);
  return summarise(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function summarise(trace) {
  const ev = trace.traceEvents || trace;
  const procName = {}, threadName = {}, procUrl = {};
  for (const e of ev) {
    if (e.ph === 'M' && e.name === 'process_name') procName[e.pid] = e.args?.name;
    if (e.ph === 'M' && e.name === 'thread_name') threadName[`${e.pid}:${e.tid}`] = e.args?.name;
    if (e.name === 'TracingStartedInBrowser' || e.name === 'TracingStartedInPage') for (const f of e.args?.data?.frames || []) if (f.processId && f.url && !procUrl[f.processId]) procUrl[f.processId] = f.url;
    if (e.name === 'CommitLoad' || e.name === 'FrameCommittedInBrowser') { const d = e.args?.data; if (d?.processId && d.url && !procUrl[d.processId]) procUrl[d.processId] = d.url; }
  }
  const label = (pid) => { const u = procUrl[pid] || ''; if (/cinemap/.test(new URL(u || 'http://x').host) && !/tapnow-/.test(u)) return 'cinemap-iframe'; if (/tapnow/.test(u)) return 'tapnow-page'; return procName[pid] || `pid${pid}`; };
  const phases = ev.filter((e) => e.ph === 'R' || (e.cat?.includes('user_timing') && e.name?.startsWith('phase:'))).filter((e) => e.name?.startsWith('phase:')).map((e) => ({ name: e.name.slice(6), ts: e.ts })).sort((a, b) => a.ts - b.ts);
  const endTs = Math.max(...ev.filter((e) => e.ts).map((e) => e.ts + (e.dur || 0)));
  const windows = phases.map((p, i) => ({ name: p.name, from: p.ts, to: phases[i + 1]?.ts ?? endTs }));
  const res = {};
  for (const w of windows) {
    const secs = (w.to - w.from) / 1e6, by = {}, frames = {}, scripts = {}; let longTasks = 0;
    for (const e of ev) {
      if (!e.ts || e.ts < w.from || e.ts >= w.to) continue;
      const tn = threadName[`${e.pid}:${e.tid}`] || '';
      const who = label(e.pid);
      if ((e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.ph === 'X' && /CrRendererMain|CrGpuMain|VizCompositorThread/.test(tn)) {
        const key = `${who}/${tn.replace('Cr', '')}`; by[key] = (by[key] || 0) + e.dur / 1000;
        if (e.dur > 50_000 && /CrRendererMain/.test(tn)) longTasks++;
      }
      if (e.name === 'DrawFrame' || e.name === 'Graphics.Pipeline' && e.args?.step === 'SubmitCompositorFrame') frames[who] = (frames[who] || 0) + 1;
      if (e.name === 'FunctionCall' && e.ph === 'X' && e.args?.data?.url) { const u = e.args.data.url.replace(/[?#].*$/, '').split('/').slice(-2).join('/'); const k = `${who}:${u}`; scripts[k] = (scripts[k] || 0) + e.dur / 1000; }
    }
    const per = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v / secs)]));
    res[w.name] = { seconds: +secs.toFixed(1), busyMsPerSecond: per(by), framesPerSecond: Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, +(v / secs).toFixed(1)])), longTasksOver50ms: longTasks, topScriptsMsPerSecond: per(scripts) };
  }
  return res;
}
