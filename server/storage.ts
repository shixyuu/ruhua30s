import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppConfig,
  CONFIG_BOUNDS,
  CalibrationData,
  ChemicalOutcome,
  ContactFrame,
  ContactSheetInfo,
  DEFAULT_CONFIG,
  DoorPhotoInfo,
  PersistedState,
  QueuedPhoto,
  Point2D,
  StorageStats,
  outcomeShortCode,
} from '../shared/protocol.js';

export const ROOT_DIR = process.cwd();
export const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(ROOT_DIR, 'assets'));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const ROLLS_DIR = path.join(DATA_DIR, 'rolls');
export const QUEUE_DIR = path.join(DATA_DIR, 'queue');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CALIBRATION_FILE = path.join(DATA_DIR, 'calibration.json');
const DOOR_FILE = path.join(DATA_DIR, 'latest-door.jpg');
/** Max photos waiting in the upload queue (env QUEUE_MAX, default 10) */
export const QUEUE_MAX = Math.max(1, Math.min(100, Math.floor(Number(process.env.QUEUE_MAX) || 10)));

export function ensureDirs(): void {
  for (const d of [ASSETS_DIR, DATA_DIR, ROLLS_DIR, QUEUE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export function pad(n: number, w = 2): string {
  return String(Math.max(0, Math.floor(n))).padStart(w, '0');
}

export function rollDirName(rollNumber: number): string {
  return `roll_${pad(rollNumber, 2)}`;
}

export function rollDirPath(rollNumber: number): string {
  return path.join(ROLLS_DIR, rollDirName(rollNumber));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

let tmpSeq = 0;
const tmpName = (file: string) => `${file}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

function atomicWriteJsonSync(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = tmpName(file);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[storage] write ${path.basename(file)} failed`, err);
  }
}

export function sanitizeConfig(input: Partial<AppConfig> | undefined, base: AppConfig): AppConfig {
  const src = input || {};
  return {
    observeSec: round1(
      clamp(src.observeSec ?? base.observeSec, CONFIG_BOUNDS.observeSec.min, CONFIG_BOUNDS.observeSec.max, base.observeSec),
    ),
    exposeSec: round1(
      clamp(src.exposeSec ?? base.exposeSec, CONFIG_BOUNDS.exposeSec.min, CONFIG_BOUNDS.exposeSec.max, base.exposeSec),
    ),
    developSec: round1(
      clamp(src.developSec ?? base.developSec, CONFIG_BOUNDS.developSec.min, CONFIG_BOUNDS.developSec.max, base.developSec),
    ),
    revealSec: round1(
      clamp(src.revealSec ?? base.revealSec, CONFIG_BOUNDS.revealSec.min, CONFIG_BOUNDS.revealSec.max, base.revealSec),
    ),
    noiseFloor: round3(
      clamp(src.noiseFloor ?? base.noiseFloor, CONFIG_BOUNDS.noiseFloor.min, CONFIG_BOUNDS.noiseFloor.max, base.noiseFloor),
    ),
    devSpeed: round3(
      clamp(src.devSpeed ?? base.devSpeed, CONFIG_BOUNDS.devSpeed.min, CONFIG_BOUNDS.devSpeed.max, base.devSpeed),
    ),
    easelMargin: Math.round(
      clamp(src.easelMargin ?? base.easelMargin, CONFIG_BOUNDS.easelMargin.min, CONFIG_BOUNDS.easelMargin.max, base.easelMargin),
    ),
    diffSensitivity: round3(
      clamp(
        src.diffSensitivity ?? base.diffSensitivity,
        CONFIG_BOUNDS.diffSensitivity.min,
        CONFIG_BOUNDS.diffSensitivity.max,
        base.diffSensitivity,
      ),
    ),
    detectBlur: Math.round(
      clamp(src.detectBlur ?? base.detectBlur, CONFIG_BOUNDS.detectBlur.min, CONFIG_BOUNDS.detectBlur.max, base.detectBlur),
    ),
    detectMinArea: round1(
      clamp(src.detectMinArea ?? base.detectMinArea, CONFIG_BOUNDS.detectMinArea.min, CONFIG_BOUNDS.detectMinArea.max, base.detectMinArea),
    ),
    fullDodgeSec: round1(
      clamp(src.fullDodgeSec ?? base.fullDodgeSec, CONFIG_BOUNDS.fullDodgeSec.min, CONFIG_BOUNDS.fullDodgeSec.max, base.fullDodgeSec),
    ),
    mouseSimulator: typeof src.mouseSimulator === 'boolean' ? src.mouseSimulator : base.mouseSimulator,
    sampleFallback: (() => {
      const s = typeof src.sampleFallback === 'number' ? src.sampleFallback : Number(src.sampleFallback);
      return Number.isFinite(s) ? Math.max(0, Math.min(7, Math.floor(s))) : base.sampleFallback;
    })(),
    rollNumber: (() => {
      const r = typeof src.rollNumber === 'number' ? src.rollNumber : Number(src.rollNumber);
      return Number.isFinite(r) && r >= 1 ? Math.floor(r) : Math.max(1, Math.floor(base.rollNumber || 1));
    })(),
  };
}

function detectHighestRollOnDisk(): number {
  let maxRoll = 1;
  try {
    for (const e of fs.readdirSync(ROLLS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = /^roll[_-](\d+)$/i.exec(e.name);
      if (m) maxRoll = Math.max(maxRoll, Number(m[1]) || 1);
    }
  } catch {
    /* ignore */
  }
  return maxRoll;
}

export function loadConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const fallback: AppConfig = {
      ...DEFAULT_CONFIG,
      rollNumber: Math.max(DEFAULT_CONFIG.rollNumber, detectHighestRollOnDisk()),
    };
    const cfg = sanitizeConfig(raw, fallback);
    fs.mkdirSync(rollDirPath(cfg.rollNumber), { recursive: true });
    atomicWriteJsonSync(CONFIG_FILE, cfg);
    return cfg;
  } catch {
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      rollNumber: detectHighestRollOnDisk(),
    };
    fs.mkdirSync(rollDirPath(cfg.rollNumber), { recursive: true });
    atomicWriteJsonSync(CONFIG_FILE, cfg);
    return cfg;
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await fsp.mkdir(rollDirPath(cfg.rollNumber), { recursive: true });
  await atomicWriteJson(CONFIG_FILE, cfg);
}

// Calibration persistence (./data/calibration.json)
export function loadCalibration(): CalibrationData {
  try {
    const raw = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')) as Partial<CalibrationData>;
    const corners =
      Array.isArray(raw.corners) && raw.corners.length === 4
        ? (raw.corners as [Point2D, Point2D, Point2D, Point2D])
        : null;
    const hInv = Array.isArray(raw.hInv) && raw.hInv.length === 9 ? raw.hInv.map(Number) : null;
    return { corners, hInv, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null };
  } catch {
    return { corners: null, hInv: null, updatedAt: null };
  }
}

export async function saveCalibration(data: CalibrationData): Promise<CalibrationData> {
  const clean: CalibrationData = {
    corners: data.corners ?? null,
    hInv: Array.isArray(data.hInv) && data.hInv.length === 9 ? data.hInv.map(Number) : null,
    updatedAt: Date.now(),
  };
  await atomicWriteJson(CALIBRATION_FILE, clean);
  return clean;
}

// state.json persistence
export function emptyPersistedState(rollNumber: number): PersistedState {
  return {
    rollNumber,
    frames: [],
    latestFrameUrl: null,
    hasQueuedPhoto: false,
    queuedPhotoUrl: null,
    queuedAt: null,
    queue: [],
    queueLength: 0,
    queueMax: QUEUE_MAX,
  };
}

/** Recompute queue head / length fields from st.queue */
function withQueue(st: PersistedState, queue: QueuedPhoto[]): PersistedState {
  const head = queue[0] ?? null;
  return {
    ...st,
    queue,
    queueLength: queue.length,
    queueMax: QUEUE_MAX,
    hasQueuedPhoto: !!head,
    queuedPhotoUrl: head ? head.url : null,
    queuedAt: head ? head.at : null,
  };
}

/** Authoritative in-memory queue (mutated synchronously, so concurrent uploads/rounds never lose entries) */
let liveQueue: QueuedPhoto[] = [];

/** Merge the authoritative queue into any state object before use/broadcast */
export function withLiveQueue(st: PersistedState): PersistedState {
  return withQueue(st, liveQueue);
}

let queueSeq = 0;
function queueFileName(ts: number): string {
  return `${ts}-${(++queueSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`;
}

/** Keep only queue entries whose files exist; migrate a legacy next.jpg into the queue */
function loadQueueSync(raw: Partial<PersistedState>): QueuedPhoto[] {
  const list: QueuedPhoto[] = Array.isArray(raw.queue)
    ? raw.queue.filter(
        (q): q is QueuedPhoto =>
          !!q && typeof q.file === 'string' && /^[\w.-]+\.jpg$/.test(q.file) && fs.existsSync(path.join(QUEUE_DIR, q.file)),
      )
    : [];
  const legacy = path.join(QUEUE_DIR, 'next.jpg');
  if (fs.existsSync(legacy)) {
    try {
      const at = typeof raw.queuedAt === 'number' ? raw.queuedAt : Math.floor(fs.statSync(legacy).mtimeMs);
      const file = queueFileName(at);
      fs.renameSync(legacy, path.join(QUEUE_DIR, file));
      list.push({ file, url: `/data/queue/${file}`, at });
      console.log(`[queue] migrated legacy next.jpg -> ${file}`);
    } catch (err) {
      console.error('[queue] legacy next.jpg migration failed', err);
    }
  }
  return list.sort((a, b) => a.at - b.at).slice(0, Math.max(QUEUE_MAX, list.length));
}

export function loadPersistedState(rollNumber: number): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<PersistedState>;
    const rNo = typeof raw.rollNumber === 'number' && raw.rollNumber >= 1 ? Math.floor(raw.rollNumber) : rollNumber;
    const st: PersistedState = withQueue(
      {
        ...emptyPersistedState(rNo),
        ...raw,
        rollNumber: rNo,
        frames: Array.isArray(raw.frames) ? raw.frames : [],
      },
      (liveQueue = loadQueueSync(raw)),
    );
    atomicWriteJsonSync(STATE_FILE, st);
    return st;
  } catch {
    const st = withQueue(emptyPersistedState(rollNumber), (liveQueue = loadQueueSync({})));
    atomicWriteJsonSync(STATE_FILE, st);
    return st;
  }
}

export async function savePersistedState(st: PersistedState): Promise<void> {
  await atomicWriteJson(STATE_FILE, withQueue(st, liveQueue));
}

// JPEG decode, Queue management & Roll archiving
export function decodeJpeg(data: string): Buffer | null {
  if (typeof data !== 'string') return null;
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

export class QueueFullError extends Error {}

/** Append an uploaded photo to the FIFO queue (throws QueueFullError when QUEUE_MAX reached) */
export async function saveQueuedPhoto(st: PersistedState, buf: Buffer): Promise<PersistedState> {
  if (liveQueue.length >= QUEUE_MAX) throw new QueueFullError(`Queue full (${QUEUE_MAX})`);
  const ts = Date.now();
  const file = queueFileName(ts);
  const entry: QueuedPhoto = { file, url: `/data/queue/${file}`, at: ts };
  liveQueue = [...liveQueue, entry]; // reserve the slot synchronously
  try {
    await fsp.mkdir(QUEUE_DIR, { recursive: true });
    const target = path.join(QUEUE_DIR, file);
    const tmp = tmpName(target);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, target);
  } catch (err) {
    liveQueue = liveQueue.filter((q) => q !== entry);
    throw err;
  }
  const next = withQueue(st, liveQueue);
  await savePersistedState(next);
  return next;
}

/** Remove (and delete) the queued photo a finished round used, identified by its URL (privacy guarantee) */
export async function consumeQueuedPhoto(st: PersistedState, url: string | null): Promise<PersistedState> {
  const clean = (url || '').split('?')[0];
  const entry = clean ? liveQueue.find((q) => q.url === clean) : undefined;
  if (!entry) return withQueue(st, liveQueue);
  liveQueue = liveQueue.filter((q) => q !== entry);
  await fsp.rm(path.join(QUEUE_DIR, entry.file), { force: true });
  const next = withQueue(st, liveQueue);
  await savePersistedState(next);
  return next;
}

/** Clear the whole queue (admin CLEAR QUEUE / purge) */
export async function purgeQueuedPhoto(st: PersistedState): Promise<PersistedState> {
  liveQueue = [];
  try {
    for (const f of await fsp.readdir(QUEUE_DIR)) {
      await fsp.rm(path.join(QUEUE_DIR, f), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
  const next = withQueue(st, liveQueue);
  await savePersistedState(next);
  return next;
}

let doorVersion = 0;

export function doorPhotoInfo(): DoorPhotoInfo {
  let has = false;
  try {
    const st = fs.statSync(DOOR_FILE);
    has = st.isFile() && st.size > 0;
    if (has && doorVersion === 0) doorVersion = Math.floor(st.mtimeMs);
  } catch {
    has = false;
  }
  return { has, version: doorVersion, url: has ? `/data/latest-door.jpg?v=${doorVersion}` : null };
}

export function contactSheetFromState(st: PersistedState): ContactSheetInfo {
  return {
    rollNumber: st.rollNumber,
    totalInRoll: st.frames.length,
    frames: st.frames,
  };
}

export function nextFrameNumber(st: PersistedState): number {
  const maxIdx = st.frames.reduce((mx, f) => Math.max(mx, f.index), 0);
  return maxIdx + 1;
}

export async function saveArchivedFrame(
  st: PersistedState,
  frameNumber: number,
  buf: Buffer,
  devPercent: number,
  outcome: ChemicalOutcome,
): Promise<{ next: PersistedState; archiveName: string }> {
  const rFolder = rollDirName(st.rollNumber);
  const dir = path.join(ROLLS_DIR, rFolder);
  await fsp.mkdir(dir, { recursive: true });

  const ts = Date.now();
  const frameNo = `${pad(frameNumber, 2)}A`;
  const fileName = `${frameNo}.jpg`;
  await fsp.writeFile(path.join(dir, fileName), buf);
  const frameUrl = `/data/rolls/${rFolder}/${fileName}?v=${ts}`;

  const tmpDoor = tmpName(DOOR_FILE);
  await fsp.writeFile(tmpDoor, buf);
  await fsp.rename(tmpDoor, DOOR_FILE);
  doorVersion = ts;

  const frameEntry: ContactFrame = {
    frameNo,
    index: frameNumber,
    url: frameUrl,
    timestamp: ts,
    name: `${rFolder}/${fileName}`,
    devPercent: Math.max(0, Math.round(devPercent)),
    outcome,
    outcomeCode: outcomeShortCode(outcome),
  };

  const filtered = st.frames.filter((f) => f.index !== frameNumber);
  const frames = [...filtered, frameEntry].sort((a, b) => a.index - b.index);

  const next: PersistedState = {
    ...st,
    frames,
    latestFrameUrl: frameUrl,
  };
  await savePersistedState(next);
  return { next: withQueue(next, liveQueue), archiveName: `${rFolder}/${fileName}` };
}

export async function clearCache(
  mode: 'runtime' | 'all',
  config: AppConfig,
  curState: PersistedState,
): Promise<{ config: AppConfig; state: PersistedState }> {
  // Always clear ./data/queue/
  const afterQueue = await purgeQueuedPhoto(curState);

  if (mode === 'runtime') {
    return { config, state: afterQueue };
  }

  // mode === 'all': purge all rolls, legacy dirs, door cache, and reset to roll 1
  for (const dir of [ROLLS_DIR, path.join(DATA_DIR, 'archive'), path.join(DATA_DIR, 'forecasts'), path.join(DATA_DIR, 'cache')]) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  try {
    await fsp.unlink(DOOR_FILE);
  } catch {
    /* ignore */
  }
  doorVersion = Date.now();

  const nextCfg = sanitizeConfig({ ...config, rollNumber: 1 }, config);
  await saveConfig(nextCfg);
  const nextState = emptyPersistedState(1);
  await savePersistedState(nextState);
  return { config: nextCfg, state: nextState };
}

export async function computeStorageStats(_st: PersistedState): Promise<StorageStats> {
  async function walkBytes(dir: string): Promise<number> {
    let sum = 0;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sum += await walkBytes(p);
      else if (e.isFile()) {
        try {
          sum += (await fsp.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
    return sum;
  }

  const totalBytes = await walkBytes(DATA_DIR);
  let rollsCount = 0;
  let framesCount = 0;
  try {
    const rEntries = await fsp.readdir(ROLLS_DIR, { withFileTypes: true });
    for (const r of rEntries) {
      if (!r.isDirectory()) continue;
      const files = (await fsp.readdir(path.join(ROLLS_DIR, r.name))).filter((n) => /\.jpe?g$/i.test(n));
      if (files.length > 0) {
        rollsCount++;
        framesCount += files.length;
      }
    }
  } catch {
    /* ignore */
  }

  return {
    totalBytes,
    rollsCount,
    framesCount,
    queueCount: liveQueue.length,
  };
}

export async function resetDoorPhoto(): Promise<DoorPhotoInfo> {
  try {
    await fsp.unlink(DOOR_FILE);
  } catch {
    /* ignore */
  }
  doorVersion = Date.now();
  return doorPhotoInfo();
}

export interface ArchiveItem {
  name: string;
  roll: number | null;
  frameNo: string | null;
  url: string;
  size: number;
  mtime: number;
}

export async function listArchive(rollFilter?: number | null): Promise<ArchiveItem[]> {
  const items: ArchiveItem[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(ROLLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^roll[_-](\d+)$/i.exec(e.name);
    const rollNo = m ? Number(m[1]) : null;
    if (rollFilter != null && rollNo !== rollFilter) continue;
    let files: string[] = [];
    try {
      files = await fsp.readdir(path.join(ROLLS_DIR, e.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.jpe?g$/i.test(f)) continue;
      try {
        const st = await fsp.stat(path.join(ROLLS_DIR, e.name, f));
        const fm = /^(\d+A)/i.exec(f);
        items.push({
          name: `${e.name}/${f}`,
          roll: rollNo,
          frameNo: fm ? fm[1].toUpperCase() : null,
          url: `/data/rolls/${encodeURIComponent(e.name)}/${encodeURIComponent(f)}`,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
        });
      } catch {
        /* ignore */
      }
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}
