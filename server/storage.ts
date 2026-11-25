import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppConfig, DEFAULT_CONFIG, DoorPhotoInfo, ENTER_BUFFER_MAX, ENTER_BUFFER_MIN } from '../shared/protocol.js';

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

export function sanitizeConfig(input: Partial<AppConfig> | undefined, base: AppConfig): AppConfig {
  const src = input || {};
  // 只保留已知字段（旧版 config.json 中的多余字段会被丢弃）
  return {
    enterBufferSec:
      Math.round(clamp(src.enterBufferSec ?? base.enterBufferSec, ENTER_BUFFER_MIN, ENTER_BUFFER_MAX, base.enterBufferSec) * 10) / 10,
  };
}

export function loadConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = sanitizeConfig(raw, DEFAULT_CONFIG);
    saveConfigSync(cfg);
    return cfg;
  } catch {
    const cfg = { ...DEFAULT_CONFIG };
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

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
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

export async function saveFreeze(buf: Buffer, roundId: number): Promise<{ photo: DoorPhotoInfo; archiveName: string }> {
  const archiveName = `${timeStamp()}-r${roundId}.jpg`;
  await fsp.writeFile(path.join(ARCHIVE_DIR, archiveName), buf);
  const tmp = tmpName(DOOR_FILE);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, DOOR_FILE);
  doorVersion = Date.now();
  return { photo: doorPhotoInfo(), archiveName };
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
  url: string;
  size: number;
  mtime: number;
}

export async function listArchive(date: string | null, all: boolean): Promise<ArchiveItem[]> {
  const prefix = all ? '' : date || dateStamp();
  let names: string[] = [];
  try {
    names = await fsp.readdir(ARCHIVE_DIR);
  } catch {
    return [];
  }
  const items: ArchiveItem[] = [];
  for (const name of names) {
    if (!/\.jpe?g$/i.test(name) || !name.startsWith(prefix)) continue;
    try {
      const st = await fsp.stat(path.join(ARCHIVE_DIR, name));
      items.push({ name, url: `/data/archive/${encodeURIComponent(name)}`, size: st.size, mtime: Math.floor(st.mtimeMs) });
    } catch {
      /* ignore */
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
