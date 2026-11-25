/**
 * 《入画三十秒 (RH-30)》v2 — 暗房档案与集体顺从版 前后端共享协议。
 * 服务端是唯一真相源：所有终端根据 state 包里的 serverTime / phaseStartedAt 校准本地时钟。
 */

export type Phase =
  | 'IDLE'
  | 'ENTER_BUFFER'
  | 'ACTIVE_30S'
  | 'FLASH_FREEZE'
  | 'REWIND'
  | 'REPLAY_TRUTH'
  | 'CCTV_REVEAL';

export type Role = 'main' | 'door' | 'station1' | 'station2' | 'admin';

export const ROLES: Role[] = ['main', 'door', 'station1', 'station2', 'admin'];

/** 固定阶段“剧情时长”（秒）。ENTER_BUFFER 与 CCTV_REVEAL 由 AppConfig 动态决定。 */
export const PHASE_SECONDS: Record<Exclude<Phase, 'IDLE' | 'ENTER_BUFFER' | 'CCTV_REVEAL'>, number> = {
  ACTIVE_30S: 30,
  FLASH_FREEZE: 2.5,
  REWIND: 3,
  REPLAY_TRUTH: 30,
};

/** ACTIVE_30S 内的多人并行档案校准时间窗（秒） */
export const TIMELINE = {
  station1P1: [4, 16] as const, // Protocol 01 · Vocal Calibration（多段发声校准）
  station1P2: [16, 25] as const, // Protocol 02 · Optical Dodging Assist（维持遮挡提示）
  station1Wait: [25, 30] as const, // 等待西北侧定影
  station2P2: [8, 21] as const, // Protocol 02 · Optical Dodging（提前唤醒引导群体挡光）
  station2P3: [21, 30] as const, // Protocol 03 · Fixation（阻尼推杆终止显影）
  breakerSpoilerGuard: 28.5, // 早于此时间拉到底 → 锁定 FIXING EXPOSURE...
  breakerDelayedFlash: 29.5, // 锁定后在此时刻触发全局定格
  maxAudioClips: 4, // 每轮最多录制段数
  maxClipDurationSec: 6, // 单段最长秒数
};

export interface AppConfig {
  /** 入场缓冲秒数（2~10，默认 6） */
  enterBufferSec: number;
  /** CCTV 揭晓秒数（4~15，默认 8） */
  cctvRevealSec: number;
  /** 当前胶卷编号（从 1 开始，NEW ROLL 时递增，历史照片按卷归档保留） */
  rollNumber: number;
}

export const ENTER_BUFFER_MIN = 2;
export const ENTER_BUFFER_MAX = 10;
export const CCTV_REVEAL_MIN = 4;
export const CCTV_REVEAL_MAX = 15;

export const DEFAULT_CONFIG: AppConfig = {
  enterBufferSec: 6,
  cctvRevealSec: 8,
  rollNumber: 1,
};

export interface AudioClip {
  mime: string;
  dataUrl: string;
  offsetMs: number;
}

export interface RoundInfo {
  id: number;
  rollNumber: number;
  frameNumber: number; // 当前卷内的底片序号（1 → 01A）
  activeStartedAt: number | null;
  didSpeak: boolean;
  audioClipCount: number;
  audioOffsetsMs: number[];
  didPullBreaker: boolean;
  breakerPulledAtSec: number | null;
  breakerLocked: boolean;
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
}

export interface ContactSheetInfo {
  rollNumber: number;
  totalInRoll: number;
  frames: ContactFrame[];
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
    }
  | { type: 'time'; clientTime: number; serverTime: number }
  | { type: 'config'; config: AppConfig }
  | { type: 'door-photo'; photo: DoorPhotoInfo; serverTime: number }
  | { type: 'contact-sheet'; sheet: ContactSheetInfo; serverTime: number }
  | { type: 'flash'; serverTime: number } // 测试闪白（仅发往 /main）
  | { type: 'audio'; clip: AudioClip; index: number; roundId: number }
  | { type: 'audio-sync'; clips: AudioClip[]; roundId: number }
  | { type: 'cctv'; data: string; serverTime: number }
  | { type: 'clients'; clients: ClientStatus[]; serverTime: number }
  | { type: 'breaker'; status: 'locked' | 'flash'; atSec: number }
  | { type: 'ack'; what: string; ok: boolean; message?: string }
  | { type: 'error'; message: string };

// ---------------- 客户端 → 服务端 ----------------
/** 状态机只能由 admin 端发送 START_SESSION 启动 */
export type AdminAction = 'reset' | 'skipPhase' | 'newRoll' | 'resetDoor' | 'testFlash' | 'setConfig';

export type ClientMsg =
  | { type: 'hello'; role: Role; token?: string }
  | { type: 'time'; clientTime: number }
  | { type: 'hb' }
  | { type: 'START_SESSION'; token?: string }
  | { type: 'speak'; mime: string; dataUrl: string; offsetMs: number }
  | { type: 'breaker' }
  | { type: 'freeze'; data: string }
  | { type: 'cctv'; data: string }
  | { type: 'admin'; action: AdminAction; config?: Partial<AppConfig>; token?: string };
