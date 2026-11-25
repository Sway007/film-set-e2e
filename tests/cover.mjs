// CM-1025 (11-25): the cloud renders nothing, so the card's still and its 60 s video are made by the card's viewer in this browser.
// Builds a new Film set on a new canvas, stays on the page, and reports what the viewer said ([node media] lines), what went up
// (POST poster / turntable_video / render_res / clips, status only) and what the card plays in the end (a <video>: size, seconds, bytes).
process.env.BFF_ENV ||= 'pr-11238';
process.env.FE_HOST ||= 'tapnow-pr-11305.cinemap.space';
const { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, typeIntoEmptyCard } = await import('./lib.mjs');

const CM = process.env.CM_HOST || 'pr-11305.cinemap.space';
const CANVAS = process.env.CANVAS_ID;
const SENTENCE = process.env.SENTENCE || 'A quiet bus stop at dusk with one bench and a streetlight';
const AGENT = process.env.AGENT_ENV || 'pr-3679-b7f266';
const STAY_S = Number(process.env.CYCLES) > 0 ? Number(process.env.CYCLES) * 60 : 420; // minutes on the page after the set is ready
const { ctx, page } = await launch();
const media = [], net = [];
ctx.on('console', (m) => { const t = m.text(); if (/\[node media\]|\[runner-live\]|\[clip-render\]|\[clip|turntable|falling back to React Flow|webgpu/i.test(t)) { media.push(t.slice(0, 400)); log('CON', t.slice(0, 400)); } });
const clipNet = [], videoReq = [];
ctx.on('response', async (r) => { const u = r.url(); if (/[?&]tv=/.test(u)) { const h = r.headers(); log('VIDEO RES', r.status(), h['content-type'] || '', h['content-range'] || h['content-length'] || ''); } });
ctx.on('requestfailed', (q) => { if (/[?&]tv=/.test(q.url())) log('VIDEO FAILED', q.failure()?.errorText || ''); });
ctx.on('console', (m) => { if (m.type() === 'error' || /video|media|cover/i.test(m.text())) { const t = m.text(); if (!/favicon|sso-api/.test(t)) log('CONERR', m.type(), t.slice(0, 260)); } });
ctx.on('request', (q) => { const u = q.url(); if (/[?&]tv=/.test(u)) { videoReq.push(`${q.resourceType()} ${(q.headers().range || '').slice(0, 30)}`); if (videoReq.length <= 3) { log('VIDEO REQ', q.resourceType(), q.headers().range || ''); for (const d of [300, 1500, 4000, 10000]) setTimeout(() => page.evaluate(() => ({ videos: [...document.querySelectorAll('video')].map((v) => ({ tv: /[?&]tv=/.test(v.currentSrc || v.src || ''), ready: v.readyState, net: v.networkState, err: v.error?.code ?? null, paused: v.paused, w: v.videoWidth, inDoc: v.isConnected })), nodes: document.querySelectorAll('.react-flow__node').length, nodeHtml: [...document.querySelectorAll('.react-flow__node')].map((n) => n.innerHTML.length), iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src.match(/render=clips|ui=watch|embed=node/) || ['?'])[0]), canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}${c.getAttribute('data-webgpu') != null ? ':gpu' : ''}`).slice(0, 6), gpuAttr: [...document.querySelectorAll('[data-webgpu-plane],[data-render-mode],[data-canvas-renderer]')].map((e) => e.getAttribute('data-render-mode') || e.getAttribute('data-canvas-renderer') || 'plane').slice(0, 4), renderer: { ...(document.querySelector('[data-canvas-renderer]')?.dataset || {}) }, gpuHost: !!document.querySelector('[data-webgpu-host]'), shotHtml: [...document.querySelectorAll('.react-flow__node')].filter((n) => !/Step inside/.test(n.textContent)).map((n) => n.innerHTML.length) })).then((v) => log('VIDEOS after', d, 'ms', JSON.stringify(v))).catch(() => {}), d); } } });
ctx.on('response', (r) => { const u = new URL(r.url()); if (/\/api\/tapnow\/clips/.test(u.pathname) || /[?&]render=clips/.test(u.search)) { const e = `${r.request().method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, ':id')}${/render=clips/.test(u.search) ? '?render=clips' : ''} ${r.status()}`; clipNet.push(e); log('CLIP', e); } });
ctx.on('response', (r) => { const m = /\/api\/jobs\/[^/]+\/(poster|turntable_video|render_res|clips)$/.exec(new URL(r.url()).pathname); if (m && r.request().method() === 'POST') { net.push(`${m[1]} ${r.status()}`); log('NET', m[1], r.status()); } });
// a <video> that fails says why (capture phase: media errors do not bubble)
await ctx.addInitScript(() => { document.addEventListener('error', (e) => { const v = e.target; if (v && v.tagName === 'VIDEO') console.log('[vid-err]', JSON.stringify({ code: v.error?.code ?? null, message: v.error?.message ?? '', tv: /[?&]tv=/.test(v.currentSrc || v.src || ''), ready: v.readyState, net: v.networkState })); }, true); });
// the uploaded file itself: its avcC (profile, level), whether this browser says it can play it, and a fresh off-canvas <video>'s verdict
const probeFile = (u) => page.evaluate(async (u) => {
  const out = {};
  try {
    const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); out.bytes = b.length;
    const find = (tag) => { const t = [...tag].map((c) => c.charCodeAt(0)); for (let i = 0; i < b.length - 4; i++) if (b[i] === t[0] && b[i + 1] === t[1] && b[i + 2] === t[2] && b[i + 3] === t[3]) return i; return -1; };
    out.boxes = ['ftyp', 'moov', 'mdat', 'moof', 'avc1', 'avcC', 'hvc1', 'vp09', 'av01'].filter((t) => find(t) >= 0);
    out.order = ['moov', 'mdat'].map((t) => `${t}@${find(t)}`).join(' ');
    const c = find('avcC'); if (c >= 0) { const h = (x) => x.toString(16).padStart(2, '0'); out.codec = `avc1.${h(b[c + 5])}${h(b[c + 6])}${h(b[c + 7])}`; out.canPlay = document.createElement('video').canPlayType(`video/mp4; codecs="${out.codec}"`); out.mse = window.MediaSource?.isTypeSupported?.(`video/mp4; codecs="${out.codec}"`) ?? null; }
    const st = find('stsd'); if (st >= 0) out.stsd = [...b.slice(st + 12, st + 40)].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    const url = URL.createObjectURL(new Blob([b], { type: 'video/mp4' }));
    out.fresh = await new Promise((res) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; const done = (k) => res({ k, code: v.error?.code ?? null, message: v.error?.message ?? '', w: v.videoWidth, h: v.videoHeight, d: Math.round(v.duration || 0) }); v.onloadeddata = () => done('loaded'); v.onerror = () => done('error'); setTimeout(() => done('timeout'), 15000); v.src = url; v.play().catch(() => {}); });
  } catch (e) { out.err = String(e?.message || e); }
  return out;
}, u);
let probed = false;
ctx.on('request', (q) => { const u = q.url(); if (!probed && /[?&]tv=/.test(u)) { probed = true; probeFile(u).then((r) => { result.file = r; log('VIDEO FILE', JSON.stringify(r)); }).catch((e) => log('VIDEO FILE probe failed', String(e))); } });
ctx.on('console', (m) => { if (/\[vid-err\]/.test(m.text())) log('VIDEO ERR', m.text().slice(0, 300)); });
try {
  await signIn(page);
  // the CineMap preview is behind Vercel Authentication: one top-level visit puts its cookie in this profile (the card's frame needs it)
  const cm = await ctx.newPage(); await cm.goto(`https://${CM}/`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}); await sleep(6000);
  result.cinemapHost = new URL(cm.url()).host; log('cinemap host after visit', result.cinemapHost); await cm.close();
  if (!CANVAS) throw new Error('CANVAS_ID input is required');
  const q = `t=c&bff_env=${BFF}&agent_env=${AGENT}&agent_team=project`;
  await page.goto(`https://${FE}/p/${CANVAS}?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(15000);
  const sw = page.getByRole('button', { name: /^Switch to / });
  if (await sw.count().catch(() => 0)) { log('switching team'); await sw.first().click(); await sleep(20000); }
  await dismiss(page);
  const u0 = page.url();
  await page.getByText('Canvases', { exact: true }).locator('xpath=..').locator('button').first().click({ timeout: 20000 });
  for (let i = 0; i < 30 && page.url() === u0; i++) await sleep(1000);
  result.newCanvas = page.url() !== u0; log('new canvas', result.newCanvas);
  if (!result.newCanvas) throw new Error('no new canvas');
  await sleep(15000); await dismiss(page);
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  await page.getByTestId('add-node-3d-world').click(); await sleep(4000); await dismiss(page);
  await typeIntoEmptyCard(page, SENTENCE);
  const t0 = Date.now(), at = () => Math.round((Date.now() - t0) / 1000);
  await page.keyboard.press('Enter'); log('sent'); result.sentence = SENTENCE;

  const card = () => page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe')].filter((f) => /embed=node/.test(f.src)).map((f) => { let o = 1, el = f; while (el && el !== document.body) { o *= Number(getComputedStyle(el).opacity || 1); el = el.parentElement; } return { job: /[?&]job=/.test(f.src), watch: /ui=watch/.test(f.src), opacity: Math.round(o * 100) / 100 }; });
    const vids = [...document.querySelectorAll('video')].map((v) => ({ tv: /[?&]tv=/.test(v.currentSrc || v.src || ''), w: v.videoWidth, h: v.videoHeight, seconds: Math.round((v.duration || 0) * 10) / 10, paused: v.paused, src: v.currentSrc || v.src || '' }));
    const text = [...document.querySelectorAll('.react-flow__node')].map((n) => n.textContent.slice(0, 80)).join(' | ');
    return { frames, vids, text };
  });
  let readyAt = null, liveAt = null, videoAt = null, last = null;
  for (let i = 0; i < 240; i++) {
    await sleep(5000);
    const c = await card().catch(() => null); if (!c) continue; last = c;
    if (liveAt == null && c.frames.some((f) => f.job && f.opacity > 0.5)) { liveAt = at(); log('live viewer shown', liveAt); await shot(page, 'live'); }
    if (readyAt == null && net.some((n) => n.startsWith('poster'))) { readyAt = at(); log('still sent', readyAt); await shot(page, 'still-sent'); }
    if (readyAt == null && media.some((m) => /recording|no video|recorded|skipped|not recording/.test(m))) { readyAt = at(); log('media started', readyAt); }
    const v = c.vids.find((x) => x.tv && x.w > 0);
    if (v && videoAt == null) {
      videoAt = at(); result.video = { w: v.w, h: v.h, seconds: v.seconds, paused: v.paused };
      result.video.bytes = await page.evaluate((u) => fetch(u, { method: 'HEAD' }).then((r) => Number(r.headers.get('content-length')) || null).catch(() => null), v.src);
      log('card plays the video', JSON.stringify(result.video), 'at', videoAt); await sleep(8000); await shot(page, 'video-a'); await sleep(12000); await shot(page, 'video-b');
    }
    if (media.some((m) => /upload ok/.test(m)) && result.motion == null && at() - (readyAt ?? at()) > 40) {
      // the card may draw its video as a texture (no <video> in the DOM): compare the card's pixels 1.5 s apart
      const box = await page.evaluate(() => { const n = [...document.querySelectorAll('.react-flow__node')].find((x) => /Step inside/.test(x.textContent)); const r = n?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 400) } : null; });
      if (box && box.width > 20) {
        const a1 = await page.screenshot({ clip: box }).catch(() => null); await sleep(1500); const a2 = await page.screenshot({ clip: box }).catch(() => null);
        let diff = 0; if (a1 && a2) { const n = Math.min(a1.length, a2.length); for (let k = 0; k < n; k += 97) if (a1[k] !== a2[k]) diff++; diff = Math.round((diff / (n / 97)) * 1000) / 10; }
        result.motion = { changedPct: diff, box: { w: Math.round(box.width), h: Math.round(box.height) } }; log('card motion', JSON.stringify(result.motion)); await shot(page, 'motion');
      }
    }
    const clipVid = c.vids.find((x) => !x.tv && x.w > 0 && /clip|deliver|\.mp4/.test(x.src));
    if (clipVid && result.clipVideoAtS == null) { result.clipVideoAtS = at(); result.clipVideo = { w: clipVid.w, h: clipVid.h, seconds: clipVid.seconds }; log('shot card plays its clip', JSON.stringify(result.clipVideo)); await shot(page, 'clip'); }
    if (videoAt != null && (result.clipVideoAtS != null || !/Waiting to render|Rendering|出片/i.test(c.text))) break;
    if (i % 6 === 0) log('renderer', JSON.stringify(await page.evaluate(() => ({ ...(document.querySelector('[data-canvas-renderer]')?.dataset || {}) })).catch(() => null)));
    if (i % 6 === 0) log('card', JSON.stringify({ frames: c.frames, vids: c.vids.map(({ src, ...r }) => r), text: c.text.slice(0, 120) }));
    if (/failed|失败/i.test(c.text) && liveAt == null && at() > 120) { result.failed = c.text.slice(0, 120); break; }
    if (readyAt != null && at() - readyAt > STAY_S) break;
  }
  result.liveAtS = liveAt; result.mediaStartAtS = readyAt; result.videoAtS = videoAt; result.videoRequests = videoReq.length; result.videoReqKinds = [...new Set(videoReq)].slice(0, 5);
  result.media = media; result.net = net; result.clipNet = clipNet; result.lastText = last?.text?.slice(0, 240);
  result.lastCard = last && { frames: last.frames, vids: last.vids.map(({ src, ...r }) => r) };
  await shot(page, 'end');
} catch (e) { result.error = String(e?.message || e); result.media = media; result.net = net; log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); console.log('RESULT ' + JSON.stringify(result)); await ctx.close(); }
