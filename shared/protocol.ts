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

/** Live detection telemetry streamed /main -> /admin while the admin DETECT VIEW is on */
export interface DetectStatsMsg {
  phase: string;
  camLive: boolean;
  hasRef: boolean;
  refKind: 'round' | 'preview';
  activePct: number;
  photoActivePct: number;
  threshold: number;
  minAreaPct: number;
  triggered: boolean;
  aeScale: number;
}

export interface CalibrationData {
  /** 4 corners in camera snapshot normalized coords: [TL, TR, BR, BL] */
  corners: [Point2D, Point2D, Point2D, Point2D] | null;
  /** 3x3 inverse homography matrix (row-major 9 floats): 320x180 grid -> camera normalized [0..1] */
  hInv: number[] | null;
  updatedAt: number | null;
}

export interface AppConfig {
  /** OBSERVE duration, seconds (3–20, default 8) */
  observeSec: number;
  /** EXPOSE duration, seconds (10–60, default 30) */
  exposeSec: number;
  /** DEVELOP duration, seconds (10–45, default 25) */
  developSec: number;
  /** REVEAL duration, seconds (6–25, default 12) */
  revealSec: number;
  /** Mic noise floor (0–0.50, default 0.08) */
  noiseFloor: number;
  /** Development per second at full energy (0.03–0.80, default 0.20) */
  devSpeed: number;
  /** Easel margin percent (0–30, default 6) */
  easelMargin: number;
  /** Camera diff threshold; lower = more sensitive (0.02–0.50, default 0.12) */
  diffSensitivity: number;
  /** Diff-map box-blur radius in grid px (0–4, default 0) */
  detectBlur: number;
  /** Ignore frames with less than this % of the grid changed (0–10, default 0) */
  detectMinArea: number;
  /** Seconds of blocking to reach full dodge (5–40, default 18) */
  fullDodgeSec: number;
  /** Paint dodge on /main with the mouse when no camera is available */
  mouseSimulator: boolean;
  /** 0 = off, 1..6 = built-in sample, 7 = last print */
  sampleFallback: number;
  /** Current roll number (increments on NEW ROLL) */
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
  detectBlur: { min: 0, max: 4 },
  detectMinArea: { min: 0, max: 10 },
  fullDodgeSec: { min: 5, max: 40 },
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
  detectBlur: 0,
  detectMinArea: 0,
  fullDodgeSec: 18,
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
  hasQueuedPhoto: boolean; // queue head exists
  queuedPhotoUrl: string | null; // queue head URL
  queuedAt: number | null; // queue head upload time
  /** FIFO upload queue (oldest first), max QUEUE_MAX */
  queue: QueuedPhoto[];
  queueLength: number;
  queueMax: number;
}

export interface QueuedPhoto {
  file: string; // file name inside data/queue/
  url: string;
  at: number;
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

// server -> client
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
  | { type: 'DETECT_VIEW'; on: boolean; reref?: boolean }
  | { type: 'REREF_EVENT'; kind: 'round' | 'preview'; reason: string; frames: number; ts: number }
  | { type: 'DETECT_FRAME'; imageData: string; stats: DetectStatsMsg; ts: number }
  | { type: 'door-photo'; photo: DoorPhotoInfo; serverTime: number }
  | { type: 'contact-sheet'; sheet: ContactSheetInfo; serverTime: number }
  | { type: 'STATE_SYNC'; persisted: PersistedState; storage: StorageStats; serverTime: number }
  | { type: 'FLASH_PULSE'; durationMs: number; ts: number }
  | { type: 'clients'; clients: ClientStatus[]; serverTime: number }
  | { type: 'ack'; what: string; ok: boolean; message?: string }
  | { type: 'error'; message: string };

// client -> server
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
  | { type: 'DETECT_VIEW'; on: boolean; reref?: boolean; token?: string }
  | { type: 'REREF_EVENT'; kind: 'round' | 'preview'; reason: string; frames: number }
  | { type: 'DETECT_FRAME'; imageData: string; stats: DetectStatsMsg }
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
