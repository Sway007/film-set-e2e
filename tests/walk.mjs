// Walkthrough of the paths no other test covers, on a fresh canvas in canvas_id's team, bound to an Agent preview:
//  - the empty card: its stage floor and "Let Agent start" (Ethan 11-23), and the Agent building the set from it (a create
//    job started by the Agent, not by the card's own field);
//  - the buddy's "Starting to build the film set" line while the Agent builds (Ethan #11087);
//  - the canvas tab left in the background for 90 s while the job runs (the runner frame must not stall or park);
//  - the finished card's tour video (Ethan #2202): size, length, bytes;
//  - the add menu once the canvas has a set: the row says "On canvas" and a press goes to it, never adds a second;
//  - every media URL on the canvas loads.
// Prints only states, timings and counts (public repo); screenshots stay on this Mac.
import { FE, BFF, launch, signIn, dismiss, sleep, log, result, save, shot } from './lib.mjs';

const CANVAS = process.env.CANVAS_ID; if (!CANVAS) throw new Error('CANVAS_ID input is required');
const ENV = process.env.AGENT_ENV || ''; if (!/^[a-z0-9-]+$/.test(ENV)) throw new Error('agent_env input is required');
const BACKGROUND_S = Number(process.env.BACKGROUND_S || 90);
const { ctx, page } = await launch();
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 1000);
const scrub = (s) => String(s || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>');
const worldCards = () => page.locator('.react-flow__node').filter({ has: page.locator('[data-testid^="cinemap-world"]') });

const all = { nodes: [] };
page.on('response', async (r) => { if (!/\/canvases\/[^/]+\/overview/.test(r.url())) return; try { const d = await r.json(); const out = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id && o.type && o.data) out.push(o); Object.values(o).forEach(walk); } }; walk(d); all.nodes = out; } catch {} });
async function mediaCheck() {
  const urls = new Map();
  for (const n of all.nodes) { const walk = (o, p) => { if (typeof o === 'string') { if (/^https:\/\/[^ ]+\.(mp4|webm|mov|png|jpe?g|webp)(\?|$)|\/storage\/uploads\//i.test(o)) urls.set(o, `${n.type}:${p}`); } else if (Array.isArray(o)) o.forEach((v) => walk(v, `${p}[]`)); else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => walk(v, `${p}.${k}`)); }; walk(n.data, 'data'); }
  for (const u of await page.evaluate(() => [...document.querySelectorAll('.react-flow__node video, .react-flow__node img')].map((e) => e.currentSrc || e.src).filter((s) => /^https:/.test(s)))) if (!urls.has(u)) urls.set(u, 'dom');
  const byHost = {};
  for (const [u, where] of urls) {
    let host = '?'; try { host = new URL(u).host; } catch {}
    const r = await page.request.get(u, { headers: { Range: 'bytes=0-1023' }, timeout: 30000, failOnStatusCode: false }).then((x) => x.status()).catch(() => 'error');
    byHost[`${host} ${r}`] = (byHost[`${host} ${r}`] || 0) + 1;
    if (!/^20[06]$/.test(String(r))) log('bad media', host, r, where);
  }
  result.media = { urls: urls.size, byHost }; log('media', JSON.stringify(byHost));
}

try {
  await signIn(page);
  const states = []; let last = '';
  page.on('response', async (r) => {
    if (!/cinemap-worlds?\/|\/api\/tapnow\/jobs\//.test(r.url()) || r.request().method() !== 'GET') return;
    try { const d = await r.json(); const w = d?.data ?? d; const s = [w?.status, w?.progress?.stage ?? w?.stage, w?.failure_code ?? w?.error_code].filter(Boolean).join('/');
      if (s && s !== last) { last = s; states.push({ t: at(), s, error: w?.error ? scrub(w.error).slice(0, 200) : undefined }); log('world', s); } } catch {}
  });
  const chat = { run: null };
  page.on('request', (r) => { const m = r.url().match(/agent-gateway-stream\/v1\/runs\/([0-9a-f-]{36})/); if (m && !chat.run) { chat.run = at(); log('agent run started'); } });

  await page.goto(`https://${FE}/p/${CANVAS}?t=c&bff_env=${BFF}&agent_env=${ENV}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(15000);
  const sw = page.getByRole('button', { name: /^Switch to / });
  if (await sw.count().catch(() => 0)) { log('switching team'); await sw.first().click(); await sleep(20000); }
  await dismiss(page);
  const u0 = page.url();
  await page.getByText('Canvases', { exact: true }).locator('xpath=..').locator('button').first().click({ timeout: 20000 });
  for (let i = 0; i < 30 && page.url() === u0; i++) await sleep(1000);
  if (page.url() === u0) throw new Error('no new canvas');
  // keep the agent preview on the new canvas
  if (!page.url().includes('agent_env=')) await page.goto(page.url() + (page.url().includes('?') ? '&' : '?') + `agent_env=${ENV}`, { waitUntil: 'domcontentloaded' });
  await sleep(20000); await dismiss(page);

  // 1. the empty card
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  await page.getByTestId('add-node-3d-world').click(); await sleep(4000); await dismiss(page);
  const empty = page.locator('[data-testid="cinemap-world-empty"]').last();
  result.empty = {
    floor: await page.locator('[data-testid="cinemap-world-empty-floor"]').count(),
    letAgent: await empty.getByText('Let Agent start').count(),
    describe: await empty.getByText(/describe the scene yourself/i).count(),
  };
  log('empty card', JSON.stringify(result.empty)); await shot(page, 'empty-card');

  // 2. hand the card to the Agent
  const sentAt = at();
  await empty.getByText('Let Agent start').first().click({ timeout: 20000 });
  log('let agent start');
  // With nothing on the canvas to go by, the Agent may ask what to build first (a question card with numbered answers).
  const submit = page.getByRole('button', { name: /^Submit$/ });
  for (let i = 0; i < 30 && !chat.asked; i++) {
    await sleep(3000);
    if (await submit.isVisible().catch(() => false)) {
      chat.asked = at() - sentAt; await shot(page, 'agent-asks');
      const panel = page.locator('div').filter({ has: submit }).filter({ hasText: /^[\s\S]*1[\s\S]*2/ }).last();
      await panel.getByText(/^1$/).first().click({ timeout: 10000 }).catch((e) => log('pick', e.message.slice(0, 100)));
      await sleep(800); await submit.click({ timeout: 10000 }); log('agent asked after', chat.asked, 's; picked answer 1');
    }
    if (/queued|running|building|claimed/i.test(last)) break;
  }
  result.agentAskedS = chat.asked ?? null;

  // 3. leave the tab in the background for a while once the job is under way
  let buddyAt = null, backgroundDone = false, end = null, cardText = '';
  for (let i = 0; i < 150; i++) {
    await sleep(8000);
    if (buddyAt == null && (await page.getByText('Starting to build the film set').count().catch(() => 0))) { buddyAt = at() - sentAt; log('buddy line after', buddyAt, 's'); await shot(page, 'buddy'); }
    if (!backgroundDone && /queued|running|building|claimed/i.test(last)) {
      backgroundDone = true; const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront();
      log('tab in background', BACKGROUND_S, 's at', last); await sleep(BACKGROUND_S * 1000);
      await page.bringToFront(); await other.close(); log('tab back at', last); result.backgroundAt = last;
    }
    const card = await page.evaluate(() => { for (const n of document.querySelectorAll('.react-flow__node')) if (n.querySelector('[data-testid^="cinemap-world"]')) { const v = n.querySelector('[data-testid="cinemap-world-turntable-video"]'); return { text: n.textContent.slice(0, 160), video: v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight, s: Math.round(v.duration || 0), src: v.currentSrc } : null }; } return null; });
    cardText = card?.text || cardText;
    if (i % 8 === 7) await shot(page, `wait-${i}`);
    if (card?.video) {
      const head = await page.request.fetch(card.video.src, { method: 'HEAD', failOnStatusCode: false }).catch(() => null);
      result.video = { w: card.video.w, h: card.video.h, seconds: card.video.s, bytes: Number(head?.headers()['content-length']) || null, status: head?.status() };
      end = 'ready'; break;
    }
    if (/^(failed|cancelled)/.test(last) || /failed|didn't get built|out of tapies|did not start/i.test(cardText)) { end = 'failed'; break; }
  }
  result.agentRunAt = chat.run; result.buddyLineS = buddyAt; result.end = end || 'timeout'; result.endS = at() - sentAt; result.states = states;
  if (end !== 'ready') result.cardText = scrub(cardText);
  log('end', result.end, result.endS, 's', JSON.stringify(result.video || {}));
  await shot(page, 'end');

  // 4. the add menu with a set on the canvas: "On canvas", and a press goes to it
  await page.keyboard.press('Escape'); await page.mouse.click(1500, 900); await sleep(800);
  const before = await worldCards().count();
  await page.getByRole('button', { name: 'Add node' }).click(); await sleep(1500);
  const row = page.getByTestId('add-node-3d-world');
  result.addRow = { text: scrub(await row.textContent().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160) };
  await shot(page, 'add-menu');
  await row.click({ timeout: 10000 }).catch((e) => { result.addRow.clickError = e.message.slice(0, 120); });
  await sleep(2500);
  result.addRow.menuClosed = !(await page.getByTestId('add-node-3d-world').isVisible().catch(() => false));
  result.addRow.cardsBefore = before; result.addRow.cardsAfter = await worldCards().count();
  result.addRow.selected = await page.locator('.react-flow__node.selected [data-testid^="cinemap-world"]').count();
  log('add row', JSON.stringify(result.addRow)); await shot(page, 'went-to-set');

  // 5. media on the canvas, read fresh
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(25000); await dismiss(page);
  await mediaCheck();
} catch (e) { result.error = scrub(e?.message || e).slice(0, 300); log('ERROR', result.error); await shot(page, 'error'); }
finally { save(); await ctx.close(); }
