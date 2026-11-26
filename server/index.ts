/**
 * 《入画三十秒 (RH-30)》v3 统一单端口服务：扫码传图彩色暗房精修 + 远程透视标定 + /data + /api + /ws
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  AppConfig,
  CalibrationData,
  ChemicalOutcome,
  ClientMsg,
  ClientStatus,
  PersistedState,
  Phase,
  Role,
  ROLES,
  RoundInfo,
  ServerMsg,
} from '../shared/protocol.js';
import {
  ASSETS_DIR,
  DATA_DIR,
  clearCache,
  computeStorageStats,
  contactSheetFromState,
  decodeJpeg,
  doorPhotoInfo,
  emptyPersistedState,
  ensureDirs,
  listArchive,
  loadCalibration,
  loadConfig,
  loadPersistedState,
  nextFrameNumber,
  pad,
  consumeQueuedPhoto,
  withLiveQueue,
  QueueFullError,
  QUEUE_MAX,
  resetDoorPhoto,
  rollDirName,
  sanitizeConfig,
  saveArchivedFrame,
  saveCalibration,
  saveConfig,
  savePersistedState,
  saveQueuedPhoto,
} from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '../public'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const TIME_SCALE = Math.min(10, Math.max(0.01, Number(process.env.TIME_SCALE || 1) || 1));
const MAX_PAYLOAD = 15 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;
const DEV_TICK_MS = 50;
/** Admin DETECT VIEW auto-expires so /main stops streaming if the admin tab is closed */
const DETECT_VIEW_TTL_MS = 10 * 60_000;
let detectViewOn = false;
let lastReref: Extract<ServerMsg, { type: 'REREF_EVENT' }> | null = null;
let detectViewUntil = 0;
const detectViewTimer = setInterval(() => {
  if (detectViewOn && Date.now() > detectViewUntil) {
    detectViewOn = false;
    broadcast({ type: 'DETECT_VIEW', on: false }, (p) => p.role === 'main' || p.role === 'admin');
  }
}, 5000);

ensureDirs();
let config: AppConfig = loadConfig();
let persisted: PersistedState = loadPersistedState(config.rollNumber);
let calibration: CalibrationData = loadCalibration();
if (persisted.rollNumber !== config.rollNumber) {
  config = sanitizeConfig({ ...config, rollNumber: persisted.rollNumber }, config);
  void saveConfig(config);
}

// ======================================================================
// HTTP
// ======================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));

function tokenOk(req: Request): boolean {
  if (!ADMIN_TOKEN) return true;
  const t = (req.query.token as string) || req.get('x-admin-token') || (req.body?.token as string) || '';
  return t === ADMIN_TOKEN;
}

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: '3.2.0-color-dodge',
    state,
    clients: clientCounts(),
    round: round.id,
    rollNumber: config.rollNumber,
    hasQueuedPhoto: withLiveQueue(persisted).hasQueuedPhoto,
    queueLength: withLiveQueue(persisted).queueLength,
    queueMax: QUEUE_MAX,
    timeScale: TIME_SCALE,
    uptime: Math.round(process.uptime()),
    serverTime: Date.now(),
  });
});

app.get('/api/state', async (_req, res) => {
  persisted = withLiveQueue(persisted);
  const storage = await computeStorageStats(persisted);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    config,
    state: persisted,
    calibration,
    storage,
    phase: state,
    serverTime: Date.now(),
  });
});

app.get('/api/contact-sheet', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, sheet: contactSheetFromState(persisted) });
});

app.get('/api/calibration', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, calibration });
});

app.post('/api/calibration', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  const { corners, hInv } = req.body || {};
  calibration = await saveCalibration({ corners: corners ?? null, hInv: hInv ?? null, updatedAt: Date.now() });
  broadcast({ type: 'calibration', calibration });
  console.log('[calibration] 透视标定矩阵已保存');
  res.json({ ok: true, calibration });
});

app.post('/api/upload', async (req, res) => {
  const { imageData } = req.body || {};
  const buf = decodeJpeg(imageData);
  if (!buf) return void res.status(400).json({ ok: false, error: 'Invalid JPEG photo' });
  try {
    persisted = await saveQueuedPhoto(persisted, buf);
  } catch (err) {
    if (err instanceof QueueFullError) {
      return void res.status(429).json({
        ok: false,
        error: 'queue_full',
        message: `The darkroom queue is full (${QUEUE_MAX} photos). Please try again in a few minutes.`,
        queueLength: QUEUE_MAX,
        queueMax: QUEUE_MAX,
      });
    }
    console.error('[upload] save failed', err);
    return void res.status(500).json({ ok: false, error: 'Upload failed' });
  }
  await broadcastSync();
  console.log(`[upload] 观众已上传照片至队列 (${(buf.length / 1024).toFixed(0)}KB, queue ${persisted.queueLength}/${QUEUE_MAX})`);
  res.json({ ok: true, queuedPhotoUrl: persisted.queuedPhotoUrl, queueLength: persisted.queueLength, queueMax: QUEUE_MAX });
});

app.get('/api/archive', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  const rollParam = req.query.roll === 'current' ? config.rollNumber : req.query.roll ? Number(req.query.roll) : null;
  const rollFilter = rollParam != null && Number.isFinite(rollParam) ? rollParam : null;
  const items = await listArchive(rollFilter);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rollNumber: config.rollNumber, count: items.length, items });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, config });
});

app.post('/api/roll/new', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  await performNewRoll();
  const storage = await computeStorageStats(persisted);
  res.json({ ok: true, config, state: persisted, storage });
});

app.post('/api/cache/clear', async (req, res) => {
  if (!tokenOk(req)) return void res.status(401).json({ ok: false, error: 'unauthorized' });
  const mode = req.body?.mode === 'all' ? 'all' : 'runtime';
  stopDevLoop();
  enter('IDLE');
  const cleared = await clearCache(mode, config, persisted);
  config = cleared.config;
  persisted = cleared.state;
  round = freshRound(round.id, config.rollNumber, nextFrameNumber(persisted));
  await broadcastSync();
  broadcast({ type: 'config', config });
  const storage = await computeStorageStats(persisted);
  console.log(`[cache] 清理完成 mode=${mode} (roll=${config.rollNumber})`);
  res.json({ ok: true, mode, config, state: persisted, storage });
});

// /assets
const noCache = (res: Response) => res.setHeader('Cache-Control', 'no-cache');
app.use('/assets', express.static(ASSETS_DIR, { etag: true, lastModified: true, maxAge: 0, setHeaders: noCache }));
app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('asset not found'));

// /data
app.use('/data', (req: Request, res: Response, next: NextFunction) => {
  if (/\.tmp$/i.test(req.path)) return void res.status(404).end();
  if (req.path.startsWith('/rolls')) {
    const curPrefix = `/rolls/${rollDirName(config.rollNumber)}/`;
    if (!req.path.startsWith(curPrefix) && !tokenOk(req)) {
      return void res.status(401).end();
    }
  }
  next();
});
app.use(
  '/data',
  express.static(DATA_DIR, { etag: true, lastModified: true, maxAge: 0, dotfiles: 'deny', setHeaders: noCache }),
);
app.use('/data', (_req, res) => res.status(404).type('text/plain').send('not found'));

// Frontend build
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
      .send('Frontend not built yet: run npm run build first');
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

const isDevSubscriber = (p: Peer) => p.role === 'main' || p.role === 'admin' || p.role === 'station2';

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

async function broadcastSync(): Promise<void> {
  persisted = withLiveQueue(persisted);
  const storage = await computeStorageStats(persisted);
  broadcast({ type: 'door-photo', photo: doorPhotoInfo(), serverTime: Date.now() });
  broadcast({ type: 'contact-sheet', sheet: contactSheetFromState(persisted), serverTime: Date.now() });
  broadcast({ type: 'STATE_SYNC', persisted, storage, serverTime: Date.now() });
  broadcast(stateMsg());
}

function touch(p: Peer): void {
  p.alive = true;
  p.lastSeen = Date.now();
  if (p.role) lastSeenByRole[p.role] = p.lastSeen;
}

const heartbeat = setInterval(() => {
  for (const [ws, p] of peers) {
    if (!p.alive) {
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
    pushClients();
  });
  ws.on('error', () => {});
});

async function sendFullSync(ws: WebSocket, peer: Peer): Promise<void> {
  persisted = withLiveQueue(persisted);
  send(ws, { type: 'time', clientTime: 0, serverTime: Date.now() });
  send(ws, stateMsg());
  send(ws, { type: 'config', config });
  send(ws, { type: 'calibration', calibration });
  if (detectViewOn && (peer.role === 'main' || peer.role === 'admin')) send(ws, { type: 'DETECT_VIEW', on: true });
  if (lastReref && peer.role === 'admin') send(ws, lastReref);
  send(ws, { type: 'door-photo', photo: doorPhotoInfo(), serverTime: Date.now() });
  send(ws, { type: 'contact-sheet', sheet: contactSheetFromState(persisted), serverTime: Date.now() });
  const storage = await computeStorageStats(persisted);
  send(ws, { type: 'STATE_SYNC', persisted, storage, serverTime: Date.now() });
  if (peer.role === 'admin') send(ws, { type: 'clients', clients: clientStatuses(), serverTime: Date.now() });
  if (peer.role === 'main' || peer.role === 'admin' || peer.role === 'station2') {
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
        return send(ws, { type: 'ack', what: 'START_SESSION', ok: false, message: 'Only /admin can start a session' });
      }
      const ok = tryStart('admin');
      return send(ws, {
        type: 'ack',
        what: 'START_SESSION',
        ok,
        message: ok
          ? `Session started · Roll ${pad(round.rollNumber, 2)} Frame ${pad(round.frameNumber, 2)}A`
          : `Current state is ${state}; can only start from IDLE`,
      });
    }
    case 'ENTER_CALIBRATION': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        return send(ws, { type: 'ack', what: 'ENTER_CALIBRATION', ok: false, message: 'Unauthorized' });
      }
      if (state !== 'IDLE') {
        return send(ws, { type: 'ack', what: 'ENTER_CALIBRATION', ok: false, message: `Busy (${state})` });
      }
      enter('CALIBRATING');
      return send(ws, { type: 'ack', what: 'ENTER_CALIBRATION', ok: true, message: 'Calibration target on /main' });
    }
    case 'EXIT_CALIBRATION': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        return send(ws, { type: 'ack', what: 'EXIT_CALIBRATION', ok: false, message: 'Unauthorized' });
      }
      if (state === 'CALIBRATING') enter('IDLE');
      return send(ws, { type: 'ack', what: 'EXIT_CALIBRATION', ok: true, message: 'Exited calibration' });
    }
    case 'REQUEST_SNAPSHOT': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) return;
      broadcast({ type: 'REQUEST_SNAPSHOT' }, (p) => p.role === 'main');
      return send(ws, { type: 'ack', what: 'REQUEST_SNAPSHOT', ok: true, message: 'Snapshot requested from /main' });
    }
    case 'DETECT_VIEW': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) return;
      detectViewOn = !!msg.on;
      detectViewUntil = detectViewOn ? Date.now() + DETECT_VIEW_TTL_MS : 0;
      broadcast({ type: 'DETECT_VIEW', on: detectViewOn, reref: !!msg.reref }, (p) => p.role === 'main' || p.role === 'admin');
      return;
    }
    case 'REREF_EVENT': {
      if (peer.role !== 'main') return;
      const reason = String(msg.reason ?? '').slice(0, 120);
      const kind = msg.kind === 'preview' ? 'preview' : 'round';
      const frames = Math.max(0, Math.min(99, Number(msg.frames) || 0));
      console.log(`[reref] ${kind === 'round' ? 'round clean plate' : 'preview reference'} captured (${frames} frame${frames === 1 ? '' : 's'}) · ${reason}`);
      lastReref = { type: 'REREF_EVENT', kind, reason, frames, ts: Date.now() };
      broadcast(lastReref, (p) => p.role === 'admin');
      return;
    }
    case 'DETECT_FRAME': {
      if (peer.role !== 'main' || !detectViewOn) return;
      if (typeof msg.imageData !== 'string' || msg.imageData.length > 400_000) return;
      broadcast({ type: 'DETECT_FRAME', imageData: msg.imageData, stats: msg.stats, ts: Date.now() }, (p) => p.role === 'admin');
      return;
    }
    case 'SNAPSHOT_DATA': {
      if (peer.role !== 'main') return;
      broadcast({ type: 'SNAPSHOT_READY', imageData: msg.imageData, ts: Date.now() }, (p) => p.role === 'admin');
      return;
    }
    case 'TEST_FLASH': {
      if (peer.role !== 'admin' || !(peer.isAdmin || (ADMIN_TOKEN && msg.token === ADMIN_TOKEN))) {
        return send(ws, { type: 'ack', what: 'TEST_FLASH', ok: false, message: 'Not authorised (ADMIN_TOKEN)' });
      }
      broadcast({ type: 'FLASH_PULSE', durationMs: 260, ts: Date.now() });
      return send(ws, { type: 'ack', what: 'TEST_FLASH', ok: true, message: 'Flash pulse sent to all screens' });
    }
    case 'AUDIO_ENERGY':
      if (peer.role !== 'station1') return;
      return onAudioEnergy(msg.level);
    case 'TRIGGER_FIX':
      if (peer.role !== 'station2') return;
      return onTriggerFix(ws);
    case 'freeze':
      if (peer.role !== 'main') return;
      return void onFreeze(ws, msg.data);
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

function freshRound(
  id: number,
  rollNumber: number,
  frameNumber: number,
  sourceUrl: string | null = null,
  sampleIndex = 0,
): RoundInfo {
  return {
    id,
    rollNumber,
    frameNumber,
    sourceUrl,
    sampleIndex,
    devProgress: 0,
    finalDevProgress: null,
    fixTriggeredBy: null,
    outcome: null,
    hasFreeze: false,
    trigger: null,
  };
}

let round: RoundInfo = freshRound(0, config.rollNumber, nextFrameNumber(persisted));

function nextPhaseAfter(cur: Phase): Phase {
  switch (cur) {
    case 'CAPTURE_CLEAN':
      return 'OBSERVE';
    case 'OBSERVE':
      return 'EXPOSE';
    case 'EXPOSE':
      return 'DEVELOP';
    case 'DEVELOP':
      return round.devProgress >= 0.25 ? 'LIGHT_LEAK' : 'REVEAL';
    case 'LIGHT_LEAK':
      return 'REVEAL';
    case 'REVEAL':
      return 'IDLE';
    case 'CALIBRATING':
    case 'IDLE':
    default:
      return 'IDLE';
  }
}

function durationFor(p: Phase): number {
  let sec = 0;
  switch (p) {
    case 'IDLE':
    case 'CALIBRATING':
      return 0;
    case 'CAPTURE_CLEAN':
      sec = 1.6; // new image shown -> camera settle (~0.5s) -> average clean frames
      break;
    case 'OBSERVE':
      sec = config.observeSec;
      break;
    case 'EXPOSE':
      sec = config.exposeSec;
      break;
    case 'DEVELOP':
      sec = config.developSec;
      break;
    case 'LIGHT_LEAK':
      sec = 2.2;
      break;
    case 'REVEAL':
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
    if (state !== 'DEVELOP') return stopDevLoop();
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
      isDevSubscriber,
    );
  }, DEV_TICK_MS);
}

function classifyOutcome(dev: number, by: 'station2' | 'timeout' | 'admin'): ChemicalOutcome {
  if (by === 'timeout' && dev >= 0.25) return 'UNFIXED_LIGHT_LEAK';
  if (dev < 0.25) return 'UNDERDEVELOPED_TRACE_LOST';
  if (dev > 1.05) return 'OVERDEVELOPED_BURNED';
  return 'FIXED_OPTIMAL';
}

function lockDevelopment(by: 'station2' | 'timeout' | 'admin'): void {
  stopDevLoop();
  if (round.finalDevProgress == null) {
    round.finalDevProgress = round.devProgress;
    round.fixTriggeredBy = by;
    round.outcome = classifyOutcome(round.devProgress, by);
  }
}

function enter(next: Phase, fixSource: 'station2' | 'timeout' | 'admin' = 'timeout'): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = null;

  const prev = state;
  if (prev === 'DEVELOP' && (next === 'REVEAL' || next === 'LIGHT_LEAK')) {
    lockDevelopment(next === 'LIGHT_LEAK' ? 'timeout' : fixSource);
  } else if (prev === 'DEVELOP') {
    stopDevLoop();
  }
  if (prev === 'REVEAL' && next === 'IDLE') {
    lastFixedRoundEndAt = Date.now();
    // Privacy: ensure user's uploaded original photo is permanently deleted after round ends
    if (round.sampleIndex === 0 && round.sourceUrl) {
      void consumeQueuedPhoto(persisted, round.sourceUrl).then((nextSt) => {
        persisted = nextSt;
        void broadcastSync();
      });
    }
  }

  state = next;
  phaseStartedAt = Date.now();
  phaseDurationMs = durationFor(next);

  if (next === 'DEVELOP') {
    round.devProgress = 0;
    round.finalDevProgress = null;
    round.fixTriggeredBy = null;
    round.outcome = null;
    startDevLoop();
    broadcast({ type: 'dev', devProgress: 0, audioLevel: 0, effLevel: 0, serverTime: phaseStartedAt }, isDevSubscriber);
  } else if (next === 'LIGHT_LEAK' || next === 'REVEAL') {
    broadcast(
      {
        type: 'dev',
        devProgress: round.finalDevProgress ?? round.devProgress,
        audioLevel: 0,
        effLevel: 0,
        serverTime: phaseStartedAt,
      },
      isDevSubscriber,
    );
  }

  if (phaseDurationMs > 0) schedule(phaseStartedAt + phaseDurationMs);
  console.log(`[state] → ${next} (${phaseDurationMs}ms) roll=${round.rollNumber} frame=${pad(round.frameNumber, 2)}A round=${round.id}${round.outcome ? ` outcome=${round.outcome}` : ''}`);
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
  persisted = withLiveQueue(persisted);
  const nextFrame = nextFrameNumber(persisted);
  let sourceUrl: string | null = null;
  let sampleIndex = 0;

  if (config.sampleFallback > 0) {
    sampleIndex = config.sampleFallback;
    if (sampleIndex === 7 && persisted.latestFrameUrl) {
      sourceUrl = persisted.latestFrameUrl;
    }
  } else if (persisted.hasQueuedPhoto && persisted.queuedPhotoUrl) {
    sourceUrl = persisted.queuedPhotoUrl;
    sampleIndex = 0;
  } else {
    // Fallback gracefully to sample 1 if nothing queued
    sampleIndex = 1;
  }

  round = freshRound(round.id + 1, config.rollNumber, nextFrame, sourceUrl, sampleIndex);
  round.trigger = trigger;
  enter('CAPTURE_CLEAN');
  return true;
}

function onAudioEnergy(rawLevel: number): void {
  const n = Number(rawLevel);
  if (!Number.isFinite(n)) return;
  const level = Math.max(0, Math.min(1, n));
  if (state !== 'DEVELOP') return;
  latestAudioLevel = level;
  lastEnergyAt = Date.now();
}

function onTriggerFix(ws: WebSocket): void {
  if (state !== 'DEVELOP') {
    return send(ws, { type: 'ack', what: 'TRIGGER_FIX', ok: false, message: 'Fixation only active during DEVELOP' });
  }
  console.log(`[round ${round.id}] 定影推杆拉到底 → REVEAL (dev=${(round.devProgress * 100).toFixed(1)}%)`);
  enter('REVEAL', 'station2');
  send(ws, { type: 'ack', what: 'TRIGGER_FIX', ok: true, message: 'Fixed' });
}

async function onFreeze(ws: WebSocket, data: string): Promise<void> {
  const buf = typeof data === 'string' ? decodeJpeg(data) : null;
  if (!buf) return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Not a valid JPEG' });
  if (round.hasFreeze || freezeSaving) {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame already saved this round' });
  }
  const justExitedReveal = state === 'IDLE' && round.id > 0 && Date.now() - lastFixedRoundEndAt < 3000;
  if (state !== 'REVEAL' && !justExitedReveal) {
    return send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Freeze frame only accepted in REVEAL' });
  }
  freezeSaving = true;
  try {
    const devPct = (round.finalDevProgress ?? round.devProgress) * 100;
    const saved = await saveArchivedFrame(
      persisted,
      round.frameNumber,
      buf,
      devPct,
      round.outcome ?? 'FIXED_OPTIMAL',
    );
    persisted = saved.next;
    round.hasFreeze = true;
    // Immediately purge user's uploaded original photo once final print is archived
    if (round.sampleIndex === 0 && round.sourceUrl) {
      persisted = await consumeQueuedPhoto(persisted, round.sourceUrl);
    }
    console.log(`[round ${round.id}] 彩色暗房成品已入档 ${saved.archiveName} (${(buf.length / 1024).toFixed(0)}KB, dev=${Math.round(devPct)}%, outcome=${round.outcome ?? 'FIXED_OPTIMAL'})`);
    send(ws, { type: 'ack', what: 'freeze', ok: true, message: saved.archiveName });
    await broadcastSync();
  } catch (err) {
    console.error('[freeze] 保存失败', err);
    send(ws, { type: 'ack', what: 'freeze', ok: false, message: 'Save failed' });
  } finally {
    freezeSaving = false;
  }
}

async function performNewRoll(): Promise<void> {
  const nextRoll = config.rollNumber + 1;
  config = sanitizeConfig({ ...config, rollNumber: nextRoll }, config);
  try {
    await saveConfig(config);
  } catch (err) {
    console.error('[config] 保存新胶卷号失败', err);
  }
  await resetDoorPhoto();
  persisted = withLiveQueue(emptyPersistedState(config.rollNumber));
  await savePersistedState(persisted);
  if (state === 'IDLE') {
    round = freshRound(round.id, config.rollNumber, 1);
  }
  console.log(`[admin] 开启新胶卷 ROLL ${pad(config.rollNumber, 2)}（历史卷完整保留）`);
  broadcast({ type: 'config', config });
  await broadcastSync();
}

async function onAdmin(ws: WebSocket, action: string, cfg?: Partial<AppConfig>): Promise<void> {
  switch (action) {
    case 'reset':
      stopDevLoop();
      enter('IDLE');
      return send(ws, { type: 'ack', what: 'reset', ok: true, message: 'Reset to IDLE' });

    case 'skipPhase': {
      if (state === 'IDLE') return send(ws, { type: 'ack', what: 'skipPhase', ok: false, message: 'Already in IDLE' });
      const prev = state;
      const next = nextPhaseAfter(prev);
      enter(next, 'admin');
      return send(ws, { type: 'ack', what: 'skipPhase', ok: true, message: `Skipped ${prev} → ${next}` });
    }

    case 'newRoll': {
      await performNewRoll();
      return send(ws, { type: 'ack', what: 'newRoll', ok: true, message: `Started Roll ${pad(config.rollNumber, 2)}` });
    }

    case 'resetDoor': {
      const photo = await resetDoorPhoto();
      broadcast({ type: 'door-photo', photo, serverTime: Date.now() });
      return send(ws, { type: 'ack', what: 'resetDoor', ok: true, message: 'Latest proof cache cleared' });
    }

    case 'testFlash':
      broadcast({ type: 'FLASH_PULSE', durationMs: 260, ts: Date.now() });
      return send(ws, { type: 'ack', what: 'testFlash', ok: true, message: 'Flash pulse sent to all screens' });

    case 'testDevelop':
      if (state !== 'DEVELOP') return send(ws, { type: 'ack', what: 'testDevelop', ok: false, message: 'Only available during DEVELOP' });
      latestAudioLevel = 0.72;
      lastEnergyAt = Date.now() + 1200;
      return send(ws, { type: 'ack', what: 'testDevelop', ok: true, message: 'Developing pulse (+1.5s)' });

    case 'setConfig': {
      const merged: Partial<AppConfig> = {
        observeSec: cfg?.observeSec ?? config.observeSec,
        exposeSec: cfg?.exposeSec ?? config.exposeSec,
        developSec: cfg?.developSec ?? config.developSec,
        revealSec: cfg?.revealSec ?? config.revealSec,
        noiseFloor: cfg?.noiseFloor ?? config.noiseFloor,
        devSpeed: cfg?.devSpeed ?? config.devSpeed,
        easelMargin: cfg?.easelMargin ?? config.easelMargin,
        diffSensitivity: cfg?.diffSensitivity ?? config.diffSensitivity,
        detectBlur: cfg?.detectBlur ?? config.detectBlur,
        detectMinArea: cfg?.detectMinArea ?? config.detectMinArea,
        fullDodgeSec: cfg?.fullDodgeSec ?? config.fullDodgeSec,
        mouseSimulator: cfg?.mouseSimulator ?? config.mouseSimulator,
        sampleFallback: cfg?.sampleFallback ?? config.sampleFallback,
        rollNumber: cfg?.rollNumber ?? config.rollNumber,
      };
      config = sanitizeConfig(merged, config);
      try {
        await saveConfig(config);
      } catch (err) {
        console.error('[config] 保存失败', err);
      }
      broadcast({ type: 'config', config });
      return send(ws, { type: 'ack', what: 'setConfig', ok: true, message: 'Config saved' });
    }

    default:
      return send(ws, { type: 'ack', what: action, ok: false, message: 'unknown action' });
  }
}

server.listen(PORT, HOST, () => {
  console.log(`《入画三十秒 (RH-30)》v3.2 彩色暗房精修引擎已启动 http://${HOST}:${PORT} (TIME_SCALE=${TIME_SCALE}, ROLL=${pad(config.rollNumber, 2)})`);
  console.log(`  data:   ${DATA_DIR}`);
  console.log(`  public: ${PUBLIC_DIR}`);
  if (ADMIN_TOKEN) console.log('  ADMIN_TOKEN 已启用：/admin?token=...');
});

function shutdown(_sig: string): void {
  clearInterval(heartbeat);
  clearInterval(adminStatusTimer);
  clearInterval(detectViewTimer);
  stopDevLoop();
  for (const ws of peers.keys()) ws.close(1001, 'server shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
