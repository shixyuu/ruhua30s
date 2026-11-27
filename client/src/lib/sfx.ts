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

/** must run inside a user gesture: unlocks AudioContext (iOS requires a silent buffer played) */
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

/** Chrome 110+ supports AudioContext.setSinkId */
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

// mechanical darkroom switches
/** Crisp swing-arm red safelight filter paddle click */
export function safelightClick(volume = 0.65): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  const src = c.createBufferSource();
  src.buffer = noise();
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 2.6;
  const g = c.createGain();
  env(g, t, 0.0012, 0.48 * volume, 0.025);
  src.connect(bp).connect(g).connect(out());
  src.start(t, Math.random());
  src.stop(t + 0.05);

  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.025);
  const og = c.createGain();
  env(og, t, 0.001, 0.28 * volume, 0.03);
  o.connect(og).connect(out());
  o.start(t);
  o.stop(t + 0.045);
}

/** Heavy enlarger timer relay switch clack (on = lamp ignite, off = lamp extinguish) */
export function relayClick(on: boolean, volume = 0.85): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  const f1 = on ? 1650 : 1280;
  const f2 = on ? 2900 : 2100;

  for (const [dt, freq, peak] of [
    [0, f1, 0.55],
    [0.014, f2, 0.36],
  ] as const) {
    const src = c.createBufferSource();
    src.buffer = noise();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.1;
    const g = c.createGain();
    env(g, t + dt, 0.001, peak * volume, 0.032);
    src.connect(bp).connect(g).connect(out());
    src.start(t + dt, Math.random());
    src.stop(t + dt + 0.06);
  }

  const thump = c.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(on ? 190 : 145, t);
  thump.frequency.exponentialRampToValueAtTime(55, t + 0.045);
  const tg = c.createGain();
  env(tg, t, 0.001, 0.42 * volume, 0.05);
  thump.connect(tg).connect(out());
  thump.start(t);
  thump.stop(t + 0.07);
}

/** Single crisp mechanical camera shutter / fixation lock release */
export function shutter(volume = 0.95): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  for (const [dt, f, peak] of [
    [0, 3150, 0.85],
    [0.056, 1750, 0.52],
  ] as const) {
    const src = c.createBufferSource();
    src.buffer = noise();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 1.4;
    const g = c.createGain();
    env(g, t + dt, 0.0018, peak * volume, 0.046);
    src.connect(bp).connect(g).connect(out());
    src.start(t + dt, Math.random());
    src.stop(t + dt + 0.09);
  }
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(170, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.065);
  const g = c.createGain();
  env(g, t, 0.002, 0.55 * volume, 0.07);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.1);
}

// 1 Hz enlarger timer metronome (EXPOSURE)
let timerInterval: number | null = null;
let nextTickAt = 0;
let tickParity = 0;
let timerBus: GainNode | null = null;

function playEscapementTick(t: number, bus: GainNode, parity: number): void {
  const c = audioCtx();
  const src = c.createBufferSource();
  src.buffer = noise();
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = parity === 0 ? 2150 : 1780;
  bp.Q.value = 3.2;
  const cg = c.createGain();
  env(cg, t, 0.0012, parity === 0 ? 0.25 : 0.2, 0.016);
  src.connect(bp).connect(cg).connect(bus);
  src.start(t, (parity * 0.37) % 1.5);
  src.stop(t + 0.03);

  const body = c.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(parity === 0 ? 420 : 360, t);
  body.frequency.exponentialRampToValueAtTime(140, t + 0.018);
  const bg = c.createGain();
  env(bg, t, 0.001, 0.075, 0.02);
  body.connect(bg).connect(bus);
  body.start(t);
  body.stop(t + 0.03);
}

let timerPeriodSec = 1.0;

export const enlargerTimer = {
  start(level = 0.85, fadeSec = 0.12, periodSec = 1.0): void {
    timerPeriodSec = Math.max(0.25, periodSec);
    const c = audioCtx();
    if (!timerBus) {
      timerBus = c.createGain();
      timerBus.gain.value = 0;
      timerBus.connect(out());
    }
    const g = timerBus.gain;
    g.cancelScheduledValues(c.currentTime);
    g.setValueAtTime(Math.max(g.value, 0.0001), c.currentTime);
    g.linearRampToValueAtTime(level, c.currentTime + Math.max(0.02, fadeSec));

    if (timerInterval !== null) return;
    tickParity = 0;
    nextTickAt = c.currentTime + 0.08;
    const scheduler = () => {
      const now = c.currentTime;
      while (nextTickAt < now + 0.25) {
        playEscapementTick(nextTickAt, timerBus!, tickParity);
        tickParity ^= 1;
        nextTickAt += timerPeriodSec;
      }
    };
    scheduler();
    timerInterval = window.setInterval(scheduler, 80);
  },

  stop(fadeSec = 0.06): void {
    const c = audioCtx();
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerBus) {
      timerBus.gain.cancelScheduledValues(c.currentTime);
      timerBus.gain.setValueAtTime(timerBus.gain.value, c.currentTime);
      timerBus.gain.linearRampToValueAtTime(0, c.currentTime + fadeSec);
    }
  },
};

// chemical bath ambient feedback (DEVELOPING)
let bathSrc: AudioBufferSourceNode | null = null;
let bathFilter: BiquadFilterNode | null = null;
let bathGain: GainNode | null = null;
let bathLfo: OscillatorNode | null = null;
let overCrackleSrc: AudioBufferSourceNode | null = null;
let overCrackleGain: GainNode | null = null;

export const devBathAudio = {
  start(): void {
    if (bathSrc) return;
    const c = audioCtx();

    // Subtle low-frequency liquid bath murmur (90–380 Hz)
    bathSrc = c.createBufferSource();
    bathSrc.buffer = noise();
    bathSrc.loop = true;

    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 75;

    bathFilter = c.createBiquadFilter();
    bathFilter.type = 'lowpass';
    bathFilter.frequency.value = 240;
    bathFilter.Q.value = 1.1;

    bathGain = c.createGain();
    bathGain.gain.setValueAtTime(0.0001, c.currentTime);
    bathGain.gain.linearRampToValueAtTime(0.045, c.currentTime + 0.45);

    // Slow agitation swell
    bathLfo = c.createOscillator();
    bathLfo.frequency.value = 0.28;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 55;
    bathLfo.connect(lfoGain).connect(bathFilter.frequency);

    bathSrc.connect(hp).connect(bathFilter).connect(bathGain).connect(out());
    bathSrc.start(c.currentTime);
    bathLfo.start(c.currentTime);

    // Subtle granular overdevelopment crackle channel (silent until devProgress > 1.0)
    overCrackleSrc = c.createBufferSource();
    overCrackleSrc.buffer = noise();
    overCrackleSrc.loop = true;

    const cb = c.createBiquadFilter();
    cb.type = 'bandpass';
    cb.frequency.value = 3400;
    cb.Q.value = 2.8;

    overCrackleGain = c.createGain();
    overCrackleGain.gain.value = 0.0001;

    overCrackleSrc.connect(cb).connect(overCrackleGain).connect(out());
    overCrackleSrc.start(c.currentTime);
  },

  update(devProgress: number): void {
    if (!bathFilter || !bathGain || !overCrackleGain) return;
    const c = audioCtx();
    const t = c.currentTime;
    const p = Math.max(0, devProgress);
    const norm = Math.min(1, p);
    const over = p > 1.0 ? Math.min(1, (p - 1.0) / 0.45) : 0;

    bathFilter.frequency.setTargetAtTime(220 + norm * 320 + over * 260, t, 0.08);
    bathGain.gain.setTargetAtTime(0.04 + norm * 0.045, t, 0.08);
    // Restrained granular electrical texture above 100% — tactile warning, never an alarm
    overCrackleGain.gain.setTargetAtTime(over > 0 ? 0.004 + over * 0.028 : 0.0001, t, 0.08);
  },

  stop(fadeSec = 0.08): void {
    const c = audioCtx();
    const s1 = bathSrc;
    const s2 = overCrackleSrc;
    const lfo = bathLfo;
    const g1 = bathGain;
    const g2 = overCrackleGain;

    bathSrc = null;
    overCrackleSrc = null;
    bathLfo = null;
    bathFilter = null;
    bathGain = null;
    overCrackleGain = null;

    if (g1) {
      g1.gain.cancelScheduledValues(c.currentTime);
      g1.gain.setValueAtTime(g1.gain.value, c.currentTime);
      g1.gain.linearRampToValueAtTime(0.0001, c.currentTime + fadeSec);
    }
    if (g2) {
      g2.gain.cancelScheduledValues(c.currentTime);
      g2.gain.setValueAtTime(g2.gain.value, c.currentTime);
      g2.gain.linearRampToValueAtTime(0.0001, c.currentTime + fadeSec);
    }

    window.setTimeout(() => {
      for (const n of [s1, s2, lfo]) {
        try {
          n?.stop();
        } catch {
          /* ignore */
        }
      }
    }, Math.ceil(fadeSec * 1000) + 40);
  },
};

export function stopAllLoops(): void {
  enlargerTimer.stop();
  devBathAudio.stop();
}

/** Neutral 880Hz 120ms laboratory instrument chime when /station1 & /station2 wake up */
export function stationWakeChime(): void {
  const c = audioCtx();
  const t = c.currentTime + 0.01;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.14);
}

/** Low stop-bath thud for OVERDEVELOPED / UNDERDEVELOPED fixation */
export function stopBathThud(): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.16);
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.2);
}

/** Harsh brief door-open / light-burst sound for UNFIXED LIGHT LEAK */
export function lightLeakBurst(): void {
  const c = audioCtx();
  const t = c.currentTime + 0.01;

  // Door latch slam + harsh white-light noise sweep
  const n = c.createBufferSource();
  n.buffer = noise();
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(1800, t);
  bp.frequency.exponentialRampToValueAtTime(420, t + 0.55);
  bp.Q.value = 0.8;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.55, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  n.connect(bp).connect(ng).connect(out());
  n.start(t);
  n.stop(t + 0.62);

  // Brief high-frequency flash arc
  const o = c.createOscillator();
  const og = c.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(1240, t);
  o.frequency.exponentialRampToValueAtTime(220, t + 0.35);
  og.gain.setValueAtTime(0.18, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
  o.connect(og).connect(out());
  o.start(t);
  o.stop(t + 0.4);
}
