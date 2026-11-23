// Records only the moments that matter (CDP screencast frames of the tab, iframes included) and stitches them into one short webm
// with the ffmpeg Playwright installs for its own videos. Loading in between is simply not recorded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

export function findFfmpeg() {
  try { const p = execSync('command -v ffmpeg', { encoding: 'utf8' }).trim(); if (p) return p; } catch { /* no system ffmpeg */ }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const r of roots) { try { for (const d of fs.readdirSync(r).filter((x) => x.startsWith('ffmpeg')).sort().reverse()) for (const f of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe']) { const p = path.join(r, d, f); if (fs.existsSync(p)) return p; } } catch { /* next */ } }
  return null;
}

export async function createClips(ctx, page, dir, { fps = 25, quality = 82, maxWidth = 1600, maxHeight = 1000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const segs = []; let cur = null, n = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!cur) return;
    const file = path.join(dir, `f${String(n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64')); cur.frames.push({ file, t: metadata.timestamp });
  });
  const api = {
    async start(name) { if (cur) await api.stop(); cur = { name, frames: [], t0: Date.now() }; await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 }); },
    async stop() { if (!cur) return; await new Promise((r) => setTimeout(r, 200)); const seg = cur; seg.t1 = Date.now(); cur = null; segs.push(seg); await cdp.send('Page.stopScreencast').catch(() => {}); }, // the end is when we said stop: a busy page can answer stopScreencast seconds later
    /** Stitch every segment, holding each frame until the next one (screencast only sends frames when the picture changes). */
    async render(outFile) {
      await api.stop();
      const ff = findFfmpeg(); if (!ff) return { error: 'no ffmpeg' };
      const args = ['-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-y', '-an', '-c:v', 'vp8', '-b:v', '3M', '-crf', '8', '-qmin', '0', '-qmax', '40', '-deadline', 'good', '-threads', '2', outFile];
      const p = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; });
      const write = (buf) => new Promise((r) => (p.stdin.write(buf) ? r() : p.stdin.once('drain', r)));
      let out = 0; const lens = [];
      for (const s of segs) {
        const end = s.t1 / 1000, f = s.frames.filter((x) => x.t <= end).sort((a, b) => a.t - b.t); if (!f.length) continue; let segFrames = 0; // frame timestamps are wall-clock seconds
        for (let i = 0; i < f.length; i++) {
          const until = i + 1 < f.length ? f[i + 1].t : end;
          const k = Math.max(1, Math.round((until - f[i].t) * fps)); const buf = fs.readFileSync(f[i].file);
          for (let j = 0; j < k; j++) await write(buf);
          out += k; segFrames += k;
        }
        lens.push({ name: s.name, seconds: +(segFrames / fps).toFixed(1) });
      }
      p.stdin.end();
      const code = await new Promise((r) => p.on('close', r));
      for (const s of segs) for (const f of s.frames) fs.rmSync(f.file, { force: true });
      return code === 0 ? { file: path.basename(outFile), seconds: +(out / fps).toFixed(1), segments: lens } : { error: `ffmpeg ${code}: ${err.slice(0, 200)}` };
    },
  };
  return api;
}
