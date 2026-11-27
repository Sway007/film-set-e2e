// One-time (Sway 11-27): the runner's browser profile signed in as the person who owns the film sets under test. The repo's test
// account reads someone else's world as "scene 404", so the popup never loads. Opens a window on this Mac with TapNow and CineMap
// signed out; the person signs in with their own account there and opens any film set's popup once. Done when CineMap's 3D viewer
// (editor.html) loads in that popup. Waits up to 10 minutes.
import { FE, BFF, launch, sleep, log, result, save } from './lib.mjs';

const { ctx, page } = await launch();
try {
  const before = (await ctx.cookies()).length;
  await ctx.clearCookies({ domain: /cinemap\.space$/ }).catch(async () => { await ctx.clearCookies(); });
  result.clearedCookies = before - (await ctx.cookies()).length;
  if (process.env.CM_SHARE) { await page.goto(`https://pr-11305.cinemap.space/?_vercel_share=${process.env.CM_SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(2000); }
  const share = process.env.VERCEL_SHARE;
  const canvas = process.env.CANVAS_ID;
  await page.goto(`https://${FE}/${canvas ? `p/${canvas}?t=c&` : '?'}${share ? `_vercel_share=${share}&` : ''}bff_env=${BFF}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  log('opened TapNow — sign in with your own account in this window, then open a film set (进入片场) once');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (page.frames().some((f) => /editor\.html/.test(f.url()))) { result.login = 'viewer loaded'; log('CineMap viewer loaded: this profile can open the set'); break; }
    await sleep(3000);
  }
  result.login = result.login || 'timed out';
} finally { save(); await sleep(3000); await ctx.close(); }
