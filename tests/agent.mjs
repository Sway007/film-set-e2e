// Agent chat edits a Film set: opens the canvas bound to an Agent PR preview (agent_env), sends one sentence to the canvas
// chat, and follows the set's job until it ends. Only this page is open, so the job is claimed by this page's own runner.
// Prints only states and timings (public repo); screenshots stay on this Mac.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot, watchOverview } from './lib.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const ENV = process.env.AGENT_ENV || ''; if (ENV && !/^[a-z0-9-]+$/.test(ENV)) throw new Error('bad agent_env');
const SAY = process.env.SENTENCE;
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);
try {
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}${ENV ? `&agent_env=${ENV}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  const target = overview.nodes.find((n) => MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no set matching ${MATCH}`);
  result.set = target.data.title; result.before = { status: target.data.cinemap.status, job: !!target.data.cinemap.job_id };
  const sceneId = target.data.cinemap.scene_id;
  // The world's state as the canvas polls it (cinemap-worlds/<scene>): status / stage / error code, each change once.
  const states = []; let last = '';
  page.on('response', async (r) => {
    if (!r.url().includes(sceneId) || r.request().method() !== 'GET') return;
    try { const d = await r.json(); const w = d?.data ?? d; const s = [w?.status, w?.progress?.stage ?? w?.stage, w?.error_code].filter(Boolean).join('/');
      if (s && s !== last) { last = s; states.push({ t: at(), s, error: w?.error ? String(w.error).slice(0, 160) : undefined }); log('world', s); } } catch {}
  });
  const chat = { capability: null, run: null, tools: [] };
  page.on('request', (r) => { if (r.method() === 'POST' && /agent-gateway/.test(r.url()) && chat.capability === null) { const b = r.postData() || ''; if (/client_capabilities/.test(b)) chat.capability = /"cinemap_world":\{"available":true\}/.test(b); } });
  page.on('request', (r) => { const m = r.url().match(/agent-gateway-stream\/v1\/runs\/([0-9a-f-]{36})/); if (m && !chat.run) { chat.run = m[1].slice(0, 8); log('run', chat.run); } });
  // The canvas chat, not the Front desk panel.
  if (await page.getByText('Front desk', { exact: true }).nth(1).isVisible().catch(() => false)) { await page.mouse.click(631, 40); await sleep(1500); }
  await page.mouse.click(700, 450); await page.keyboard.press('/'); await sleep(1500);
  await page.keyboard.type(SAY, { delay: 20 }); await sleep(500); await page.keyboard.press('Enter');
  result.sentAt = at(); log('sent');
  for (let i = 0; i < 90; i++) { await sleep(10000); if (/^(ready|failed|cancelled)/.test(last) && i > 3) break; if (i % 12 === 11) await shot(page, `agent-${i}`); }
  await shot(page, 'agent-end');
  result.chat = chat; result.states = states; result.final = last;
} catch (e) { result.error = e.message.slice(0, 300); log('error', result.error); }
finally { save(); await ctx.close(); }
