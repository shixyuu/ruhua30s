import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppConfig,
  CCTV_REVEAL_MAX,
  CCTV_REVEAL_MIN,
  ContactFrame,
  ContactSheetInfo,
  DEFAULT_CONFIG,
  DoorPhotoInfo,
  ENTER_BUFFER_MAX,
  ENTER_BUFFER_MIN,
} from '../shared/protocol.js';

export const ROOT_DIR = process.cwd();
export const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(ROOT_DIR, 'assets'));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DOOR_FILE = path.join(DATA_DIR, 'latest-door.jpg');

export function ensureDirs(): void {
  for (const d of [ASSETS_DIR, DATA_DIR, ARCHIVE_DIR]) fs.mkdirSync(d, { recursive: true });
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

export function sanitizeConfig(input: Partial<AppConfig> | undefined, base: AppConfig): AppConfig {
  const src = input || {};
  const enterBufferSec =
    Math.round(clamp(src.enterBufferSec ?? base.enterBufferSec, ENTER_BUFFER_MIN, ENTER_BUFFER_MAX, base.enterBufferSec) * 10) / 10;
  const cctvRevealSec =
    Math.round(clamp(src.cctvRevealSec ?? base.cctvRevealSec, CCTV_REVEAL_MIN, CCTV_REVEAL_MAX, base.cctvRevealSec) * 10) / 10;
  const rollRaw = typeof src.rollNumber === 'number' ? src.rollNumber : Number(src.rollNumber);
  const rollNumber = Number.isFinite(rollRaw) && rollRaw >= 1 ? Math.floor(rollRaw) : Math.max(1, Math.floor(base.rollNumber || 1));
  return { enterBufferSec, cctvRevealSec, rollNumber };
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

/** 读取指定胶卷的完整接触印相表（按时间升序编号 01A, 02A...） */
export async function getContactSheet(rollNumber: number): Promise<ContactSheetInfo> {
  const rFolder = rollDirName(rollNumber);
  const dir = path.join(ARCHIVE_DIR, rFolder);
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { rollNumber, totalInRoll: 0, frames: [] };
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
  // 按文件名时间戳（及 mtime）升序，保证 01A → 02A → 03A 稳定生长
  raw.sort((a, b) => a.name.localeCompare(b.name) || a.mtime - b.mtime);
  const frames: ContactFrame[] = raw.map((it, idx) => {
    const index = idx + 1;
    const m = /-f(\d+)/i.exec(it.name);
    const num = m ? Number(m[1]) || index : index;
    return {
      frameNo: `${pad(num, 2)}A`,
      index,
      url: `/data/archive/${rFolder}/${encodeURIComponent(it.name)}`,
      timestamp: it.mtime,
      name: `${rFolder}/${it.name}`,
    };
  });
  return {
    rollNumber,
    totalInRoll: frames.length,
    frames,
  };
}

export async function saveFreeze(
  buf: Buffer,
  rollNumber: number,
  frameNumber: number,
  roundId: number,
): Promise<{ photo: DoorPhotoInfo; archiveName: string; sheet: ContactSheetInfo }> {
  const rFolder = rollDirName(rollNumber);
  const dir = path.join(ARCHIVE_DIR, rFolder);
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${timeStamp()}-f${pad(frameNumber, 2)}-r${roundId}.jpg`;
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
          items.push({
            name: `${entry.name}/${name}`,
            roll: rollNo,
            frameNo: fm ? `${pad(Number(fm[1]), 2)}A` : null,
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
