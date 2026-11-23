// Light performance recording for the film set popup: a few counters read at phase boundaries, not a full trace.
// - CPU: Chrome's cumulative per-process counters (CDP Performance.getMetrics: script, layout, style, task time, heap),
//   for the TapNow page and for the CineMap iframe (its own process), as deltas per phase.
// - Frames: frames with a requestAnimationFrame callback in each document (the viewer's render loop; the canvas page) and the
//   canvas's WebGPU submits.
// - Jank: long tasks (> 50 ms) count and total per document.
// - Network: bytes and requests the iframe loaded per phase (Resource Timing).
export async function installCounters(page) {
  await page.addInitScript(() => {
    if (window.__fsC) return;
    const c = (window.__fsC = { raf: 0, rafFrames: 0, to: 0, iv: 0, longN: 0, longMs: 0 });
    try { performance.setResourceTimingBufferSize(20000); } catch {} // the default 250 cut the open's count off at 250
    // raf: rAF callbacks (several loops each count); rafFrames: frames in which any rAF callback ran (the real frame rate).
    const raf = window.requestAnimationFrame.bind(window); let lastT = -1;
    window.requestAnimationFrame = (cb) => raf((t) => { c.raf++; if (t !== lastT) { lastT = t; c.rafFrames++; } cb(t); });
    const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
    window.setTimeout = (fn, ...a) => st(typeof fn === 'function' ? (...x) => { c.to++; return fn(...x); } : fn, ...a);
    window.setInterval = (fn, ...a) => si(typeof fn === 'function' ? (...x) => { c.iv++; return fn(...x); } : fn, ...a);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { c.longN++; c.longMs += e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch {}
  });
}

const PICK = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize'];

export async function openSessions(ctx, page) {
  const sessions = { page: await ctx.newCDPSession(page) };
  const viewer = page.frames().find((f) => /\/p\/[^?]+\?embed=node/.test(f.url()));
  if (viewer) { try { sessions.iframe = await ctx.newCDPSession(viewer); } catch { /* same process as the page */ } }
  for (const s of Object.values(sessions)) await s.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
  return { sessions, viewer };
}

async function snapshot(page, opened) {
  const out = { at: Date.now(), cdp: {}, docs: {} };
  for (const [k, s] of Object.entries(opened?.sessions || {})) {
    try { const { metrics } = await s.send('Performance.getMetrics'); out.cdp[k] = Object.fromEntries(metrics.filter((m) => PICK.includes(m.name)).map((m) => [m.name, m.value])); } catch {}
  }
  for (const f of page.frames()) {
    const who = f === page.mainFrame() ? 'page' : /editor\.html/.test(f.url()) ? 'viewer' : /\/p\/[^?]+\?embed=node/.test(f.url()) ? 'iframe' : null;
    if (!who) continue;
    try { out.docs[who] = await f.evaluate(() => { const c = window.__fsC || {}; const r = performance.getEntriesByType('resource'); return { raf: c.rafFrames || 0, longN: c.longN || 0, longMs: c.longMs || 0, gpuSubmits: window.__fsSubmits ?? null, requests: r.length, bytes: r.reduce((a, e) => a + (e.transferSize || 0), 0) }; }); } catch {}
  }
  return out;
}

/** Phases: call mark(name) at each boundary, then report() for per-phase deltas (per second where it is a rate). */
export function createRecorder(page) {
  const marks = []; let opened = null;
  return {
    attach: (o) => { opened = o; },
    async mark(name) { marks.push({ name, snap: await snapshot(page, opened) }); },
    report() {
      const res = {};
      for (let i = 0; i + 1 < marks.length; i++) {
        const a = marks[i].snap, b = marks[i + 1].snap, secs = (b.at - a.at) / 1000;
        const ph = { seconds: +secs.toFixed(1) };
        for (const k of Object.keys(b.cdp)) {
          // The iframe's process starts with the popup: before it there is nothing, so its first phase counts from zero.
          const y = b.cdp[k]; const x = a.cdp[k] || (k === 'iframe' ? { TaskDuration: 0, ScriptDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0 } : null); if (!x || !y) continue;
          ph[`${k}Cpu`] = { taskMsPerS: Math.round(((y.TaskDuration - x.TaskDuration) * 1000) / secs), scriptMsPerS: Math.round(((y.ScriptDuration - x.ScriptDuration) * 1000) / secs), layoutStyleMsPerS: Math.round(((y.LayoutDuration - x.LayoutDuration + y.RecalcStyleDuration - x.RecalcStyleDuration) * 1000) / secs), heapMB: Math.round(y.JSHeapUsedSize / 1048576) };
        }
        for (const k of Object.keys(b.docs)) {
          const x = a.docs[k] || { raf: 0, longN: 0, longMs: 0, requests: 0, bytes: 0, gpuSubmits: 0 }, y = b.docs[k];
          ph[k] = { fps: +((y.raf - x.raf) / secs).toFixed(1), longTasks: y.longN - x.longN, longTaskMs: Math.round(y.longMs - x.longMs), requests: y.requests - x.requests, MB: +((y.bytes - x.bytes) / 1048576).toFixed(1), ...(y.gpuSubmits != null && k === 'page' ? { canvasGpuFramesPerS: +(((y.gpuSubmits || 0) - (x.gpuSubmits || 0)) / secs).toFixed(1) } : {}) };
        }
        res[marks[i].name] = ph;
      }
      return res;
    },
  };
}
