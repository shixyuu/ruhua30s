import type {
  AppConfig,
  ClientMsg,
  ContactSheetInfo,
  DoorPhotoInfo,
  Phase,
  Role,
  RoundInfo,
  ServerMsg,
} from '../../../shared/protocol';

export type StateMsg = Extract<ServerMsg, { type: 'state' }>;
type Handler<T extends ServerMsg['type']> = (msg: Extract<ServerMsg, { type: T }>) => void;

/**
 * WebSocket client:
 *  - exponential back-off reconnect (0.5s → 1s → 2s … capped at 10s, with jitter)
 *  - after reconnecting the server immediately sends state / config / door-photo / contact-sheet for a full resync
 *  - NTP-style clock sync: uses the offset of the lowest-RTT sample among recent ones
 */
export class Net {
  readonly role: Role;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private handlers = new Map<string, Set<(m: any) => void>>();
  private samples: { rtt: number; offset: number }[] = [];
  private syncTimer: number | null = null;
  private hbTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private token?: string;

  /** serverTime - Date.now() */
  offset = 0;
  rtt = 0;
  connected = false;
  state: StateMsg | null = null;
  config: AppConfig | null = null;
  doorPhoto: DoorPhotoInfo | null = null;
  contactSheet: ContactSheetInfo | null = null;

  constructor(role: Role, token?: string) {
    this.role = role;
    this.token = token;
  }

  get phase(): Phase {
    return this.state?.state ?? 'IDLE';
  }

  get round(): RoundInfo | null {
    return this.state?.round ?? null;
  }

  get timeScale(): number {
    return this.state?.timeScale ?? 1;
  }

  /** server time (ms) */
  now(): number {
    return Date.now() + this.offset;
  }

  /** real milliseconds elapsed in the current phase */
  elapsedMs(): number {
    return this.state ? this.now() - this.state.phaseStartedAt : 0;
  }

  /** story seconds of the current phase (TIME_SCALE undone) */
  storySec(): number {
    return this.elapsedMs() / this.timeScale / 1000;
  }

  /** real milliseconds left in the phase */
  remainingMs(): number {
    if (!this.state || !this.state.phaseDurationMs) return 0;
    return Math.max(0, this.state.phaseDurationMs - this.elapsedMs());
  }

  /** server time → local Date.now() time usable for performance/AudioContext */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  on<T extends ServerMsg['type'] | 'open' | 'close'>(
    type: T,
    fn: T extends ServerMsg['type'] ? Handler<T> : () => void,
  ): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn as any);
    return () => this.handlers.get(type)?.delete(fn as any);
  }

  private emit(type: string, msg?: unknown): void {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        fn(msg);
      } catch (err) {
        console.error(err);
      }
    });
  }

  send(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** bytes queued in the send buffer (CCTV frame back-pressure) */
  buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this.send({ type: 'hello', role: this.role, token: this.token });
      this.burstSync();
      this.startTimers();
      this.emit('open');
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.stopTimers();
      if (this.ws === ws) this.ws = null;
      if (was) this.emit('close');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = Math.min(10_000, 500 * 2 ** this.attempt);
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 8);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startTimers(): void {
    this.stopTimers();
    this.syncTimer = window.setInterval(() => this.send({ type: 'time', clientTime: Date.now() }), 10_000);
    this.hbTimer = window.setInterval(() => this.send({ type: 'hb' }), 5_000);
  }

  private stopTimers(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.syncTimer = this.hbTimer = null;
  }

  private burstSync(): void {
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => this.send({ type: 'time', clientTime: Date.now() }), i * 180);
    }
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case 'time': {
        if (msg.clientTime > 0) {
          const t1 = Date.now();
          const rtt = t1 - msg.clientTime;
          const offset = msg.serverTime - (msg.clientTime + t1) / 2;
          this.samples.push({ rtt, offset });
          if (this.samples.length > 10) this.samples.shift();
          const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
          this.offset = best.offset;
          this.rtt = best.rtt;
        } else if (this.samples.length === 0) {
          this.offset = msg.serverTime - Date.now();
        }
        break;
      }
      case 'state':
        if (this.samples.length === 0) this.offset = msg.serverTime - Date.now();
        this.state = msg;
        this.doorPhoto = msg.doorPhoto;
        break;
      case 'config':
        this.config = msg.config;
        break;
      case 'door-photo':
        this.doorPhoto = msg.photo;
        break;
      case 'contact-sheet':
        this.contactSheet = msg.sheet;
        break;
    }
    this.emit(msg.type, msg);
  }
}

/** connection dot in the corner (turns safelight red when offline) */
export function mountNetDot(net: Net): void {
  const dot = document.createElement('div');
  dot.className = 'net-dot';
  document.body.appendChild(dot);
  const upd = () => dot.classList.toggle('off', !net.connected);
  net.on('open', upd);
  net.on('close', upd);
  upd();
}
