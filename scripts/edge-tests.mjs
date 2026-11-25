#!/usr/bin/env node
/**
 * 协议层边界测试（无浏览器）。建议用 TIME_SCALE=0.2 启动服务。
 *   BASE=http://localhost:3000 [ADMIN_TOKEN=..] [SKIP_HEARTBEAT=1] node scripts/edge-tests.mjs
 * 覆盖：双 admin、拉闸 28.5s 边界、非 ACTIVE 拉闸、录音窗口、15MB 载荷、20s 心跳断开。
 */
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const TOKEN = process.env.ADMIN_TOKEN || undefined;
const results = [];
const ok = (cond, label) => {
  results.push([!!cond, label]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(BASE + '/api/health', { cache: 'no-store' })).json();

function client(role, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, opts);
    const c = { role, ws, msgs: [], waiters: [], closed: null };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, timeout = 20000, label = '') =>
      new Promise((res, rej) => {
        const hit = c.msgs.find(pred);
        if (hit) return res(hit);
        const w = { pred, res };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          rej(new Error(`[${role}] timeout ${label}`));
        }, timeout);
      });
    c.clear = () => (c.msgs = []);
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      c.msgs.push(m);
      for (const w of [...c.waiters]) if (w.pred(m)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.res(m);
      }
    });
    ws.on('close', (code) => (c.closed = { code, at: Date.now() }));
    ws.on('open', () => {
      if (!opts.silent) c.send({ type: 'hello', role, token: role === 'admin' ? TOKEN : undefined });
      resolve(c);
    });
    ws.on('error', (e) => (c.closed ? null : reject(e)));
  });
}
const isState = (s, roundId) => (m) => m.type === 'state' && m.state === s && (roundId == null || m.round.id === roundId);

async function waitStory(c, active, sec, scale) {
  await sleep(Math.max(0, active.phaseStartedAt + sec * 1000 * scale - Date.now()));
}

async function reset(admin) {
  admin.clear();
  admin.send({ type: 'admin', action: 'reset', token: TOKEN });
  await admin.wait(isState('IDLE'));
}

async function main() {
  const h = await health();
  const scale = h.timeScale;
  console.log(`BASE=${BASE} TIME_SCALE=${scale}`);
  const a1 = await client('admin');
  const a2 = await client('admin');
  const s1 = await client('station1');
  const s2 = await client('station2');
  const m = await client('main');
  await sleep(300);
  await reset(a1);

  // ---- 双 admin ----
  ok(a1.msgs.some((x) => x.type === 'state') && a2.msgs.some((x) => x.type === 'state'), '两个 admin 都收到 state');
  a1.clear();
  a2.clear();
  a1.send({ type: 'START_SESSION', token: TOKEN });
  a2.send({ type: 'START_SESSION', token: TOKEN });
  const k1 = await a1.wait((x) => x.type === 'ack' && x.what === 'START_SESSION');
  const k2 = await a2.wait((x) => x.type === 'ack' && x.what === 'START_SESSION');
  ok([k1.ok, k2.ok].filter(Boolean).length === 1, `两个 admin 同时开始：仅一个成功（${k1.ok}/${k2.ok}）`);
  const e1 = await a1.wait(isState('ENTER_BUFFER'));
  const e2 = await a2.wait(isState('ENTER_BUFFER'));
  ok(e1.round.id === e2.round.id, '两个 admin 看到同一轮 ENTER_BUFFER');

  // ---- 非 ACTIVE 拉闸被忽略 ----
  s2.clear();
  s2.send({ type: 'breaker' });
  await sleep(150);
  ok(!s2.msgs.some((x) => x.type === 'breaker'), 'ENTER_BUFFER 期间拉闸被忽略');

  // ---- 录音窗口 ----
  const act = await s1.wait(isState('ACTIVE_30S', e1.round.id));
  const audio = 'data:audio/webm;base64,' + Buffer.alloc(3000, 3).toString('base64');
  s1.clear();
  s1.send({ type: 'speak', mime: 'audio/webm', data: audio, audioOffsetMs: Math.round(3 * 1000 * scale) });
  let ack = await s1.wait((x) => x.type === 'ack' && x.what === 'speak');
  ok(ack.ok === false, `offset=3s 的录音被拒绝（${ack.message}）`);
  s1.clear();
  s1.send({ type: 'speak', mime: 'audio/webm', data: audio, audioOffsetMs: Math.round(14 * 1000 * scale) });
  ack = await s1.wait((x) => x.type === 'ack' && x.what === 'speak');
  ok(ack.ok === false, `offset=14s 的录音被拒绝（${ack.message}）`);
  // 早于 20.5s 拉闸被拒
  await waitStory(s2, act, 10, scale);
  s2.clear();
  s2.send({ type: 'breaker' });
  const early = await s2.wait((x) => x.type === 'ack' && x.what === 'breaker', 3000);
  ok(early.ok === false, `10s 时拉闸被拒（${early.message}）`);
  s1.clear();
  s1.send({ type: 'speak', mime: 'audio/webm', data: audio, audioOffsetMs: Math.round(7 * 1000 * scale) });
  ack = await s1.wait((x) => x.type === 'ack' && x.what === 'speak');
  ok(ack.ok === true, 'offset=7s 的录音被接受');
  s1.clear();
  s1.send({ type: 'speak', mime: 'audio/webm', data: audio, audioOffsetMs: Math.round(8 * 1000 * scale) });
  ack = await s1.wait((x) => x.type === 'ack' && x.what === 'speak');
  ok(ack.ok === false, '同一轮第二段录音被拒绝');

  // ---- 拉闸 28.3s → 锁定 ----
  await waitStory(s2, act, 28.3, scale);
  s2.clear();
  s2.send({ type: 'breaker' });
  const b1 = await s2.wait((x) => x.type === 'breaker');
  ok(b1.status === 'locked', `28.3s 拉闸 → ${b1.status} @${b1.atSec}s`);
  const f1 = await s2.wait(isState('FLASH_FREEZE', act.round.id));
  const len1 = (f1.phaseStartedAt - act.phaseStartedAt) / scale / 1000;
  ok(Math.abs(len1 - 29.5) < 0.12, `锁定后剧情 ${len1.toFixed(3)}s 闪白`);
  s2.clear();
  s2.send({ type: 'breaker' });
  await sleep(150);
  ok(!s2.msgs.some((x) => x.type === 'breaker') && (await health()).state !== 'ACTIVE_30S', 'FLASH_FREEZE 期间再拉闸被忽略');
  const rp = await a1.wait(isState('REPLAY_TRUTH', act.round.id));
  s2.send({ type: 'breaker' });
  await sleep(150);
  ok((await health()).state === 'REPLAY_TRUTH', 'REPLAY_TRUTH 期间拉闸被忽略');
  ok(rp.round.didSpeak && rp.round.audioOffsetMs === Math.round(7 * 1000 * scale), '本轮 didSpeak=true 且 audioOffsetMs 正确');
  await reset(a1);

  // ---- 拉闸 28.7s → 立即 ----
  a1.clear();
  a1.send({ type: 'START_SESSION', token: TOKEN });
  const act2 = await s2.wait(isState('ACTIVE_30S', act.round.id + 1));
  await waitStory(s2, act2, 28.7, scale);
  s2.clear();
  s2.send({ type: 'breaker' });
  const b2 = await s2.wait((x) => x.type === 'breaker');
  ok(b2.status === 'flash', `28.7s 拉闸 → ${b2.status} @${b2.atSec}s`);
  const f2 = await s2.wait(isState('FLASH_FREEZE', act2.round.id));
  const len2 = (f2.phaseStartedAt - act2.phaseStartedAt) / scale / 1000;
  ok(len2 < 28.95, `立即闪白发生在剧情 ${len2.toFixed(3)}s`);
  await reset(a1);

  // ---- IDLE 拉闸被忽略 ----
  s2.clear();
  s2.send({ type: 'breaker' });
  await sleep(150);
  ok(!s2.msgs.some((x) => x.type === 'breaker') && (await health()).state === 'IDLE', 'IDLE 期间拉闸被忽略');

  // ---- 15MB 载荷 ----
  const big = await client('door');
  await sleep(200);
  const nearly = JSON.stringify({ type: 'cctv', data: 'A'.repeat(15 * 1024 * 1024 - 200) });
  big.ws.send(nearly);
  await sleep(1500);
  big.clear();
  big.send({ type: 'time', clientTime: Date.now() });
  const tt = await big.wait((x) => x.type === 'time', 8000).catch(() => null);
  ok(!big.closed && !!tt, `≈15MB (${(nearly.length / 1048576).toFixed(2)}MB) 消息被接收，连接保持`);
  const over = await client('door');
  await sleep(200);
  over.ws.send('X'.repeat(15 * 1024 * 1024 + 1024));
  await sleep(2500);
  ok(over.closed && over.closed.code === 1009, `>15MB 消息被拒绝并断开（close code ${over.closed?.code}）`);
  const hh = await health();
  ok(hh.ok === true, '超大消息后服务器仍健康');
  big.ws.close();

  // ---- 20s 心跳：不回 pong 的客户端被终止 ----
  if (!process.env.SKIP_HEARTBEAT) {
    const dead = await client('station2', { autoPong: false });
    const alive = await client('station1');
    const t0 = Date.now();
    while (!dead.closed && Date.now() - t0 < 45000) await sleep(250);
    const secs = ((dead.closed?.at ?? Date.now()) - t0) / 1000;
    ok(!!dead.closed && secs <= 41, `不回 Pong 的客户端在 ${secs.toFixed(1)}s 后被服务器终止（code ${dead.closed?.code}）`);
    ok(!alive.closed, '正常客户端同期保持连接');
    alive.ws.close();
  }

  for (const c of [a1, a2, s1, s2, m]) c.ws.close();
  const fails = results.filter((r) => !r[0]).length;
  console.log(fails ? `\n${fails} FAILED` : `\nALL ${results.length} PASSED`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
