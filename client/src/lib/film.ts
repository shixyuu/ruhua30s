/** Procedural canvas imagery for /main: standby grain, simulated film, rewinding film, no-recording placeholder */
import { TIMELINE } from '../../../shared/protocol';

const W = 1280;
const H = 720;
const MONO = "'RH Mono', 'IBM Plex Mono', ui-monospace, monospace";
const SERIF = "'RH Serif', 'Instrument Serif', Georgia, serif";
const GROT = "'RH Grot', 'Archivo Narrow', 'Arial Narrow', sans-serif";
const MARKER = "'RH Marker', 'Permanent Marker', cursive";
const EDGE = '#d08a2a';
const PENCIL = '#c8261d';
const PAPER = '#ebe5d6';
const SAFE = '#b3241b';

/** preload the self-hosted fonts used on canvas */
export function preloadCanvasFonts(): void {
  const f = (document as any).fonts;
  if (!f?.load) return;
  for (const spec of [`16px ${MONO}`, `500 16px ${MONO}`, `italic 16px ${SERIF}`, `800 16px ${GROT}`, `600 16px ${GROT}`, `16px ${MARKER}`]) f.load(spec, 'RH0123').catch(() => {});
}

const grain = document.createElement('canvas');
grain.width = 320;
grain.height = 180;
const gctx = grain.getContext('2d')!;
const gimg = gctx.createImageData(320, 180);

function makeGrain(base: number, spread: number, warm = 0): HTMLCanvasElement {
  const d = gimg.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = base + (Math.random() - 0.5) * spread;
    d[i] = v + warm;
    d[i + 1] = v;
    d[i + 2] = v - warm * 0.6;
    d[i + 3] = 255;
  }
  gctx.putImageData(gimg, 0, 0);
  return grain;
}

export function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  c.width = W;
  c.height = H;
  return c.getContext('2d')!;
}

export function clear(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
}

function sprockets(g: CanvasRenderingContext2D, y: number, h: number, offset: number, fill: string): void {
  const pitch = 34;
  g.fillStyle = fill;
  for (let x = -pitch + (offset % pitch); x < W + pitch; x += pitch) {
    g.beginPath();
    (g as any).roundRect ? (g as any).roundRect(x, y + h * 0.3, 18, h * 0.4, 3) : g.rect(x, y + h * 0.3, 18, h * 0.4);
    g.fill();
  }
}

function edgePrint(g: CanvasRenderingContext2D, y: number, frame: number, offset = 0, alpha = 0.85): void {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = EDGE;
  g.font = `500 13px ${MONO}`;
  for (let i = -1; i < 6; i++) {
    const x = 40 + i * 260 - (offset % 260);
    const n = frame + i;
    g.fillText(`RUHUA SAFETY FILM  RH 3030   ${String(Math.max(0, n)).padStart(2, '0')}   ▸${String(Math.max(0, n)).padStart(2, '0')}A`, x, y);
  }
  g.restore();
}

/** IDLE: faint darkroom film grain */
export function drawIdle(g: CanvasRenderingContext2D, ms: number): void {
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
  g.drawImage(makeGrain(9, 14, 2), 0, 0, W, H);
  // safelight: a dim red pool from the upper left
  const r = g.createRadialGradient(W * 0.18, -H * 0.1, 10, W * 0.18, -H * 0.1, W * 0.75);
  r.addColorStop(0, 'rgba(179,36,27,0.20)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, W, H);
  if (Math.random() < 0.06) {
    g.strokeStyle = 'rgba(235,229,214,0.10)';
    g.lineWidth = 1;
    const x = Math.random() * W;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 3, H);
    g.stroke();
  }
  g.fillStyle = 'rgba(200,137,44,0.16)';
  g.font = `12px ${MONO}`;
  g.fillText(`RH-30 · STANDBY · SAFELIGHT ON · ${new Date(ms).toLocaleTimeString('en-GB', { hour12: false })}`, 40, H - 32);
  g.fillStyle = 'rgba(235,229,214,0.08)';
  g.fillRect(40, H - 50, 240, 1);
}

const NODE_TEXT: Record<number, string> = {
  6: 'ANOMALOUS SHADOW APPEARS',
  15: 'OVEREXPOSURE',
  28: 'SUBJECT TURNS IN TERROR',
};

/** ACTIVE_30S without base.mp4: a bright, minimal simulated print (paper texture + film edge) */
export function drawSimFilm(g: CanvasRenderingContext2D, t: number): void {
  const sec = Math.max(0, Math.min(30, t));
  const band = 64;
  // film-base border
  g.fillStyle = '#0d0c0b';
  g.fillRect(0, 0, W, H);
  // image area (paper white with a slight flicker)
  const fy = band;
  const fh = H - band * 2;
  const flick = 228 + Math.random() * 8;
  g.fillStyle = `rgb(${flick + 6},${flick + 2},${flick - 8})`;
  g.fillRect(0, fy, W, fh);
  g.globalAlpha = 0.14;
  g.imageSmoothingEnabled = false;
  g.drawImage(makeGrain(128, 180), 0, fy, W, fh);
  g.globalAlpha = 1;
  // film edge: sprockets + edge print
  const frame = Math.floor(sec * 24);
  sprockets(g, 0, band * 0.6, -sec * 40, '#efe9dc');
  sprockets(g, H - band * 0.6, band * 0.6, -sec * 40, '#efe9dc');
  edgePrint(g, band - 10, Math.floor(sec), sec * 40);
  edgePrint(g, H - band + 20, Math.floor(sec) + 1, sec * 40, 0.6);

  // scene: horizon, subject, anomalous shadow
  const ground = fy + fh * 0.74;
  g.strokeStyle = 'rgba(40,36,32,0.45)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, ground);
  g.lineTo(W, ground);
  g.stroke();
  const px = W * 0.3 + Math.min(sec, 28) * (W * 0.011);
  const turned = sec >= 28;
  g.fillStyle = '#1b1815';
  g.beginPath();
  g.ellipse(px, ground - 196, 22, 26, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(px - 40, ground - 160);
  g.quadraticCurveTo(px, ground - 178, px + 40, ground - 160);
  g.lineTo(px + 30, ground - 70);
  const step = turned ? 0 : Math.sin(sec * 5) * 12;
  g.lineTo(px + 18 + step, ground);
  g.lineTo(px + 4, ground);
  g.lineTo(px, ground - 60);
  g.lineTo(px - 4, ground);
  g.lineTo(px - 18 - step, ground);
  g.lineTo(px - 30, ground - 70);
  g.closePath();
  g.fill();
  if (turned) {
    g.fillStyle = PAPER;
    g.fillRect(px - 10, ground - 202, 5, 5);
    g.fillRect(px + 5, ground - 202, 5, 5);
    g.beginPath();
    g.ellipse(px, ground - 186, 4, 6, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (sec >= 6) {
    const k = Math.min(1, (sec - 6) / 22);
    const sx = W * 0.06 + k * (px - W * 0.06 - 100);
    g.save();
    g.globalAlpha = 0.3 + 0.6 * k;
    g.filter = 'blur(12px)';
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse(sx, ground - 140, 40 + k * 18, 140 + k * 40, -0.05, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  if (sec >= 15 && sec < 21) {
    g.fillStyle = `rgba(255,252,246,${0.4 + 0.35 * Math.abs(Math.sin(sec * 6))})`;
    g.fillRect(0, fy, W, fh);
  }

  // timecode (top left, monospace)
  g.fillStyle = '#14110f';
  g.font = `500 44px ${MONO}`;
  g.fillText(`00:${sec.toFixed(1).padStart(4, '0')}`, 48, fy + 64);
  g.font = `13px ${MONO}`;
  g.fillStyle = 'rgba(20,17,15,0.6)';
  g.fillText(`FR ${String(frame).padStart(4, '0')} / 0720`, 52, fy + 88);
  // note (top right, small)
  g.textAlign = 'right';
  g.fillText('SIMULATED FILM · /assets/base.mp4 NOT FOUND (REPLACED AUTOMATICALLY ONCE UPLOADED)', W - 48, fy + 30);
  g.textAlign = 'left';

  // ruler: a tick per second, long ticks every 5 s, nodes at 06 / 15 / 28
  const x0 = 48;
  const x1 = W - 48;
  const y = fy + fh - 34;
  const xs = (s: number) => x0 + ((x1 - x0) * s) / 30;
  g.strokeStyle = 'rgba(20,17,15,0.75)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x1, y);
  for (let s = 0; s <= 30; s++) {
    const h = s % 5 === 0 ? 12 : 6;
    g.moveTo(xs(s), y);
    g.lineTo(xs(s), y - h);
  }
  g.stroke();
  g.fillStyle = SAFE;
  g.fillRect(x0, y + 2, xs(sec) - x0, 3);
  g.font = `500 13px ${MONO}`;
  for (const n of TIMELINE.filmNodes) {
    const active = sec >= n && sec < n + 2.5;
    const nx = xs(n);
    g.fillStyle = active || sec >= n ? SAFE : 'rgba(20,17,15,0.75)';
    g.beginPath();
    g.moveTo(nx, y - 16);
    g.lineTo(nx - 6, y - 28);
    g.lineTo(nx + 6, y - 28);
    g.closePath();
    g.fill();
    g.fillText(`${String(n).padStart(2, '0')}s`, nx - 12, y - 34);
  }
  // node caption (bottom left, condensed) with a grease-pencil frame mark
  for (const n of TIMELINE.filmNodes) {
    if (sec >= n && sec < n + 2.5) {
      g.fillStyle = SAFE;
      g.font = `500 14px ${MONO}`;
      g.fillText(`NODE ${String(n).padStart(2, '0')}s`, 48, y - 112);
      g.fillStyle = '#14110f';
      g.font = `800 64px ${GROT}`;
      g.fillText(`${String(n).padStart(2, '0')}s · ${NODE_TEXT[n]}`, 46, y - 56);
      const tw = g.measureText(`${String(n).padStart(2, '0')}s`).width;
      g.save();
      g.strokeStyle = PENCIL;
      g.lineWidth = 4;
      g.beginPath();
      g.ellipse(46 + tw / 2, y - 78, tw / 2 + 18, 40, -0.06, 0.2, Math.PI * 2.05);
      g.stroke();
      g.fillStyle = PENCIL;
      g.font = `30px ${MARKER}`;
      g.translate(46 + tw + 34, y - 128);
      g.rotate(-0.08);
      g.fillText(`#${String(Math.floor(n * 24)).padStart(3, '0')} ✓`, 0, 0);
      g.restore();
    }
  }
}

/** REWIND without rewind.mp4: procedural high-speed film rewind (strip racing backwards) */
export function drawRewind(g: CanvasRenderingContext2D, p: number): void {
  const q = Math.max(0, Math.min(1, p));
  g.fillStyle = '#060505';
  g.fillRect(0, 0, W, H);
  const speed = 3000 + 9000 * Math.sin(q * Math.PI);
  const off = (q * speed) % 360;
  const top = H * 0.22;
  const sh = H * 0.56;
  g.fillStyle = '#16120f';
  g.fillRect(0, top, W, sh);
  sprockets(g, top, 40, off, '#060505');
  sprockets(g, top + sh - 40, 40, off, '#060505');
  for (let i = -1; i < 6; i++) {
    const x = i * 360 + off - 360;
    const n = Math.floor(720 * (1 - q)) - i;
    const v = 150 + Math.random() * 70;
    g.fillStyle = `rgb(${v + 8},${v + 4},${v - 6})`;
    g.fillRect(x + 20, top + 48, 320, sh - 96);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(x + 150 + Math.sin(n) * 50, top + 110, 30, sh - 170);
    g.fillStyle = EDGE;
    g.font = `500 12px ${MONO}`;
    g.fillText(`RH-30  ${n}`, x + 24, top + 34);
  }
  g.globalAlpha = 0.22;
  g.drawImage(makeGrain(128, 255), 0, 0, W, H);
  g.globalAlpha = 1;
  if (Math.random() < 0.3) {
    g.fillStyle = 'rgba(235,229,214,0.18)';
    g.fillRect(0, Math.random() * H, W, 3 + Math.random() * 18);
  }
  const tc = 30 * (1 - q);
  g.fillStyle = PAPER;
  g.font = `500 56px ${MONO}`;
  g.fillText(`◀◀ 00:${tc.toFixed(1).padStart(4, '0')}`, 48, 96);
  g.fillStyle = SAFE;
  g.fillRect(48, 116, 300 * (1 - q), 3);
  g.fillStyle = 'rgba(235,229,214,0.5)';
  g.font = `13px ${MONO}`;
  g.fillText('REWIND · TIMELINE ROLLING BACK', 48, H - 48);
}

/** REPLAY_TRUTH placeholder when there is no local recording */
export function drawNoRecording(g: CanvasRenderingContext2D, t: number): void {
  g.imageSmoothingEnabled = false;
  g.drawImage(makeGrain(14, 20, 1), 0, 0, W, H);
  g.fillStyle = 'rgba(235,229,214,0.45)';
  g.font = `italic 26px ${SERIF}`;
  g.fillText('No local camera recording found', 48, 72);
  g.font = `13px ${MONO}`;
  g.fillStyle = 'rgba(200,137,44,0.6)';
  g.fillText('REPLAY · PLACEHOLDER', 48, 98);
  g.fillStyle = 'rgba(235,229,214,0.45)';
  g.font = `500 22px ${MONO}`;
  g.fillText(`00:${Math.min(30, t).toFixed(1).padStart(4, '0')}`, 48, H - 44);
}
