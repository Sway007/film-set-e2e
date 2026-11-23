// One-time: sign the runner's browser profile in to Vercel, so the CineMap preview (behind Vercel Authentication) loads in the
// popup's iframe. Opens a window on this Mac; the person signs in there. Waits up to 10 minutes.
import { launch, sleep, log, result, save } from './lib.mjs';

const CM = process.env.CM_HOST || 'pr-2178.cinemap.space';
const { ctx, page } = await launch();
try {
  await page.goto(`https://${CM}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  log('opened', new URL(page.url()).host, '— sign in to Vercel in this window if it asks');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const host = new URL(page.url()).host;
    if (host === CM) { const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => ''); if (!/Vercel|Log in/i.test(body) || /CineMap/i.test(body)) { result.vercel = 'signed in'; log('CineMap preview reachable'); break; } }
    await sleep(3000);
  }
  result.vercel = result.vercel || 'timed out';
} finally { save(); await sleep(2000); await ctx.close(); }
