/**
 * Procedural archival canvas imagery for /main (v2):
 *  - IDLE: subtle darkroom grain + low-saturation safelight glow
 *  - ACTIVE_30S (no base.mp4): high-key architectural daylight interior with slowly drifting window-pane sunlight
 *  - REWIND (no rewind.mp4): restrained motorized 35mm transport rollback
 *  - REPLAY_TRUTH (no camera): quiet archival darkroom background
 */

const W = 1280;
const H = 720;
const MONO = "'RH Mono', 'IBM Plex Mono', ui-monospace, monospace";
const EDGE = '#c48a3a';
const PAPER = '#e8e2d5';
const SAFE = '#9e2a22';

/** preload the self-hosted fonts used on canvas */
export function preloadCanvasFonts(): void {
  const f = (document as any).fonts;
  if (!f?.load) return;
  for (const spec of [`16px ${MONO}`, `500 16px ${MONO}`]) {
    f.load(spec, 'RH0123').catch(() => {});
  }
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
  g.fillStyle = '#0b0a09';
  g.fillRect(0, 0, W, H);
}

function pad(n: number, len = 2): string {
  return String(Math.max(0, Math.floor(n))).padStart(len, '0');
}

function sprockets(g: CanvasRenderingContext2D, y: number, h: number, offset: number, fill: string): void {
  const pitch = 38;
  g.fillStyle = fill;
  for (let x = -pitch + (((offset % pitch) + pitch) % pitch); x < W + pitch; x += pitch) {
    g.beginPath();
    (g as any).roundRect ? (g as any).roundRect(x, y + h * 0.28, 18, h * 0.44, 2.5) : g.rect(x, y + h * 0.28, 18, h * 0.44);
    g.fill();
  }
}

/** Widely spaced 35mm edge print (460px pitch — prevents any overlap between label and frame numbers) */
function edgePrint(g: CanvasRenderingContext2D, y: number, frame: number, offset = 0, alpha = 0.78): void {
  const step = 460;
  const shift = ((offset % step) + step) % step;
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = EDGE;
  g.font = `500 12px ${MONO}`;
  for (let i = -1; i < 5; i++) {
    const x = 44 + i * step - shift;
    const n = Math.max(0, frame + i);
    const nn = pad(n, 2);
    g.fillText(`RUHUA SAFETY FILM  RH-30     ${nn}     ▸${nn}A`, x, y);
  }
  g.restore();
}

/** IDLE: calm darkroom grain with subtle muted safelight glow */
export function drawIdle(g: CanvasRenderingContext2D, ms: number, rollNumber = 1): void {
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
  g.drawImage(makeGrain(10, 10, 1.5), 0, 0, W, H);

  // gentle, non-flickering safelight pool
  const breath = 0.12 + 0.03 * Math.sin(ms / 2400);
  const r = g.createRadialGradient(W * 0.16, -H * 0.08, 10, W * 0.16, -H * 0.08, W * 0.72);
  r.addColorStop(0, `rgba(158,42,34,${breath.toFixed(3)})`);
  r.addColorStop(1, 'rgba(11,10,9,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, W, H);

  g.fillStyle = 'rgba(232,226,213,0.10)';
  g.fillRect(48, H - 52, 260, 1);
  g.fillStyle = 'rgba(196,138,58,0.34)';
  g.font = `12px ${MONO}`;
  g.fillText(
    `RH-30 · ARCHIVAL ENLARGER STANDBY · ROLL ${pad(rollNumber)} · ${new Date(ms).toLocaleTimeString('en-GB', { hour12: false })}`,
    48,
    H - 32,
  );
}

/**
 * ACTIVE_30S without base.mp4:
 * Minimalist, bright, high-key architectural daylight simulation.
 * Provides a clean, steady off-white surface with a slowly drifting slanted window-pane sunbeam
 * so real visitors cast crisp, sculptural physical shadows on the projection wall.
 */
export function drawSimFilm(g: CanvasRenderingContext2D, t: number, rollNumber = 1, frameNumber = 1): void {
  const sec = Math.max(0, Math.min(30, t));
  const progress = sec / 30;
  const band = 56;
  const fy = band;
  const fh = H - band * 2;

  // darkroom film base border
  g.fillStyle = '#0b0a09';
  g.fillRect(0, 0, W, H);

  // high-key architectural interior wall (warm silver-gelatin off-white, zero strobe)
  const wallGrad = g.createLinearGradient(0, fy, W, fy + fh);
  wallGrad.addColorStop(0, '#ebe5d8');
  wallGrad.addColorStop(0.55, '#e3ddd0');
  wallGrad.addColorStop(1, '#d6cfc1');
  g.fillStyle = wallGrad;
  g.fillRect(0, fy, W, fh);

  // subtle architectural floor-skirting datum line
  const datumY = fy + fh * 0.84;
  g.strokeStyle = 'rgba(32, 28, 24, 0.14)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, datumY);
  g.lineTo(W, datumY);
  g.stroke();

  // slowly drifting slanted architectural window-pane light patch across center wall
  const driftX = -46 + progress * 92;
  const driftY = -8 + progress * 16;
  const skew = 68;
  const paneW = 248;
  const paneH = fh * 0.62;
  const startX = (W - (paneW * 2 + 26)) / 2 + driftX;
  const startY = fy + fh * 0.15 + driftY;

  g.save();
  g.beginPath();
  g.rect(0, fy, W, fh);
  g.clip();
  g.filter = 'blur(11px)';

  for (let col = 0; col < 2; col++) {
    const px = startX + col * (paneW + 26);
    const py = startY;
    // sunlit window aperture
    g.fillStyle = 'rgba(252, 249, 242, 0.78)';
    g.beginPath();
    g.moveTo(px + skew * 0.5, py);
    g.lineTo(px + paneW + skew * 0.5, py);
    g.lineTo(px + paneW - skew * 0.5, py + paneH);
    g.lineTo(px - skew * 0.5, py + paneH);
    g.closePath();
    g.fill();

    // soft horizontal window mullion bar
    const my = py + paneH * 0.47;
    g.fillStyle = 'rgba(214, 207, 193, 0.68)';
    g.beginPath();
    g.moveTo(px + skew * 0.03 - 4, my);
    g.lineTo(px + paneW + skew * 0.03 + 4, my);
    g.lineTo(px + paneW - skew * 0.03 + 4, my + 16);
    g.lineTo(px - skew * 0.03 - 4, my + 16);
    g.closePath();
    g.fill();
  }
  g.restore();

  // subtle fine silver-halide film grain
  g.save();
  g.globalAlpha = 0.055;
  g.imageSmoothingEnabled = false;
  g.drawImage(makeGrain(128, 150), 0, fy, W, fh);
  g.restore();

  // film edge sprockets & non-overlapping edge print
  sprockets(g, 0, band * 0.58, -sec * 18, '#ded8ca');
  sprockets(g, H - band * 0.58, band * 0.58, -sec * 18, '#ded8ca');
  edgePrint(g, band - 9, frameNumber, sec * 18, 0.8);
  edgePrint(g, H - band + 19, frameNumber + 1, sec * 18, 0.58);

  // discreet corner timecode & plate metadata
  g.fillStyle = 'rgba(24, 20, 17, 0.56)';
  g.font = `500 14px ${MONO}`;
  g.fillText(`ROLL ${pad(rollNumber)} · FR ${pad(frameNumber)}A · 00:${sec.toFixed(1).padStart(4, '0')}`, 44, fy + 32);

  g.textAlign = 'right';
  g.fillStyle = 'rgba(24, 20, 17, 0.36)';
  g.font = `11px ${MONO}`;
  g.fillText('DAYLIGHT CALIBRATION PLATE · /assets/base.mp4 STANDBY', W - 44, fy + 30);
  g.textAlign = 'left';

  // minimalist hairline exposure progress bar at very bottom of frame
  const rx0 = 44;
  const rx1 = W - 44;
  const ry = fy + fh - 18;
  g.fillStyle = 'rgba(24, 20, 17, 0.14)';
  g.fillRect(rx0, ry, rx1 - rx0, 1.5);
  g.fillStyle = SAFE;
  g.fillRect(rx0, ry, (rx1 - rx0) * progress, 2);
}

/** REWIND without rewind.mp4: restrained motorized 35mm transport rollback */
export function drawRewind(g: CanvasRenderingContext2D, p: number, rollNumber = 1): void {
  const q = Math.max(0, Math.min(1, p));
  g.fillStyle = '#0b0a09';
  g.fillRect(0, 0, W, H);

  const speed = 1800 + 4200 * Math.sin(q * Math.PI);
  const off = (q * speed) % 380;
  const top = H * 0.23;
  const sh = H * 0.54;

  g.fillStyle = '#15120f';
  g.fillRect(0, top, W, sh);
  sprockets(g, top, 38, off, '#0b0a09');
  sprockets(g, top + sh - 38, 38, off, '#0b0a09');

  for (let i = -1; i < 6; i++) {
    const x = i * 380 + off - 380;
    const n = Math.max(1, Math.floor(720 * (1 - q)) - i);
    const v = 205 + ((n * 7) % 16);
    g.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
    g.fillRect(x + 22, top + 48, 336, sh - 96);
    // subtle window-light band inside rewinding frame
    g.fillStyle = 'rgba(248, 244, 236, 0.55)';
    g.fillRect(x + 118, top + 76, 130, sh - 152);
    g.fillStyle = EDGE;
    g.font = `500 11px ${MONO}`;
    g.fillText(`RH-30 · ROLL ${pad(rollNumber)} · #${pad(n, 3)}`, x + 26, top + 33);
  }

  g.save();
  g.globalAlpha = 0.12;
  g.drawImage(makeGrain(128, 180), 0, 0, W, H);
  g.restore();

  const tc = 30 * (1 - q);
  g.fillStyle = PAPER;
  g.font = `500 32px ${MONO}`;
  g.fillText(`◀ 00:${tc.toFixed(1).padStart(4, '0')}`, 48, 86);
  g.fillStyle = SAFE;
  g.fillRect(48, 102, 220 * (1 - q), 2);
  g.fillStyle = 'rgba(232,226,213,0.46)';
  g.font = `12px ${MONO}`;
  g.fillText('FILM TRANSPORT · RETURNING TO 00:00.0', 48, H - 44);
}

/** REPLAY_TRUTH calm darkroom background when no local camera stream was recorded */
export function drawNoRecording(g: CanvasRenderingContext2D): void {
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
  g.drawImage(makeGrain(11, 12, 1), 0, 0, W, H);
  g.fillStyle = 'rgba(232,226,213,0.28)';
  g.font = `12px ${MONO}`;
  g.fillText('NO LOCAL CAMERA STREAM RECORDED · AUDIO LOG PLAYBACK ONLY', 48, 52);
}
