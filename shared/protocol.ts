/**
 * 《入画三十秒 (RH-30)》v3 — 活体暗房时间预言引擎（完整终版）前后端共享协议。
 * 服务端是唯一真相源：所有终端根据 state / dev 包里的 serverTime / phaseStartedAt 校准本地时钟。
 */

export type Phase =
  | 'IDLE'
  | 'ENTER_BUFFER'
  | 'SAFELIGHT_COMPOSE'
  | 'EXPOSURE'
  | 'DEVELOPING'
  | 'LIGHT_LEAK'
  | 'FIXED_REVEAL';

export type PrintMode = 'photogram_negative' | 'positive_print';

export type ChemicalOutcome =
  | 'FIXED_OPTIMAL'
  | 'OVERDEVELOPED_BURNED'
  | 'UNDERDEVELOPED_TRACE_LOST'
  | 'UNFIXED_LIGHT_LEAK';

export type Role = 'main' | 'door' | 'station1' | 'station2' | 'admin';

export const ROLES: Role[] = ['main', 'door', 'station1', 'station2', 'admin'];

export interface CollapseZone {
  cx: number; // 0..1 normalized
  cy: number; // 0..1 normalized
  rx: number; // 0..1 normalized
  ry: number; // 0..1 normalized
}

export interface AppConfig {
  /** 入场缓冲秒数（2–10，默认 5） */
  enterBufferSec: number;
  /** 安全红光构图秒数（0–10，默认 5；设为 0 时直接跳过进入 EXPOSURE） */
  safelightSec: number;
  /** 放大机白光曝光秒数（8–30，默认 15） */
  exposureSec: number;
  /** 最长声控显影秒数（15–45，默认 25） */
  maxDevelopSec: number;
  /** 定影后画面展示秒数（6–25，默认 12） */
  revealSec: number;
  /** 抗环境底噪阈值（0.00–0.50，默认 0.08） */
  noiseFloor: number;
  /** 满能量时每秒显影增量（0.03–0.80，默认 0.20） */
  devSpeed: number;
  /** 活着的过去：上一轮 15s 动态影像在白光重曝中的透明度（0.15–0.85，默认 0.48） */
  pastOpacity: number;
  /** 显影光学模式：classic photogram_negative 或 positive_print */
  printMode: PrintMode;
  /** 当前胶卷编号（从 1 开始，NEW ROLL 时递增，历史照片按卷归档保留） */
  rollNumber: number;
}

export const CONFIG_BOUNDS = {
  enterBufferSec: { min: 2, max: 10 },
  safelightSec: { min: 0, max: 10 },
  exposureSec: { min: 8, max: 30 },
  maxDevelopSec: { min: 15, max: 45 },
  revealSec: { min: 6, max: 25 },
  noiseFloor: { min: 0.0, max: 0.5 },
  devSpeed: { min: 0.03, max: 0.8 },
  pastOpacity: { min: 0.15, max: 0.85 },
} as const;

export const DEFAULT_CONFIG: AppConfig = {
  enterBufferSec: 5,
  safelightSec: 5,
  exposureSec: 15,
  maxDevelopSec: 25,
  revealSec: 12,
  noiseFloor: 0.08,
  devSpeed: 0.2,
  pastOpacity: 0.48,
  printMode: 'photogram_negative',
  rollNumber: 1,
};

export interface ForecastInfo {
  has: boolean;
  version: number;
  targetFrameNo: string; // e.g. "01A"
  url: string | null;
  collapseZone?: CollapseZone | null;
}

export interface RoundInfo {
  id: number;
  rollNumber: number;
  frameNumber: number; // 当前卷内的底片序号（0 → 00A 种子轮，1 → 01A...）
  printMode: PrintMode;
  devProgress: number; // 初始 0.0，无上限，可超过 1.5
  finalDevProgress: number | null; // 进入 LIGHT_LEAK / FIXED_REVEAL 时锁死
  fixTriggeredBy: 'station2' | 'timeout' | 'admin' | null;
  outcome: ChemicalOutcome | null;
  deviationPct: number | null;
  hasFreeze: boolean;
  predictedUrl: string | null; // 本轮开始前锁定的预测未来图 URL
  collapseZone: CollapseZone | null; // 本轮开始前锁定的坍缩区
  trigger: string | null;
}

export interface DoorPhotoInfo {
  has: boolean;
  version: number;
  url: string | null;
}

export interface ContactFrame {
  frameNo: string; // "00A", "01A", "02A"...
  index: number; // 0, 1, 2...
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
  forecast?: ForecastInfo;
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
      phaseDurationMs: number; // 0 = 无限（IDLE）
      serverTime: number;
      timeScale: number;
      round: RoundInfo;
      doorPhoto: DoorPhotoInfo;
      forecast: ForecastInfo;
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
  | { type: 'door-photo'; photo: DoorPhotoInfo; serverTime: number }
  | { type: 'contact-sheet'; sheet: ContactSheetInfo; serverTime: number }
  | { type: 'flash'; serverTime: number } // 测试闪白（仅发往 /main）
  | { type: 'clients'; clients: ClientStatus[]; serverTime: number }
  | { type: 'ack'; what: string; ok: boolean; message?: string }
  | { type: 'error'; message: string };

// ---------------- 客户端 → 服务端 ----------------
/** 状态机只能由 admin 端发送 START_SESSION 启动 */
export type AdminAction = 'reset' | 'skipPhase' | 'newRoll' | 'resetDoor' | 'testFlash' | 'testDevelop' | 'setConfig';

export type ClientMsg =
  | { type: 'hello'; role: Role; token?: string }
  | { type: 'time'; clientTime: number }
  | { type: 'hb' }
  | { type: 'START_SESSION'; token?: string }
  | { type: 'AUDIO_ENERGY'; level: number }
  | { type: 'TRIGGER_FIX' }
  | {
      type: 'freeze';
      data: string;
      forecastData?: string;
      collapseZone?: CollapseZone | null;
      deviationPct?: number | null;
    }
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
