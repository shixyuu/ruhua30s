/**
 * 《入画三十秒 (RH-30)》v3 — 扫码传图彩色暗房精修版（前后端共享协议）
 * 服务端是唯一真相源：所有终端根据 state / dev 包里的 serverTime / phaseStartedAt 校准本地时钟。
 */

export type Phase =
  | 'IDLE'
  | 'CALIBRATING'
  | 'CAPTURE_CLEAN'
  | 'OBSERVE'
  | 'EXPOSE'
  | 'DEVELOP'
  | 'LIGHT_LEAK'
  | 'REVEAL';

export type ChemicalOutcome =
  | 'FIXED_OPTIMAL'
  | 'OVERDEVELOPED_BURNED'
  | 'UNDERDEVELOPED_TRACE_LOST'
  | 'UNFIXED_LIGHT_LEAK';

export type Role = 'main' | 'door' | 'station1' | 'station2' | 'admin';

export const ROLES: Role[] = ['main', 'door', 'station1', 'station2', 'admin'];

export interface Point2D {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export interface CalibrationData {
  /** 4 corners in camera snapshot normalized coords: [TL, TR, BR, BL] */
  corners: [Point2D, Point2D, Point2D, Point2D] | null;
  /** 3x3 inverse homography matrix (row-major 9 floats): 320x180 grid -> camera normalized [0..1] */
  hInv: number[] | null;
  updatedAt: number | null;
}

export interface AppConfig {
  /** 01 OBSERVE 安全红光秒数（3–20，默认 8） */
  observeSec: number;
  /** 02 EXPOSE 彩色投影遮挡减光秒数（10–60，默认 30） */
  exposeSec: number;
  /** 03 DEVELOP 最长声控显影秒数（10–45，默认 25） */
  developSec: number;
  /** 04 REVEAL 前后对照展示秒数（6–25，默认 12） */
  revealSec: number;
  /** 抗环境底噪阈值（0.00–0.50，默认 0.08） */
  noiseFloor: number;
  /** 满能量时每秒显影增量（0.03–0.80，默认 0.20） */
  devSpeed: number;
  /** 画框四周黑边百分比（0–30，默认 6） */
  easelMargin: number;
  /** 摄像头遮挡差分阈值（0.02–0.50，默认 0.12；越低越灵敏） */
  diffSensitivity: number;
  /** 在家无摄像头鼠标涂抹减光模拟开关 */
  mouseSimulator: boolean;
  /** 免扫码兜底：使用内置高反差测试图（0=关闭, 1..3=内置样张, 4=上一轮成品） */
  sampleFallback: number;
  /** 当前胶卷编号（从 1 开始，NEW ROLL 时递增，历史照片按卷归档保留） */
  rollNumber: number;
}

export const CONFIG_BOUNDS = {
  observeSec: { min: 3, max: 20 },
  exposeSec: { min: 10, max: 60 },
  developSec: { min: 10, max: 45 },
  revealSec: { min: 6, max: 25 },
  noiseFloor: { min: 0.0, max: 0.5 },
  devSpeed: { min: 0.03, max: 0.8 },
  easelMargin: { min: 0, max: 30 },
  diffSensitivity: { min: 0.02, max: 0.5 },
} as const;

export const DEFAULT_CONFIG: AppConfig = {
  observeSec: 8,
  exposeSec: 30,
  developSec: 25,
  revealSec: 12,
  noiseFloor: 0.08,
  devSpeed: 0.2,
  easelMargin: 6,
  diffSensitivity: 0.12,
  mouseSimulator: false,
  sampleFallback: 0,
  rollNumber: 1,
};

export interface RoundInfo {
  id: number;
  rollNumber: number;
  frameNumber: number; // 1 -> 01A, 2 -> 02A...
  sourceUrl: string | null; // uploaded photo URL or null (sample fallback)
  sampleIndex: number; // 0 = uploaded, 1..6 = built-in sample photo, 7 = prev print
  devProgress: number;
  finalDevProgress: number | null;
  fixTriggeredBy: 'station2' | 'timeout' | 'admin' | null;
  outcome: ChemicalOutcome | null;
  hasFreeze: boolean;
  trigger: string | null;
}

export interface DoorPhotoInfo {
  has: boolean;
  version: number;
  url: string | null;
}

export interface ContactFrame {
  frameNo: string; // "01A", "02A"...
  index: number; // 1, 2...
  url: string;
  timestamp: number;
  name: string;
  devPercent?: number;
  outcome?: ChemicalOutcome | null;
  outcomeCode?: string; // "FIXED" | "BURNED" | "UNDER" | "LEAK"
}

export interface ContactSheetInfo {
  rollNumber: number;
  totalInRoll: number;
  frames: ContactFrame[];
}

export interface PersistedState {
  rollNumber: number;
  frames: ContactFrame[];
  latestFrameUrl: string | null;
  hasQueuedPhoto: boolean;
  queuedPhotoUrl: string | null;
  queuedAt: number | null;
}

export interface StorageStats {
  totalBytes: number;
  rollsCount: number;
  framesCount: number;
  queueCount: number;
}

export interface ClientStatus {
  role: Role;
  online: boolean;
  count: number;
  lastSeen: number | null;
}

// ---------------- 服务端 → 客户端 ----------------
export type ServerMsg =
  | {
      type: 'state';
      state: Phase;
      phaseStartedAt: number;
      phaseDurationMs: number;
      serverTime: number;
      timeScale: number;
      round: RoundInfo;
      doorPhoto: DoorPhotoInfo;
    }
  | {
      type: 'dev';
      devProgress: number;
      audioLevel: number;
      effLevel: number;
      serverTime: number;
    }
  | { type: 'time'; clientTime: number; serverTime: number }
  | { type: 'config'; config: AppConfig }
  | { type: 'calibration'; calibration: CalibrationData }
  | { type: 'REQUEST_SNAPSHOT' }
  | { type: 'SNAPSHOT_READY'; imageData: string; ts: number }
  | { type: 'door-photo'; photo: DoorPhotoInfo; serverTime: number }
  | { type: 'contact-sheet'; sheet: ContactSheetInfo; serverTime: number }
  | { type: 'STATE_SYNC'; persisted: PersistedState; storage: StorageStats; serverTime: number }
  | { type: 'FLASH_PULSE'; durationMs: number; ts: number }
  | { type: 'clients'; clients: ClientStatus[]; serverTime: number }
  | { type: 'ack'; what: string; ok: boolean; message?: string }
  | { type: 'error'; message: string };

// ---------------- 客户端 → 服务端 ----------------
export type AdminAction = 'reset' | 'skipPhase' | 'newRoll' | 'resetDoor' | 'testFlash' | 'testDevelop' | 'setConfig';

export type ClientMsg =
  | { type: 'hello'; role: Role; token?: string }
  | { type: 'time'; clientTime: number }
  | { type: 'hb' }
  | { type: 'START_SESSION'; token?: string }
  | { type: 'ENTER_CALIBRATION'; token?: string }
  | { type: 'EXIT_CALIBRATION'; token?: string }
  | { type: 'REQUEST_SNAPSHOT'; token?: string }
  | { type: 'SNAPSHOT_DATA'; imageData: string }
  | { type: 'TEST_FLASH'; token?: string }
  | { type: 'AUDIO_ENERGY'; level: number }
  | { type: 'TRIGGER_FIX' }
  | { type: 'freeze'; data: string }
  | { type: 'admin'; action: AdminAction; config?: Partial<AppConfig>; token?: string };

export function outcomeShortCode(o?: ChemicalOutcome | null): string {
  switch (o) {
    case 'FIXED_OPTIMAL':
      return 'FIXED';
    case 'OVERDEVELOPED_BURNED':
      return 'BURNED';
    case 'UNDERDEVELOPED_TRACE_LOST':
      return 'UNDER';
    case 'UNFIXED_LIGHT_LEAK':
      return 'LEAK';
    default:
      return 'FIXED';
  }
}

export function outcomeFullLabel(o?: ChemicalOutcome | null): string {
  switch (o) {
    case 'FIXED_OPTIMAL':
      return 'FIXED · OPTIMAL';
    case 'OVERDEVELOPED_BURNED':
      return 'OVERDEVELOPED · BURNED';
    case 'UNDERDEVELOPED_TRACE_LOST':
      return 'UNDERDEVELOPED · TRACE LOST';
    case 'UNFIXED_LIGHT_LEAK':
      return 'UNFIXED · LIGHT LEAK';
    default:
      return 'FIXED';
  }
}
