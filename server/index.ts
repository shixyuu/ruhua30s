/**
 * 《入画三十秒 (RH-30)》v2 统一单端口服务：静态前端 + /assets + /data + /api + /ws
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  AppConfig,
  AudioClip,
  ClientMsg,
  ClientStatus,
  ContactSheetInfo,
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
  countRollFramesSync,
  decodeJpeg,
  doorPhotoInfo,
  ensureDirs,
  getContactSheet,
  listArchive,
  loadConfig,
  pad,
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
let currentSheet: ContactSheetInfo = { rollNumber: config.rollNumber, totalInRoll: 0, frames: [] };
getContactSheet(config.rollNumber)
  .then((s) => (currentSheet = s))
  .catch(() => {});

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
    version: '2.0.0-archival',
    state,
    clients: clientCounts(),
    round: round.id,
    rollNumber: config.rollNumber,
    timeScale: TIME_SCALE,
    assets: { base: assetExists('base.mp4'), rewind: assetExists('rewind.mp4') },
    uptime: Math.round(process.uptime()),
    serverTime: Date.now(),
  });
});

app.get('/api/contact-sheet', async (_req, res) => {
  const sheet = await getContactSheet(config.rollNumber);
  currentSheet = sheet;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, sheet });
});

app.get('/api/archive', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  const date = typeof req.query.date === 'string' && /^\d{8}$/.test(req.query.date) ? req.query.date : null;
  const all = req.query.all === '1';
  const rollParam = req.query.roll === 'current' ? config.rollNumber : req.query.roll ? Number(req.query.roll) : null;
  const rollFilter = rollParam != null && Number.isFinite(rollParam) ? rollParam : null;
  const items = await listArchive(date, all, rollFilter);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    rollNumber: config.rollNumber,
    date: date || (all ? 'all' : 'today'),
    count: items.length,
    items,
  });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, config });
});

// /assets：外部挂载目录，运行中覆盖文件即可热更新
const noCache = (res: Response) => res.setHeader('Cache-Control', 'no-cache');
app.use(
  '/assets',
  express.static(ASSETS_DIR, { etag: true, lastModified: true, maxAge: 0, setHeaders: noCache }),
);
app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('asset not found'));

// /data：持久化目录。
// 注意：/door 需要无需 token 展示当前胶卷（/archive/roll-XX/）的接触印相表；
// 若设置了 ADMIN_TOKEN，仅保护非当前卷的历史归档。
app.use('/data', (req: Request, res: Response, next: NextFunction) => {
  if (/\.tmp$/i.test(req.path)) return void res.status(404).end();
  if (req.path.startsWith('/archive')) {
    const curPrefix = `/archive/roll-${pad(config.rollNumber, 2)}/`;
    if (!req.path.startsWith(curPrefix) && !tokenOk(req)) {
      return void res.status(401).end();
    }
  }
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

async function sendFullSync(ws: WebSocket, peer: Peer): Promise<void> {
  send(ws, { type: 'time', clientTime: 0, serverTime: Date.now() });
  send(ws, stateMsg());
  send(ws, { type: 'config', config });
  send(ws, { type: 'door-photo', photo: doorPhotoInfo(), serverTime: Date.now() });
  currentSheet = await getContactSheet(config.rollNumber);
  send(ws, { type: 'contact-sheet', sheet: currentSheet, serverTime: Date.now() });
  if (peer.role === 'admin') send(ws, { type: 'clients', clients: clientStatuses(), serverTime: Date.now() });
  // main 中途重连：若本轮已有观众录音片段，补发完整数组
  if (peer.role === 'main' && audioClips.length > 0 && state !== 'IDLE') {
    send(ws, { type: 'audio-sync', clips: audioClips, roundId: round.id });
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
      void sendFullSync(ws, peer);
      pushClients();
      return;
    }
    case 'time':
      return send(ws, { type: 'time', clientTime: msg.clientTime, serverTime: Date.now() });
    case 'hb':
      return;
    case 'START_SESSION': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        console.log(`[ws] 拒绝来自 ${peer.role ?? '未注册'} 的 START_SESSION`);
        return send(ws, { type: 'ack', what: 'START_SESSION', ok: false, message: 'Only /admin can start a session' });
      }
      const ok = tryStart('admin');
      return send(ws, {
        type: 'ack',
        what: 'START_SESSION',
        ok,
        message: ok
          ? `Shutter released · Roll ${pad(round.rollNumber, 2)} Frame ${pad(round.frameNumber, 2)}A`
          : `Current state is ${state}; can only start from IDLE`,
      });
    }
    case 'speak': {
      if (peer.role !== 'station1') return;
      const anyMsg = msg as ClientMsg & { data?: string; audioOffsetMs?: number };
      const dataUrl = msg.dataUrl ?? anyMsg.data ?? '';
      const offsetMs = msg.offsetMs ?? anyMsg.audioOffsetMs ?? 0;
      return onSpeak(ws, msg.mime, dataUrl, offsetMs);
    }
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
let audioClips: AudioClip[] = [];

function freshRound(id: number, rollNumber: number, frameNumber: number): RoundInfo {
  return {
    id,
    rollNumber,
    frameNumber,
    activeStartedAt: null,
    didSpeak: false,
    audioClipCount: 0,
    audioOffsetsMs: [],
    didPullBreaker: false,
    breakerPulledAtSec: null,
    breakerLocked: false,
    hasFreeze: false,
    trigger: null,
  };
}

let round: RoundInfo = freshRound(0, config.rollNumber, countRollFramesSync(config.rollNumber) + 1);

function durationFor(p: Phase): number {
  if (p === 'IDLE') return 0;
  let sec: number;
  if (p === 'ENTER_BUFFER') sec = config.enterBufferSec;
  else if (p === 'CCTV_REVEAL') sec = config.cctvRevealSec;
  else sec = PHASE_SECONDS[p];
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
  console.log(`[state] → ${next} (${phaseDurationMs}ms) roll=${round.rollNumber} frame=${pad(round.frameNumber, 2)}A round=${round.id}`);
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
  const nextFrame = countRollFramesSync(config.rollNumber) + 1;
  round = freshRound(round.id + 1, config.rollNumber, nextFrame);
  round.trigger = trigger;
  audioClips = [];
  enter('ENTER_BUFFER');
  return true;
}

/** ACTIVE_30S 内的剧情秒数（已按 TIME_SCALE 还原） */
function activeSec(): number {
  return (Date.now() - phaseStartedAt) / TIME_SCALE / 1000;
}

function onSpeak(ws: WebSocket, mime: string, dataUrl: string, offsetMs: number): void {
  if (state !== 'ACTIVE_30S' && state !== 'FLASH_FREEZE') {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'Audio clip not accepted in this phase' });
  }
  if (typeof dataUrl !== 'string' || dataUrl.length < 100) {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'empty' });
  }
  if (audioClips.length >= TIMELINE.maxAudioClips) {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: `Max ${TIMELINE.maxAudioClips} clips reached this round` });
  }
  const offset = Math.max(0, Math.min(PHASE_SECONDS.ACTIVE_30S * 1000 * TIME_SCALE, Math.round(Number(offsetMs) || 0)));
  // 录音必须开始于 Protocol 01 窗口（04s~16s，容差 0.5s）
  const offsetSec = offset / 1000 / TIME_SCALE;
  if (offsetSec < TIMELINE.station1P1[0] - 0.5 || offsetSec > TIMELINE.station1P1[1] + 0.5) {
    return send(ws, { type: 'ack', what: 'speak', ok: false, message: 'Clip outside the 04s–16s vocal calibration window; ignored' });
  }
  const clip: AudioClip = {
    mime: String(mime || 'audio/webm').slice(0, 80),
    dataUrl,
    offsetMs: offset,
  };
  audioClips.push(clip);
  audioClips.sort((a, b) => a.offsetMs - b.offsetMs);
  round.didSpeak = true;
  round.audioClipCount = audioClips.length;
  round.audioOffsetsMs = audioClips.map((c) => c.offsetMs);
  console.log(
    `[round ${round.id}] 收到校准语音 #${audioClips.length}/${TIMELINE.maxAudioClips} ${(dataUrl.length / 1024).toFixed(0)}KB @${offset}ms`,
  );
  broadcast({ type: 'audio', clip, index: audioClips.length - 1, roundId: round.id }, toRole('main'));
  send(ws, { type: 'ack', what: 'speak', ok: true, message: `Clip ${audioClips.length}/${TIMELINE.maxAudioClips} logged` });
  broadcast(stateMsg());
}

function onBreaker(ws: WebSocket): void {
  if (state !== 'ACTIVE_30S' || round.didPullBreaker) return;
  const t = activeSec();
  if (t < TIMELINE.station2P3[0] - 0.5) {
    return send(ws, { type: 'ack', what: 'breaker', ok: false, message: 'Fixation phase has not started yet' });
  }
  round.didPullBreaker = true;
  round.breakerPulledAtSec = Math.round(t * 1000) / 1000;
  if (t < TIMELINE.breakerSpoilerGuard) {
    // 防提前截断保护：锁定推杆显示 FIXING EXPOSURE...，等到 29.5s 再全局定格
    round.breakerLocked = true;
    schedule(phaseStartedAt + TIMELINE.breakerDelayedFlash * 1000 * TIME_SCALE);
    console.log(`[round ${round.id}] 定影推杆提前拉到底 @${t.toFixed(2)}s → 锁定至 ${TIMELINE.breakerDelayedFlash}s`);
    broadcast({ type: 'breaker', status: 'locked', atSec: round.breakerPulledAtSec });
    broadcast(stateMsg());
  } else {
    console.log(`[round ${round.id}] 定影推杆完成 @${t.toFixed(2)}s → 立即定格`);
    broadcast({ type: 'breaker', status: 'flash', atSec: round.breakerPulledAtSec });
    enter('FLASH_FREEZE');
  }
}

async function onFreeze(ws: WebSocket, data: string): Promise<void> {
  const buf = typeof data === 'string' ? decodeJpeg(data) : null;
  if (!buf) return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Not a valid JPEG' });
  if (round.hasFreeze || freezeSaving) {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame already saved this round' });
  }
  if (state === 'IDLE' || state === 'ENTER_BUFFER' || state === 'ACTIVE_30S') {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame not accepted in this phase' });
  }
  freezeSaving = true;
  try {
    const { photo, archiveName, sheet } = await saveFreeze(buf, round.rollNumber, round.frameNumber, round.id);
    round.hasFreeze = true;
    currentSheet = sheet;
    console.log(`[round ${round.id}] 底片已入档 ${archiveName} (${(buf.length / 1024).toFixed(0)}KB)`);
    send(ws, { type: 'ack', what: 'freeze', ok: true, message: archiveName });
    broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
    broadcast({ type: 'contact-sheet', sheet, serverTime: Date.now() });
    broadcast(stateMsg());
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
      audioClips = [];
      enter('IDLE');
      return send(ws, { type: 'ack', what: 'reset', ok: true, message: 'Reset to IDLE' });

    case 'skipPhase': {
      if (state === 'IDLE') {
        return send(ws, { type: 'ack', what: 'skipPhase', ok: false, message: 'Already in IDLE' });
      }
      const prev = state;
      const next = NEXT[state];
      enter(next);
      return send(ws, { type: 'ack', what: 'skipPhase', ok: true, message: `Skipped ${prev} → ${next}` });
    }

    case 'newRoll': {
      const nextRoll = config.rollNumber + 1;
      config = sanitizeConfig({ ...config, rollNumber: nextRoll }, config);
      try {
        await saveConfig(config);
      } catch (err) {
        console.error('[config] 保存新胶卷号失败', err);
      }
      const photo = await resetDoorPhoto();
      currentSheet = await getContactSheet(config.rollNumber);
      if (state === 'IDLE') {
        round.rollNumber = config.rollNumber;
        round.frameNumber = 1;
      }
      console.log(`[admin] 开启新胶卷 ROLL ${pad(config.rollNumber, 2)}（历史归档完整保留）`);
      broadcast({ type: 'config', config });
      broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
      broadcast({ type: 'contact-sheet', sheet: currentSheet, serverTime: Date.now() });
      broadcast(stateMsg());
      return send(ws, {
        type: 'ack',
        what: 'newRoll',
        ok: true,
        message: `Started Roll ${pad(config.rollNumber, 2)} · contact sheet cleared (archive preserved)`,
      });
    }

    case 'resetDoor': {
      const photo = await resetDoorPhoto();
      broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
      return send(ws, { type: 'ack', what: 'resetDoor', ok: true, message: 'Latest proof cache cleared (archive preserved)' });
    }

    case 'testFlash':
      broadcast({ type: 'flash', serverTime: Date.now() }, toRole('main'));
      return send(ws, { type: 'ack', what: 'testFlash', ok: true, message: 'Test flash sent to main screen' });

    case 'setConfig': {
      // rollNumber 仅由 newRoll 或显式正整数更新
      const merged: Partial<AppConfig> = {
        enterBufferSec: cfg?.enterBufferSec ?? config.enterBufferSec,
        cctvRevealSec: cfg?.cctvRevealSec ?? config.cctvRevealSec,
        rollNumber: cfg?.rollNumber ?? config.rollNumber,
      };
      config = sanitizeConfig(merged, config);
      try {
        await saveConfig(config);
      } catch (err) {
        console.error('[config] 保存失败', err);
      }
      broadcast({ type: 'config', config });
      return send(ws, {
        type: 'ack',
        what: 'setConfig',
        ok: true,
        message: `Saved · Buffer ${config.enterBufferSec}s · CCTV ${config.cctvRevealSec}s`,
      });
    }

    default:
      return send(ws, { type: 'ack', what: action, ok: false, message: 'unknown action' });
  }
}

// ======================================================================
server.listen(PORT, HOST, () => {
  console.log(`《入画三十秒 (RH-30)》v2 服务已启动 http://${HOST}:${PORT}  (TIME_SCALE=${TIME_SCALE}, ROLL=${pad(config.rollNumber, 2)})`);
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
