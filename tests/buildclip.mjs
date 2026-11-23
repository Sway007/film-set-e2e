// One clip: the Film set card building live on the canvas (an edit asked of the agent rebuilds the set and streams the build into
// the card). Recording starts when the card shows it is building and stops a few seconds after it is done; played at 2x.
import path from 'node:path';
import { FE, BFF, OUT, launch, signIn, dismiss, sleep, log, result, save, watchOverview, focusBySearch } from './lib.mjs';
import { createClips } from './clips.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const ENV = process.env.AGENT_ENV || ''; if (ENV && !/^[a-z0-9-]+$/.test(ENV)) throw new Error('bad agent_env');
const SAY = process.env.SENTENCE; if (!SAY) throw new Error('SENTENCE input is required');
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
const building = () => page.evaluate(() => /\bBuilding\b|搭建中|\b\d{1,2}%/.test(document.body.innerText)).catch(() => false);
try {
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}${ENV ? `&agent_env=${ENV}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  if (await page.getByText('Front desk', { exact: true }).nth(1).isVisible().catch(() => false)) { await page.mouse.click(631, 40); await sleep(1500); }
  const target = overview.nodes.find((n) => MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no set matching ${MATCH}`);
  const title = String(target.data.title).slice(0, 30);
  // Say it to the agent in the canvas chat bar, then bring the card back to the middle with nothing over it.
  const typeBar = page.getByText(/to type/).first();
  if (await typeBar.isVisible({ timeout: 3000 }).catch(() => false)) await typeBar.click(); else { await page.mouse.click(700, 450); await page.keyboard.press('/'); }
  await sleep(1200); await page.keyboard.type(SAY, { delay: 30 }); await sleep(500); await page.keyboard.press('Enter');
  const sent = Date.now(); log('sent');
  await sleep(3000); await page.keyboard.press('Escape');
  const where = await focusBySearch(page, title);
  if (!where) throw new Error('could not bring the set to the middle');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(300); }
  await page.mouse.move(where.x, where.y + 460);
  const clip = await createClips(ctx, page, path.join(OUT, 'frames'));
  // Wait for the card to start building (the agent hands the edit over, the canvas's runner picks it up), then record it.
  let started = 0;
  for (let i = 0; i < 120 && !started; i++) { if (await building()) started = Date.now(); else await sleep(1500); }
  result.waitedForBuildSeconds = Math.round(((started || Date.now()) - sent) / 1000);
  if (!started) throw new Error('the card never showed a build');
  await clip.start('build'); log('building');
  let quiet = 0;
  for (let i = 0; i < 400; i++) { await sleep(1000); if (await building()) quiet = 0; else if (++quiet >= 4) break; }
  await sleep(2000); await clip.stop();
  result.buildSeconds = Math.round((Date.now() - started) / 1000);
  result.video = await clip.render(path.join(OUT, 'film-set-build.webm'), { speed: 2 });
  log('video', JSON.stringify(result.video));
} catch (e) { result.error = e.message.slice(0, 300); log('error', result.error); }
finally { save(); await ctx.close(); }
