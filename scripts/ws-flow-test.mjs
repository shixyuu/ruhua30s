#!/usr/bin/env node
/**
 * v3.2 扫码传图彩色暗房精修引擎 WebSocket + HTTP 全流程联调测试
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
    health.ok === true && health.version === '3.2.0-color-dodge' && health.state === 'IDLE',
    `/api/health → ${JSON.stringify(health)}`,
  );

  const [admin, door, s1, s2, mainC] = await Promise.all(['admin', 'door', 'station1', 'station2', 'main'].map(client));
  await admin.wait(isState('IDLE'), 3000, 'initial IDLE').catch(() => null);

  // ---- 1. 非 admin 发起 START_SESSION 必须被拒绝 ----
  for (const c of [door, s1, s2, mainC]) {
    c.clear();
    c.send({ type: 'START_SESSION' });
    const ack = await c.wait((m) => m.type === 'ack' && m.what === 'START_SESSION', 3000, 'ack');
    ok(ack.ok === false, `${c.role} 的 START_SESSION 被拒绝`);
  }

  // ---- 2. TEST_FLASH 全局广播 FLASH_PULSE ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  admin.send({ type: 'TEST_FLASH', token: TOKEN });
  const pulses = await Promise.all(
    [admin, door, s1, s2, mainC].map((c) => c.wait((m) => m.type === 'FLASH_PULSE', 3000, `${c.role} FLASH_PULSE`)),
  );
  ok(pulses.every((p) => p.durationMs === 260), 'TEST_FLASH 向全部 5 个终端同步广播 FLASH_PULSE');

  // ---- 3. 远程标定 ENTER_CALIBRATION + REQUEST_SNAPSHOT + POST /api/calibration ----
  admin.clear();
  mainC.clear();
  admin.send({ type: 'ENTER_CALIBRATION', token: TOKEN });
  await mainC.wait(isState('CALIBRATING'), 3000, 'CALIBRATING');
  admin.send({ type: 'REQUEST_SNAPSHOT', token: TOKEN });
  await mainC.wait((m) => m.type === 'REQUEST_SNAPSHOT', 3000, 'main REQUEST_SNAPSHOT');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]);
  mainC.send({ type: 'SNAPSHOT_DATA', imageData: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const snapReady = await admin.wait((m) => m.type === 'SNAPSHOT_READY', 3000, 'SNAPSHOT_READY');
  ok(snapReady.imageData.startsWith('data:image/jpeg'), '远程快照回传至 /admin 正常');

  const calSave = await (
    await fetch(BASE + '/api/calibration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
        hInv: [0.0025, 0, 0.1, 0, 0.0044, 0.1, 0, 0, 1],
        token: TOKEN,
      }),
    })
  ).json();
  ok(calSave.ok && calSave.calibration?.hInv?.length === 9, 'POST /api/calibration 透视矩阵持久化成功');

  admin.send({ type: 'EXIT_CALIBRATION', token: TOKEN });
  await mainC.wait(isState('IDLE'), 3000, 'IDLE after EXIT_CALIBRATION');

  // ---- 4. 手机扫码上传 POST /api/upload ----
  const upRes = await (
    await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: 'data:image/jpeg;base64,' + jpeg.toString('base64') }),
    })
  ).json();
  const stBefore = await (await fetch(BASE + '/api/state')).json();
  ok(upRes.ok && stBefore.state.hasQueuedPhoto === true, 'POST /api/upload 用户照片入队成功');

  // ---- 5. 完整 4 阶段流程 + 隐私自动清理 ----
  for (const c of [admin, door, s1, s2, mainC]) c.clear();
  const seen = [];
  admin.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state' && seen[seen.length - 1] !== m.state) seen.push(m.state);
  });

  admin.send({ type: 'START_SESSION', token: TOKEN });
  await mainC.wait(isState('CAPTURE_CLEAN'), 3000, 'CAPTURE_CLEAN');
  await mainC.wait(isState('OBSERVE'), 3000, 'OBSERVE');
  await mainC.wait(isState('EXPOSE'), 5000, 'EXPOSE');
  await mainC.wait(isState('DEVELOP'), 10000, 'DEVELOP');

  for (let i = 0; i < 4; i++) {
    s1.send({ type: 'AUDIO_ENERGY', level: 0.85 });
    await sleep(60);
  }
  await mainC.wait((m) => m.type === 'dev' && m.devProgress > 0.25, 3000, 'dev > 0.25');

  s2.send({ type: 'TRIGGER_FIX' });
  const reveal = await mainC.wait(isState('REVEAL'), 3000, 'REVEAL');
  ok(reveal.round.outcome === 'FIXED_OPTIMAL', `station2 定影成功 (${reveal.round.outcome})`);

  door.clear();
  mainC.send({ type: 'freeze', data: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const cs = await door.wait((m) => m.type === 'contact-sheet' && m.sheet.totalInRoll >= 1, 5000, 'contact-sheet');
  const stAfter = await (await fetch(BASE + '/api/state')).json();
  ok(
    cs.sheet.frames.length === 1 && stAfter.state.hasQueuedPhoto === false,
    '成品已归档至 contact-sheet，且用户原始上传文件已自动销毁',
  );

  await mainC.wait(isState('IDLE'), 5000, 'auto IDLE');
  const expected = ['CAPTURE_CLEAN', 'OBSERVE', 'EXPOSE', 'DEVELOP', 'REVEAL', 'IDLE'];
  ok(JSON.stringify(seen.slice(-6)) === JSON.stringify(expected), `状态序列正确: ${seen.slice(-6).join(' → ')}`);

  // ---- 6. PURGE ALL DATA ----
  const clrAll = await (
    await fetch(BASE + '/api/cache/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all', token: TOKEN }),
    })
  ).json();
  ok(clrAll.ok && clrAll.state.rollNumber === 1 && clrAll.storage.framesCount === 0, 'PURGE ALL DATA 清零成功');

  for (const c of [admin, door, s1, s2, mainC]) c.ws.close();
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n🎉 v3.2 全部联调测试通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
