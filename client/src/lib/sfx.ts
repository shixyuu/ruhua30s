/**
 * Every sound is synthesised live with the Web Audio API: shutter, heartbeat, ringtone, alarms, rewind.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function audioCtx(): AudioContext {
  if (!ctx) {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function out(): GainNode {
  audioCtx();
  return master!;
}

/** must run inside a user gesture: unlocks the AudioContext (iOS needs an empty buffer played) */
export async function unlockAudio(): Promise<void> {
  const c = audioCtx();
  try {
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  } catch {
    /* ignore */
  }
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* ignore */
    }
  }
}

/** Chrome 110+ supports AudioContext.setSinkId to switch the audio output device */
export async function setAudioSink(deviceId: string): Promise<boolean> {
  const c = audioCtx() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!deviceId || typeof c.setSinkId !== 'function') return false;
  try {
    await c.setSinkId(deviceId === 'default' ? '' : deviceId);
    return true;
  } catch (err) {
    console.warn('setSinkId failed', err);
    return false;
  }
}

function noise(): AudioBuffer {
  const c = audioCtx();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function env(g: GainNode, t: number, a: number, peak: number, d: number): void {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

// ---------------------------------------------------------------- shutter
export function shutter(volume = 1): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  // mechanical clack: two band-passed noise bursts + a low thump
  for (const [dt, f, peak] of [
    [0, 3200, 0.9],
    [0.065, 1800, 0.6],
  ] as const) {
    const src = c.createBufferSource();
    src.buffer = noise();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 1.2;
    const g = c.createGain();
    env(g, t + dt, 0.002, peak * volume, 0.06);
    src.connect(bp).connect(g).connect(out());
    src.start(t + dt, Math.random());
    src.stop(t + dt + 0.12);
  }
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(180, t);
  o.frequency.exponentialRampToValueAtTime(50, t + 0.08);
  const g = c.createGain();
  env(g, t, 0.002, 0.7 * volume, 0.09);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.12);
}

// ---------------------------------------------------------------- loop scheduler
class Loop {
  private timer: number | null = null;
  private nextAt = 0;
  readonly bus: GainNode;
  constructor(
    private interval: () => number,
    private play: (t: number, bus: GainNode) => void,
  ) {
    this.bus = audioCtx().createGain();
    this.bus.gain.value = 0;
    this.bus.connect(out());
  }
  get running(): boolean {
    return this.timer !== null;
  }
  start(level = 1, fadeSec = 0.05): void {
    const c = audioCtx();
    const g = this.bus.gain;
    g.cancelScheduledValues(c.currentTime);
    g.setValueAtTime(Math.max(g.value, 0.0001), c.currentTime);
    g.linearRampToValueAtTime(level, c.currentTime + Math.max(0.02, fadeSec));
    if (this.timer !== null) return;
    this.nextAt = c.currentTime + 0.05;
    const tick = () => {
      const now = audioCtx().currentTime;
      while (this.nextAt < now + 0.25) {
        this.play(this.nextAt, this.bus);
        this.nextAt += this.interval();
      }
    };
    tick();
    this.timer = window.setInterval(tick, 60);
  }
  level(v: number, rampSec = 0.3): void {
    const c = audioCtx();
    this.bus.gain.cancelScheduledValues(c.currentTime);
    this.bus.gain.setValueAtTime(this.bus.gain.value, c.currentTime);
    this.bus.gain.linearRampToValueAtTime(v, c.currentTime + rampSec);
  }
  stop(fadeSec = 0.05): void {
    if (this.timer === null) return;
    const c = audioCtx();
    this.bus.gain.cancelScheduledValues(c.currentTime);
    this.bus.gain.setValueAtTime(this.bus.gain.value, c.currentTime);
    this.bus.gain.linearRampToValueAtTime(0, c.currentTime + fadeSec);
    clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------- heartbeat
let heartRate = 72;
function thump(t: number, bus: GainNode, strength: number): void {
  const c = audioCtx();
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(95, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.13);
  const g = c.createGain();
  env(g, t, 0.008, strength, 0.2);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 180;
  o.connect(lp).connect(g).connect(bus);
  o.start(t);
  o.stop(t + 0.3);
}
let heartLoop: Loop | null = null;
function heart(): Loop {
  if (!heartLoop) {
    heartLoop = new Loop(
      () => 60 / heartRate,
      (t, bus) => {
        thump(t, bus, 1);
        thump(t + 0.22, bus, 0.65);
      },
    );
  }
  return heartLoop;
}
export const heartbeat = {
  start(fadeSec = 2, level = 0.9) {
    heart().start(level, fadeSec);
  },
  setRate(bpm: number) {
    heartRate = Math.max(40, Math.min(180, bpm));
  },
  stop(fadeSec = 0.05) {
    heartLoop?.stop(fadeSec);
  },
};

// ---------------------------------------------------------------- ringtone (urgent two-tone)
let ringLoop: Loop | null = null;
export const ring = {
  start() {
    if (!ringLoop) {
      ringLoop = new Loop(
        () => 0.9,
        (t, bus) => {
          const c = audioCtx();
          for (let k = 0; k < 2; k++) {
            const tt = t + k * 0.25;
            for (const f of [1400, 1750]) {
              const o = c.createOscillator();
              o.type = 'square';
              o.frequency.value = f;
              const am = c.createOscillator();
              am.frequency.value = 22;
              const amg = c.createGain();
              amg.gain.value = 0.5;
              const g = c.createGain();
              g.gain.setValueAtTime(0, tt);
              g.gain.linearRampToValueAtTime(0.08, tt + 0.01);
              g.gain.setValueAtTime(0.08, tt + 0.19);
              g.gain.linearRampToValueAtTime(0, tt + 0.2);
              am.connect(amg).connect(g.gain);
              o.connect(g).connect(bus);
              o.start(tt);
              am.start(tt);
              o.stop(tt + 0.21);
              am.stop(tt + 0.21);
            }
          }
        },
      );
    }
    ringLoop.start(1, 0.02);
  },
  duck(v: number) {
    ringLoop?.level(v, 0.1);
  },
  stop() {
    ringLoop?.stop();
  },
};

// ---------------------------------------------------------------- alarms
type AlarmKind = 'overexposure' | 'danger';
const alarmLoops: Partial<Record<AlarmKind, Loop>> = {};
export const alarm = {
  start(kind: AlarmKind = 'danger', level = 0.6) {
    let l = alarmLoops[kind];
    if (!l) {
      l =
        kind === 'danger'
          ? new Loop(
              () => 0.5,
              (t, bus) => {
                // danger: fast up/down sawtooth sweep
                const c = audioCtx();
                const o = c.createOscillator();
                o.type = 'sawtooth';
                o.frequency.setValueAtTime(700, t);
                o.frequency.linearRampToValueAtTime(1500, t + 0.25);
                o.frequency.linearRampToValueAtTime(700, t + 0.5);
                const g = c.createGain();
                g.gain.setValueAtTime(0.0, t);
                g.gain.linearRampToValueAtTime(0.18, t + 0.02);
                g.gain.setValueAtTime(0.18, t + 0.47);
                g.gain.linearRampToValueAtTime(0, t + 0.5);
                const lp = c.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 4000;
                o.connect(lp).connect(g).connect(bus);
                o.start(t);
                o.stop(t + 0.51);
              },
            )
          : new Loop(
              () => 0.32,
              (t, bus) => {
                // overexposure: piercing high beeps + hiss
                const c = audioCtx();
                const o = c.createOscillator();
                o.type = 'square';
                o.frequency.value = 2600;
                const g = c.createGain();
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.07, t + 0.005);
                g.gain.setValueAtTime(0.07, t + 0.14);
                g.gain.linearRampToValueAtTime(0, t + 0.15);
                o.connect(g).connect(bus);
                o.start(t);
                o.stop(t + 0.16);
                const n = c.createBufferSource();
                n.buffer = noise();
                const hp = c.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 6000;
                const ng = c.createGain();
                ng.gain.setValueAtTime(0.05, t);
                ng.gain.linearRampToValueAtTime(0.0, t + 0.3);
                n.connect(hp).connect(ng).connect(bus);
                n.start(t, Math.random());
                n.stop(t + 0.31);
              },
            );
      alarmLoops[kind] = l;
    }
    l.start(level, 0.02);
  },
  stop(kind?: AlarmKind) {
    for (const k of Object.keys(alarmLoops) as AlarmKind[]) if (!kind || k === kind) alarmLoops[k]?.stop();
  },
};

// ---------------------------------------------------------------- rewind
export function rewindSfx(durSec = 3): void {
  const c = audioCtx();
  const t = c.currentTime + 0.01;
  // high-speed tape rewind: noise + swept band-pass + falling sawtooth whine
  const n = c.createBufferSource();
  n.buffer = noise();
  n.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 3;
  bp.frequency.setValueAtTime(400, t);
  bp.frequency.exponentialRampToValueAtTime(5000, t + durSec * 0.8);
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
  ng.gain.setValueAtTime(0.5, t + durSec - 0.25);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
  n.connect(bp).connect(ng).connect(out());
  n.start(t);
  n.stop(t + durSec + 0.05);

  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(80, t);
  o.frequency.exponentialRampToValueAtTime(900, t + durSec * 0.9);
  const wob = c.createOscillator();
  wob.frequency.value = 9;
  const wg = c.createGain();
  wg.gain.value = 40;
  wob.connect(wg).connect(o.frequency);
  const og = c.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(0.12, t + 0.2);
  og.gain.setValueAtTime(0.12, t + durSec - 0.2);
  og.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2500;
  o.connect(lp).connect(og).connect(out());
  o.start(t);
  wob.start(t);
  o.stop(t + durSec + 0.05);
  wob.stop(t + durSec + 0.05);
}

export function stopAllLoops(): void {
  heartbeat.stop();
  ring.stop();
  alarm.stop();
}
