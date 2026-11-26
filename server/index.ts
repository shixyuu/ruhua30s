/**
 * 《入画三十秒 (RH-30)》v3 统一单端口服务：纯现场活体暗房引擎 + /data + /api + /ws
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
  ContactSheetInfo,
  Phase,
  Role,
  ROLES,
  RoundInfo,
  ServerMsg,
} from '../shared/protocol.js';
import {
  ASSETS_DIR,
  DATA_DIR,
  countRollFramesSync,
  currentForecastArchiveUrl,
  decodeJpeg,
  doorPhotoInfo,
  ensureDirs,
  forecastInfo,
  getContactSheet,
  listArchive,
  loadConfig,
  pad,
  resetDoorPhoto,
  resetForecast,
  sanitizeConfig,
  saveConfig,
  saveForecast,
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
const DEV_TICK_MS = 50;

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
    version: '3.0.0-live-darkroom',
    state,
    clients: clientCounts(),
    round: round.id,
    rollNumber: config.rollNumber,
    timeScale: TIME_SCALE,
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

// /assets：保留静态挂载以兼容现有 Docker volume 配置
const noCache = (res: Response) => res.setHeader('Cache-Control', 'no-cache');
app.use(
  '/assets',
  express.static(ASSETS_DIR, { etag: true, lastModified: true, maxAge: 0, setHeaders: noCache }),
);
app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('asset not found'));

// /data：持久化目录（当前卷对 /door 免 token 开放；历史卷可受 ADMIN_TOKEN 保护）
app.use('/data', (req: Request, res: Response, next: NextFunction) => {
  if (/\.tmp$/i.test(req.path)) return void res.status(404).end();
  if (req.path.startsWith('/archive')) {
    const curPrefix = `/archive/roll-${pad(config.rollNumber, 2)}/`;
    if (!req.path.startsWith(curPrefix) && !tokenOk(req)) {
      return void res.status(401).end();
    }
  }
  if (req.path.startsWith('/forecasts')) {
    const curPrefix = `/forecasts/roll-${pad(config.rollNumber, 2)}/`;
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

// 前端构建产物
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

const isMainOrAdmin = (p: Peer) => p.role === 'main' || p.role === 'admin';

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
  if (peer.role === 'main' || peer.role === 'admin') {
    send(ws, {
      type: 'dev',
      devProgress: round.finalDevProgress ?? round.devProgress,
      audioLevel: latestAudioLevel,
      effLevel: lastEffLevel,
      serverTime: Date.now(),
    });
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
    case 'AUDIO_ENERGY':
      if (peer.role !== 'station1') return;
      return onAudioEnergy(msg.level);
    case 'TRIGGER_FIX':
      if (peer.role !== 'station2') return;
      return onTriggerFix(ws);
    case 'freeze':
      if (peer.role !== 'main') return;
      return void onFreeze(ws, msg.data, msg.forecastData);
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
let state: Phase = 'IDLE';
let phaseStartedAt = Date.now();
let phaseDurationMs = 0;
let phaseTimer: NodeJS.Timeout | null = null;
let devTimer: NodeJS.Timeout | null = null;
let lastDevTick = Date.now();
let latestAudioLevel = 0;
let lastEffLevel = 0;
let lastEnergyAt = 0;
let lastFixedRoundEndAt = 0;
let freezeSaving = false;

function freshRound(id: number, rollNumber: number, frameNumber: number, predictedUrl: string | null = null): RoundInfo {
  return {
    id,
    rollNumber,
    frameNumber,
    printMode: config.printMode,
    devProgress: 0,
    finalDevProgress: null,
    fixTriggeredBy: null,
    hasFreeze: false,
    predictedUrl,
    trigger: null,
  };
}

let round: RoundInfo = freshRound(0, config.rollNumber, countRollFramesSync(config.rollNumber));

function nextPhaseAfter(cur: Phase): Phase {
  switch (cur) {
    case 'ENTER_BUFFER':
      return config.safelightSec <= 0 ? 'EXPOSURE' : 'SAFELIGHT_COMPOSE';
    case 'SAFELIGHT_COMPOSE':
      return 'EXPOSURE';
    case 'EXPOSURE':
      return 'DEVELOPING';
    case 'DEVELOPING':
      return 'FIXED_REVEAL';
    case 'FIXED_REVEAL':
      return 'IDLE';
    case 'IDLE':
    default:
      return 'IDLE';
  }
}

function durationFor(p: Phase): number {
  let sec = 0;
  switch (p) {
    case 'IDLE':
      return 0;
    case 'ENTER_BUFFER':
      sec = config.enterBufferSec;
      break;
    case 'SAFELIGHT_COMPOSE':
      sec = config.safelightSec;
      break;
    case 'EXPOSURE':
      sec = config.exposureSec;
      break;
    case 'DEVELOPING':
      sec = config.maxDevelopSec;
      break;
    case 'FIXED_REVEAL':
      sec = config.revealSec;
      break;
  }
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
    forecast: forecastInfo(config.rollNumber),
  };
}

function stopDevLoop(): void {
  if (devTimer) {
    clearInterval(devTimer);
    devTimer = null;
  }
  latestAudioLevel = 0;
  lastEffLevel = 0;
  lastEnergyAt = 0;
}

function startDevLoop(): void {
  stopDevLoop();
  lastDevTick = Date.now();
  devTimer = setInterval(() => {
    if (state !== 'DEVELOPING') return stopDevLoop();
    const now = Date.now();
    if (now - lastEnergyAt > 400) latestAudioLevel = 0;
    const storyDt = Math.max(0, (now - lastDevTick) / 1000 / TIME_SCALE);
    lastDevTick = now;

    const floor = config.noiseFloor;
    const eff = latestAudioLevel <= floor ? 0 : Math.min(1, (latestAudioLevel - floor) / Math.max(0.05, 1 - floor));
    lastEffLevel = eff;
    round.devProgress = Math.round((round.devProgress + eff * config.devSpeed * storyDt) * 10000) / 10000;

    broadcast(
      {
        type: 'dev',
        devProgress: round.devProgress,
        audioLevel: latestAudioLevel,
        effLevel: eff,
        serverTime: now,
      },
      isMainOrAdmin,
    );
  }, DEV_TICK_MS);
}

function lockDevelopment(by: 'station2' | 'timeout' | 'admin'): void {
  stopDevLoop();
  if (round.finalDevProgress == null) {
    round.finalDevProgress = round.devProgress;
    round.fixTriggeredBy = by;
  }
}

function enter(next: Phase, fixSource: 'station2' | 'timeout' | 'admin' = 'timeout'): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = null;

  const prev = state;
  if (prev === 'DEVELOPING' && next === 'FIXED_REVEAL') {
    lockDevelopment(fixSource);
  } else if (prev === 'DEVELOPING') {
    stopDevLoop();
  }
  if (prev === 'FIXED_REVEAL' && next === 'IDLE') {
    lastFixedRoundEndAt = Date.now();
  }

  state = next;
  phaseStartedAt = Date.now();
  phaseDurationMs = durationFor(next);

  if (next === 'DEVELOPING') {
    round.devProgress = 0;
    round.finalDevProgress = null;
    round.fixTriggeredBy = null;
    startDevLoop();
    broadcast({ type: 'dev', devProgress: 0, audioLevel: 0, effLevel: 0, serverTime: phaseStartedAt }, isMainOrAdmin);
  } else if (next === 'FIXED_REVEAL') {
    broadcast(
      {
        type: 'dev',
        devProgress: round.finalDevProgress ?? round.devProgress,
        audioLevel: 0,
        effLevel: 0,
        serverTime: phaseStartedAt,
      },
      isMainOrAdmin,
    );
  }

  if (phaseDurationMs > 0) schedule(phaseStartedAt + phaseDurationMs);
  console.log(`[state] → ${next} (${phaseDurationMs}ms) roll=${round.rollNumber} frame=${pad(round.frameNumber, 2)}A round=${round.id}`);
  broadcast(stateMsg());
}

function schedule(atMs: number): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  const current = state;
  phaseTimer = setTimeout(() => {
    if (state === current) enter(nextPhaseAfter(current), 'timeout');
  }, Math.max(0, atMs - Date.now()));
}

function tryStart(trigger: string): boolean {
  if (state !== 'IDLE') return false;
  const nextFrame = countRollFramesSync(config.rollNumber);
  const predictedUrl = nextFrame > 0 ? currentForecastArchiveUrl(config.rollNumber) : null;
  round = freshRound(round.id + 1, config.rollNumber, nextFrame, predictedUrl);
  round.trigger = trigger;
  enter('ENTER_BUFFER');
  return true;
}

function onAudioEnergy(rawLevel: number): void {
  const n = Number(rawLevel);
  if (!Number.isFinite(n)) return;
  const level = Math.max(0, Math.min(1, n));
  if (state !== 'DEVELOPING') return;
  latestAudioLevel = level;
  lastEnergyAt = Date.now();
}

function onTriggerFix(ws: WebSocket): void {
  if (state !== 'DEVELOPING') {
    return send(ws, { type: 'ack', what: 'TRIGGER_FIX', ok: false, message: 'Fixation only active during DEVELOPING' });
  }
  console.log(`[round ${round.id}] 定影推杆拉到底 → FIXED_REVEAL (dev=${(round.devProgress * 100).toFixed(1)}%)`);
  enter('FIXED_REVEAL', 'station2');
  send(ws, { type: 'ack', what: 'TRIGGER_FIX', ok: true, message: 'Fixed' });
}

async function onFreeze(ws: WebSocket, data: string, forecastData?: string): Promise<void> {
  const buf = typeof data === 'string' ? decodeJpeg(data) : null;
  if (!buf) return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Not a valid JPEG' });
  if (round.hasFreeze || freezeSaving) {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame already saved this round' });
  }
  const justExitedReveal = state === 'IDLE' && round.id > 0 && Date.now() - lastFixedRoundEndAt < 3000;
  if (state !== 'FIXED_REVEAL' && !justExitedReveal) {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame only accepted in FIXED_REVEAL' });
  }
  freezeSaving = true;
  try {
    const devPct = (round.finalDevProgress ?? round.devProgress) * 100;
    const fBuf = typeof forecastData === 'string' ? decodeJpeg(forecastData) : null;
    if (fBuf) {
      await saveForecast(fBuf, round.rollNumber, round.frameNumber + 1);
    }
    const { photo, archiveName, sheet } = await saveFreeze(buf, round.rollNumber, round.frameNumber, round.id, devPct);
    round.hasFreeze = true;
    currentSheet = sheet;
    console.log(`[round ${round.id}] 底片已入档 ${archiveName} (${(buf.length / 1024).toFixed(0)}KB, dev=${Math.round(devPct)}%${fBuf ? ', forecast updated' : ''})`);
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
      stopDevLoop();
      enter('IDLE');
      return send(ws, { type: 'ack', what: 'reset', ok: true, message: 'Reset to IDLE' });

    case 'skipPhase': {
      if (state === 'IDLE') {
        return send(ws, { type: 'ack', what: 'skipPhase', ok: false, message: 'Already in IDLE' });
      }
      const prev = state;
      const next = nextPhaseAfter(prev);
      enter(next, 'admin');
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
      await resetForecast();
      currentSheet = await getContactSheet(config.rollNumber);
      if (state === 'IDLE') {
        round.rollNumber = config.rollNumber;
        round.frameNumber = 0;
        round.predictedUrl = null;
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
        message: `Started Roll ${pad(config.rollNumber, 2)} · contact sheet & forecast cleared (archive preserved)`,
      });
    }

    case 'resetDoor': {
      const photo = await resetDoorPhoto();
      broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
      return send(ws, { type: 'ack', what: 'resetDoor', ok: true, message: 'Latest proof cache cleared (archive preserved)' });
    }

    case 'testFlash':
      broadcast({ type: 'flash', serverTime: Date.now() }, (p) => p.role === 'main');
      return send(ws, { type: 'ack', what: 'testFlash', ok: true, message: 'Test flash sent to main screen' });

    case 'testDevelop':
      if (state !== 'DEVELOPING') {
        return send(ws, { type: 'ack', what: 'testDevelop', ok: false, message: 'Only available during DEVELOPING' });
      }
      latestAudioLevel = 0.72;
      lastEnergyAt = Date.now() + 1200;
      return send(ws, { type: 'ack', what: 'testDevelop', ok: true, message: 'Developing pulse (+1.5s)' });

    case 'setConfig': {
      const merged: Partial<AppConfig> = {
        enterBufferSec: cfg?.enterBufferSec ?? config.enterBufferSec,
        safelightSec: cfg?.safelightSec ?? config.safelightSec,
        exposureSec: cfg?.exposureSec ?? config.exposureSec,
        maxDevelopSec: cfg?.maxDevelopSec ?? config.maxDevelopSec,
        revealSec: cfg?.revealSec ?? config.revealSec,
        noiseFloor: cfg?.noiseFloor ?? config.noiseFloor,
        devSpeed: cfg?.devSpeed ?? config.devSpeed,
        pastOpacity: cfg?.pastOpacity ?? config.pastOpacity,
        printMode: cfg?.printMode ?? config.printMode,
        rollNumber: cfg?.rollNumber ?? config.rollNumber,
      };
      config = sanitizeConfig(merged, config);
      try {
        await saveConfig(config);
      } catch (err) {
        console.error('[config] 保存失败', err);
      }
      broadcast({ type: 'config', config });
      if (state !== 'FIXED_REVEAL' && round.printMode !== config.printMode) {
        round.printMode = config.printMode;
        broadcast(stateMsg());
      }
      return send(ws, {
        type: 'ack',
        what: 'setConfig',
        ok: true,
        message: `Config saved (${config.printMode === 'photogram_negative' ? 'NEGATIVE' : 'POSITIVE'})`,
      });
    }

    default:
      return send(ws, { type: 'ack', what: action, ok: false, message: 'unknown action' });
  }
}

// ======================================================================
server.listen(PORT, HOST, () => {
  console.log(`《入画三十秒 (RH-30)》v3 活体暗房引擎已启动 http://${HOST}:${PORT}  (TIME_SCALE=${TIME_SCALE}, ROLL=${pad(config.rollNumber, 2)})`);
  console.log(`  data:   ${DATA_DIR}`);
  console.log(`  public: ${PUBLIC_DIR}`);
  if (ADMIN_TOKEN) console.log('  ADMIN_TOKEN 已启用：/admin?token=...');
});

function shutdown(sig: string): void {
  console.log(`收到 ${sig}，正在关闭...`);
  clearInterval(heartbeat);
  clearInterval(adminStatusTimer);
  stopDevLoop();
  for (const ws of peers.keys()) ws.close(1001, 'server shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
