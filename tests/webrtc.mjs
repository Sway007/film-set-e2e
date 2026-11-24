// WebRTC spike on the Mac's GPU: open a finished Film set's popup, take the light 3D viewer's canvas, compose it with a
// 32-bit timestamp bar into a 2D canvas, captureStream it and send it over a plain RTCPeerConnection (iceServers: []) to a
// second page (about:blank) in the same browser; Node relays SDP / ICE. The camera keeps moving (synthetic drags).
// Per setting (size, fps, bitrate, codec) after a short warm-up, one measured window:
//  publisher: encoder (hardware or software), encoded fps, encode ms / frame, quality limits, kbps, compose cost, main-thread s/s
//  viewer page: decoded fps, decoder, freezes, latency p50 / p90 from the timestamp bar, kbps
//  3D viewer: its own render fps and GPU ms while streaming; whole-browser CPU (cores, by process type) and GPU utilisation.
// A baseline window (camera moving, no stream) comes first. Only numbers and states are printed (public log).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import http from 'node:http';
import { FE, BFF, OUT, launch, signIn, dismiss, countGpuFrames, sleep, log, result, save, shot, watchOverview, focusBySearch } from './lib.mjs';
import { installFrameStats, readFrameStats } from './profile.mjs';
const run = promisify(execFile);

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const WARM = Number(process.env.WARM_S || 6), MEASURE = Number(process.env.MEASURE_S || 20);
const CONFIGS = [
  { name: '720p30-3M-VP8', W: 1280, H: 720, FPS: 30, KBPS: 3000, codec: 'VP8' },
  { name: '720p30-3M-H264', W: 1280, H: 720, FPS: 30, KBPS: 3000, codec: 'H264' },
  { name: '540p24-1.5M-VP8', W: 960, H: 540, FPS: 24, KBPS: 1500, codec: 'VP8' },
  { name: '540p24-1.5M-H264', W: 960, H: 540, FPS: 24, KBPS: 1500, codec: 'H264' },
];
const clean = (s) => String(s).replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, 'https://$1/…').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');

// ---- whole-browser CPU (ps) and GPU utilisation (ioreg, no sudo on Apple Silicon) ----
const cpuSec = (t) => { let d = 0; if (t.includes('-')) { const [a, b] = t.split('-'); d = Number(a) * 86400; t = b; } return d + t.split(':').reduce((acc, x) => acc * 60 + Number(x), 0); };
async function cpuSnap() {
  try {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,time=,command='], { maxBuffer: 32 << 20 });
    const m = {};
    for (const line of stdout.split('\n')) {
      const x = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/); if (!x || !/ms-playwright|pw-browsers|Chromium/.test(x[3])) continue;
      const type = (x[3].match(/--type=(\S+)/)?.[1] || 'browser').replace(/-process$/, '');
      const sub = x[3].match(/--utility-sub-type=(\S+)/)?.[1]; m[x[1]] = { type: sub ? `utility:${sub.split('.').pop()}` : type, s: cpuSec(x[2]) };
    }
    return m;
  } catch { return null; }
}
const cpuDelta = (a, b, wall) => { if (!a || !b) return null; const by = {}; let total = 0; for (const [pid, v] of Object.entries(b)) { const d = v.s - (a[pid]?.s ?? 0); if (d <= 0) continue; by[v.type] = (by[v.type] || 0) + d; total += d; } const r = { totalCores: +(total / wall).toFixed(2) }; for (const [k, v] of Object.entries(by)) if (v / wall >= 0.02) r[k] = +(v / wall).toFixed(2); return r; };
async function gpuUtil() { try { const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']); const d = stdout.match(/"Device Utilization %"=(\d+)/); const r = stdout.match(/"Renderer Utilization %"=(\d+)/); return d ? { device: Number(d[1]), renderer: r ? Number(r[1]) : null } : null; } catch { return null; } }

/** Adds x-google start / min / max bitrate to the video codecs of an SDP (not rtx / red / fec). */
function startBitrate(sdp, k) {
  const lines = sdp.split('\r\n'); let video = false; const out = [];
  const x = `x-google-start-bitrate=${k};x-google-min-bitrate=${Math.round(k / 3)};x-google-max-bitrate=${k}`;
  const names = {}; for (const l of lines) { const m = l.match(/^a=rtpmap:(\d+) ([^/]+)/); if (m) names[m[1]] = m[2].toLowerCase(); }
  const ok = (pt) => names[pt] && !/rtx|red|ulpfec|flexfec/.test(names[pt]);
  const hasFmtp = new Set(lines.map((l) => l.match(/^a=fmtp:(\d+)/)?.[1]).filter(Boolean));
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const f = l.match(/^a=fmtp:(\d+) /); if (video && f && ok(f[1])) { out.push(`${l};${x}`); continue; }
    out.push(l);
    const r = l.match(/^a=rtpmap:(\d+) /); if (video && r && ok(r[1]) && !hasFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${x}`);
  }
  return out.join('\r\n');
}

const { ctx, page } = await launch(undefined, { args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
// The viewer page: a blank page from Node on 127.0.0.1 (a secure context, unlike about:blank, so it may capture too).
const server = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<!doctype html><title>viewer</title><body style="margin:0;background:#111">'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let view = null;
try {
  await countGpuFrames(page);
  await ctx.grantPermissions(['camera', 'microphone']).catch(() => {});
  // Let every iframe (the popup's, and the viewer's inside it) use a camera, so the viewer's document may capture (see above).
  await page.addInitScript(() => {
    const ADD = 'camera *; microphone *'; const sa = Element.prototype.setAttribute; const add = (v) => (window.__allowCam === false ? v : v ? `${v}; ${ADD}` : ADD);
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'allow');
    if (d?.set) Object.defineProperty(HTMLIFrameElement.prototype, 'allow', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, add(v)); } });
    Element.prototype.setAttribute = function (n, v) { if (this instanceof HTMLIFrameElement && String(n).toLowerCase() === 'allow') v = add(v); return sa.call(this, n, v); };
  });
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  const target = overview.nodes.find((n) => n.data.cinemap.status === 'ready' && MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no finished set matching the set_match text (${overview.nodes.length} film set nodes)`);
  const at = await focusBySearch(page, String(target.data.title || target.data.cinemap.brief).slice(0, 30));
  if (!at) throw new Error('could not bring the set to the middle of the canvas');
  await page.mouse.move(at.x, at.y); await sleep(4000);
  // Errors of the page and its frames (cleaned: no ids, no queries), to tell why a viewer did not come up.
  const errs = []; const onErr = (m) => { if (errs.length < 12) errs.push(clean(m).slice(0, 160)); };
  page.on('pageerror', (e) => onErr(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') onErr(`console ${m.text()}`); });
  const openPopup = async () => {
    const t0 = Date.now();
    const viaButton = await page.evaluate(({ x, y }) => { const bs = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].map((e) => { const r = e.getBoundingClientRect(); return { e, d: Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y), ok: r.width > 0 }; }).filter((b) => b.ok && b.d < 400).sort((a, b) => a.d - b.d); if (bs[0]) { bs[0].e.click(); return true; } return false; }, at);
    if (!viaButton) await page.mouse.dblclick(at.x, at.y);
    let state = null;
    for (let i = 0; i < 240; i++) {
      state = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return { dialog: !!d, iframe: !!d?.querySelector('iframe'), coverShown: c?.hasAttribute('data-shown') ?? null, failed: !!d?.querySelector('[data-testid="cinemap-world-preview-failed"]') }; });
      if ((state.iframe && state.coverShown === false) || state.failed) break;
      await sleep(500);
    }
    const frameAllow = await page.evaluate(() => document.querySelector('[data-testid="cinemap-world-frame"]')?.getAttribute('allow') ?? null).catch(() => null);
    return { ...state, seconds: (Date.now() - t0) / 1000, readySeconds: state.iframe && state.coverShown === false ? (Date.now() - t0) / 1000 : null, frameAllow, errors: errs.splice(0) };
  };
  result.popup = await openPopup();
  log('popup', JSON.stringify(result.popup));
  if (!result.popup.readySeconds) {
    // Once more without the camera delegation, to tell whether it is what broke the viewer.
    await shot(page, 'popup-failed');
    await page.keyboard.press('Escape'); await sleep(1500); if (await page.locator('[data-testid="cinemap-world-detail-dialog"]').count()) { await page.mouse.click(10, 10); await page.keyboard.press('Escape'); await sleep(1500); }
    await page.evaluate(() => { window.__allowCam = false; });
    await page.mouse.move(at.x, at.y); await sleep(3000);
    result.popupRetryNoCamera = await openPopup();
    log('popup retry without camera delegation', JSON.stringify(result.popupRetryNoCamera));
    result.popup.retried = true; if (result.popupRetryNoCamera.readySeconds) result.popup.readySeconds = result.popupRetryNoCamera.readySeconds;
  }
  if (!result.popup.readySeconds) throw new Error('popup did not get ready');

  // The light viewer's frame and its biggest canvas.
  let ed = null;
  for (let i = 0; i < 60 && !ed; i++) { for (const f of page.frames()) { if (!/editor\.html/.test(f.url())) continue; const ok = await f.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return !!(c && c.width > 200); }).catch(() => false); if (ok) { ed = f; break; } } if (!ed) await sleep(1000); }
  if (!ed) throw new Error('no viewer canvas');
  const embed = page.frames().find((f) => /\/p\/[^?]+\?embed=node/.test(f.url()));
  result.source = await ed.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; const R = window.__workshop?.renderer; return { w: c.width, h: c.height, cssW: Math.round(c.clientWidth), cssH: Math.round(c.clientHeight), dpr: devicePixelRatio, webgpu: !!(R?.isWebGPURenderer || R?.backend?.isWebGPUBackend), webgl2: !!R?.capabilities?.isWebGL2, lite: !!window.__nodeLite }; });
  log('source', JSON.stringify(result.source));
  await installFrameStats(ed);
  await shot(page, '1-popup');

  // Main-thread metrics of the viewer's process (an out-of-process frame when it is one), and of the receiving page.
  const cdpFor = async () => { for (const [name, f] of [['viewer-frame', ed], ['embed-frame', embed]]) { if (!f) continue; try { const s = await ctx.newCDPSession(f); await s.send('Performance.enable'); return { name, s }; } catch {} } const s = await ctx.newCDPSession(page); await s.send('Performance.enable'); return { name: 'canvas-page', s }; };
  const pubCdp = await cdpFor(); result.publisherMetricsTarget = pubCdp.name;
  const metrics = async (s) => Object.fromEntries((await s.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));

  // Keep the camera moving: slow horizontal drags back and forth over the stage (orbit), from Node.
  const stage = await page.locator('[data-testid="cinemap-world-stage"]').boundingBox();
  const cx = stage ? stage.x + stage.width / 2 : 800, cy = stage ? stage.y + stage.height / 2 : 500;
  let moving = true, drags = 0;
  const mover = (async () => {
    let dir = 1;
    while (moving) {
      await page.mouse.move(cx - dir * 150, cy); await page.mouse.down();
      for (let i = 0; i <= 30 && moving; i++) { await page.mouse.move(cx - dir * 150 + dir * 10 * i, cy + Math.sin(i / 5) * 20); await sleep(33); }
      await page.mouse.up(); drags++; dir = -dir; await sleep(100);
    }
  })().catch((e) => log('mover stopped', clean(e.message).slice(0, 80)));
  const camPos = () => ed.evaluate(() => window.__workshop?.camera?.position?.toArray?.() ?? null).catch(() => null);

  // One measured window: deltas of everything between two snapshots.
  const subs = () => ed.evaluate(() => window.__fsSubmits ?? null).catch(() => null);
  async function window_(fn) {
    const c0 = await cpuSnap(); const m0 = await metrics(pubCdp.s); const v0 = viewCdp ? await metrics(viewCdp) : null; const s0 = await subs(); const p0 = await camPos();
    await readFrameStats(ed); const pre = fn ? await fn.before() : null;
    const w0 = Date.now(); const gpu = [];
    while (Date.now() - w0 < MEASURE * 1000) { const g = await gpuUtil(); if (g) gpu.push(g); await sleep(1000); }
    const wall = (Date.now() - w0) / 1000;
    const post = fn ? await fn.after(pre, wall) : null;
    const render = await readFrameStats(ed); const s1 = await subs(); const p1 = await camPos();
    const m1 = await metrics(pubCdp.s); const v1 = viewCdp ? await metrics(viewCdp) : null; const c1 = await cpuSnap();
    const per = (a, b, k) => +((b[k] - a[k]) / wall).toFixed(3);
    const avg = (k) => (gpu.length ? Math.round(gpu.reduce((x, y) => x + (y[k] ?? 0), 0) / gpu.length) : null);
    return {
      seconds: +wall.toFixed(1), viewerRender: render, gpuSubmitsPerS: s0 != null && s1 != null ? +((s1 - s0) / wall).toFixed(1) : null,
      cameraMoved: !!(p0 && p1 && p0.some((v, i) => Math.abs(v - p1[i]) > 0.01)),
      publisherMainThread: { taskSecPerSec: per(m0, m1, 'TaskDuration'), scriptSecPerSec: per(m0, m1, 'ScriptDuration'), layoutSecPerSec: per(m0, m1, 'LayoutDuration') },
      viewPageMainThread: v0 ? { taskSecPerSec: per(v0, v1, 'TaskDuration'), scriptSecPerSec: per(v0, v1, 'ScriptDuration') } : null,
      cpuCores: cpuDelta(c0, c1, wall), gpuUtilPct: { device: avg('device'), renderer: avg('renderer'), samples: gpu.length }, ...post,
    };
  }

  let viewCdp = null;
  await sleep(3000);
  result.baseline = await window_(null);
  log('baseline', JSON.stringify(result.baseline));

  view = await ctx.newPage(); await view.goto(`http://127.0.0.1:${server.address().port}/`);
  result.viewerCapture = await view.evaluate(() => navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120, frameRate: 5 } }).then((s) => { window.__keep = s; return 'capturing'; }, (e) => `no capture: ${e.name}`));
  viewCdp = await ctx.newCDPSession(view); await viewCdp.send('Performance.enable');
  await page.bringToFront();
  result.codecsAvailable = await ed.evaluate(() => [...new Set((RTCRtpSender.getCapabilities('video')?.codecs || []).map((c) => c.mimeType.replace('video/', '')))]);
  result.decodersAvailable = await view.evaluate(() => [...new Set((RTCRtpReceiver.getCapabilities('video')?.codecs || []).map((c) => c.mimeType.replace('video/', '')))]);
  log('codecs', result.codecsAvailable.join(','));
  result.runs = [];

  for (const cfg of CONFIGS) {
    const r = { config: cfg.name };
    try {
      // Publisher (in the viewer's frame): compose + timestamp bar, capture, offer.
      const set = await ed.evaluate(async ({ W, H, FPS, codec }) => {
        const old = window.__pub; if (old) { old.dead = true; clearInterval(old.timer); old.pc.close(); old.stream.getTracks().forEach((t) => t.stop()); }
        const src = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const out = document.createElement('canvas'); out.width = W; out.height = H; const g = out.getContext('2d', { alpha: false });
        const probe = new OffscreenCanvas(16, 9).getContext('2d', { willReadFrequently: true });
        const P = window.__pub = { pc: new RTCPeerConnection({ iceServers: [] }), ice: [], drawn: 0, drawMs: 0, stampOnly: 0, probed: 0, changed: 0, blank: 0, last: null, lastAt: 0, via: null };
        const gap = 1000 / FPS;
        const stamp = () => { const ts = Date.now() >>> 0; for (let b = 0; b < 32; b++) { g.fillStyle = (ts >>> (31 - b)) & 1 ? '#fff' : '#000'; g.fillRect(b * 12, 0, 12, 12); } }; // ms since epoch mod 2^32, 32 black / white 12 px blocks
        // A WebGL canvas without preserveDrawingBuffer reads back empty outside the task that drew it: compose right after the
        // viewer's own render (a microtask after a render to the screen), at most FPS times a second.
        P.compose = () => {
          if (P.dead) return; const now = performance.now(); if (now - P.lastAt < gap - 3) return; P.lastAt = now;
          g.drawImage(src, 0, 0, W, H); stamp(); P.drawn++; P.drawMs += performance.now() - now;
          if (P.drawn % 6 === 0) { // is the picture real and changing?
            probe.drawImage(out, 0, 24, W, H - 24, 0, 0, 16, 9); const d = probe.getImageData(0, 0, 16, 9).data; let sum = 0, diff = 0;
            for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; if (P.last) diff += Math.abs(d[i] - P.last[i]) + Math.abs(d[i + 1] - P.last[i + 1]) + Math.abs(d[i + 2] - P.last[i + 2]); }
            P.probed++; if (sum / (144 * 3) < 4) P.blank++; if (P.last && diff / (144 * 3) > 1.5) P.changed++; P.last = d;
          }
        };
        const R = window.__workshop?.renderer;
        if (R?.render) {
          if (!R.__pubHook) { const render = R.render; R.render = function (...a) { const toScreen = !R.getRenderTarget?.(); const r = render.apply(this, a); if (toScreen && window.__pub && !window.__pub.queued) { window.__pub.queued = true; queueMicrotask(() => { window.__pub.queued = false; window.__pub.compose(); }); } return r; }; R.__pubHook = true; }
          P.via = 'after-render';
        } else { P.via = 'raf'; const loop = () => { if (P.dead) return; P.compose(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
        // When the viewer does not render (idle), keep the stream going: the last picture with a fresh timestamp.
        P.timer = setInterval(() => { if (performance.now() - P.lastAt > gap * 1.5) { const a = performance.now(); stamp(); P.stampOnly++; P.drawMs += performance.now() - a; } }, gap);
        // Chrome shows encoderImplementation only to a document that is capturing: a tiny fake camera track, kept live.
        if (!window.__capture) window.__capture = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120, frameRate: 5 } }).then(() => 'capturing', (e) => `no capture: ${e.name}`);
        P.stream = out.captureStream(FPS);
        const tr = P.pc.addTransceiver(P.stream.getVideoTracks()[0], { direction: 'sendonly', streams: [P.stream] });
        const caps = RTCRtpSender.getCapabilities('video').codecs;
        let want = caps.filter((c) => c.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
        if (!want.length) return { skip: `no ${codec} encoder` };
        want = want.sort((a, b) => (/packetization-mode=1/.test(b.sdpFmtpLine || '') - /packetization-mode=1/.test(a.sdpFmtpLine || '')) || (/42e01f/.test(b.sdpFmtpLine || '') - /42e01f/.test(a.sdpFmtpLine || '')));
        tr.setCodecPreferences([...want, ...caps.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType))]);
        P.sender = tr.sender;
        P.pc.onicecandidate = (e) => { if (e.candidate) P.ice.push(e.candidate.toJSON()); };
        const o = await P.pc.createOffer(); await P.pc.setLocalDescription(o);
        return { offer: P.pc.localDescription.toJSON() };
      }, cfg);
      if (set.skip) { r.skipped = set.skip; result.runs.push(r); log(cfg.name, 'skipped', set.skip); continue; }

      // Viewer page: answer, show the video, and read every frame's timestamp bar off the track (works when the tab is hidden).
      const answer = await view.evaluate(async ({ offer, W }) => {
        const old = window.__view; if (old) { old.stop = true; old.pc.close(); old.video.remove(); }
        const V = window.__view = { pc: new RTCPeerConnection({ iceServers: [] }), ice: [], lat: [], frames: 0, shown: 0, sizes: {}, stop: false, reader: 'none' };
        const video = V.video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true; video.style.width = '640px'; document.body.append(video);
        const c = new OffscreenCanvas(384, 12); const g = c.getContext('2d', { willReadFrequently: true });
        const readStamp = (img, fw) => {
          const k = fw / W; g.drawImage(img, 0, 0, 384 * k, 12 * k, 0, 0, 384, 12); const d = g.getImageData(0, 6, 384, 1).data; let ts = 0;
          for (let b = 0; b < 32; b++) { const i = (b * 12 + 6) * 4; ts = ts * 2 + (d[i] + d[i + 1] + d[i + 2] > 382 ? 1 : 0); }
          const l = ((Date.now() >>> 0) - ts) >>> 0; if (l < 10000) V.lat.push(l); else V.badStamps = (V.badStamps || 0) + 1;
        };
        V.pc.ontrack = (e) => {
          video.srcObject = e.streams[0] || new MediaStream([e.track]); video.play().catch(() => {});
          const onShown = () => { if (V.stop) return; V.shown++; video.requestVideoFrameCallback(onShown); }; video.requestVideoFrameCallback(onShown);
          if (window.MediaStreamTrackProcessor) {
            V.reader = 'track-processor';
            const rd = new MediaStreamTrackProcessor({ track: e.track }).readable.getReader();
            (async () => { while (!V.stop) { const { value: f, done } = await rd.read(); if (done) break; V.frames++; const sz = `${f.displayWidth}x${f.displayHeight}`; V.sizes[sz] = (V.sizes[sz] || 0) + 1; try { readStamp(f, f.displayWidth); } catch {} f.close(); } })();
          }
        };
        V.pc.onicecandidate = (ev) => { if (ev.candidate) V.ice.push(ev.candidate.toJSON()); };
        await V.pc.setRemoteDescription(offer); const a = await V.pc.createAnswer(); await V.pc.setLocalDescription(a);
        return V.pc.localDescription.toJSON();
      }, { offer: set.offer, W: cfg.W });
      // Start the bandwidth estimate at the target (as a real deployment would) instead of ramping up from ~300 kbps.
      answer.sdp = startBitrate(answer.sdp, cfg.KBPS);
      await ed.evaluate(async ({ a, KBPS, FPS }) => { const P = window.__pub; await P.pc.setRemoteDescription(a); const p = P.sender.getParameters(); p.encodings = p.encodings?.length ? p.encodings : [{}]; p.encodings[0].maxBitrate = KBPS * 1000; p.encodings[0].maxFramerate = FPS; await P.sender.setParameters(p).catch((e) => { P.paramErr = e.message; }); }, { a: answer, KBPS: cfg.KBPS, FPS: cfg.FPS });
      // Signaling: Node relays ICE both ways until connected.
      const tc = Date.now(); let conn = null;
      for (let i = 0; i < 80; i++) {
        const pi = await ed.evaluate(() => window.__pub.ice.splice(0)); const vi = await view.evaluate(() => window.__view.ice.splice(0));
        for (const c of pi) await view.evaluate((c) => window.__view.pc.addIceCandidate(c).catch(() => {}), c);
        for (const c of vi) await ed.evaluate((c) => window.__pub.pc.addIceCandidate(c).catch(() => {}), c);
        conn = { pub: await ed.evaluate(() => window.__pub.pc.connectionState), view: await view.evaluate(() => window.__view.pc.connectionState) };
        if (conn.pub === 'connected' && conn.view === 'connected') break;
        await sleep(250);
      }
      r.connect = { ...conn, ms: Date.now() - tc };
      if (conn.pub !== 'connected') throw new Error(`not connected (${conn.pub}/${conn.view})`);
      await sleep(WARM * 1000);

      const pubStats = () => ed.evaluate(async () => {
        const P = window.__pub; const r = { via: P.via, capture: window.__capture, stampOnly: P.stampOnly, drawn: P.drawn, drawMs: P.drawMs, probed: P.probed, changed: P.changed, blank: P.blank, paramErr: P.paramErr ?? null }; const all = {};
        (await P.pc.getStats()).forEach((s) => { all[s.id] = s; });
        for (const s of Object.values(all)) if (s.type === 'outbound-rtp' && s.kind === 'video') Object.assign(r, { encoder: s.encoderImplementation, powerEfficient: s.powerEfficientEncoder ?? null, framesEncoded: s.framesEncoded, keyFrames: s.keyFramesEncoded, w: s.frameWidth, h: s.frameHeight, bytes: s.bytesSent, encodeS: s.totalEncodeTime || 0, qlr: s.qualityLimitationReason, qld: s.qualityLimitationDurations, qlChanges: s.qualityLimitationResolutionChanges, codec: all[s.codecId]?.mimeType?.replace('video/', '') ?? null, targetKbps: s.targetBitrate ? Math.round(s.targetBitrate / 1000) : null, fmtp: all[s.codecId]?.sdpFmtpLine ?? null });
        return r;
      });
      const viewStats = () => view.evaluate(async () => {
        const V = window.__view; const r = { frames: V.frames, shown: V.shown, latN: V.lat.length, badStamps: V.badStamps || 0, reader: V.reader, sizes: V.sizes, hidden: document.hidden }; const all = {};
        (await V.pc.getStats()).forEach((s) => { all[s.id] = s; });
        for (const s of Object.values(all)) {
          if (s.type === 'inbound-rtp' && s.kind === 'video') Object.assign(r, { decoder: s.decoderImplementation, powerEfficient: s.powerEfficientDecoder ?? null, framesDecoded: s.framesDecoded, framesDropped: s.framesDropped ?? 0, bytes: s.bytesReceived, decodeS: s.totalDecodeTime || 0, freezes: s.freezeCount ?? 0, freezeS: s.totalFreezesDuration ?? 0, pauses: s.pauseCount ?? 0, jbDelay: s.jitterBufferDelay ?? 0, jbN: s.jitterBufferEmittedCount ?? 0, packetsLost: s.packetsLost ?? 0, w: s.frameWidth, h: s.frameHeight });
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') r.rttMs = Math.round((s.currentRoundTripTime || 0) * 1000);
        }
        return r;
      });
      Object.assign(r, await window_({
        before: async () => { await view.evaluate(() => { window.__view.lat = []; }); return { p: await pubStats(), v: await viewStats() }; },
        after: async (b, wall) => {
          const p = await pubStats(), v = await viewStats(); const lat = (await view.evaluate(() => window.__view.lat.slice())).sort((x, y) => x - y);
          const q = (f) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(f * lat.length))] : null);
          const enc = p.framesEncoded - b.p.framesEncoded, dec = v.framesDecoded - b.v.framesDecoded, probed = p.probed - b.p.probed;
          const qld = {}; for (const k of Object.keys(p.qld || {})) { const d = p.qld[k] - (b.p.qld?.[k] ?? 0); if (d > 0.05) qld[k] = +d.toFixed(1); }
          return {
            publisher: { codec: p.codec, fmtp: p.fmtp, encoder: p.encoder, powerEfficient: p.powerEfficient, size: `${p.w}x${p.h}`, encodedFps: +(enc / wall).toFixed(1), encodeMsPerFrame: enc ? +(((p.encodeS - b.p.encodeS) * 1000) / enc).toFixed(2) : null, kbps: Math.round(((p.bytes - b.p.bytes) * 8) / 1000 / wall), targetKbps: p.targetKbps, keyFrames: p.keyFrames - b.p.keyFrames, qualityLimit: p.qlr, qualityLimitSeconds: qld, resolutionChanges: p.qlChanges - b.p.qlChanges, composedFps: +((p.drawn - b.p.drawn) / wall).toFixed(1), composeMsPerFrame: +((p.drawMs - b.p.drawMs) / Math.max(1, p.drawn - b.p.drawn)).toFixed(2), stampOnlyFps: +((p.stampOnly - b.p.stampOnly) / wall).toFixed(1), composeVia: p.via, statsExposure: p.capture, pictureChangedPct: probed ? Math.round((100 * (p.changed - b.p.changed)) / probed) : null, blankPct: probed ? Math.round((100 * (p.blank - b.p.blank)) / probed) : null, paramErr: p.paramErr },
            viewer: { decoder: v.decoder, powerEfficient: v.powerEfficient, size: `${v.w}x${v.h}`, decodedFps: +(dec / wall).toFixed(1), decodeMsPerFrame: dec ? +(((v.decodeS - b.v.decodeS) * 1000) / dec).toFixed(2) : null, shownFps: +((v.shown - b.v.shown) / wall).toFixed(1), readFps: +((v.frames - b.v.frames) / wall).toFixed(1), kbps: Math.round(((v.bytes - b.v.bytes) * 8) / 1000 / wall), freezes: v.freezes - b.v.freezes, freezeSeconds: +(v.freezeS - b.v.freezeS).toFixed(2), framesDropped: v.framesDropped - b.v.framesDropped, packetsLost: v.packetsLost - b.v.packetsLost, jitterBufferMs: v.jbN - b.v.jbN ? Math.round((1000 * (v.jbDelay - b.v.jbDelay)) / (v.jbN - b.v.jbN)) : null, latencyMs: lat.length ? { p50: q(0.5), p90: q(0.9), p99: q(0.99), n: lat.length } : null, badStamps: v.badStamps - b.v.badStamps, rttMs: v.rttMs ?? null, reader: v.reader, hidden: v.hidden },
          };
        },
      }));
    } catch (e) { r.error = clean(e?.message || e).slice(0, 200); }
    result.runs.push(r); log(cfg.name, JSON.stringify(r));
  }
  await shot(page, '2-streaming'); await view.screenshot({ path: path.join(OUT, '3-view.png') }).catch(() => {});
  moving = false; await mover;
  result.drags = drags;
} catch (e) { result.error = clean(e?.message || e); log('ERROR', result.error); await shot(page, 'error'); }
finally {
  // compact table for the job log
  for (const r of result.runs || []) {
    if (!r.publisher) { console.log(`TABLE ${r.config} | ${r.skipped || r.error || 'no data'}`); continue; }
    const p = r.publisher, v = r.viewer;
    console.log(`TABLE ${r.config} | enc ${p.encoder} pe=${p.powerEfficient} ${p.size} ${p.encodedFps}fps ${p.encodeMsPerFrame}ms/f ql=${p.qualityLimit} ${p.kbps}kbps chg=${p.pictureChangedPct}% | view ${v.decoder} ${v.decodedFps}fps freezes=${v.freezes} lat p50=${v.latencyMs?.p50} p90=${v.latencyMs?.p90} ${v.kbps}kbps | main ${r.publisherMainThread.taskSecPerSec}s/s | 3D ${r.viewerRender?.framesPerS}fps | cpu ${r.cpuCores?.totalCores} cores | gpu ${r.gpuUtilPct?.device}%`);
  }
  save(); await ctx.close(); server.close();
}
