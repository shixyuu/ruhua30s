/**
 * 《入画三十秒》统一单端口服务：静态前端 + /assets + /data + /api + /ws
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  AppConfig,
  ClientMsg,
  ClientStatus,
  Phase,
  PHASE_SECONDS,
  Role,
  ROLES,
  RoundInfo,
  ServerMsg,
  TIMELINE,
} from '../shared/protocol.js';
import {
  ASSETS_DIR,
  DATA_DIR,
  assetExists,
  decodeJpeg,
  doorPhotoInfo,
  ensureDirs,
  listArchive,
  loadConfig,
  resetDoorPhoto,
  sanitizeConfig,
  saveConfig,
  saveFreeze,
} from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '../public'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
/** 仅用于开发联调：把所有阶段时长按比例缩短，例如 TIME_SCALE=0.1。生产环境保持 1。 */
const TIME_SCALE = Math.min(10, Math.max(0.01, Number(process.env.TIME_SCALE || 1) || 1));
const MAX_PAYLOAD = 15 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;

ensureDirs();
let config: AppConfig = loadConfig();

// ======================================================================
// HTTP
// ======================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

function tokenOk(req: Request): boolean {
  if (!ADMIN_TOKEN) return true;
  const t = (req.query.token as string) || req.get('x-admin-token') || '';
  return t === ADMIN_TOKEN;
}

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    state,
    clients: clientCounts(),
    round: round.id,
    timeScale: TIME_SCALE,
    assets: { base: assetExists('base.mp4'), rewind: assetExists('rewind.mp4') },
    uptime: Math.round(process.uptime()),
    serverTime: Date.now(),
  });
});

app.get('/api/archive', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  const date = typeof req.query.date === 'string' && /^\d{8}$/.test(req.query.date) ? req.query.date : null;
  const all = req.query.all === '1';
  const items = await listArchive(date, all);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, date: date || (all ? 'all' : 'today'), count: items.length, items });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, config });
});

// /assets：外部挂载目录，运行中覆盖文件即可热更新（ETag + no-cache，每次协商校验）
const noCache = (res: Response) => res.setHeader('Cache-Control', 'no-cache');
app.use(
  '/assets',
  express.static(ASSETS_DIR, { etag: true, lastModified: true, maxAge: 0, setHeaders: noCache }),
);
app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('asset not found'));

// /data：持久化目录。若设置了 ADMIN_TOKEN，则观众归档照片需要 token 才能访问。
app.use('/data', (req: Request, res: Response, next: NextFunction) => {
  if (/\.tmp$/i.test(req.path)) return void res.status(404).end();
  if (req.path.startsWith('/archive') && !tokenOk(req)) return void res.status(401).end();
  next();
});
app.use(
  '/data',
  express.static(DATA_DIR, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    dotfiles: 'deny',
    setHeaders: noCache,
  }),
);
app.use('/data', (_req, res) => res.status(404).type('text/plain').send('not found'));

// 前端构建产物：/static/* 带 hash，长缓存；其余 no-cache
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}static${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// SPA fallback
const indexFile = path.join(PUBLIC_DIR, 'index.html');
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  if (!fs.existsSync(indexFile)) {
    return void res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('Frontend not built yet: run npm run build first (in dev mode open the Vite port 5173)');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexFile);
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ======================================================================
// WebSocket
// ======================================================================
interface Peer {
  role: Role | null;
  alive: boolean;
  lastSeen: number;
  ip: string;
  isAdmin: boolean;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
const peers = new Map<WebSocket, Peer>();
const lastSeenByRole: Record<Role, number | null> = { main: null, door: null, station1: null, station2: null, admin: null };

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg, filter?: (p: Peer) => boolean): void {
  const raw = JSON.stringify(msg);
  for (const [ws, p] of peers) {
    if (!p.role) continue;
    if (filter && !filter(p)) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

const toRole = (r: Role) => (p: Peer) => p.role === r;

function clientCounts(): Record<Role, number> {
  const c: Record<Role, number> = { main: 0, door: 0, station1: 0, station2: 0, admin: 0 };
  for (const p of peers.values()) if (p.role) c[p.role]++;
  return c;
}

function clientStatuses(): ClientStatus[] {
  const counts = clientCounts();
  return ROLES.map((role) => {
    let last = lastSeenByRole[role];
    for (const p of peers.values()) if (p.role === role && (!last || p.lastSeen > last)) last = p.lastSeen;
    return { role, online: counts[role] > 0, count: counts[role], lastSeen: last };
  });
}

function pushClients(): void {
  broadcast({ type: 'clients', clients: clientStatuses(), serverTime: Date.now() }, (p) => p.role === 'admin');
}

function touch(p: Peer): void {
  p.alive = true;
  p.lastSeen = Date.now();
  if (p.role) lastSeenByRole[p.role] = p.lastSeen;
}

// 服务端 20 秒 Ping/Pong 心跳：上一轮未回 pong 的连接直接 terminate
const heartbeat = setInterval(() => {
  for (const [ws, p] of peers) {
    if (!p.alive) {
      console.log(`[ws] 心跳超时，断开 ${p.role ?? '?'} ${p.ip}`);
      ws.terminate();
      continue;
    }
    p.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);

const adminStatusTimer = setInterval(pushClients, 1000);

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const peer: Peer = { role: null, alive: true, lastSeen: Date.now(), ip, isAdmin: false };
  peers.set(ws, peer);

  ws.on('pong', () => touch(peer));
  ws.on('message', (data: RawData, isBinary: boolean) => {
    touch(peer);
    if (isBinary) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'bad json' });
    }
    try {
      handleMessage(ws, peer, msg);
    } catch (err) {
      console.error('[ws] handle error', err);
    }
  });
  ws.on('close', () => {
    if (peer.role) lastSeenByRole[peer.role] = Date.now();
    peers.delete(ws);
    if (peer.role) console.log(`[ws] ${peer.role} 断开 (${ip})`);
    pushClients();
  });
  ws.on('error', () => {
    /* close 会随后触发 */
  });
});

function sendFullSync(ws: WebSocket, peer: Peer): void {
  send(ws, { type: 'time', clientTime: 0, serverTime: Date.now() });
  send(ws, stateMsg());
  send(ws, { type: 'config', config });
  send(ws, { type: 'door-photo', photo: doorPhotoInfo(), serverTime: Date.now() });
  if (peer.role === 'admin') send(ws, { type: 'clients', clients: clientStatuses(), serverTime: Date.now() });
  // main 中途重连：若本轮已有观众原声，补发
  if (peer.role === 'main' && lastAudio && lastAudio.roundId === round.id && state !== 'IDLE') {
    send(ws, { type: 'audio', ...lastAudio });
  }
}

function handleMessage(ws: WebSocket, peer: Peer, msg: ClientMsg): void {
  switch (msg.type) {
    case 'hello': {
      if (!ROLES.includes(msg.role)) return send(ws, { type: 'error', message: 'unknown role' });
      peer.role = msg.role;
      peer.isAdmin = msg.role === 'admin' && (!ADMIN_TOKEN || msg.token === ADMIN_TOKEN);
      lastSeenByRole[msg.role] = Date.now();
      console.log(`[ws] ${msg.role} 上线 (${peer.ip})`);
      if (msg.role === 'admin' && !peer.isAdmin) send(ws, { type: 'ack', what: 'auth', ok: false, message: 'Wrong ADMIN_TOKEN' });
      sendFullSync(ws, peer);
      pushClients();
      return;
    }
    case 'time':
      return send(ws, { type: 'time', clientTime: msg.clientTime, serverTime: Date.now() });
    case 'hb':
      return;
    case 'START_SESSION': {
      // 唯一启动入口：仅接受 admin 端
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        console.log(`[ws] 拒绝来自 ${peer.role ?? '未注册'} 的 START_SESSION`);
        return send(ws, { type: 'ack', what: 'START_SESSION', ok: false, message: 'Only /admin can start a session' });
      }
      const ok = tryStart('admin');
      return send(ws, {
        type: 'ack',
        what: 'START_SESSION',
        ok,
        message: ok ? 'Shutter pressed · entering the frame' : `Current state is ${state}; can only start from IDLE`,
      });
    }
    case 'speak':
      if (peer.role !== 'station1') return;
      return onSpeak(ws, msg.mime, msg.data, msg.audioOffsetMs);
    case 'breaker':
      if (peer.role !== 'station2') return;
      return onBreaker(ws);
    case 'freeze':
      if (peer.role !== 'main') return;
      return void onFreeze(ws, msg.data);
    case 'cctv':
      if (peer.role !== 'door') return;
      if (state !== 'CCTV_REVEAL' && state !== 'REPLAY_TRUTH') return;
      if (typeof msg.data !== 'string' || msg.data.length > 2_000_000) return;
      return broadcast({ type: 'cctv', data: msg.data, serverTime: Date.now() }, toRole('main'));
    case 'admin': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        return send(ws, { type: 'ack', what: msg.action, ok: false, message: 'Not authorised (ADMIN_TOKEN)' });
      }
      return void onAdmin(ws, msg.action, msg.config);
    }
  }
}

// ======================================================================
// 状态机（唯一真相源）
// ======================================================================
const NEXT: Record<Phase, Phase> = {
  IDLE: 'IDLE',
  ENTER_BUFFER: 'ACTIVE_30S',
  ACTIVE_30S: 'FLASH_FREEZE',
  FLASH_FREEZE: 'REWIND',
  REWIND: 'REPLAY_TRUTH',
  REPLAY_TRUTH: 'CCTV_REVEAL',
  CCTV_REVEAL: 'IDLE',
};

let state: Phase = 'IDLE';
let phaseStartedAt = Date.now();
let phaseDurationMs = 0;
let phaseTimer: NodeJS.Timeout | null = null;
let freezeSaving = false;
let lastAudio: { mime: string; data: string; audioOffsetMs: number; roundId: number } | null = null;

function freshRound(id: number): RoundInfo {
  return {
    id,
    activeStartedAt: null,
    didSpeak: false,
    didPullBreaker: false,
    audioOffsetMs: null,
    breakerPulledAtSec: null,
    breakerLocked: false,
    hasFreeze: false,
    trigger: null,
  };
}
let round: RoundInfo = freshRound(0);

function durationFor(p: Phase): number {
  if (p === 'IDLE') return 0;
  const sec = p === 'ENTER_BUFFER' ? config.enterBufferSec : PHASE_SECONDS[p];
  return Math.round(sec * 1000 * TIME_SCALE);
}

function stateMsg(): ServerMsg {
  return {
    type: 'state',
    state,
    phaseStartedAt,
    phaseDurationMs,
    serverTime: Date.now(),
    timeScale: TIME_SCALE,
    round,
    doorPhoto: doorPhotoInfo(),
  };
}

function enter(next: Phase, endAtMs?: number): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = null;
  state = next;
  phaseStartedAt = Date.now();
  phaseDurationMs = durationFor(next);

  if (next === 'ACTIVE_30S') round.activeStartedAt = phaseStartedAt;

  if (phaseDurationMs > 0) schedule(endAtMs ?? phaseStartedAt + phaseDurationMs);
  console.log(`[state] → ${next} (${phaseDurationMs}ms) round=${round.id}`);
  broadcast(stateMsg());
}

function schedule(atMs: number): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  const current = state;
  phaseTimer = setTimeout(() => {
    if (state === current) enter(NEXT[current]);
  }, Math.max(0, atMs - Date.now()));
}

function tryStart(trigger: string): boolean {
  if (state !== 'IDLE') return false;
  round = freshRound(round.id + 1);
  round.trigger = trigger;
  lastAudio = null;
  enter('ENTER_BUFFER');
  return true;
}

/** ACTIVE_30S 内的剧情秒数（已按 TIME_SCALE 还原） */
function activeSec(): number {
  return (Date.now() - phaseStartedAt) / TIME_SCALE / 1000;
}

function onSpeak(ws: WebSocket, mime: string, data: string, audioOffsetMs: number): void {
  if (state !== 'ACTIVE_30S' && state !== 'FLASH_FREEZE') {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'Recording not accepted in this phase' });
  }
  if (typeof data !== 'string' || data.length < 100) return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'empty' });
  const offset = Math.max(0, Math.min(PHASE_SECONDS.ACTIVE_30S * 1000 * TIME_SCALE, Math.round(Number(audioOffsetMs) || 0)));
  // 录音必须开始于 A 段（05s~13s，容差 0.3s），否则丢弃
  const offsetSec = offset / 1000 / TIME_SCALE;
  if (offsetSec < TIMELINE.station1A[0] - 0.3 || offsetSec > TIMELINE.station1A[1]) {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'Recording outside the 05s–13s window; ignored' });
  }
  if (round.didSpeak) return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'A recording was already received this round' });
  round.didSpeak = true;
  round.audioOffsetMs = offset;
  lastAudio = { mime: String(mime || 'audio/webm').slice(0, 80), data, audioOffsetMs: offset, roundId: round.id };
  console.log(`[round ${round.id}] 收到观众喊话 ${(data.length / 1024).toFixed(0)}KB @${offset}ms`);
  broadcast({ type: 'audio', ...lastAudio }, toRole('main'));
  send(ws, { type: 'ack', what: 'speak', ok: true });
  broadcast(stateMsg());
}

function onBreaker(ws: WebSocket): void {
  if (state !== 'ACTIVE_30S' || round.didPullBreaker) return;
  const t = activeSec();
  if (t < TIMELINE.station2C[0] - 0.5) {
    return send(ws, { type: 'ack', what: 'breaker', ok: false, message: 'Breaker phase has not started yet' });
  }
  round.didPullBreaker = true;
  round.breakerPulledAtSec = Math.round(t * 1000) / 1000;
  if (t < TIMELINE.breakerSpoilerGuard) {
    // 防剧透：锁定，等到 29.5s 再全局闪白
    round.breakerLocked = true;
    schedule(phaseStartedAt + TIMELINE.breakerDelayedFlash * 1000 * TIME_SCALE);
    console.log(`[round ${round.id}] 电闸提前拉下 @${t.toFixed(2)}s → 锁定至 ${TIMELINE.breakerDelayedFlash}s`);
    broadcast({ type: 'breaker', status: 'locked', atSec: round.breakerPulledAtSec });
    broadcast(stateMsg());
  } else {
    console.log(`[round ${round.id}] 电闸拉下 @${t.toFixed(2)}s → 立即闪白`);
    broadcast({ type: 'breaker', status: 'flash', atSec: round.breakerPulledAtSec });
    enter('FLASH_FREEZE');
  }
}

async function onFreeze(ws: WebSocket, data: string): Promise<void> {
  const buf = typeof data === 'string' ? decodeJpeg(data) : null;
  if (!buf) return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Not a valid JPEG' });
  // 同一轮只保存第一张（多台 /main 同时在线时避免重复归档）
  if (round.hasFreeze || freezeSaving) return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame already saved this round' });
  if (state === 'IDLE' || state === 'ENTER_BUFFER' || state === 'ACTIVE_30S') {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame not accepted in this phase' });
  }
  freezeSaving = true;
  try {
    const { photo, archiveName } = await saveFreeze(buf, round.id);
    round.hasFreeze = true;
    console.log(`[round ${round.id}] 定格照已保存 ${archiveName} (${(buf.length / 1024).toFixed(0)}KB)`);
    send(ws, { type: 'ack', what: 'freeze', ok: true, message: archiveName });
    broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
  } catch (err) {
    console.error('[freeze] 保存失败', err);
    send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Save failed' });
  } finally {
    freezeSaving = false;
  }
}

async function onAdmin(ws: WebSocket, action: string, cfg?: Partial<AppConfig>): Promise<void> {
  switch (action) {
    case 'reset':
      lastAudio = null;
      enter('IDLE');
      return send(ws, { type: 'ack', what: 'reset', ok: true, message: 'Reset to IDLE' });
    case 'resetDoor': {
      const photo = await resetDoorPhoto();
      broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
      return send(ws, { type: 'ack', what: 'resetDoor', ok: true, message: 'Entrance photo reset to the default negative' });
    }
    case 'testFlash':
      broadcast({ type: 'flash', serverTime: Date.now() }, toRole('main'));
      return send(ws, { type: 'ack', what: 'testFlash', ok: true, message: 'Test flash sent to main screen' });
    case 'setConfig': {
      config = sanitizeConfig(cfg, config);
      try {
        await saveConfig(config);
      } catch (err) {
        console.error('[config] 保存失败', err);
      }
      broadcast({ type: 'config', config });
      return send(ws, { type: 'ack', what: 'setConfig', ok: true, message: 'config.json saved' });
    }
    default:
      return send(ws, { type: 'ack', what: action, ok: false, message: 'unknown action' });
  }
}

// ======================================================================
server.listen(PORT, HOST, () => {
  console.log(`《入画三十秒》服务已启动 http://${HOST}:${PORT}  (TIME_SCALE=${TIME_SCALE})`);
  console.log(`  assets: ${ASSETS_DIR}`);
  console.log(`  data:   ${DATA_DIR}`);
  console.log(`  public: ${PUBLIC_DIR}`);
  if (ADMIN_TOKEN) console.log('  ADMIN_TOKEN 已启用：/admin?token=...');
});

function shutdown(sig: string): void {
  console.log(`收到 ${sig}，正在关闭...`);
  clearInterval(heartbeat);
  clearInterval(adminStatusTimer);
  for (const ws of peers.keys()) ws.close(1001, 'server shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
