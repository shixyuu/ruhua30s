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
  PrintMode,
  outcomeShortCode,
} from '../shared/protocol.js';

export const ROOT_DIR = process.cwd();
export const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(ROOT_DIR, 'assets'));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
export const FORECAST_DIR = path.join(DATA_DIR, 'forecasts');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DOOR_FILE = path.join(DATA_DIR, 'latest-door.jpg');
const FORECAST_FILE = path.join(DATA_DIR, 'latest-forecast.jpg');
const FORECAST_META_FILE = path.join(DATA_DIR, 'latest-forecast.json');

export function ensureDirs(): void {
  for (const d of [ASSETS_DIR, DATA_DIR, ARCHIVE_DIR, FORECAST_DIR]) fs.mkdirSync(d, { recursive: true });
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
  return `roll-${pad(rollNumber, 2)}`;
}

export function rollDirPath(rollNumber: number): string {
  return path.join(ARCHIVE_DIR, rollDirName(rollNumber));
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

export function sanitizeConfig(input: Partial<AppConfig> | undefined, base: AppConfig): AppConfig {
  const src = input || {};
  const enterBufferSec = round1(
    clamp(src.enterBufferSec ?? base.enterBufferSec, CONFIG_BOUNDS.enterBufferSec.min, CONFIG_BOUNDS.enterBufferSec.max, base.enterBufferSec),
  );
  const safelightSec = round1(
    clamp(src.safelightSec ?? base.safelightSec, CONFIG_BOUNDS.safelightSec.min, CONFIG_BOUNDS.safelightSec.max, base.safelightSec),
  );
  const exposureSec = round1(
    clamp(src.exposureSec ?? base.exposureSec, CONFIG_BOUNDS.exposureSec.min, CONFIG_BOUNDS.exposureSec.max, base.exposureSec),
  );
  const maxDevelopSec = round1(
    clamp(src.maxDevelopSec ?? base.maxDevelopSec, CONFIG_BOUNDS.maxDevelopSec.min, CONFIG_BOUNDS.maxDevelopSec.max, base.maxDevelopSec),
  );
  const revealSec = round1(
    clamp(src.revealSec ?? base.revealSec, CONFIG_BOUNDS.revealSec.min, CONFIG_BOUNDS.revealSec.max, base.revealSec),
  );
  const noiseFloor = round3(
    clamp(src.noiseFloor ?? base.noiseFloor, CONFIG_BOUNDS.noiseFloor.min, CONFIG_BOUNDS.noiseFloor.max, base.noiseFloor),
  );
  const devSpeed = round3(
    clamp(src.devSpeed ?? base.devSpeed, CONFIG_BOUNDS.devSpeed.min, CONFIG_BOUNDS.devSpeed.max, base.devSpeed),
  );
  const pastOpacity = round2(
    clamp(src.pastOpacity ?? base.pastOpacity, CONFIG_BOUNDS.pastOpacity.min, CONFIG_BOUNDS.pastOpacity.max, base.pastOpacity),
  );
  const printMode: PrintMode =
    src.printMode === 'positive_print' || src.printMode === 'photogram_negative' ? src.printMode : base.printMode;
  const rollRaw = typeof src.rollNumber === 'number' ? src.rollNumber : Number(src.rollNumber);
  const rollNumber = Number.isFinite(rollRaw) && rollRaw >= 1 ? Math.floor(rollRaw) : Math.max(1, Math.floor(base.rollNumber || 1));

  return {
    enterBufferSec,
    safelightSec,
    exposureSec,
    maxDevelopSec,
    revealSec,
    noiseFloor,
    devSpeed,
    pastOpacity,
    printMode,
    rollNumber,
  };
}

/** 扫描磁盘上已有的最大卷号，避免 config 缺失时覆盖已有卷目录 */
function detectHighestRollOnDisk(): number {
  let maxRoll = 1;
  try {
    const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = /^roll-(\d+)$/i.exec(e.name);
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
    saveConfigSync(cfg);
    return cfg;
  } catch {
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      rollNumber: detectHighestRollOnDisk(),
    };
    fs.mkdirSync(rollDirPath(cfg.rollNumber), { recursive: true });
    saveConfigSync(cfg);
    return cfg;
  }
}

function saveConfigSync(cfg: AppConfig): void {
  try {
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    console.error('[storage] 写入 config.json 失败', err);
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await fsp.mkdir(rollDirPath(cfg.rollNumber), { recursive: true });
  const tmp = tmpName(CONFIG_FILE);
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fsp.rename(tmp, CONFIG_FILE);
}

let doorVersion = 0;
let forecastVersion = 0;
let tmpSeq = 0;
/** 每次写入使用唯一临时文件名，避免并发写入互相 rename 掉对方的临时文件 */
const tmpName = (file: string) => `${file}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;

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

export function forecastInfo(rollNumber: number): ForecastInfo {
  const nextIdx = countRollFramesSync(rollNumber);
  const fallbackTarget = `${pad(nextIdx, 2)}A`;
  try {
    const st = fs.statSync(FORECAST_FILE);
    if (!st.isFile() || st.size === 0) {
      return { has: false, version: forecastVersion, targetFrameNo: fallbackTarget, url: null, collapseZone: null };
    }
    const meta = JSON.parse(fs.readFileSync(FORECAST_META_FILE, 'utf8')) as {
      rollNumber?: number;
      targetFrameNo?: string;
      version?: number;
      archiveUrl?: string;
      collapseZone?: CollapseZone | null;
    };
    if (meta.rollNumber !== rollNumber) {
      return { has: false, version: forecastVersion, targetFrameNo: fallbackTarget, url: null, collapseZone: null };
    }
    const ver = meta.version || forecastVersion || Math.floor(st.mtimeMs);
    if (forecastVersion === 0) forecastVersion = ver;
    return {
      has: true,
      version: ver,
      targetFrameNo: meta.targetFrameNo || fallbackTarget,
      url: `/data/latest-forecast.jpg?v=${ver}`,
      collapseZone: meta.collapseZone ?? null,
    };
  } catch {
    return { has: false, version: forecastVersion, targetFrameNo: fallbackTarget, url: null, collapseZone: null };
  }
}

export async function saveForecast(
  buf: Buffer,
  rollNumber: number,
  targetFrameNumber: number,
  collapseZone: CollapseZone | null = null,
): Promise<{ forecast: ForecastInfo; archiveUrl: string }> {
  const rFolder = rollDirName(rollNumber);
  const fDir = path.join(FORECAST_DIR, rFolder);
  await fsp.mkdir(fDir, { recursive: true });
  const targetFrameNo = `${pad(targetFrameNumber, 2)}A`;
  const ver = Date.now();
  forecastVersion = ver;
  const archiveFile = `forecast-f${pad(targetFrameNumber, 2)}-v${ver}.jpg`;
  const archiveUrl = `/data/forecasts/${rFolder}/${encodeURIComponent(archiveFile)}`;
  await fsp.writeFile(path.join(fDir, archiveFile), buf);

  const tmpImg = tmpName(FORECAST_FILE);
  await fsp.writeFile(tmpImg, buf);
  await fsp.rename(tmpImg, FORECAST_FILE);

  const tmpMeta = tmpName(FORECAST_META_FILE);
  await fsp.writeFile(tmpMeta, JSON.stringify({ rollNumber, targetFrameNo, version: ver, archiveUrl, collapseZone }));
  await fsp.rename(tmpMeta, FORECAST_META_FILE);

  return {
    forecast: {
      has: true,
      version: ver,
      targetFrameNo,
      url: `/data/latest-forecast.jpg?v=${ver}`,
      collapseZone,
    },
    archiveUrl,
  };
}

export function currentForecastSnapshot(rollNumber: number): { archiveUrl: string | null; collapseZone: CollapseZone | null } {
  try {
    const meta = JSON.parse(fs.readFileSync(FORECAST_META_FILE, 'utf8')) as {
      rollNumber?: number;
      archiveUrl?: string;
      collapseZone?: CollapseZone | null;
    };
    if (meta.rollNumber === rollNumber) {
      return { archiveUrl: meta.archiveUrl ?? null, collapseZone: meta.collapseZone ?? null };
    }
  } catch {
    /* ignore */
  }
  return { archiveUrl: null, collapseZone: null };
}

export async function resetForecast(): Promise<void> {
  for (const f of [FORECAST_FILE, FORECAST_META_FILE]) {
    try {
      await fsp.unlink(f);
    } catch {
      /* ignore */
    }
  }
  forecastVersion = Date.now();
}

export function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function timeStamp(d = new Date()): string {
  return `${dateStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** 解析 dataURL 或纯 base64 的 JPEG，校验魔数。 */
export function decodeJpeg(data: string): Buffer | null {
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

/** 同步统计当前卷已有多少张归档底片，用于分配下一张底片号（01A, 02A...） */
export function countRollFramesSync(rollNumber: number): number {
  const dir = rollDirPath(rollNumber);
  try {
    return fs.readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n)).length;
  } catch {
    return 0;
  }
}

function codeToOutcome(code?: string): ChemicalOutcome | null {
  switch (code) {
    case 'FIXED':
      return 'FIXED_OPTIMAL';
    case 'BURNED':
      return 'OVERDEVELOPED_BURNED';
    case 'UNDER':
      return 'UNDERDEVELOPED_TRACE_LOST';
    case 'LEAK':
      return 'UNFIXED_LIGHT_LEAK';
    default:
      return null;
  }
}

/** 读取指定胶卷的完整接触印相表（按时间升序编号 00A, 01A, 02A...） */
export async function getContactSheet(rollNumber: number): Promise<ContactSheetInfo> {
  const rFolder = rollDirName(rollNumber);
  const dir = path.join(ARCHIVE_DIR, rFolder);
  const fc = forecastInfo(rollNumber);
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { rollNumber, totalInRoll: 0, frames: [], forecast: fc };
  }
  const raw: { name: string; mtime: number }[] = [];
  for (const name of names) {
    if (!/\.jpe?g$/i.test(name)) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile() && st.size > 0) raw.push({ name, mtime: Math.floor(st.mtimeMs) });
    } catch {
      /* ignore */
    }
  }
  raw.sort((a, b) => a.name.localeCompare(b.name) || a.mtime - b.mtime);
  const frames: ContactFrame[] = raw.map((it, idx) => {
    const fm = /-f(\d+)/i.exec(it.name);
    const dm = /-d(\d+)/i.exec(it.name);
    const om = /-o(FIXED|BURNED|UNDER|LEAK)/i.exec(it.name);
    const num = fm ? Number(fm[1]) : idx;
    const outcomeCode = om ? om[1].toUpperCase() : 'FIXED';
    return {
      frameNo: `${pad(num, 2)}A`,
      index: num,
      url: `/data/archive/${rFolder}/${encodeURIComponent(it.name)}`,
      timestamp: it.mtime,
      name: `${rFolder}/${it.name}`,
      devPercent: dm ? Number(dm[1]) : undefined,
      outcome: codeToOutcome(outcomeCode),
      outcomeCode,
    };
  });
  return {
    rollNumber,
    totalInRoll: frames.length,
    frames,
    forecast: fc,
  };
}

export async function saveFreeze(
  buf: Buffer,
  rollNumber: number,
  frameNumber: number,
  roundId: number,
  devPercent = 0,
  outcome: ChemicalOutcome | null = 'FIXED_OPTIMAL',
): Promise<{ photo: DoorPhotoInfo; archiveName: string; sheet: ContactSheetInfo }> {
  const rFolder = rollDirName(rollNumber);
  const dir = path.join(ARCHIVE_DIR, rFolder);
  await fsp.mkdir(dir, { recursive: true });
  const dp = Math.max(0, Math.round(devPercent));
  const code = outcomeShortCode(outcome);
  const fileName = `${timeStamp()}-f${pad(frameNumber, 2)}-d${dp}-o${code}-r${roundId}.jpg`;
  await fsp.writeFile(path.join(dir, fileName), buf);
  const tmp = tmpName(DOOR_FILE);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, DOOR_FILE);
  doorVersion = Date.now();
  const sheet = await getContactSheet(rollNumber);
  return { photo: doorPhotoInfo(), archiveName: `${rFolder}/${fileName}`, sheet };
}

export async function resetDoorPhoto(): Promise<DoorPhotoInfo> {
  try {
    await fsp.unlink(DOOR_FILE);
  } catch {
    /* 不存在也没关系 */
  }
  doorVersion = Date.now();
  return doorPhotoInfo();
}

export interface ArchiveItem {
  name: string;
  roll: number | null;
  frameNo: string | null;
  devPercent: number | null;
  url: string;
  size: number;
  mtime: number;
}

/** 列出归档照片（包含各 roll-XX 子目录以及根目录旧版照片；绝不删除任何历史文件） */
export async function listArchive(date: string | null, all: boolean, rollFilter?: number | null): Promise<ArchiveItem[]> {
  const prefix = all ? '' : date || dateStamp();
  const items: ArchiveItem[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(ARCHIVE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const rm = /^roll-(\d+)$/i.exec(entry.name);
      const rollNo = rm ? Number(rm[1]) : null;
      if (rollFilter != null && rollNo !== rollFilter) continue;
      let subNames: string[] = [];
      try {
        subNames = await fsp.readdir(path.join(ARCHIVE_DIR, entry.name));
      } catch {
        continue;
      }
      for (const name of subNames) {
        if (!/\.jpe?g$/i.test(name) || !name.startsWith(prefix)) continue;
        try {
          const st = await fsp.stat(path.join(ARCHIVE_DIR, entry.name, name));
          const fm = /-f(\d+)/i.exec(name);
          const dm = /-d(\d+)/i.exec(name);
          items.push({
            name: `${entry.name}/${name}`,
            roll: rollNo,
            frameNo: fm ? `${pad(Number(fm[1]), 2)}A` : null,
            devPercent: dm ? Number(dm[1]) : null,
            url: `/data/archive/${encodeURIComponent(entry.name)}/${encodeURIComponent(name)}`,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
          });
        } catch {
          /* ignore */
        }
      }
    } else if (entry.isFile() && rollFilter == null) {
      const name = entry.name;
      if (!/\.jpe?g$/i.test(name) || !name.startsWith(prefix)) continue;
      try {
        const st = await fsp.stat(path.join(ARCHIVE_DIR, name));
        items.push({
          name,
          roll: null,
          frameNo: null,
          devPercent: null,
          url: `/data/archive/${encodeURIComponent(name)}`,
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

export function assetExists(name: string): boolean {
  try {
    return fs.statSync(path.join(ASSETS_DIR, name)).isFile();
  } catch {
    return false;
  }
}
