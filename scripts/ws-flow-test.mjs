#!/usr/bin/env node
/**
 * v3 纯现场活体暗房引擎 WebSocket 全流程联调测试（无需浏览器）
 *   TIME_SCALE=0.05 node build/server/index.js
 *   BASE=http://127.0.0.1:3199 node scripts/ws-flow-test.mjs
 */
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const TOKEN = process.env.ADMIN_TOKEN || undefined;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const c = { role, ws, msgs: [], waiters: [] };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, timeout = 15000, label = '') =>
      new Promise((res, rej) => {
        const hit = c.msgs.find(pred);
        if (hit) return res(hit);
        const w = { pred, res };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          rej(new Error(`[${role}] 等待超时 ${label}`));
        }, timeout);
      });
    c.clear = () => (c.msgs = []);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      c.msgs.push(m);
      for (const w of [...c.waiters]) {
        if (w.pred(m)) {
          c.waiters = c.waiters.filter((x) => x !== w);
          w.res(m);
        }
      }
    });
    ws.on('open', () => {
      c.send({ type: 'hello', role, token: role === 'admin' ? TOKEN : undefined });
      resolve(c);
    });
    ws.on('error', reject);
  });
}

const isState = (s) => (m) => m.type === 'state' && m.state === s;

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json();
  ok(
    health.ok === true && health.version === '3.0.0-live-darkroom' && health.state === 'IDLE',
    `/api/health → ${JSON.stringify(health)}`,
  );
  const scale = health.timeScale || 1;
  console.log(`TIME_SCALE = ${scale}`);

  const [admin, door, s1, s2, mainC] = await Promise.all(['admin', 'door', 'station1', 'station2', 'main'].map(client));
  await admin.wait(isState('IDLE'), 3000, 'initial IDLE').catch(() => null);
  if (health.state !== 'IDLE') {
    admin.send({ type: 'admin', action: 'reset', token: TOKEN });
    await admin.wait(isState('IDLE'));
  }

  // ---- 1. 非 admin 发起 START_SESSION 必须被拒绝 ----
  for (const c of [door, s1, s2, mainC]) {
    c.clear();
    c.send({ type: 'START_SESSION' });
    const ack = await c.wait((m) => m.type === 'ack' && m.what === 'START_SESSION', 3000, 'ack');
    ok(ack.ok === false, `${c.role} 的 START_SESSION 被拒绝（${ack.message}）`);
  }

  // ---- 2. 配置限幅与持久化 ----
  admin.clear();
  admin.send({
    type: 'admin',
    action: 'setConfig',
    config: {
      enterBufferSec: 99,
      safelightSec: -5,
      exposureSec: 99,
      maxDevelopSec: 99,
      revealSec: 99,
      noiseFloor: 0.9,
      devSpeed: 5,
      printMode: 'positive_print',
    },
    token: TOKEN,
  });
  let cfg = await admin.wait((m) => m.type === 'config');
  ok(
    cfg.config.enterBufferSec === 10 &&
      cfg.config.safelightSec === 0 &&
      cfg.config.exposureSec === 30 &&
      cfg.config.maxDevelopSec === 45 &&
      cfg.config.revealSec === 25 &&
      cfg.config.noiseFloor === 0.5 &&
      cfg.config.devSpeed === 0.8 &&
      cfg.config.printMode === 'positive_print',
    `配置超界限幅正确 ${JSON.stringify(cfg.config)}`,
  );

  // 恢复默认 v3 配置
  admin.clear();
  admin.send({
    type: 'admin',
    action: 'setConfig',
    config: {
      enterBufferSec: 5,
      safelightSec: 5,
      exposureSec: 15,
      maxDevelopSec: 25,
      revealSec: 12,
      noiseFloor: 0.08,
      devSpeed: 0.25,
      printMode: 'photogram_negative',
    },
    token: TOKEN,
  });
  cfg = await admin.wait((m) => m.type === 'config');
  ok(cfg.config.safelightSec === 5 && cfg.config.printMode === 'photogram_negative', '恢复默认配置成功');

  // ---- 3. 完整轮次：ENTER_BUFFER -> SAFELIGHT_COMPOSE -> EXPOSURE -> DEVELOPING -> FIXED_REVEAL -> IDLE ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  const seen = [];
  admin.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state' && seen[seen.length - 1] !== m.state) seen.push(m.state);
  });

  admin.send({ type: 'START_SESSION', token: TOKEN });
  const startAck = await admin.wait((m) => m.type === 'ack' && m.what === 'START_SESSION');
  ok(startAck.ok === true, `admin START_SESSION 成功（${startAck.message}）`);

  await mainC.wait(isState('ENTER_BUFFER'), 3000, 'ENTER_BUFFER');
  await mainC.wait(isState('SAFELIGHT_COMPOSE'), 5000, 'SAFELIGHT_COMPOSE');
  await mainC.wait(isState('EXPOSURE'), 5000, 'EXPOSURE');
  await mainC.wait(isState('DEVELOPING'), 10000, 'DEVELOPING');
  ok(true, '自动流转进入 DEVELOPING');

  // 低能量（<= noiseFloor）时 devProgress 应保持 0
  mainC.clear();
  admin.clear();
  s1.send({ type: 'AUDIO_ENERGY', level: 0.04 });
  await sleep(160);
  const devQuiet = await mainC.wait((m) => m.type === 'dev', 2000, 'dev quiet');
  ok(devQuiet.devProgress === 0, `低于 noiseFloor(0.08) 时 devProgress=${devQuiet.devProgress}`);

  // 高能量（> noiseFloor）应推动 devProgress 增长，并广播给 main 和 admin
  for (let i = 0; i < 4; i++) {
    s1.send({ type: 'AUDIO_ENERGY', level: 0.8 });
    await sleep(70);
  }
  const devMain = await mainC.wait((m) => m.type === 'dev' && m.devProgress > 0.05, 3000, 'dev main');
  const devAdmin = await admin.wait((m) => m.type === 'dev' && m.devProgress > 0.05, 3000, 'dev admin');
  ok(devMain.devProgress > 0.05 && devAdmin.devProgress > 0.05, `高噪音驱动显影进度上升 (main=${devMain.devProgress}, admin=${devAdmin.devProgress})`);

  // station2 触发 TRIGGER_FIX → 立刻进入 FIXED_REVEAL 并锁死 finalDevProgress
  s2.send({ type: 'TRIGGER_FIX' });
  const fixAck = await s2.wait((m) => m.type === 'ack' && m.what === 'TRIGGER_FIX', 3000, 'fix ack');
  const reveal = await mainC.wait(isState('FIXED_REVEAL'), 3000, 'FIXED_REVEAL');
  ok(
    fixAck.ok && reveal.round.fixTriggeredBy === 'station2' && reveal.round.finalDevProgress != null && reveal.round.finalDevProgress > 0,
    `station2 定影锁定 finalDevProgress=${reveal.round.finalDevProgress}`,
  );

  // main 上传纯净 JPEG → 写入磁盘并更新 contact-sheet
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]);
  door.clear();
  mainC.send({ type: 'freeze', data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const cs = await door.wait((m) => m.type === 'contact-sheet' && m.sheet.totalInRoll >= 1, 5000, 'contact-sheet');
  ok(cs.sheet.frames.length >= 1, `定格照已加入当前卷接触印相表（ROLL ${cs.sheet.rollNumber}, 共 ${cs.sheet.totalInRoll} 张）`);

  await mainC.wait(isState('IDLE'), 10000, 'auto IDLE');
  await admin.wait(isState('IDLE'), 5000, 'admin IDLE');
  const expected = ['ENTER_BUFFER', 'SAFELIGHT_COMPOSE', 'EXPOSURE', 'DEVELOPING', 'FIXED_REVEAL', 'IDLE'];
  ok(JSON.stringify(seen.slice(-6)) === JSON.stringify(expected), `状态序列正确: ${seen.slice(-6).join(' → ')}`);

  // ---- 4. safelightSec = 0 时应直接跳过 SAFELIGHT_COMPOSE ----
  for (const c of [admin, mainC]) c.clear();
  admin.send({ type: 'admin', action: 'setConfig', config: { safelightSec: 0 }, token: TOKEN });
  await admin.wait((m) => m.type === 'config' && m.config.safelightSec === 0, 3000);
  admin.send({ type: 'START_SESSION', token: TOKEN });
  await mainC.wait(isState('ENTER_BUFFER'), 3000);
  const expDirect = await mainC.wait(isState('EXPOSURE'), 5000);
  ok(expDirect.state === 'EXPOSURE' && !mainC.msgs.some(isState('SAFELIGHT_COMPOSE')), 'safelightSec=0 时直接从 ENTER_BUFFER 跳入 EXPOSURE');
  admin.send({ type: 'admin', action: 'reset', token: TOKEN });
  await mainC.wait(isState('IDLE'), 3000);

  // ---- 5. NEW ROLL：清空接触印相表，但磁盘历史归档完整保留 ----
  const archBefore = await (await fetch(BASE + '/api/archive?all=1' + (TOKEN ? `&token=${TOKEN}` : ''))).json();
  door.clear();
  admin.send({ type: 'admin', action: 'newRoll', token: TOKEN });
  const csNew = await door.wait((m) => m.type === 'contact-sheet' && m.sheet.totalInRoll === 0, 3000, 'newRoll contact-sheet');
  const archAfter = await (await fetch(BASE + '/api/archive?all=1' + (TOKEN ? `&token=${TOKEN}` : ''))).json();
  ok(csNew.sheet.rollNumber === cs.sheet.rollNumber + 1 && csNew.sheet.totalInRoll === 0, `NEW ROLL 切换至 ROLL ${csNew.sheet.rollNumber}`);
  ok(archAfter.count === archBefore.count && archAfter.count >= 1, `磁盘历史归档完整保留（共 ${archAfter.count} 张未删除）`);

  for (const c of [admin, door, s1, s2, mainC]) c.ws.close();
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n🎉 v3 全部联调测试通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
