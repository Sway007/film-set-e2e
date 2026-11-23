// Feature demo recording (real GPU): card turntable → one film set per canvas → popup (orbit, WASD, rests when still, Esc) → agent edits the set.
// The screen recording (webm) stays on this Mac in the results folder; the log prints only the steps and timings.
import path from 'node:path';
import { FE, BFF, OUT, launch, signIn, dismiss, sleep, log, result, save, shot, watchOverview, focusBySearch } from './lib.mjs';
import { createClips } from './clips.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const ENV = process.env.AGENT_ENV || ''; if (ENV && !/^[a-z0-9-]+$/.test(ENV)) throw new Error('bad agent_env');
const SAY = process.env.SENTENCE;
const MATCH = new RegExp(process.env.SET_MATCH || 'airport', 'i');
const { ctx, page } = await launch();
const steps = []; const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);
const caption = async (text) => { steps.push({ t: at(), step: text }); log('step', text); await page.evaluate((s) => { let d = document.getElementById('__demo_cap'); if (!d) { d = document.createElement('div'); d.id = '__demo_cap'; Object.assign(d.style, { position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)', zIndex: 2147483647, background: 'rgba(17,17,17,.86)', color: '#fff', font: '600 22px/1.4 -apple-system, "PingFang SC", sans-serif', padding: '10px 22px', borderRadius: '12px', pointerEvents: 'none', boxShadow: '0 6px 24px rgba(0,0,0,.35)' }); document.body.append(d); } d.textContent = s; }, text).catch(() => {}); };
async function openPopup(where) {
  const viaButton = await page.evaluate(({ x, y }) => { const bs = [...document.querySelectorAll('[data-testid="cinemap-world-enter"]')].map((e) => { const r = e.getBoundingClientRect(); return { e, d: Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y), ok: r.width > 0 }; }).filter((b) => b.ok && b.d < 400).sort((a, b) => a.d - b.d); if (bs[0]) { bs[0].e.click(); return true; } return false; }, where);
  if (!viaButton) await page.mouse.dblclick(where.x, where.y);
  const s0 = Date.now();
  for (let i = 0; i < 180; i++) { const ok = await page.evaluate(() => { const d = document.querySelector('[data-testid="cinemap-world-detail-dialog"]'); const c = d?.querySelector('[data-testid="cinemap-world-frame-cover"]'); return !!d?.querySelector('iframe') && c?.hasAttribute('data-shown') === false; }); if (ok) return (Date.now() - s0) / 1000; await sleep(500); }
  return null;
}
try {
  const overview = watchOverview(page);
  await signIn(page);
  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}${ENV ? `&agent_env=${ENV}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(25000); await dismiss(page);
  if (await page.getByText('Front desk', { exact: true }).nth(1).isVisible().catch(() => false)) { await page.mouse.click(631, 40); await sleep(1500); }
  const target = overview.nodes.find((n) => MATCH.test(`${n.data.title || ''} ${n.data.cinemap.brief || ''}`));
  if (!target) throw new Error(`no set matching ${MATCH}`);
  const sceneId = target.data.cinemap.scene_id;
  const clip = await createClips(ctx, page, path.join(OUT, 'frames'));

  await caption('① 片场卡片：搭好后是 720p 慢速转台视频（60 秒一圈）');
  const where = await focusBySearch(page, String(target.data.title).slice(0, 30));
  if (!where) throw new Error('could not bring the set to the middle');
  await page.mouse.move(where.x + 380, where.y + 260); await sleep(1500);
  await clip.start('card'); await sleep(5000); await clip.stop();

  await caption('② 一个画布只能有一个片场：添加菜单里「片场」置灰并提示');
  try {
    const plus = await page.evaluate(() => { const bar = [...document.querySelectorAll('*')].find((e) => /to type/.test(e.textContent || '') && e.children.length < 6 && e.getBoundingClientRect().width < 500); if (!bar) return null; const b = bar.closest('div')?.getBoundingClientRect() ?? bar.getBoundingClientRect(); const cy = b.y + b.height / 2; const bs = [...document.querySelectorAll('button')].map((x) => ({ r: x.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && Math.abs(r.y + r.height / 2 - cy) < 30 && r.x > b.x + b.width - 5).sort((a, c) => a.r.x - c.r.x); return bs[0] ? { x: bs[0].r.x + bs[0].r.width / 2, y: bs[0].r.y + bs[0].r.height / 2 } : null; });
    await clip.start('one-set');
    if (plus) { await page.mouse.click(plus.x, plus.y); await sleep(1500); }
    const row = page.getByText(/^(Film set|片场)$/).first();
    if (await row.isVisible({ timeout: 3000 }).catch(() => false)) { const rb = await row.boundingBox(); await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2); await sleep(3000); result.menuRow = await row.evaluate((e) => { const it = e.closest('[role="menuitem"],button,[aria-disabled]'); return { disabled: it?.getAttribute('aria-disabled') ?? it?.hasAttribute?.('disabled') ?? null }; }).catch(() => null); }
    else log('menu row not found', plus ? 'plus clicked' : 'no plus');
    await page.keyboard.press('Escape'); await sleep(600); await clip.stop();
  } catch (e) { await clip.stop(); log('menu step skipped', e.message.slice(0, 80)); }

  await caption('③ 进入片场：轻量只读查看器，在弹窗里预览 3D 场景');
  await clip.start('open'); await sleep(200);
  const opening = openPopup(where); await sleep(2200); await clip.stop();
  const ready = await opening; result.popupReadySeconds = ready; await sleep(800);
  await clip.start('popup');
  await caption('④ 拖动转镜头（画布在弹窗下暂停渲染）');
  const box = await page.locator('[data-testid="cinemap-world-detail-dialog"] iframe').first().boundingBox();
  if (box) { const cx = box.x + box.width / 2, cy = box.y + box.height / 2; await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 40; i++) { await page.mouse.move(cx + i * 6, cy + Math.sin(i / 6) * 20); await sleep(40); } await page.mouse.up(); await sleep(1500); await page.mouse.click(cx, cy); }
  await caption('⑤ WASD 自由漫游：W 前进 · S 后退 · A/D 左右 · Q/E 下降/上升 · Shift 加速');
  for (const [k, ms] of [['w', 2200], ['a', 900], ['d', 1800], ['s', 1000], ['e', 700], ['q', 700]]) { await page.keyboard.down(k); await sleep(ms); await page.keyboard.up(k); await sleep(300); }
  await page.keyboard.down('Shift'); await page.keyboard.down('w'); await sleep(1200); await page.keyboard.up('w'); await page.keyboard.up('Shift'); await sleep(800);
  await caption('⑥ 镜头不动约 4 秒后自动停止渲染，几乎不占 CPU / GPU');
  await sleep(4500);
  await caption('⑦ 在弹窗里按 Esc 直接关闭');
  await page.keyboard.press('Escape'); await sleep(2500);
  result.closedByEsc = !(await page.locator('[data-testid="cinemap-world-detail-dialog"]').isVisible().catch(() => false));
  await clip.stop();

  if (SAY) {
    await caption('⑧ 在画布里跟 agent 说一句话，直接改这个片场');
    await clip.start('agent');
    const states = []; let last = '';
    page.on('response', async (r) => { if (!r.url().includes(sceneId) || r.request().method() !== 'GET') return; try { const d = await r.json(); const w = d?.data ?? d; const s = [w?.status, w?.progress?.stage ?? w?.stage].filter(Boolean).join('/'); if (s && s !== last) { last = s; states.push({ t: at(), s }); } } catch {} });
    let run = null; page.on('request', (r) => { const m = r.url().match(/agent-gateway-stream\/v1\/runs\/([0-9a-f-]{36})/); if (m && !run) run = m[1].slice(0, 8); });
    await page.keyboard.press('Escape'); await sleep(500);
    const typeBar = page.getByText(/to type/).first();
    if (await typeBar.isVisible({ timeout: 2000 }).catch(() => false)) await typeBar.click(); else { await page.mouse.click(700, 450); await page.keyboard.press('/'); }
    await sleep(1500);
    await page.keyboard.type(SAY, { delay: 45 }); await sleep(800); await page.keyboard.press('Enter');
    const sent = Date.now(); await sleep(8000); await clip.stop();
    for (let i = 0; i < 48; i++) { await sleep(5000); if (/^(ready|failed)/.test(last) && states.length > 1) break; if (!states.length && Date.now() - sent > 150000) break; }
    if (/^ready/.test(last) && states.some((x) => !/^ready/.test(x.s)) || !states.length) { await caption('⑨ 片场按 agent 的指令重建完成，再进去看效果'); await clip.start('rebuilt'); await sleep(3000); await clip.stop(); } else { result.agentNotDone = true; log('agent edit did not finish', last); }
    result.agent = { run, states, final: last, seconds: Math.round((Date.now() - sent) / 1000) };
    await page.keyboard.press('Escape'); await sleep(800); const where2 = where;
    result.popupReadySeconds2 = await openPopup(where2); await sleep(800);
    await clip.start('result'); await caption('⑩ 改完的片场');
    const box2 = await page.locator('[data-testid="cinemap-world-detail-dialog"] iframe').first().boundingBox();
    if (box2) { const cx = box2.x + box2.width / 2, cy = box2.y + box2.height / 2; await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 50; i++) { await page.mouse.move(cx - i * 6, cy); await sleep(50); } await page.mouse.up(); }
    await sleep(3000); await page.keyboard.press('Escape'); await sleep(800); await clip.stop();
  }
  await shot(page, 'demo-end');
  result.highlights = await clip.render(path.join(OUT, 'film-set-highlights.webm'));
  log('highlights', JSON.stringify(result.highlights));
} catch (e) { result.error = e.message.slice(0, 300); log('error', result.error); }
finally { result.steps = steps; save(); await ctx.close(); log('video saved in the results folder (webm)'); }
