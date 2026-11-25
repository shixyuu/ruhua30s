#!/usr/bin/env node
/**
 * v2 全流程 WebSocket 联调测试（无需浏览器）
 *   TIME_SCALE=0.1 npm start          # 另一个终端，用 1/10 时长启动服务
 *   BASE=http://localhost:3000 npm run test:flow
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
  ok(health.ok === true && typeof health.state === 'string' && health.clients, `/api/health → ${JSON.stringify(health)}`);
  const scale = health.timeScale || 1;
  const story = (sec) => sec * 1000 * scale;
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

  // ---- 2. 配置：ENTER_BUFFER 2~10s（默认 6），CCTV_REVEAL 4~15s（默认 8） ----
  admin.clear();
  admin.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: 20, cctvRevealSec: 30 }, token: TOKEN });
  let cfg = await admin.wait((m) => m.type === 'config');
  ok(
    cfg.config.enterBufferSec === 10 && cfg.config.cctvRevealSec === 15,
    `超界限幅 enterBufferSec=${cfg.config.enterBufferSec}, cctvRevealSec=${cfg.config.cctvRevealSec}`,
  );
  admin.clear();
  admin.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: 6, cctvRevealSec: 8 }, token: TOKEN });
  cfg = await admin.wait((m) => m.type === 'config');
  ok(
    cfg.config.enterBufferSec === 6 && cfg.config.cctvRevealSec === 8 && cfg.config.rollNumber >= 1,
    `恢复默认配置 ${JSON.stringify(cfg.config)}`,
  );

  // ---- 3. 第一轮：多段语音校准（2 条 audioClips） + 提前拉下定影推杆（锁定至 29.5s） ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  admin.send({ type: 'START_SESSION', token: TOKEN });
  const startAck = await admin.wait((m) => m.type === 'ack' && m.what === 'START_SESSION');
  ok(startAck.ok === true, `admin START_SESSION 成功（${startAck.message}）`);

  const enter = await door.wait(isState('ENTER_BUFFER'));
  ok(Math.abs(enter.phaseDurationMs - 6000 * scale) < 5, `ENTER_BUFFER 时长 ${enter.phaseDurationMs}ms（6s）`);

  const active = await s1.wait(isState('ACTIVE_30S'));
  await sleep(Math.max(0, active.phaseStartedAt + story(5) - Date.now()));
  const fakeAudio = 'data:audio/webm;base64,' + Buffer.alloc(2000, 7).toString('base64');
  s1.send({ type: 'speak', mime: 'audio/webm', dataUrl: fakeAudio, offsetMs: Math.round(story(5)) });
  const a1 = await mainC.wait((m) => m.type === 'audio' && m.index === 0, 5000, 'audio #1');
  ok(a1.clip.offsetMs === Math.round(story(5)), `第 1 段校准音频已转发到 main（offsetMs=${a1.clip.offsetMs}）`);

  mainC.clear();
  await sleep(Math.max(0, active.phaseStartedAt + story(11) - Date.now()));
  s1.send({ type: 'speak', mime: 'audio/webm', dataUrl: fakeAudio, offsetMs: Math.round(story(11)) });
  const a2 = await mainC.wait((m) => m.type === 'audio' && m.index === 1, 5000, 'audio #2');
  ok(a2.clip.offsetMs === Math.round(story(11)), `第 2 段校准音频已转发到 main（offsetMs=${a2.clip.offsetMs}）`);

  await sleep(Math.max(0, active.phaseStartedAt + story(24) - Date.now()));
  s2.send({ type: 'breaker' });
  const br = await s2.wait((m) => m.type === 'breaker');
  ok(br.status === 'locked', `24s 拉下定影推杆 → ${br.status}（防提前截断锁定）`);

  const flash = await mainC.wait(isState('FLASH_FREEZE'));
  const activeLen = (flash.phaseStartedAt - active.phaseStartedAt) / scale / 1000;
  ok(Math.abs(activeLen - 29.5) < 0.2, `锁定后在剧情 ${activeLen.toFixed(2)}s 触发定格（期望 29.5s）`);

  // main 上传定格照 → 更新 contact-sheet
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]);
  door.clear();
  mainC.send({ type: 'freeze', data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const cs = await door.wait((m) => m.type === 'contact-sheet' && m.sheet.totalInRoll >= 1, 5000, 'contact-sheet');
  ok(cs.sheet.frames.length >= 1, `定格照已加入当前卷接触印相表（ROLL ${cs.sheet.rollNumber}, 共 ${cs.sheet.totalInRoll} 张）`);

  const replay = await mainC.wait(isState('REPLAY_TRUTH'), 15000, 'REPLAY_TRUTH');
  ok(replay.round.audioClipCount === 2, `回合记录 audioClipCount=${replay.round.audioClipCount}`);

  // 测试 SKIP PHASE：从 REPLAY_TRUTH 直接跳到 CCTV_REVEAL，再跳回 IDLE
  admin.clear();
  mainC.clear();
  admin.send({ type: 'admin', action: 'skipPhase', token: TOKEN });
  const cctv = await mainC.wait(isState('CCTV_REVEAL'), 3000, 'skip to CCTV_REVEAL');
  ok(Math.abs(cctv.phaseDurationMs - 8000 * scale) < 5, `SKIP PHASE 跳至 CCTV_REVEAL（时长 ${cctv.phaseDurationMs}ms）`);

  admin.send({ type: 'admin', action: 'skipPhase', token: TOKEN });
  await mainC.wait(isState('IDLE'), 3000, 'skip to IDLE');
  ok(true, 'SKIP PHASE 从 CCTV_REVEAL 跳回 IDLE');

  // ---- 4. 测试 NEW ROLL：清空当前印相表，但磁盘归档完整保留 ----
  const archBefore = await (await fetch(BASE + '/api/archive?all=1' + (TOKEN ? `&token=${TOKEN}` : ''))).json();
  door.clear();
  admin.send({ type: 'admin', action: 'newRoll', token: TOKEN });
  const csNew = await door.wait((m) => m.type === 'contact-sheet' && m.sheet.totalInRoll === 0, 3000, 'newRoll contact-sheet');
  const archAfter = await (await fetch(BASE + '/api/archive?all=1' + (TOKEN ? `&token=${TOKEN}` : ''))).json();
  ok(
    csNew.sheet.rollNumber === cs.sheet.rollNumber + 1 && csNew.sheet.totalInRoll === 0,
    `NEW ROLL 切换至 ROLL ${csNew.sheet.rollNumber} 且新卷印相表为空`,
  );
  ok(
    archAfter.count === archBefore.count && archAfter.count >= 1,
    `磁盘历史归档完整保留（共 ${archAfter.count} 张未删除）`,
  );

  for (const c of [admin, door, s1, s2, mainC]) c.ws.close();
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n🎉 v2 全部联调测试通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
