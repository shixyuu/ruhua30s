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
  code?: string;
  kicker?: string;
  title: string;
  subtitle?: string;
  button?: string;
  onUnlock?: () => Promise<void> | void;
  fullscreen?: boolean;
}

export function withTimeout<T>(p: Promise<T>, ms = 600): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => window.setTimeout(r, ms))]);
}

export function showStartOverlay(opts: UnlockOptions): Promise<void> {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'start-overlay';
    const code = opts.code || 'RH';
    ov.innerHTML = `
      <div class="start-panel">
        <div class="start-head">
          <span class="mono">${escapeHtml(code)}</span>
          <span class="mono">${escapeHtml(opts.kicker || location.pathname)}</span>
        </div>
        <div class="start-title"></div>
        <div class="start-sub"></div>
        <button class="start-btn" type="button"></button>
        <div class="start-err"></div>
      </div>`;
    ov.querySelector('.start-title')!.textContent = opts.title;
    ov.querySelector('.start-sub')!.textContent = opts.subtitle || '';
    const btn = ov.querySelector('.start-btn') as HTMLButtonElement;
    btn.textContent = opts.button || 'TAP TO START';
    const err = ov.querySelector('.start-err') as HTMLDivElement;
    document.body.appendChild(ov);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const audioP = unlockAudio();
      const fsP = opts.fullscreen === false ? Promise.resolve() : requestFullscreen();
      const wakeP = keepAwake();
      try {
        if (opts.onUnlock) await withTimeout(Promise.resolve(opts.onUnlock()), 1500);
      } catch (e) {
        err.textContent = 'Media permission failed: ' + ((e as Error)?.message || e);
      }
      await Promise.allSettled([withTimeout(audioP), withTimeout(fsP), withTimeout(wakeP)]);
      ov.remove();
      resolve();
    });
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
