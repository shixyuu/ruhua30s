#!/usr/bin/env node
/**
 * 全流程 WebSocket 联调测试（无需浏览器）
 *   TIME_SCALE=0.1 npm start          # 另一个终端，用 1/10 时长启动服务
 *   BASE=http://localhost:3000 npm run test:flow
 * 如设置了 ADMIN_TOKEN，请同时导出 ADMIN_TOKEN=... 给本脚本。
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
      for (const w of [...c.waiters]) if (w.pred(m)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.res(m);
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
  const story = (sec) => sec * 1000 * scale; // 剧情秒 → 真实毫秒
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
  await sleep(200);
  ok((await (await fetch(BASE + '/api/health')).json()).state === 'IDLE', '被拒绝后状态仍为 IDLE');
  // 旧版拍手消息不再有效
  door.send({ type: 'clap', source: 'clap' });
  await sleep(200);
  ok((await (await fetch(BASE + '/api/health')).json()).state === 'IDLE', '旧 clap 消息被忽略');

  // ---- 2. 配置：ENTER_BUFFER 2~8 秒限幅 ----
  admin.clear();
  admin.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: 20 }, token: TOKEN });
  let cfg = await admin.wait((m) => m.type === 'config');
  ok(cfg.config.enterBufferSec === 8, `enterBufferSec=20 被限幅为 ${cfg.config.enterBufferSec}`);
  admin.clear();
  admin.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: 4 }, token: TOKEN });
  cfg = await admin.wait((m) => m.type === 'config');
  ok(cfg.config.enterBufferSec === 4 && Object.keys(cfg.config).length === 1, `config 仅含 enterBufferSec=4 ${JSON.stringify(cfg.config)}`);

  // ---- 3. 第一轮：提前拉闸（锁定到 29.5s） + 喊话 ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  const seen = [];
  admin.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state' && seen[seen.length - 1]?.state !== m.state) seen.push({ state: m.state, at: Date.now() });
  });
  admin.send({ type: 'START_SESSION', token: TOKEN });
  const startAck = await admin.wait((m) => m.type === 'ack' && m.what === 'START_SESSION');
  ok(startAck.ok === true, `admin START_SESSION 成功（${startAck.message}）`);
  admin.clear();
  admin.send({ type: 'START_SESSION', token: TOKEN });
  const dupAck = await admin.wait((m) => m.type === 'ack' && m.what === 'START_SESSION');
  ok(dupAck.ok === false, '非 IDLE 时重复 START_SESSION 被拒绝');

  const enter = await door.wait(isState('ENTER_BUFFER'));
  ok(typeof enter.serverTime === 'number' && typeof enter.phaseStartedAt === 'number', 'state 包含 serverTime / phaseStartedAt');
  ok(Math.abs(enter.phaseDurationMs - 4000 * scale) < 2, `ENTER_BUFFER 时长 ${enter.phaseDurationMs}ms`);

  const active = await s1.wait(isState('ACTIVE_30S'));
  await sleep(Math.max(0, active.phaseStartedAt + story(6) - Date.now()));
  const fakeAudio = 'data:audio/webm;base64,' + Buffer.alloc(4000, 7).toString('base64');
  s1.send({ type: 'speak', mime: 'audio/webm', data: fakeAudio, audioOffsetMs: Math.round(story(6)) });
  const audio = await mainC.wait((m) => m.type === 'audio', 5000, 'audio relay');
  ok(audio.audioOffsetMs === Math.round(story(6)), `station1 音频已转发到 main（audioOffsetMs=${audio.audioOffsetMs}）`);

  await sleep(Math.max(0, active.phaseStartedAt + story(24) - Date.now()));
  s2.send({ type: 'breaker' });
  const br = await s2.wait((m) => m.type === 'breaker');
  ok(br.status === 'locked', `24s 拉闸 → ${br.status}（防剧透锁定）`);

  const flash = await mainC.wait(isState('FLASH_FREEZE'));
  const activeLen = (flash.phaseStartedAt - active.phaseStartedAt) / scale / 1000;
  ok(Math.abs(activeLen - 29.5) < 0.15, `锁定后在剧情 ${activeLen.toFixed(2)}s 触发闪白（期望 29.5s）`);

  // main 上传定格照
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]);
  mainC.send({ type: 'freeze', data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const dp = await door.wait((m) => m.type === 'door-photo' && m.photo.has, 5000, 'door-photo');
  ok(!!dp.photo.url, `定格照已推送到 door：${dp.photo.url}`);
  const img = await fetch(BASE + dp.photo.url.split('?')[0] + (TOKEN ? '' : ''));
  ok(img.ok && img.headers.get('cache-control') === 'no-cache', `GET ${dp.photo.url} → ${img.status} (${img.headers.get('cache-control')})`);

  await mainC.wait(isState('REWIND'));
  const replay = await mainC.wait(isState('REPLAY_TRUTH'));
  ok(replay.round.didSpeak === true && replay.round.didPullBreaker === true, `回合记录 didSpeak=${replay.round.didSpeak} didPullBreaker=${replay.round.didPullBreaker}`);

  await mainC.wait(isState('CCTV_REVEAL'), 40000 * scale + 5000, 'CCTV_REVEAL');
  door.send({ type: 'cctv', data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const cc = await mainC.wait((m) => m.type === 'cctv', 3000, 'cctv relay');
  ok(!!cc.data, 'CCTV_REVEAL 期间 door 监控帧已转发到 main');
  await mainC.wait((m) => m.type === 'state' && m.state === 'IDLE' && m.round.id === replay.round.id, 15000, 'back to IDLE');
  ok(true, 'CCTV_REVEAL 结束自动回 IDLE');
  // admin 与 main 是两条独立连接：等 admin 也收到 IDLE 再比对序列（避免公网下的到达先后竞态）
  await admin.wait((m) => m.type === 'state' && m.state === 'IDLE' && m.round.id === replay.round.id, 5000, 'admin IDLE');
  console.log('  状态序列：' + seen.map((s) => s.state).join(' → '));
  const expected = ['ENTER_BUFFER', 'ACTIVE_30S', 'FLASH_FREEZE', 'REWIND', 'REPLAY_TRUTH', 'CCTV_REVEAL', 'IDLE'];
  ok(JSON.stringify(seen.map((s) => s.state).slice(-7)) === JSON.stringify(expected), '状态机顺序正确');

  // IDLE 时 cctv 不转发
  mainC.clear();
  door.send({ type: 'cctv', data: 'x'.repeat(200) });
  await sleep(300);
  ok(!mainC.msgs.some((m) => m.type === 'cctv'), 'IDLE 时监控帧不转发');

  // ---- 4. 第二轮：28.5s 后拉闸 → 立即闪白；不喊话 ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  admin.send({ type: 'START_SESSION', token: TOKEN });
  const a2 = await s2.wait(isState('ACTIVE_30S'));
  await sleep(Math.max(0, a2.phaseStartedAt + story(28.8) - Date.now()));
  s2.send({ type: 'breaker' });
  const br2 = await s2.wait((m) => m.type === 'breaker');
  ok(br2.status === 'flash', `28.8s 拉闸 → ${br2.status}（立即闪白）`);
  const f2 = await s2.wait(isState('FLASH_FREEZE'));
  const len2 = (f2.phaseStartedAt - a2.phaseStartedAt) / scale / 1000;
  ok(len2 < 29.3, `立即闪白发生在剧情 ${len2.toFixed(2)}s`);

  // 急停（需要二次确认的是前端；协议层直接 reset）
  admin.send({ type: 'admin', action: 'reset', token: TOKEN });
  const idle = await admin.wait((m) => m.type === 'state' && m.state === 'IDLE' && m.round.id === f2.round.id);
  ok(idle.round.didSpeak === false, '急停后回到 IDLE');

  // ---- 5. 第三轮：不拉闸 → 30s 自然闪白（旁观者结局条件） ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  admin.send({ type: 'START_SESSION', token: TOKEN });
  const a3 = await mainC.wait(isState('ACTIVE_30S'));
  const f3 = await mainC.wait(isState('FLASH_FREEZE'), 35000 * scale + 5000);
  const len3 = (f3.phaseStartedAt - a3.phaseStartedAt) / scale / 1000;
  ok(Math.abs(len3 - 30) < 0.15, `无人拉闸：剧情 ${len3.toFixed(2)}s 自然闪白`);
  ok(f3.round.didSpeak === false && f3.round.didPullBreaker === false, '旁观者结局条件 didSpeak=false && didPullBreaker=false');
  admin.send({ type: 'admin', action: 'reset', token: TOKEN });
  await admin.wait((m) => m.type === 'state' && m.state === 'IDLE' && m.round.id === f3.round.id);

  // ---- 6. 管理功能 ----
  admin.clear();
  mainC.clear();
  door.clear();
  admin.send({ type: 'admin', action: 'testFlash', token: TOKEN });
  await mainC.wait((m) => m.type === 'flash', 3000, 'flash');
  await sleep(200);
  ok(!door.msgs.some((m) => m.type === 'flash'), '测试主屏闪白只发往 main（door 不闪）');

  const arch = await (await fetch(BASE + '/api/archive' + (TOKEN ? `?token=${TOKEN}` : ''))).json();
  ok(arch.ok && arch.count >= 1, `/api/archive 今日归档 ${arch.count} 张`);

  admin.send({ type: 'admin', action: 'resetDoor', token: TOKEN });
  const rd = await door.wait((m) => m.type === 'door-photo' && !m.photo.has, 3000, 'resetDoor');
  ok(rd.photo.has === false, '重置入口照片为默认底片');

  const cl = await admin.wait((m) => m.type === 'clients', 3000);
  ok(['main', 'door', 'station1', 'station2'].every((r) => cl.clients.find((c) => c.role === r)?.online), '四端在线状态正确');

  for (const c of [admin, door, s1, s2, mainC]) c.ws.close();
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n🎉 全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
