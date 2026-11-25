#!/usr/bin/env node
/**
 * 多页面 / 多视口浏览器冒烟测试（headless Chrome + 假摄像头/麦克风）
 *
 *   BASE=http://localhost:3000 CHROME=/usr/bin/google-chrome OUT=./smoke-out \
 *   [ADMIN_TOKEN=..] [MATRIX=full|lite] [SUITES=viewports,round,interact,latejoin,denied,reconnect,assets] \
 *   [STOP_CMD='...' START_CMD='...' INJECT_DOOR_CMD='...']   # reconnect
 *   [ASSETS_PUT_CMD='...' ASSETS_RM_CMD='...']                # assets
 *   node scripts/browser-smoke.mjs
 * 服务端建议 TIME_SCALE=0.2~0.5。
 */
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = process.env.OUT || './smoke-out';
const TOKEN = process.env.ADMIN_TOKEN || '';
const MATRIX = process.env.MATRIX || 'full';
const SUITES = (process.env.SUITES || 'viewports,round,interact,latejoin,denied,reconnect,assets').split(',');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  ipad: { width: 1024, height: 768, isMobile: true, hasTouch: true },
  ipadP: { width: 820, height: 1180, isMobile: true, hasTouch: true },
  chromebook: { width: 1366, height: 768 },
  projector: { width: 1920, height: 1080 },
};
const PAGES = ['home', 'main', 'door', 'station1', 'station2', 'admin'];
const TEXT = {
  doorCaption: 'NODE TIME 00:30 · AN ANOMALOUS SHADOW COLLAPSED THE FRAME',
  doorEnter: 'LIFT THE CURTAIN · STEP INTO THE PHOTOGRAPH',
  doorStandby: 'SHOOTING IN PROGRESS · PLEASE WAIT',
  s1A: 'ANOMALY DETECTED! HOLD THE BUTTON BELOW AND SHOUT TO STOP HIM — NOW!',
  s1B: 'WARNING: OVEREXPOSURE IS BURNING THE NEGATIVE! RUN TO THE CENTRE OF THE ROOM AND SPREAD YOUR ARMS TO BLOCK THE BEAM ON THE WALL!',
  s2C: 'NO TIME LEFT! RUN OVER AND PULL THE MAIN BREAKER DOWN — CUT THE TIMELINE!',
  s2Lock: 'FORCING POWER CUT...',
  shutter: 'PRESS SHUTTER · ENTER THE FRAME',
  setupGo: 'Unlock audio/video & go fullscreen',
  cctvL: 'New node negative synced to the entrance',
  cctvR: 'Entrance live feed · next visitor',
  exit: 'Please exit to the north',
  nosig: 'ENTRANCE FEED · NO SIGNAL',
  bystander: 'You kept to the rules and did not become the killer. But you also watched it end.',
};

const results = [];
const TEXT_BY = TEXT.bystander;
const record = (ok, name, detail = '') => {
  results.push({ ok: !!ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(BASE + '/api/health', { cache: 'no-store' })).json();
const sh = (cmd) => cmd && execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

const launch = (extra = []) =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      ...extra,
    ],
  });

let browser;
const errorsByPage = new Map();

function urlFor(role) {
  const r = role === 'home' ? '/' : '/' + role;
  return BASE + r + (role === 'admin' && TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
}

async function openPage(role, vpName, { b = browser, unlock = true, tag = '' } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ ...VIEWPORTS[vpName], deviceScaleFactor: 1 });
  const key = `${role}@${vpName}${tag}`;
  const errs = [];
  errorsByPage.set(key, errs);
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    if (/\/assets\/(base|rewind)\.mp4/.test(loc)) return; // 缺素材的 HEAD 404：预期
    errs.push('console: ' + m.text() + (loc ? ` @${loc}` : ''));
  });
  p.on('requestfailed', (r) => {
    const u = r.url();
    if (/\/assets\/|\/ws$/.test(u) || r.failure()?.errorText === 'net::ERR_ABORTED') return;
    errs.push('requestfailed: ' + u + ' ' + r.failure()?.errorText);
  });
  const pending = new Map();
  p.on('request', (q) => pending.set(q.url(), Date.now()));
  p.on('requestfinished', (q) => pending.delete(q.url()));
  p.on('requestfailed', (q) => pending.delete(q.url()));
  try {
    await p.goto(urlFor(role), { waitUntil: 'load', timeout: 45000 });
  } catch (e) {
    throw new Error(`${e.message} (${key}) pending: ${[...pending.keys()].join(', ')}`);
  }
  await p.evaluate(() => document.fonts && document.fonts.ready);
  const pg = { p, role, vp: vpName, key, ctx, errs };
  if (unlock) await unlockPage(pg);
  return pg;
}

async function unlockPage(pg) {
  const { p, role } = pg;
  if (role === 'main') {
    await p.waitForSelector('#go', { timeout: 15000 });
    await sleep(600);
    await p.click('#go');
    await p.waitForFunction(() => !document.querySelector('.setup'), { timeout: 15000 });
  } else if (['door', 'station1', 'station2'].includes(role)) {
    await p.waitForSelector('.start-btn', { timeout: 15000 });
    await p.click('.start-btn');
    await p.waitForFunction(() => !document.querySelector('.start-overlay'), { timeout: 15000 });
  }
  if (role !== 'home') await p.waitForFunction(() => window.__net && window.__net.connected && window.__net.state, { timeout: 40000 }).catch((e) => { throw new Error(`${e.message} (${role} ws connect)`); });
}

/** 检查文字存在、可见、未被裁切、在视口内 */
async function checkCopy(pg, selector, text) {
  const r = await pg.p.evaluate(
    (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, why: 'missing ' + sel };
      const norm = (s) => s.replace(/\s+/g, '');
      if (!norm(el.textContent || '').includes(norm(txt))) return { ok: false, why: `text mismatch: "${el.textContent}"` };
      const cs = getComputedStyle(el);
      let op = 1;
      for (let n = el; n && n instanceof Element; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden') return { ok: false, why: 'hidden' };
        op *= parseFloat(s.opacity);
      }
      if (op < 0.5) return { ok: false, why: 'opacity ' + op.toFixed(2) };
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects());
      const W = innerWidth;
      const H = innerHeight;
      for (const q of rects) {
        if (q.width === 0) continue;
        if (q.left < -1 || q.right > W + 1 || q.top < -1 || q.bottom > H + 1)
          return { ok: false, why: `out of viewport ${Math.round(q.left)},${Math.round(q.top)},${Math.round(q.right)},${Math.round(q.bottom)} vs ${W}x${H}` };
      }
      if (cs.overflow !== 'visible' && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2))
        return { ok: false, why: `clipped ${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight}` };
      return { ok: true };
    },
    selector,
    text,
  );
  return r;
}

async function noHOverflow(pg) {
  return pg.p.evaluate(() => {
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    return { ok: sw <= innerWidth + 1, sw, w: innerWidth };
  });
}

async function shot(pg, name) {
  const file = path.join(OUT, `${name}.png`);
  try {
    await pg.p.screenshot({ path: file });
  } catch (e) {
    console.log('screenshot failed', name, e.message);
  }
  return file;
}

async function copyCheck(pg, sel, text, label) {
  const r = await checkCopy(pg, sel, text);
  record(r.ok, `${label} [${pg.key}]`, r.ok ? '' : r.why);
}

async function closeAll(pages) {
  for (const pg of pages) await pg.ctx.close().catch(() => {});
}

// ---------------- 服务器状态观察 ----------------
async function adminWs(action, extra = {}) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'admin', token: TOKEN || undefined }));
      ws.send(JSON.stringify({ type: action === 'START_SESSION' ? 'START_SESSION' : 'admin', action, token: TOKEN || undefined, ...extra }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ack' && (m.what === action || (action === 'START_SESSION' && m.what === 'START_SESSION'))) {
        ws.close();
        resolve(m);
      }
    });
    ws.on('error', reject);
    setTimeout(() => {
      ws.close();
      reject(new Error('adminWs timeout ' + action));
    }, 8000);
  });
}

/** 通过某个已连接页面读取 net 状态 */
const netOf = (pg) =>
  pg.p.evaluate(() => {
    const n = window.__net;
    return n && n.state ? { phase: n.state.state, story: n.storySec(), round: n.state.round, connected: n.connected, scale: n.timeScale } : null;
  });

async function waitPhase(pg, phase, minStory = 0, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await netOf(pg);
    if (s && s.phase === phase && s.story >= minStory) return s;
    await sleep(40);
  }
  throw new Error(`waitPhase ${phase}@${minStory} timeout on ${pg.key}`);
}

async function resetIdle() {
  await adminWs('reset').catch(() => {});
  await sleep(400);
}

// =====================================================================
// SUITE 1: 视口矩阵
// =====================================================================
async function suiteViewports() {
  console.log('\n== viewports ==');
  await resetIdle();
  for (const vp of Object.keys(VIEWPORTS)) {
    for (const role of PAGES) {
      if (MATRIX === 'lite' && !['phone', 'ipad', 'projector'].includes(vp)) continue;
      const pg = await openPage(role, vp, { unlock: false });
      // 启动遮罩 / 配置面板阶段
      if (role === 'main') {
        await pg.p.waitForSelector('#go');
        await sleep(500);
        await copyCheck(pg, '#go', TEXT.setupGo, 'main 配置面板按钮');
        const ov = await noHOverflow(pg);
        record(ov.ok, `无横向溢出(配置面板) [${pg.key}]`, ov.ok ? '' : `${ov.sw}>${ov.w}`);
        await shot(pg, `vp-${role}-setup-${vp}`);
      } else if (['door', 'station1', 'station2'].includes(role)) {
        await pg.p.waitForSelector('.start-btn');
        await shot(pg, `vp-${role}-overlay-${vp}`);
        const r = await checkCopy(pg, '.start-btn', 'Tap to start');
        record(r.ok, `启动遮罩按钮可见 [${pg.key}]`, r.why || '');
      }
      await unlockPage(pg);
      await sleep(900);
      const ov = await noHOverflow(pg);
      record(ov.ok, `无横向溢出 [${pg.key}]`, ov.ok ? '' : `${ov.sw}>${ov.w}`);
      if (role === 'door') await copyCheck(pg, '#capLine', TEXT.doorCaption, 'door IDLE 文案');
      const lang = await pg.p.evaluate(() => {
        const txt = (document.title + '\n' + document.body.innerText).replaceAll('\u5165\u753b\u4e09\u5341\u79d2', '');
        const han = txt.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g) || [];
        return { lang: document.documentElement.lang, han: han.slice(0, 5) };
      });
      record(lang.lang === 'en' && lang.han.length === 0, `UI 全英文 (lang=en, 无中文) [${pg.key}]`, lang.han.join(' | ') || lang.lang);
      if (role === 'admin') {
        await copyCheck(pg, '#shutter .big', TEXT.shutter, 'admin 快门按钮');
        const bb = await pg.p.$eval('#shutter', (e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, h: r.height, top: r.top };
        });
        record(bb.h >= 180 && bb.w >= Math.min(340, VIEWPORTS[vp].width - 40) && bb.top < VIEWPORTS[vp].height * 0.35, `快门按钮足够大且位于顶部 [${pg.key}]`, `${Math.round(bb.w)}x${Math.round(bb.h)} @${Math.round(bb.top)}`);
      }
      await shot(pg, `vp-${role}-${vp}`);
      record(pg.errs.length === 0, `无控制台错误 [${pg.key}]`, pg.errs.slice(0, 3).join(' | '));
      await pg.ctx.close();
    }
  }
}

// =====================================================================
// SUITE 2: 全员同步一轮（多视口），无交互 → 旁观者结局
// =====================================================================
async function suiteRound() {
  console.log('\n== round (all pages, multi-viewport) ==');
  await resetIdle();
  const set =
    MATRIX === 'lite'
      ? [['main', 'projector'], ['door', 'ipad'], ['station1', 'ipad'], ['station2', 'ipadP'], ['admin', 'phone']]
      : [
          ['main', 'projector'], ['main', 'chromebook'],
          ['door', 'ipad'], ['door', 'ipadP'], ['door', 'phone'],
          ['station1', 'ipad'], ['station1', 'ipadP'], ['station1', 'phone'], ['station1', 'chromebook'],
          ['station2', 'ipad'], ['station2', 'ipadP'], ['station2', 'phone'], ['station2', 'chromebook'],
          ['admin', 'phone'], ['admin', 'chromebook'],
        ];
  const pages = [];
  for (const [r, v] of set) pages.push(await openPage(r, v));
  const by = (role) => pages.filter((x) => x.role === role);
  const ref = by('admin')[0];
  await sleep(800);
  const all = (fn) => Promise.all(pages.map(fn));

  // 在 admin 页面上真正点击按钮（手机视口）
  await ref.p.click('#shutter');
  await waitPhase(ref, 'ENTER_BUFFER', 0.2);
  await all((pg) => shot(pg, `round-1buffer-${pg.role}-${pg.vp}`));
  for (const pg of by('door')) await copyCheck(pg, '#msgText', TEXT.doorEnter, 'door ENTER_BUFFER 文案');

  // 同步检查：各页面的 phase 与剧情秒一致
  const s = await waitPhase(ref, 'ACTIVE_30S', 3);
  const states = await all(netOf);
  const stories = states.map((x) => x?.story ?? -99);
  const spread = Math.max(...stories) - Math.min(...stories);
  record(states.every((x) => x?.phase === 'ACTIVE_30S'), `全部 ${pages.length} 页同时处于 ACTIVE_30S`);
  record(spread * s.scale < 0.35, `多页时钟差 ${(spread * s.scale * 1000).toFixed(0)}ms（含逐页采样耗时）`);
  await Promise.all([...by('main'), ...by('door')].map((pg) => shot(pg, `round-2active-${pg.role}-${pg.vp}`)));
  for (const pg of by('door')) await copyCheck(pg, '#standby', TEXT.doorStandby, 'door 拍摄中文案');

  await waitPhase(ref, 'ACTIVE_30S', 6.5);
  await Promise.all(by('station1').map((pg) => shot(pg, `round-3A-station1-${pg.vp}`)));
  for (const pg of by('station1')) {
    await copyCheck(pg, '#msg', TEXT.s1A, 'station1 A 段文案');
    await copyCheck(pg, '#talk', 'Holdto talk', 'station1 按钮');
  }
  for (const pg of by('station2')) {
    const cls = await pg.p.$eval('#root', (e) => e.className);
    record(cls.includes('black'), `station2 前 21 秒黑屏 [${pg.key}]`);
  }
  await waitPhase(ref, 'ACTIVE_30S', 15.5);
  await Promise.all(by('station1').map((pg) => shot(pg, `round-4B-station1-${pg.vp}`)));
  for (const pg of by('station1')) await copyCheck(pg, '#msg', TEXT.s1B, 'station1 B 段文案');
  await Promise.all(by('main').map((pg) => shot(pg, `round-4film-main-${pg.vp}`)));

  await waitPhase(ref, 'ACTIVE_30S', 23);
  await Promise.all([...by('station2'), ...by('station1')].map((pg) => shot(pg, `round-5C-${pg.role}-${pg.vp}`)));
  for (const pg of by('station2')) await copyCheck(pg, '#msg', TEXT.s2C, 'station2 C 段文案');
  for (const pg of by('station1')) {
    const cls = await pg.p.$eval('#root', (e) => e.className);
    record(cls.includes('black'), `station1 21s 后黑屏 [${pg.key}]`);
  }
  await Promise.all(by('main').map((pg) => shot(pg, `round-5film28-main-${pg.vp}`)));

  await waitPhase(ref, 'FLASH_FREEZE', 0.4);
  await all((pg) => shot(pg, `round-6flash-${pg.role}-${pg.vp}`));
  for (const pg of by('door')) {
    const flashOn = await pg.p.evaluate(() => !!document.querySelector('.flash.on'));
    const dim = await pg.p.evaluate(() => [...document.querySelectorAll('.door-photo')].every((e) => e.classList.contains('dim')));
    record(!flashOn && dim, `door 闪白阶段保持暗（无白闪、底片调暗） [${pg.key}]`);
  }
  await waitPhase(ref, 'REWIND', 0.5);
  await Promise.all(by('main').map((pg) => shot(pg, `round-7rewind-main-${pg.vp}`)));
  await waitPhase(ref, 'REPLAY_TRUTH', 3);
  await Promise.all(by('main').map((pg) => shot(pg, `round-8replay-main-${pg.vp}`)));
  for (const pg of [...by('station1'), ...by('station2')]) {
    const cls = await pg.p.$eval('#root', (e) => e.className);
    record(cls.includes('black'), `REPLAY 期间平板纯黑 [${pg.key}]`);
  }
  // 旁观者结局：最后 4 秒淡入（1.2s 过渡）。低 TIME_SCALE 下只校验 class 与文字
  await waitPhase(ref, 'REPLAY_TRUTH', s.scale >= 0.5 ? 26 + 1.4 / s.scale : 26.3);
  await Promise.all(by('main').map((pg) => shot(pg, `round-9bystander-main-${pg.vp}`)));
  for (const pg of by('main')) {
    if (s.scale >= 0.5) await copyCheck(pg, '#bystanderText', TEXT.bystander, 'main 旁观者结局（未喊话未拉闸）');
    else {
      const r = await pg.p.evaluate(() => ({ show: document.querySelector('#bystander').classList.contains('show'), t: document.querySelector('#bystanderText').textContent }));
      record(r.show && r.t === TEXT_BY, `main 旁观者结局已触发（低速模式只校验状态） [${pg.key}]`);
    }
  }
  await waitPhase(ref, 'CCTV_REVEAL', 0.25);
  await sleep(Math.min(2000, Math.max(500, 1000 * s.scale * 3.5)));
  for (const pg of by('main')) {
    await copyCheck(pg, '.cctv .pane.left .cap .t', TEXT.cctvL, 'CCTV 左侧说明');
    await copyCheck(pg, '.cctv .pane.right .cap .t', TEXT.cctvR, 'CCTV 右侧说明');
    await copyCheck(pg, '.cctv .exit', TEXT.exit + '↑', 'CCTV 出口指示');
    const live = await pg.p.evaluate(() => !document.querySelector('#cctvImg').classList.contains('hidden') && document.querySelector('#cctvImg').src.startsWith('data:image/jpeg'));
    record(live, `door 前置摄像头监控帧到达 main [${pg.key}]`);
  }
  await Promise.all(by('main').map((pg) => shot(pg, `round-10cctv-main-${pg.vp}`)));
  await Promise.all(by('door').map((pg) => shot(pg, `round-10cctv-door-${pg.vp}`)));
  await waitPhase(ref, 'IDLE', 0, 30000);
  await sleep(1200);
  await Promise.all(by('door').map((pg) => shot(pg, `round-11idle-door-${pg.vp}`)));
  for (const pg of by('door')) {
    const src = await pg.p.$eval('#photo', (e) => (e.classList.contains('hidden') ? '' : e.getAttribute('src') || ''));
    record(src.includes('/data/latest-door.jpg'), `door 显示新的定格照 [${pg.key}]`, src);
  }
  await Promise.all(by('admin').map((pg) => shot(pg, `round-11idle-admin-${pg.vp}`)));
  for (const pg of pages) {
    const ov = await noHOverflow(pg);
    if (!ov.ok) record(false, `无横向溢出(整轮后) [${pg.key}]`, `${ov.sw}>${ov.w}`);
    record(pg.errs.length === 0, `整轮无控制台错误 [${pg.key}]`, pg.errs.slice(0, 3).join(' | '));
  }
  await closeAll(pages);
}

// =====================================================================
// SUITE 3: 交互（喊话自动停止 + 提前拉闸锁定） + 摄像头拒绝的 door
// =====================================================================
async function suiteInteract() {
  console.log('\n== interact + camera-denied door ==');
  await resetIdle();
  const denied = await launch(['--deny-permission-prompts']);
  const main = await openPage('main', 'projector');
  const s1 = await openPage('station1', 'ipad');
  const s2 = await openPage('station2', 'ipad');
  const admin = await openPage('admin', 'chromebook');
  const door = await openPage('door', 'ipad', { b: denied, tag: '-denied' });
  await sleep(600);
  await admin.p.click('#shutter');
  // 11s 按住不放 → 13s 自动停止并发送
  await waitPhase(s1, 'ACTIVE_30S', 11);
  const bb = await (await s1.p.$('#talk')).boundingBox();
  await s1.p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await s1.p.mouse.down();
  await sleep(120);
  const recCls = await s1.p.$eval('#talk', (e) => e.className);
  record(recCls.includes('rec'), 'station1 按住时进入录音状态');
  await shot(s1, 'interact-station1-recording');
  await waitPhase(s1, 'ACTIVE_30S', 13.6);
  await sleep(600);
  const st = await netOf(admin);
  record(st.round.didSpeak === true, '按住不放：13s 自动停止并发送录音（didSpeak=true）');
  const off = st.round.audioOffsetMs / st.scale / 1000;
  record(off >= 10.8 && off <= 11.8, `audioOffsetMs 对应剧情 ${off.toFixed(2)}s（期望≈11s）`);
  await s1.p.mouse.up();
  // 24s 拉闸 → 锁定
  await waitPhase(s2, 'ACTIVE_30S', Number(process.env.BREAKER_AT || 22.5));
  const hb = await (await s2.p.$('#handle')).boundingBox();
  const scaleNow = (await netOf(s2)).scale;
  if (scaleNow >= 0.4) {
    await s2.p.mouse.move(hb.x + hb.width / 2, hb.y + 10);
    await s2.p.mouse.down();
    // 先拉一半松手：应弹回
    for (let i = 1; i <= 6; i++) await s2.p.mouse.move(hb.x + hb.width / 2, hb.y + 10 + i * 30, { steps: 2 });
    await s2.p.mouse.up();
    await sleep(500);
    const back = await s2.p.$eval('#handle', (e) => e.textContent);
    record(back === 'MAIN' && !(await netOf(s2)).round.didPullBreaker, '电闸只拉一半松手会弹回（未触发）');
  }
  await s2.p.mouse.move(hb.x + hb.width / 2, hb.y + 10);
  await s2.p.mouse.down();
  for (let i = 1; i <= 45; i++) await s2.p.mouse.move(hb.x + hb.width / 2, hb.y + 10 + i * 30);
  await s2.p.mouse.up();
  await sleep(scaleNow >= 0.4 ? 400 : 120);
  await shot(s2, 'interact-station2-locked');
  await copyCheck(s2, '#lock', TEXT.s2Lock, 'station2 提前拉闸锁定文案');
  const shake = await s2.p.$eval('#breaker', (e) => e.classList.contains('shake'));
  record(shake, 'station2 锁定时剧烈震动(shake)');
  const f = await waitPhase(admin, 'FLASH_FREEZE', 0);
  const r = f.round;
  record(r.breakerLocked && r.breakerPulledAtSec < 28.5, `拉闸 @${r.breakerPulledAtSec}s → 锁定，至 29.5s 闪白`);
  await waitPhase(admin, 'REPLAY_TRUTH', 27.5);
  await sleep(400);
  const by = await main.p.$eval('#bystander', (e) => e.classList.contains('show'));
  record(!by, '喊话+拉闸时不显示旁观者结局');
  await waitPhase(admin, 'CCTV_REVEAL', 0.2);
  await main.p.waitForFunction(() => { const e = document.querySelector('#nosig'); return e && !e.classList.contains('hidden'); }, { timeout: 8000, polling: 30 }).catch(() => {});
  await copyCheck(main, '#nosig', TEXT.nosig, '摄像头被拒绝时 main 显示无信号');
  await shot(main, 'interact-main-cctv-nosignal');
  await shot(door, 'interact-door-denied');
  record(door.errs.length === 0, '摄像头被拒绝的 door 无错误', door.errs.join(' | '));
  const dv = await door.p.evaluate(() => getComputedStyle(document.querySelector('#photo').classList.contains('hidden') ? document.querySelector('#def') : document.querySelector('#photo')).opacity);
  record(parseFloat(dv) > 0.9, `摄像头被拒绝时 door 底片照常显示（opacity ${dv}）`);
  await waitPhase(admin, 'IDLE', 0, 30000);
  for (const pg of [main, s1, s2, admin]) record(pg.errs.length === 0, `交互轮无控制台错误 [${pg.key}]`, pg.errs.slice(0, 3).join(' | '));
  await closeAll([main, s1, s2, admin, door]);
  await denied.close();
}

// =====================================================================
// SUITE 4: 中途加入
// =====================================================================
async function suiteLateJoin() {
  console.log('\n== late join ==');
  await resetIdle();
  const admin = await openPage('admin', 'phone');
  await adminWs('START_SESSION');
  await waitPhase(admin, 'ACTIVE_30S', Number(process.env.LATE_AT || 7));
  const [s1, main, door] = await Promise.all([openPage('station1', 'ipad'), openPage('main', 'chromebook'), openPage('door', 'ipadP')]);
  await sleep(500);
  const a = await netOf(admin);
  for (const pg of [s1, main, door]) {
    const n = await netOf(pg);
    record(n.phase === a.phase && Math.abs(n.story - a.story) < 0.6, `中途加入同步 [${pg.key}]`, `${n.phase}@${n.story.toFixed(2)} vs admin ${a.story.toFixed(2)}`);
  }
  const cls = await s1.p.$eval('#root', (e) => e.className);
  const n1 = await netOf(s1);
  const expectSeg = n1.phase !== 'ACTIVE_30S' ? 'black' : n1.story >= 5 && n1.story < 13 ? 'st-call' : n1.story >= 13 && n1.story < 21 ? 'st-over' : 'black';
  record(cls.includes(expectSeg), `中途加入的 station1 直接进入正确画面（${expectSeg} @${n1.story.toFixed(1)}s）`);
  if (expectSeg !== 'black') {
    const clock = parseFloat(await s1.p.$eval('#clock', (e) => e.textContent));
    const ex = (expectSeg === 'st-call' ? 13 : 21) - (await netOf(s1)).story;
    record(Math.abs(clock - ex) < 0.6, `station1 倒计时 ${clock} ≈ ${ex.toFixed(1)}`);
  }
  await shot(main, 'latejoin-main');
  await shot(s1, 'latejoin-station1');
  for (const pg of [s1, main, door]) record(pg.errs.length === 0, `中途加入无错误 [${pg.key}]`, pg.errs.slice(0, 3).join(' | '));
  await resetIdle();
  await closeAll([admin, s1, main, door]);
}

// =====================================================================
// SUITE 5: 断线重连 + 状态 / 底片重同步
// =====================================================================
async function suiteReconnect() {
  console.log('\n== reconnect ==');
  if (!process.env.STOP_CMD || !process.env.START_CMD) return record(false, 'reconnect: 未提供 STOP_CMD/START_CMD');
  await resetIdle();
  await adminWs('resetDoor');
  const pages = [await openPage('door', 'ipad'), await openPage('admin', 'phone'), await openPage('station1', 'ipad'), await openPage('main', 'projector')];
  await sleep(800);
  const before = await pages[0].p.$eval('#photo', (e) => e.classList.contains('hidden'));
  record(before, '重连前 door 显示默认底片');
  sh(process.env.STOP_CMD);
  await sleep(2500);
  const offs = await Promise.all(pages.map((pg) => pg.p.evaluate(() => !window.__net.connected && !!document.querySelector('.net-dot.off, #conn.off'))));
  record(offs.every(Boolean), '服务器停止后所有页面显示断线');
  await shot(pages[1], 'reconnect-admin-offline');
  sh(process.env.INJECT_DOOR_CMD); // 停机期间入口底片发生变化
  const t0 = Date.now();
  sh(process.env.START_CMD);
  const okAll = await Promise.all(
    pages.map((pg) => pg.p.waitForFunction(() => window.__net.connected && window.__net.state, { timeout: 30000 }).then(() => true, () => false)),
  );
  record(okAll.every(Boolean), `重启后全部页面自动重连（${((Date.now() - t0) / 1000).toFixed(1)}s 内）`);
  await sleep(1500);
  const src = await pages[0].p.$eval('#photo', (e) => (e.classList.contains('hidden') ? '' : e.getAttribute('src')));
  record(!!src && src.includes('latest-door.jpg'), '重连后 door 立即同步到最新底片', src || '(hidden)');
  const st = await netOf(pages[1]);
  record(st.phase === 'IDLE', '重连后 admin 同步到当前状态 IDLE');
  await adminWs('START_SESSION');
  await waitPhase(pages[1], 'ENTER_BUFFER');
  const all = await Promise.all(pages.map(netOf));
  record(all.every((x) => x.phase === 'ENTER_BUFFER'), '重连后的页面能正常收到新一轮状态');
  await resetIdle();
  // 单页面掉线（只断 socket，不停服务器）
  await pages[2].p.evaluate(() => window.__net.ws.close());
  await sleep(300);
  const back = await pages[2].p.waitForFunction(() => window.__net.connected, { timeout: 10000 }).then(() => true, () => false);
  record(back, '单个页面 socket 被断开后指数退避自动重连');
  for (const pg of pages) {
    const real = pg.errs.filter((e) => !/WebSocket|ERR_CONNECTION_REFUSED|502|503|Failed to load resource/.test(e));
    record(real.length === 0, `重连过程无非网络类错误 [${pg.key}]`, real.slice(0, 3).join(' | '));
  }
  await adminWs('resetDoor');
  await closeAll(pages);
}

// =====================================================================
// SUITE 6: 实拍素材存在 vs 缺失
// =====================================================================
async function suiteAssets() {
  console.log('\n== assets present / missing ==');
  if (!process.env.ASSETS_PUT_CMD || !process.env.ASSETS_RM_CMD) return record(false, 'assets: 未提供 ASSETS_PUT_CMD/ASSETS_RM_CMD');
  await resetIdle();
  sh(process.env.ASSETS_PUT_CMD);
  const h = await health();
  record(h.assets.base && h.assets.rewind, '/api/health 检测到 base.mp4 / rewind.mp4');
  const main = await openPage('main', 'projector');
  const admin = await openPage('admin', 'phone');
  await sleep(500);
  await adminWs('START_SESSION');
  await waitPhase(admin, 'ACTIVE_30S', 1.2);
  await sleep(600);
  const v = await main.p.evaluate(() => {
    const b = document.querySelector('#base');
    return { hidden: b.classList.contains('hidden'), paused: b.paused, t: b.currentTime, src: b.currentSrc };
  });
  record(!v.hidden && !v.paused && v.t > 0 && v.src.includes('/assets/base.mp4'), `ACTIVE_30S 播放 base.mp4（t=${v.t.toFixed(2)}）`);
  await shot(main, 'assets-main-base');
  await waitPhase(admin, 'REWIND', 0.2);
  await sleep(250);
  const r = await main.p.evaluate(() => {
    const b = document.querySelector('#rewind');
    return { hidden: b.classList.contains('hidden'), src: b.currentSrc };
  });
  record(!r.hidden && r.src.includes('/assets/rewind.mp4'), 'REWIND 播放 rewind.mp4');
  await shot(main, 'assets-main-rewind');
  await resetIdle();
  sh(process.env.ASSETS_RM_CMD);
  await sleep(1200); // IDLE 时 main 会重新 HEAD 探测
  await adminWs('START_SESSION');
  await waitPhase(admin, 'ACTIVE_30S', 1.2);
  const v2 = await main.p.evaluate(() => document.querySelector('#base').classList.contains('hidden'));
  record(v2, '删除素材后下一轮自动降级为 Canvas 模拟底片（热更新）');
  await resetIdle();
  record(main.errs.length === 0, '素材切换过程 main 无错误', main.errs.slice(0, 3).join(' | '));
  await closeAll([main, admin]);
}

// =====================================================================
async function run() {
  const h = await health();
  console.log(`BASE=${BASE} TIME_SCALE=${h.timeScale} MATRIX=${MATRIX} SUITES=${SUITES.join(',')}`);
  browser = await launch(['--use-fake-ui-for-media-stream']);
  const suites = { viewports: suiteViewports, round: suiteRound, interact: suiteInteract, latejoin: suiteLateJoin, reconnect: suiteReconnect, assets: suiteAssets };
  for (const name of SUITES) {
    if (name === 'denied') continue; // 已并入 interact
    try {
      await suites[name]();
    } catch (e) {
      record(false, `suite ${name} 异常`, e.message);
    }
  }
  await resetIdle();
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  if (fails.length) console.log('FAILED:\n' + fails.map((f) => ` - ${f.name}  ${f.detail}`).join('\n'));
  process.exit(fails.length ? 1 : 0);
}
run();
