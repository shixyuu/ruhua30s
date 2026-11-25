/**
 * 《入画三十秒》前后端共享协议定义。
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

/** 各阶段“剧情时长”（秒）。ENTER_BUFFER 由 config.enterBufferSec 决定。 */
export const PHASE_SECONDS: Record<Exclude<Phase, 'IDLE' | 'ENTER_BUFFER'>, number> = {
  ACTIVE_30S: 30,
  FLASH_FREEZE: 2.5,
  REWIND: 3,
  REPLAY_TRUTH: 30,
  CCTV_REVEAL: 6,
};

/** ACTIVE_30S 内的剧情节点（秒） */
export const TIMELINE = {
  station1A: [5, 13] as const, // 来电与喊话录音
  station1B: [13, 21] as const, // 诱导挡光
  station2C: [21, 30] as const, // 拉闸
  breakerSpoilerGuard: 28.5, // 早于此时间拉闸 → 锁定
  breakerDelayedFlash: 29.5, // 锁定后在此时刻闪白
  filmNodes: [6, 15, 28] as const, // 模拟底片标记节点
  bystanderLastSec: 4, // REPLAY_TRUTH 最后 4 秒显示旁观者结局
};

export interface AppConfig {
  /** 入场缓冲秒数（2~8，默认 4） */
  enterBufferSec: number;
}

export const ENTER_BUFFER_MIN = 2;
export const ENTER_BUFFER_MAX = 8;

export const DEFAULT_CONFIG: AppConfig = {
  enterBufferSec: 4,
};

export interface RoundInfo {
  id: number;
  activeStartedAt: number | null;
  didSpeak: boolean;
  didPullBreaker: boolean;
  audioOffsetMs: number | null;
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
  | { type: 'flash'; serverTime: number } // 测试闪白（仅发往 /main）
  | { type: 'audio'; mime: string; data: string; audioOffsetMs: number; roundId: number }
  | { type: 'cctv'; data: string; serverTime: number }
  | { type: 'clients'; clients: ClientStatus[]; serverTime: number }
  | { type: 'breaker'; status: 'locked' | 'flash'; atSec: number }
  | { type: 'ack'; what: string; ok: boolean; message?: string }
  | { type: 'error'; message: string };

// ---------------- 客户端 → 服务端 ----------------
/** 状态机只能由 admin 端发送 START_SESSION 启动 */
export type AdminAction = 'reset' | 'resetDoor' | 'testFlash' | 'setConfig';

export type ClientMsg =
  | { type: 'hello'; role: Role; token?: string }
  | { type: 'time'; clientTime: number }
  | { type: 'hb' }
  | { type: 'START_SESSION'; token?: string }
  | { type: 'speak'; mime: string; data: string; audioOffsetMs: number }
  | { type: 'breaker' }
  | { type: 'freeze'; data: string }
  | { type: 'cctv'; data: string }
  | { type: 'admin'; action: AdminAction; config?: Partial<AppConfig>; token?: string };
