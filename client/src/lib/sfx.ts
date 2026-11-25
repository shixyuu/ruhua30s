/**
 * Minimalist darkroom Web Audio soundscape (v2):
 *  - ACTIVE_30S: 1 Hz mechanical enlarger timer metronome + faint darkroom ambient air floor
 *  - Station phase cue: single short neutral 880 Hz sine beep (120 ms)
 *  - FLASH_FREEZE: crisp single mechanical shutter click
 *  - REWIND: restrained 35 mm motorized transport rewind
 *  - REPLAY_TRUTH: total system silence (only visitor audio clips play back)
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
/** Single crisp mechanical camera shutter release */
export function shutter(volume = 1): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  for (const [dt, f, peak] of [
    [0, 3100, 0.85],
    [0.058, 1750, 0.52],
  ] as const) {
    const src = c.createBufferSource();
    src.buffer = noise();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 1.4;
    const g = c.createGain();
    env(g, t + dt, 0.0018, peak * volume, 0.048);
    src.connect(bp).connect(g).connect(out());
    src.start(t + dt, Math.random());
    src.stop(t + dt + 0.09);
  }
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(165, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.065);
  const g = c.createGain();
  env(g, t, 0.002, 0.55 * volume, 0.07);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.1);
}

// ---------------------------------------------------------------- neutral lab instrument cue
/** Single short neutral laboratory beep (880 Hz sine, 120 ms) on terminal protocol transition */
export function cueBeep(volume = 0.16): void {
  const c = audioCtx();
  const t = c.currentTime + 0.005;
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(880, t);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(volume, t + 0.008);
  g.gain.setValueAtTime(volume * 0.9, t + 0.055);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + 0.13);
}

// ---------------------------------------------------------------- 1 Hz enlarger timer metronome + room air
let timerInterval: number | null = null;
let nextTickAt = 0;
let tickParity = 0;
let timerBus: GainNode | null = null;
let roomAirSrc: AudioBufferSourceNode | null = null;
let roomAirGain: GainNode | null = null;

function playEscapementTick(t: number, bus: GainNode, parity: number): void {
  const c = audioCtx();
  // subtle mechanical escapement click (alternating tick / tock resonance)
  const src = c.createBufferSource();
  src.buffer = noise();
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = parity === 0 ? 2150 : 1780;
  bp.Q.value = 3.2;
  const cg = c.createGain();
  env(cg, t, 0.0012, parity === 0 ? 0.24 : 0.19, 0.016);
  src.connect(bp).connect(cg).connect(bus);
  src.start(t, (parity * 0.37) % 1.5);
  src.stop(t + 0.03);

  // faint mechanical housing body click
  const body = c.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(parity === 0 ? 420 : 360, t);
  body.frequency.exponentialRampToValueAtTime(140, t + 0.018);
  const bg = c.createGain();
  env(bg, t, 0.001, 0.07, 0.02);
  body.connect(bg).connect(bus);
  body.start(t);
  body.stop(t + 0.03);
}

export const enlargerTimer = {
  start(level = 0.85, fadeSec = 0.35): void {
    const c = audioCtx();
    if (!timerBus) {
      timerBus = c.createGain();
      timerBus.gain.value = 0;
      timerBus.connect(out());
    }
    const g = timerBus.gain;
    g.cancelScheduledValues(c.currentTime);
    g.setValueAtTime(Math.max(g.value, 0.0001), c.currentTime);
    g.linearRampToValueAtTime(level, c.currentTime + Math.max(0.04, fadeSec));

    // whisper-quiet darkroom ambient room-tone floor
    if (!roomAirSrc) {
      roomAirSrc = c.createBufferSource();
      roomAirSrc.buffer = noise();
      roomAirSrc.loop = true;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 85;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 620;
      roomAirGain = c.createGain();
      roomAirGain.gain.setValueAtTime(0.0001, c.currentTime);
      roomAirGain.gain.linearRampToValueAtTime(0.014, c.currentTime + 0.5);
      roomAirSrc.connect(hp).connect(lp).connect(roomAirGain).connect(timerBus);
      roomAirSrc.start(c.currentTime);
    }

    if (timerInterval !== null) return;
    tickParity = 0;
    nextTickAt = c.currentTime + 0.06;
    const scheduler = () => {
      const now = c.currentTime;
      while (nextTickAt < now + 0.25) {
        playEscapementTick(nextTickAt, timerBus!, tickParity);
        tickParity ^= 1;
        nextTickAt += 1.0; // exact 1 Hz darkroom timer cadence
      }
    };
    scheduler();
    timerInterval = window.setInterval(scheduler, 80);
  },

  stop(fadeSec = 0.08): void {
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
    if (roomAirSrc) {
      const s = roomAirSrc;
      roomAirSrc = null;
      roomAirGain = null;
      window.setTimeout(() => {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }, Math.ceil(fadeSec * 1000) + 40);
    }
  },
};

// ---------------------------------------------------------------- restrained film transport rewind
export function rewindSfx(durSec = 3): void {
  const c = audioCtx();
  const t = c.currentTime + 0.01;

  // soft filtered film-strip transport whir (restrained, non-alarming)
  const n = c.createBufferSource();
  n.buffer = noise();
  n.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.2;
  bp.frequency.setValueAtTime(340, t);
  bp.frequency.exponentialRampToValueAtTime(1450, t + durSec * 0.65);
  bp.frequency.exponentialRampToValueAtTime(520, t + durSec);
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.linearRampToValueAtTime(0.16, t + 0.22);
  ng.gain.setValueAtTime(0.16, t + Math.max(0.25, durSec - 0.3));
  ng.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
  n.connect(bp).connect(ng).connect(out());
  n.start(t);
  n.stop(t + durSec + 0.05);

  // gentle low-frequency spool motor hum
  const motor = c.createOscillator();
  motor.type = 'triangle';
  motor.frequency.setValueAtTime(110, t);
  motor.frequency.linearRampToValueAtTime(210, t + durSec * 0.6);
  motor.frequency.linearRampToValueAtTime(125, t + durSec);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 480;
  const mg = c.createGain();
  mg.gain.setValueAtTime(0.0001, t);
  mg.gain.linearRampToValueAtTime(0.055, t + 0.25);
  mg.gain.setValueAtTime(0.055, t + Math.max(0.3, durSec - 0.3));
  mg.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
  motor.connect(lp).connect(mg).connect(out());
  motor.start(t);
  motor.stop(t + durSec + 0.05);
}

export function stopAllLoops(): void {
  enlargerTimer.stop();
}
