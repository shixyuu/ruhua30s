import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppConfig,
  CONFIG_BOUNDS,
  ChemicalOutcome,
  CollapseZone,
  ContactFrame,
  ContactSheetInfo,
  DEFAULT_CONFIG,
  DoorPhotoInfo,
  ForecastInfo,
  PersistedState,
  StorageStats,
  outcomeShortCode,
} from '../shared/protocol.js';

export const ROOT_DIR = process.cwd();
export const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(ROOT_DIR, 'assets'));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const ROLLS_DIR = path.join(DATA_DIR, 'rolls');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const GHOST_FILE = path.join(CACHE_DIR, 'ghost_seq.json');
const DOOR_FILE = path.join(DATA_DIR, 'latest-door.jpg');

export interface GhostSequencePayload {
  rollNumber: number;
  frameNumber: number;
  frames: string[];
  updatedAt: number;
}

export function ensureDirs(): void {
  for (const d of [ASSETS_DIR, DATA_DIR, ROLLS_DIR, CACHE_DIR]) {
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
    enterBufferSec: round1(
      clamp(src.enterBufferSec ?? base.enterBufferSec, CONFIG_BOUNDS.enterBufferSec.min, CONFIG_BOUNDS.enterBufferSec.max, base.enterBufferSec),
    ),
    safelightSec: round1(
      clamp(src.safelightSec ?? base.safelightSec, CONFIG_BOUNDS.safelightSec.min, CONFIG_BOUNDS.safelightSec.max, base.safelightSec),
    ),
    exposureSec: round1(
      clamp(src.exposureSec ?? base.exposureSec, CONFIG_BOUNDS.exposureSec.min, CONFIG_BOUNDS.exposureSec.max, base.exposureSec),
    ),
    maxDevelopSec: round1(
      clamp(src.maxDevelopSec ?? base.maxDevelopSec, CONFIG_BOUNDS.maxDevelopSec.min, CONFIG_BOUNDS.maxDevelopSec.max, base.maxDevelopSec),
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
    pastOpacity: round2(
      clamp(src.pastOpacity ?? base.pastOpacity, CONFIG_BOUNDS.pastOpacity.min, CONFIG_BOUNDS.pastOpacity.max, base.pastOpacity),
    ),
    printMode:
      src.printMode === 'positive_print' || src.printMode === 'photogram_negative' ? src.printMode : base.printMode,
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

// ======================================================================
// state.json persistence
// ======================================================================
export function emptyPersistedState(rollNumber: number): PersistedState {
  return {
    rollNumber,
    frames: [],
    hasBase: false,
    baseFrameUrl: null,
    baseCapturedAt: null,
    latestFrameUrl: null,
    prevFrameUrl: null,
    forecastUrl: null,
    collapseZone: null,
    hasGhostSequence: false,
    ghostUpdatedAt: null,
  };
}

export function loadPersistedState(rollNumber: number): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<PersistedState>;
    const rNo = typeof raw.rollNumber === 'number' && raw.rollNumber >= 1 ? Math.floor(raw.rollNumber) : rollNumber;
    const ghostExists = fs.existsSync(GHOST_FILE);
    const base: PersistedState = {
      ...emptyPersistedState(rNo),
      ...raw,
      rollNumber: rNo,
      frames: Array.isArray(raw.frames) ? raw.frames : [],
      hasGhostSequence: ghostExists && !!raw.hasGhostSequence,
    };
    atomicWriteJsonSync(STATE_FILE, base);
    return base;
  } catch {
    const st = emptyPersistedState(rollNumber);
    atomicWriteJsonSync(STATE_FILE, st);
    return st;
  }
}

export async function savePersistedState(st: PersistedState): Promise<void> {
  await atomicWriteJson(STATE_FILE, st);
}

// ======================================================================
// JPEG decode & Roll image archiving
// ======================================================================
export function decodeJpeg(data: string): Buffer | null {
  if (typeof data !== 'string') return null;
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

let doorVersion = 0;
let forecastVersion = 0;

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

export function forecastInfoFromState(st: PersistedState): ForecastInfo {
  const nextIdx = st.frames.filter((f) => f.index >= 1).length + 1;
  const targetFrameNo = st.hasBase ? `${pad(nextIdx, 2)}A` : '00A';
  if (st.forecastUrl) {
    return {
      has: true,
      version: forecastVersion || Date.now(),
      targetFrameNo,
      url: st.forecastUrl,
      collapseZone: st.collapseZone ?? null,
    };
  }
  return {
    has: false,
    version: forecastVersion,
    targetFrameNo,
    url: null,
    collapseZone: null,
  };
}

export function contactSheetFromState(st: PersistedState): ContactSheetInfo {
  return {
    rollNumber: st.rollNumber,
    totalInRoll: st.frames.length,
    frames: st.frames,
    forecast: forecastInfoFromState(st),
  };
}

export function nextAudienceFrameNumber(st: PersistedState): number {
  const maxAudience = st.frames.reduce((mx, f) => (f.index >= 1 ? Math.max(mx, f.index) : mx), 0);
  return maxAudience + 1;
}

export async function saveBaseFrame(
  st: PersistedState,
  baseBuf: Buffer,
  forecastBuf: Buffer | null,
  collapseZone: CollapseZone | null,
): Promise<PersistedState> {
  const rFolder = rollDirName(st.rollNumber);
  const dir = path.join(ROLLS_DIR, rFolder);
  await fsp.mkdir(dir, { recursive: true });

  const ts = Date.now();
  await fsp.writeFile(path.join(dir, '00A_base.jpg'), baseBuf);
  const baseUrl = `/data/rolls/${rFolder}/00A_base.jpg?v=${ts}`;

  const tmpDoor = tmpName(DOOR_FILE);
  await fsp.writeFile(tmpDoor, baseBuf);
  await fsp.rename(tmpDoor, DOOR_FILE);
  doorVersion = ts;

  let fcUrl = st.forecastUrl;
  if (forecastBuf) {
    await fsp.writeFile(path.join(dir, 'forecast_latest.jpg'), forecastBuf);
    await fsp.writeFile(path.join(dir, 'forecast_01A.jpg'), forecastBuf);
    forecastVersion = ts;
    fcUrl = `/data/rolls/${rFolder}/forecast_latest.jpg?v=${ts}`;
  }

  const baseFrame: ContactFrame = {
    frameNo: '00A',
    index: 0,
    url: baseUrl,
    timestamp: ts,
    name: `${rFolder}/00A_base.jpg`,
    outcome: null,
    outcomeCode: 'BASE',
  };

  const withoutBase = st.frames.filter((f) => f.index !== 0);
  const next: PersistedState = {
    ...st,
    frames: [baseFrame, ...withoutBase],
    hasBase: true,
    baseFrameUrl: baseUrl,
    baseCapturedAt: ts,
    latestFrameUrl: st.latestFrameUrl ?? baseUrl,
    forecastUrl: fcUrl,
    collapseZone: collapseZone ?? st.collapseZone,
  };
  await savePersistedState(next);
  return next;
}

export async function saveAudienceFrame(
  st: PersistedState,
  frameNumber: number,
  buf: Buffer,
  devPercent: number,
  outcome: ChemicalOutcome,
  forecastBuf: Buffer | null,
  collapseZone: CollapseZone | null,
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

  let fcUrl = st.forecastUrl;
  if (forecastBuf) {
    await fsp.writeFile(path.join(dir, 'forecast_latest.jpg'), forecastBuf);
    await fsp.writeFile(path.join(dir, `forecast_${pad(frameNumber + 1, 2)}A.jpg`), forecastBuf);
    forecastVersion = ts;
    fcUrl = `/data/rolls/${rFolder}/forecast_latest.jpg?v=${ts}`;
  }

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
    prevFrameUrl: st.latestFrameUrl ?? st.baseFrameUrl,
    latestFrameUrl: frameUrl,
    forecastUrl: fcUrl,
    collapseZone: collapseZone ?? null,
  };
  await savePersistedState(next);
  return { next, archiveName: `${rFolder}/${fileName}` };
}

export async function saveGhostSequence(
  st: PersistedState,
  rollNumber: number,
  frameNumber: number,
  frames: string[],
): Promise<PersistedState> {
  const clean = frames.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 40);
  const payload: GhostSequencePayload = {
    rollNumber,
    frameNumber,
    frames: clean,
    updatedAt: Date.now(),
  };
  await atomicWriteJson(GHOST_FILE, payload);
  const next: PersistedState = {
    ...st,
    hasGhostSequence: clean.length > 0,
    ghostUpdatedAt: payload.updatedAt,
  };
  await savePersistedState(next);
  return next;
}

export async function loadGhostSequence(): Promise<GhostSequencePayload | null> {
  try {
    const raw = JSON.parse(fs.readFileSync(GHOST_FILE, 'utf8')) as GhostSequencePayload;
    if (Array.isArray(raw.frames) && raw.frames.length > 0) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

export async function clearCache(
  mode: 'runtime' | 'all',
  config: AppConfig,
  curState: PersistedState,
): Promise<{ config: AppConfig; state: PersistedState }> {
  // Always clear ./data/cache/
  try {
    for (const f of await fsp.readdir(CACHE_DIR)) {
      await fsp.rm(path.join(CACHE_DIR, f), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }

  if (mode === 'runtime') {
    const fcFile = path.join(rollDirPath(curState.rollNumber), 'forecast_latest.jpg');
    try {
      await fsp.unlink(fcFile);
    } catch {
      /* ignore */
    }
    const next: PersistedState = {
      ...curState,
      forecastUrl: null,
      collapseZone: null,
      hasGhostSequence: false,
      ghostUpdatedAt: null,
    };
    await savePersistedState(next);
    return { config, state: next };
  }

  // mode === 'all': purge all rolls, legacy archive/forecasts, and reset to roll 1
  for (const dir of [ROLLS_DIR, path.join(DATA_DIR, 'archive'), path.join(DATA_DIR, 'forecasts')]) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  try {
    await fsp.unlink(DOOR_FILE);
  } catch {
    /* ignore */
  }
  doorVersion = Date.now();
  forecastVersion = Date.now();

  const nextCfg = sanitizeConfig({ ...config, rollNumber: 1 }, config);
  await saveConfig(nextCfg);
  const nextState = emptyPersistedState(1);
  await savePersistedState(nextState);
  return { config: nextCfg, state: nextState };
}

export async function computeStorageStats(st: PersistedState): Promise<StorageStats> {
  let totalBytes = 0;
  let rollsCount = 0;
  let framesCount = 0;

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
      if (e.isDirectory()) {
        sum += await walkBytes(p);
      } else if (e.isFile()) {
        try {
          sum += (await fsp.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
    return sum;
  }

  totalBytes = await walkBytes(DATA_DIR);

  try {
    const rEntries = await fsp.readdir(ROLLS_DIR, { withFileTypes: true });
    for (const r of rEntries) {
      if (!r.isDirectory()) continue;
      const files = (await fsp.readdir(path.join(ROLLS_DIR, r.name))).filter(
        (n) => /\.jpe?g$/i.test(n) && !/^forecast_/i.test(n),
      );
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
    hasGhostSequence: st.hasGhostSequence && fs.existsSync(GHOST_FILE),
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
      if (!/\.jpe?g$/i.test(f) || /^forecast_/i.test(f)) continue;
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
