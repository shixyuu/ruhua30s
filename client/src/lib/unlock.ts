/** First-tap start overlay: unlocks AudioContext, media permissions, fullscreen and keep-awake in one gesture */
import { unlockAudio } from './sfx';

let wakeLock: any = null;
let silentAudio: HTMLAudioElement | null = null;

export async function requestFullscreen(): Promise<void> {
  const el = document.documentElement as any;
  try {
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) return;
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch {
    /* iPhone Safari has no web fullscreen: use "Add to Home Screen" instead */
  }
}

/** dataURL of a 1-second silent WAV */
function silentWav(): string {
  const sr = 8000;
  const n = sr;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  w(36, 'data');
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

export async function keepAwake(): Promise<void> {
  const nav = navigator as any;
  if (nav.wakeLock?.request) {
    try {
      wakeLock = await nav.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => (wakeLock = null));
      return;
    } catch {
      /* fall back to the silent-audio trick */
    }
  }
  // older iPads: a looping silent <audio> keeps the screen awake
  if (!silentAudio) {
    silentAudio = document.createElement('audio');
    silentAudio.src = silentWav();
    silentAudio.loop = true;
    silentAudio.setAttribute('playsinline', '');
    silentAudio.volume = 0.01;
    document.body.appendChild(silentAudio);
  }
  try {
    await silentAudio.play();
  } catch {
    /* ignore */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if ((navigator as any).wakeLock && !wakeLock) keepAwake();
    silentAudio?.play().catch(() => {});
  }
});

export interface UnlockOptions {
  /** device code, e.g. "T-02" */
  code?: string;
  /** route line, e.g. "/station1" */
  kicker?: string;
  title: string;
  subtitle?: string;
  button?: string;
  /** runs inside the user gesture (camera / microphone permission etc.) */
  onUnlock?: () => Promise<void> | void;
  fullscreen?: boolean;
}

export function showStartOverlay(opts: UnlockOptions): Promise<void> {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'start-overlay';
    const code = opts.code || 'RH';
    const seed = [...code].reduce((a, c) => a + c.charCodeAt(0), 0);
    ov.innerHTML = `
      ${filmStrip(seed % 20 + 1)}
      <div class="start-wrap">
        <div class="cassette">
          <div class="band"><span class="iso">135</span><span class="brand">RUHUA RH-30</span><span class="iso">36 EXP</span></div>
          <div class="body">
            <div class="kicker"><span class="k1"></span><span class="k2"></span></div>
            <div class="title"></div>
            <div class="sub"></div>
          </div>
          <div class="dx"><div class="cells">${dxCells(seed)}</div><div class="exp">${escapeHtml(code)}<small>ISO 400/27°</small></div></div>
          <span class="stamp">Load in subdued light</span>
        </div>
        <button class="start-btn"></button>
        <div class="start-err"></div>
      </div>
      ${filmStrip(seed % 20 + 15)}`;
    ov.querySelector('.k1')!.textContent = `Thirty Seconds Into the Frame · ${opts.kicker || location.pathname}`;
    ov.querySelector('.k2')!.textContent = code;
    ov.querySelector('.title')!.textContent = opts.title;
    ov.querySelector('.sub')!.textContent = opts.subtitle || '';
    const btn = ov.querySelector('.start-btn') as HTMLButtonElement;
    btn.textContent = opts.button || 'Tap to start';
    const err = ov.querySelector('.start-err') as HTMLDivElement;
    document.body.appendChild(ov);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      // call synchronously so we are still inside the user gesture
      const audioP = unlockAudio();
      const fsP = opts.fullscreen === false ? Promise.resolve() : requestFullscreen();
      const wakeP = keepAwake();
      try {
        await opts.onUnlock?.();
      } catch (e) {
        err.textContent = 'Media permission failed: ' + ((e as Error)?.message || e) + ' (HTTPS and browser permission required)';
      }
      await Promise.allSettled([audioP, fsP, wakeP]);
      ov.remove();
      resolve();
    });
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** tiny deterministic PRNG so edge prints look the same on every reload */
function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1000) / 1000;
  };
}

/** DX-style barcode (invented pattern, not a real DX code) as inline SVG */
export function dxBars(seed: number, n = 18): string {
  const r = rng(seed);
  let x = 0;
  let rects = '';
  for (let i = 0; i < n; i++) {
    const w = r() < 0.5 ? 2 : 4;
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="9"/>`;
    x += w;
  }
  return `<svg viewBox="0 0 ${x} 9" width="${x}" height="9" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}

/** 2×6 checkerboard of a cassette DX panel */
function dxCells(seed: number): string {
  const r = rng(seed + 7);
  let out = '';
  for (let i = 0; i < 12; i++) out += `<i class="${i < 2 || r() < 0.5 ? 'k' : 's'}"></i>`;
  return out;
}

/** edge print run (invented brand text, never a real trademark) */
export function edgeText(start = 1, count = 16): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const nn = String(n).padStart(2, '0');
    parts.push(
      i % 3 === 0
        ? `<span>RUHUA SAFETY FILM</span><span>RH 3030</span>${dxBars(n * 31)}`
        : i % 3 === 1
          ? `<span class="fr">▸${nn}</span><span>${nn}A</span>`
          : `<span>${nn}</span>${dxBars(n * 17, 12)}<span class="fr">▸${nn}A</span>`,
    );
  }
  return parts.join('');
}

/** full film edge strip: sprockets + edge print + DX bars + frame numbers */
export function filmStrip(start = 1, cls = ''): string {
  return `<div class="filmstrip ${cls}"><div class="holes"></div><div class="print">${edgeText(start)}</div></div>`;
}

/** four crop / registration marks */
export function cropMarks(): string {
  return '<span class="crop a"></span><span class="crop b"></span><span class="crop c"></span><span class="crop d"></span>';
}
