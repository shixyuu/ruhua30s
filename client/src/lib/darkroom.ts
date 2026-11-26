/**
 * RA-4 Color Darkroom & Physical Dodging Engine (/main)
 * - Zero AI / OpenCV dependencies: pure TypeScript 3x3 homography + Canvas pixel arithmetic.
 * - Supports:
 *   1. High-contrast Calibration Target (TL / TR / BR / BL) with adjustable Easel Margin (0–30%).
 *   2. Shadow-lifted original color projection (RGB >= 38/255) for physical dodging detection.
 *   3. Anti-AE drift normalization (median ratio of lowest-20% diff pixels) + dodgeMap integration.
 *   4. Home Mouse Dodge Simulator (paint directly onto canvas during EXPOSE).
 *   5. RA-4 subtractive color darkroom developing curve (E <= 1.0 soft dodge, E > 1.0 overdeveloped burn).
 *   6. Side-by-side ORIGINAL vs ALTERED PRINT reveal + clean border-framed Instax export.
 */
import { GRID_H, GRID_W, warpCameraToGridGray } from './homography';

// Built-in sample photographs (admin "USE BUILT-IN SAMPLE" #1..#6); re-encoded JPEGs, metadata stripped
import samplePhoto1 from '../samples/sample-1.jpg';
import samplePhoto2 from '../samples/sample-2.jpg';
import samplePhoto3 from '../samples/sample-3.jpg';
import samplePhoto4 from '../samples/sample-4.jpg';
import samplePhoto5 from '../samples/sample-5.jpg';
import samplePhoto6 from '../samples/sample-6.jpg';
const SAMPLE_PHOTOS = [samplePhoto1, samplePhoto2, samplePhoto3, samplePhoto4, samplePhoto5, samplePhoto6];

export const DISPLAY_W = 1280;
export const DISPLAY_H = 720;
const CAM_W = 640;
const CAM_H = 360;
const GRID_N = GRID_W * GRID_H;

export interface EaselRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  c.width = DISPLAY_W;
  c.height = DISPLAY_H;
  return c.getContext('2d')!;
}

/** Compute centered photo rect inside easel margin (0..30%) preserving aspect ratio */
export function computeEaselRect(
  canvasW: number,
  canvasH: number,
  marginPct: number,
  imgW: number,
  imgH: number,
): EaselRect {
  const m = Math.max(0, Math.min(30, marginPct)) / 100;
  const availW = canvasW * (1 - 2 * m);
  const availH = canvasH * (1 - 2 * m);
  const aspect = imgW > 0 && imgH > 0 ? imgW / imgH : 16 / 9;
  let w = availW;
  let h = w / aspect;
  if (h > availH) {
    h = availH;
    w = h * aspect;
  }
  return {
    x: (canvasW - w) / 2,
    y: (canvasH - h) / 2,
    w,
    h,
  };
}

/** IDLE: very dim darkroom safelight standby */
export function drawIdleDarkroom(g: CanvasRenderingContext2D, ms: number): void {
  g.fillStyle = '#070202';
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  const breath = 0.24 + 0.05 * Math.sin(ms / 2400);
  const r = g.createRadialGradient(DISPLAY_W * 0.22, DISPLAY_H * 0.14, 12, DISPLAY_W * 0.35, DISPLAY_H * 0.35, DISPLAY_W * 0.78);
  r.addColorStop(0, `rgba(92, 8, 8, ${breath.toFixed(3)})`);
  r.addColorStop(0.55, 'rgba(28, 3, 3, 0.35)');
  r.addColorStop(1, 'rgba(7, 2, 2, 0)');
  g.fillStyle = r;
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
}

/** CALIBRATING: pure high-contrast target with TL / TR / BR / BL markers inside easel margin */
export function drawCalibrationTarget(g: CanvasRenderingContext2D, marginPct: number): void {
  g.fillStyle = '#000000';
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

  const rect = computeEaselRect(DISPLAY_W, DISPLAY_H, marginPct, 16, 9);
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = 3;
  g.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // Inner crosshairs
  g.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(rect.x + rect.w / 2, rect.y);
  g.lineTo(rect.x + rect.w / 2, rect.y + rect.h);
  g.moveTo(rect.x, rect.y + rect.h / 2);
  g.lineTo(rect.x + rect.w, rect.y + rect.h / 2);
  g.stroke();

  const corners: Array<{ label: string; x: number; y: number; dx: number; dy: number }> = [
    { label: 'TL', x: rect.x, y: rect.y, dx: 1, dy: 1 },
    { label: 'TR', x: rect.x + rect.w, y: rect.y, dx: -1, dy: 1 },
    { label: 'BR', x: rect.x + rect.w, y: rect.y + rect.h, dx: -1, dy: -1 },
    { label: 'BL', x: rect.x, y: rect.y + rect.h, dx: 1, dy: -1 },
  ];

  const arm = 32;
  g.font = 'bold 20px "RH Mono", monospace';
  for (const c of corners) {
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(c.x, c.y + c.dy * arm);
    g.lineTo(c.x, c.y);
    g.lineTo(c.x + c.dx * arm, c.y);
    g.stroke();

    g.fillStyle = '#FFFFFF';
    const tx = c.dx > 0 ? c.x + 12 : c.x - 40;
    const ty = c.dy > 0 ? c.y + 28 : c.y - 14;
    g.fillText(c.label, tx, ty);
  }

  g.fillStyle = 'rgba(255,255,255,0.65)';
  g.font = '13px "RH Mono", monospace';
  g.textAlign = 'center';
  g.fillText(`HOMOGRAPHY TARGET · MARGIN ${marginPct}% · CLICK TL → TR → BR → BL ON /admin`, DISPLAY_W / 2, DISPLAY_H - 18);
  g.textAlign = 'left';
}

export class DarkroomEngine {
  private origCanvas: HTMLCanvasElement;
  private origCtx: CanvasRenderingContext2D;
  private liftedCanvas: HTMLCanvasElement;
  private liftedCtx: CanvasRenderingContext2D;
  private redCanvas: HTMLCanvasElement;
  private redCtx: CanvasRenderingContext2D;
  private devCanvas: HTMLCanvasElement;
  private devCtx: CanvasRenderingContext2D;
  private camCanvas: HTMLCanvasElement;
  private camCtx: CanvasRenderingContext2D;
  private exportCanvas: HTMLCanvasElement;
  private exportCtx: CanvasRenderingContext2D;

  private origW = 1280;
  private origH = 720;
  private origData: Uint8ClampedArray = new Uint8ClampedArray(0);
  private devImgData: ImageData | null = null;
  private upsampledDodge: Float32Array = new Float32Array(0);

  private cleanAccum = new Float32Array(GRID_N);
  private cleanCount = 0;
  private camClean = new Float32Array(GRID_N);
  private currGray = new Float32Array(GRID_N);
  private dodgeMap = new Float32Array(GRID_N);
  private dodgeBlurA = new Float32Array(GRID_N);
  private dodgeBlurB = new Float32Array(GRID_N);
  private diffScratch = new Float32Array(Math.ceil(GRID_N / 4));
  private ratioScratch = new Float32Array(Math.ceil(GRID_N / 4));
  private dodgeFinalized = false;

  constructor() {
    this.origCanvas = document.createElement('canvas');
    this.origCtx = this.origCanvas.getContext('2d', { willReadFrequently: true })!;
    this.liftedCanvas = document.createElement('canvas');
    this.liftedCtx = this.liftedCanvas.getContext('2d')!;
    this.redCanvas = document.createElement('canvas');
    this.redCtx = this.redCanvas.getContext('2d')!;
    this.devCanvas = document.createElement('canvas');
    this.devCtx = this.devCanvas.getContext('2d')!;
    this.camCanvas = document.createElement('canvas');
    this.camCanvas.width = CAM_W;
    this.camCanvas.height = CAM_H;
    this.camCtx = this.camCanvas.getContext('2d', { willReadFrequently: true })!;
    this.exportCanvas = document.createElement('canvas');
    this.exportCtx = this.exportCanvas.getContext('2d')!;

    this.setBlankSource();
  }

  getSourceSize(): { w: number; h: number } {
    return { w: this.origW, h: this.origH };
  }

  /** Load user uploaded photo URL (or built-in sample photo if url is null) */
  async loadSource(url: string | null, sampleIndex = 1): Promise<void> {
    const n = SAMPLE_PHOTOS.length;
    const sampleUrl = SAMPLE_PHOTOS[((Math.max(1, Math.floor(sampleIndex || 1)) - 1) % n + n) % n];
    const candidates = url ? [url, sampleUrl] : [sampleUrl];
    for (const src of candidates) {
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('Image load failed'));
          im.src = src;
        });
        const maxWork = 1280;
        const scale = Math.min(1, maxWork / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(16, Math.round(img.naturalWidth * scale));
        const h = Math.max(16, Math.round(img.naturalHeight * scale));
        this.origCanvas.width = w;
        this.origCanvas.height = h;
        this.origCtx.drawImage(img, 0, 0, w, h);
        this.prepareDerivedCanvases();
        return;
      } catch {
        console.warn(`[darkroom] source image failed to load: ${src}`);
      }
    }
    // Nothing loadable: blank (black) source, no drawn placeholder
    this.setBlankSource();
  }

  /** Blank black working source (initial state / every image failed to load) */
  private setBlankSource(): void {
    this.origCanvas.width = DISPLAY_W;
    this.origCanvas.height = DISPLAY_H;
    this.origCtx.fillStyle = '#000';
    this.origCtx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    this.prepareDerivedCanvases();
  }

  /** Build shadow-lifted (RGB >= 38/255) & safelight-red preview canvases */
  private prepareDerivedCanvases(): void {
    const w = this.origCanvas.width;
    const h = this.origCanvas.height;
    this.origW = w;
    this.origH = h;

    const src = this.origCtx.getImageData(0, 0, w, h);
    this.origData = src.data;

    this.liftedCanvas.width = w;
    this.liftedCanvas.height = h;
    const liftedImg = this.liftedCtx.createImageData(w, h);
    const ld = liftedImg.data;

    this.redCanvas.width = w;
    this.redCanvas.height = h;
    const redImg = this.redCtx.createImageData(w, h);
    const rd = redImg.data;

    const minFloor = 38;
    const scale = (255 - minFloor) / 255;

    for (let i = 0; i < this.origData.length; i += 4) {
      const r = this.origData[i];
      const g = this.origData[i + 1];
      const b = this.origData[i + 2];

      // Shadow lift for physical dodging visibility even in deep shadows
      ld[i] = Math.round(minFloor + r * scale);
      ld[i + 1] = Math.round(minFloor + g * scale);
      ld[i + 2] = Math.round(minFloor + b * scale);
      ld[i + 3] = 255;

      // Safelight red monochrome projection for OBSERVE
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      rd[i] = Math.round(28 + lum * 172);
      rd[i + 1] = Math.round(4 + lum * 16);
      rd[i + 2] = Math.round(4 + lum * 14);
      rd[i + 3] = 255;
    }

    this.liftedCtx.putImageData(liftedImg, 0, 0);
    this.redCtx.putImageData(redImg, 0, 0);

    this.devCanvas.width = w;
    this.devCanvas.height = h;
    this.devImgData = this.devCtx.createImageData(w, h);
    this.upsampledDodge = new Float32Array(w * h);
  }

  /** Draw photo during OBSERVE (darkroom safelight red filter inside easel margin) */
  drawObserve(g: CanvasRenderingContext2D, marginPct: number): void {
    g.fillStyle = '#070202';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    const rect = computeEaselRect(DISPLAY_W, DISPLAY_H, marginPct, this.origW, this.origH);
    g.drawImage(this.redCanvas, rect.x, rect.y, rect.w, rect.h);
  }

  /** Draw shadow-lifted color photo during CAPTURE_CLEAN and EXPOSE */
  drawExpose(g: CanvasRenderingContext2D, marginPct: number): void {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    const rect = computeEaselRect(DISPLAY_W, DISPLAY_H, marginPct, this.origW, this.origH);
    g.drawImage(this.liftedCanvas, rect.x, rect.y, rect.w, rect.h);
  }

  /** Reset dodge buffers for a new round */
  beginRound(): void {
    this.cleanAccum.fill(0);
    this.cleanCount = 0;
    this.camClean.fill(0.5);
    this.dodgeMap.fill(0);
    this.upsampledDodge.fill(0);
    this.dodgeFinalized = false;
  }

  /** Grab 1 camera snapshot (640x360) for remote 4-corner calibration on /admin */
  grabCameraSnapshot(videoEl: HTMLVideoElement | null, marginPct: number): string {
    if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      this.camCtx.drawImage(videoEl, 0, 0, CAM_W, CAM_H);
    } else {
      // Simulated angled camera view of the calibration target when no camera attached
      this.camCtx.fillStyle = '#060606';
      this.camCtx.fillRect(0, 0, CAM_W, CAM_H);
      const r = computeEaselRect(CAM_W, CAM_H, marginPct, 16, 9);
      this.camCtx.strokeStyle = '#E8E2D5';
      this.camCtx.lineWidth = 2;
      this.camCtx.strokeRect(r.x, r.y, r.w, r.h);
      this.camCtx.fillStyle = '#E8E2D5';
      this.camCtx.font = '12px monospace';
      this.camCtx.fillText('TL', r.x + 6, r.y + 16);
      this.camCtx.fillText('TR', r.x + r.w - 22, r.y + 16);
      this.camCtx.fillText('BR', r.x + r.w - 22, r.y + r.h - 8);
      this.camCtx.fillText('BL', r.x + 6, r.y + r.h - 8);
    }
    return this.camCanvas.toDataURL('image/jpeg', 0.85);
  }

  private sampleCameraToGrid(videoEl: HTMLVideoElement | null, hInv: number[] | null): boolean {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0) return false;
    this.camCtx.drawImage(videoEl, 0, 0, CAM_W, CAM_H);
    const rgba = this.camCtx.getImageData(0, 0, CAM_W, CAM_H).data;
    warpCameraToGridGray(rgba, CAM_W, CAM_H, hInv, this.currGray);
    return true;
  }

  /** CAPTURE_CLEAN (0.8s): average 4+ warped frames into camClean */
  sampleCleanFrame(videoEl: HTMLVideoElement | null, hInv: number[] | null): void {
    if (!this.sampleCameraToGrid(videoEl, hInv)) return;
    this.cleanCount++;
    for (let i = 0; i < GRID_N; i++) this.cleanAccum[i] += this.currGray[i];
  }

  finalizeClean(): void {
    if (this.cleanCount === 0) return;
    const inv = 1 / this.cleanCount;
    for (let i = 0; i < GRID_N; i++) this.camClean[i] = this.cleanAccum[i] * inv;
  }

  /** EXPOSE (30s): anti-AE drift normalization + dodgeMap integration */
  sampleExposeFrame(videoEl: HTMLVideoElement | null, dtSec: number, hInv: number[] | null, diffSensitivity: number): void {
    if (this.cleanCount === 0) return;
    if (!this.sampleCameraToGrid(videoEl, hInv)) return;

    // 1. Anti-AE drift normalization: median ratio of lowest-20% diff pixels (sampled 1/4 for speed)
    let k = 0;
    for (let i = 0; i < GRID_N; i += 4) {
      const c = this.camClean[i];
      const v = this.currGray[i];
      this.diffScratch[k] = Math.abs(v - c);
      this.ratioScratch[k] = c > 0.04 ? v / c : 1.0;
      k++;
    }
    // Quick partial selection via sorted indices on every 16th pixel (~3600 samples -> <0.3ms)
    const idxList: number[] = [];
    for (let j = 0; j < k; j += 4) idxList.push(j);
    idxList.sort((a, b) => this.diffScratch[a] - this.diffScratch[b]);
    const take = Math.max(1, Math.floor(idxList.length * 0.2));
    const ratios = idxList.slice(0, take).map((j) => this.ratioScratch[j]).sort((a, b) => a - b);
    const aeScale = Math.max(0.65, Math.min(1.55, ratios[Math.floor(ratios.length / 2)] || 1.0));

    // 2. Dodge integration
    const rate = Math.max(0, dtSec) / 18.0; // ~5s -> 0.28, ~18s -> 1.0
    for (let i = 0; i < GRID_N; i++) {
      const currNorm = this.currGray[i] / aeScale;
      const diff = Math.abs(currNorm - this.camClean[i]);
      if (diff > diffSensitivity) {
        const next = this.dodgeMap[i] + rate;
        this.dodgeMap[i] = next > 1 ? 1 : next;
      }
    }
  }

  /** HOME MOUSE SIMULATOR: paint soft dodge brush directly onto dodgeMap */
  applyMouseDodge(normX: number, normY: number, dtSec: number): void {
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;
    const gx = normX * GRID_W;
    const gy = normY * GRID_H;
    const radius = 24;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(gx - radius));
    const x1 = Math.min(GRID_W - 1, Math.ceil(gx + radius));
    const y0 = Math.max(0, Math.floor(gy - radius));
    const y1 = Math.min(GRID_H - 1, Math.ceil(gy + radius));
    const strength = Math.min(0.18, Math.max(0.02, dtSec * 1.1));

    for (let y = y0; y <= y1; y++) {
      const dy = y - gy;
      const row = y * GRID_W;
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const falloff = 1 - d2 / r2;
        const idx = row + x;
        const next = this.dodgeMap[idx] + strength * falloff * falloff;
        this.dodgeMap[idx] = next > 1 ? 1 : next;
      }
    }
  }

  /** Large-radius feather blur on dodgeMap + bilinear upsample to origW × origH */
  finalizeDodgeMap(): void {
    if (this.dodgeFinalized) return;
    this.dodgeFinalized = true;

    const blurPass = (src: Float32Array, dst: Float32Array, rad: number) => {
      // Horizontal
      for (let y = 0; y < GRID_H; y++) {
        const row = y * GRID_W;
        for (let x = 0; x < GRID_W; x++) {
          let sum = 0;
          let cnt = 0;
          const x0 = Math.max(0, x - rad);
          const x1 = Math.min(GRID_W - 1, x + rad);
          for (let k = x0; k <= x1; k++) {
            sum += src[row + k];
            cnt++;
          }
          this.dodgeBlurB[row + x] = sum / cnt;
        }
      }
      // Vertical
      for (let y = 0; y < GRID_H; y++) {
        const y0 = Math.max(0, y - rad);
        const y1 = Math.min(GRID_H - 1, y + rad);
        const cnt = y1 - y0 + 1;
        for (let x = 0; x < GRID_W; x++) {
          let sum = 0;
          for (let k = y0; k <= y1; k++) sum += this.dodgeBlurB[k * GRID_W + x];
          dst[y * GRID_W + x] = sum / cnt;
        }
      }
    };

    blurPass(this.dodgeMap, this.dodgeBlurA, 9);
    blurPass(this.dodgeBlurA, this.dodgeBlurB, 7);

    // Bilinear upsample to origW × origH
    const w = this.origW;
    const h = this.origH;
    const out = this.upsampledDodge;
    if (out.length !== w * h) this.upsampledDodge = new Float32Array(w * h);
    const dst = this.upsampledDodge;

    for (let y = 0; y < h; y++) {
      const sy = (y / Math.max(1, h - 1)) * (GRID_H - 1);
      const y0 = Math.floor(sy);
      const y1 = Math.min(GRID_H - 1, y0 + 1);
      const fy = sy - y0;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const sx = (x / Math.max(1, w - 1)) * (GRID_W - 1);
        const x0 = Math.floor(sx);
        const x1 = Math.min(GRID_W - 1, x0 + 1);
        const fx = sx - x0;

        const d00 = this.dodgeBlurB[y0 * GRID_W + x0];
        const d10 = this.dodgeBlurB[y0 * GRID_W + x1];
        const d01 = this.dodgeBlurB[y1 * GRID_W + x0];
        const d11 = this.dodgeBlurB[y1 * GRID_W + x1];
        const top = d00 + (d10 - d00) * fx;
        const bot = d01 + (d11 - d01) * fx;
        dst[row + x] = Math.max(0, Math.min(1, top + (bot - top) * fy));
      }
    }
  }

  /** Render RA-4 Color Darkroom developing print onto devCanvas */
  private renderToDevCanvas(devProgress: number): void {
    if (!this.dodgeFinalized) this.finalizeDodgeMap();
    if (!this.devImgData) return;

    const out = this.devImgData.data;
    const orig = this.origData;
    const dodge = this.upsampledDodge;
    const p = Math.max(0, devProgress);
    const n = this.origW * this.origH;

    const PR = 245;
    const PG = 242;
    const PB = 235;

    for (let i = 0, q = 0; i < n; i++, q += 4) {
      const eff = p * (1.0 - dodge[i] * 0.94);
      const or = orig[q];
      const og = orig[q + 1];
      const ob = orig[q + 2];

      if (eff <= 1.0) {
        const k = Math.pow(Math.max(0, eff), 0.9);
        out[q] = PR - (PR - or) * k;
        out[q + 1] = PG - (PG - og) * k;
        out[q + 2] = PB - (PB - ob) * k;
      } else {
        const excess = eff - 1.0;
        const scale = Math.max(0, 1.0 - excess * 1.15);
        const burn = excess * 0.12 * 255;
        out[q] = Math.max(0, Math.min(255, or * scale - burn));
        out[q + 1] = Math.max(0, Math.min(255, og * scale - burn));
        out[q + 2] = Math.max(0, Math.min(255, ob * scale - burn));
      }
      out[q + 3] = 255;
    }

    this.devCtx.putImageData(this.devImgData, 0, 0);
  }

  /** DEVELOP phase on /main */
  drawDevelop(g: CanvasRenderingContext2D, devProgress: number, marginPct: number): void {
    this.renderToDevCanvas(devProgress);
    g.fillStyle = '#070504';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    const rect = computeEaselRect(DISPLAY_W, DISPLAY_H, marginPct, this.origW, this.origH);
    g.drawImage(this.devCanvas, rect.x, rect.y, rect.w, rect.h);
  }

  /** LIGHT_LEAK (2.2s): white light sweep + rapid color fog collapse */
  drawLightLeak(g: CanvasRenderingContext2D, elapsedSec: number, devProgress: number, marginPct: number): void {
    const t = Math.max(0, Math.min(2.2, elapsedSec));
    const sweep = Math.min(1, t / 0.4);
    const fog = t > 0.4 ? Math.min(1, (t - 0.4) / 1.8) : 0;

    this.renderToDevCanvas(devProgress + fog * 1.1);
    g.fillStyle = '#070504';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
    const rect = computeEaselRect(DISPLAY_W, DISPLAY_H, marginPct, this.origW, this.origH);
    g.drawImage(this.devCanvas, rect.x, rect.y, rect.w, rect.h);

    if (t < 0.75) {
      const bx = rect.x + sweep * rect.w;
      const alpha = t <= 0.4 ? 0.92 : Math.max(0, 0.92 * (1 - (t - 0.4) / 0.35));
      const beam = g.createLinearGradient(bx - rect.w * 0.4, 0, bx + rect.w * 0.12, 0);
      beam.addColorStop(0, 'rgba(255,252,245,0)');
      beam.addColorStop(0.5, `rgba(255,252,245,${alpha.toFixed(3)})`);
      beam.addColorStop(1, 'rgba(255,252,245,0)');
      g.fillStyle = beam;
      g.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    if (fog > 0) {
      const grad = g.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
      grad.addColorStop(0, `rgba(28, 18, 14, ${(fog * 0.65).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(110, 48, 28, ${(fog * 0.48).toFixed(3)})`);
      grad.addColorStop(1, `rgba(14, 10, 9, ${(fog * 0.82).toFixed(3)})`);
      g.fillStyle = grad;
      g.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** REVEAL phase: crisp side-by-side ORIGINAL vs ALTERED PRINT */
  drawSideBySideReveal(g: CanvasRenderingContext2D, finalDev: number, outcomeLabel: string, isLeak: boolean): void {
    if (isLeak) {
      this.renderToDevCanvas(finalDev + 1.1);
    } else {
      this.renderToDevCanvas(finalDev);
    }

    g.fillStyle = '#080706';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    const padX = 48;
    const gap = 36;
    const boxW = (DISPLAY_W - padX * 2 - gap) / 2;
    const boxH = DISPLAY_H - 140;
    const topY = 42;

    const fit = (srcW: number, srcH: number, bx: number, by: number, bw: number, bh: number): EaselRect => {
      const s = Math.min(bw / srcW, bh / srcH);
      const w = srcW * s;
      const h = srcH * s;
      return { x: bx + (bw - w) / 2, y: by + (bh - h) / 2, w, h };
    };

    const leftBox = fit(this.origW, this.origH, padX, topY, boxW, boxH);
    const rightBox = fit(this.origW, this.origH, padX + boxW + gap, topY, boxW, boxH);

    g.drawImage(this.origCanvas, leftBox.x, leftBox.y, leftBox.w, leftBox.h);
    g.strokeStyle = 'rgba(232, 226, 213, 0.25)';
    g.lineWidth = 1;
    g.strokeRect(leftBox.x, leftBox.y, leftBox.w, leftBox.h);

    g.drawImage(this.devCanvas, rightBox.x, rightBox.y, rightBox.w, rightBox.h);
    if (isLeak) {
      const grad = g.createLinearGradient(rightBox.x, rightBox.y, rightBox.x + rightBox.w, rightBox.y + rightBox.h);
      grad.addColorStop(0, 'rgba(28, 18, 14, 0.65)');
      grad.addColorStop(0.5, 'rgba(110, 48, 28, 0.48)');
      grad.addColorStop(1, 'rgba(14, 10, 9, 0.82)');
      g.fillStyle = grad;
      g.fillRect(rightBox.x, rightBox.y, rightBox.w, rightBox.h);
    }
    g.strokeStyle = 'rgba(232, 226, 213, 0.45)';
    g.strokeRect(rightBox.x, rightBox.y, rightBox.w, rightBox.h);

    g.font = '13px "RH Mono", monospace';
    g.fillStyle = '#9A9387';
    g.fillText('ORIGINAL', leftBox.x, leftBox.y + leftBox.h + 26);

    g.fillStyle = '#E8E2D5';
    g.fillText(`ALTERED PRINT · ${outcomeLabel}`, rightBox.x, rightBox.y + rightBox.h + 26);
  }

  /** Export ONLY the finished high-res color print with restrained darkroom white border for Instax */
  exportCleanInstaxPrint(finalDev: number, isLeak: boolean): string {
    this.renderToDevCanvas(isLeak ? finalDev + 1.1 : finalDev);
    const border = 28;
    const maxW = 1280;
    const scale = Math.min(1, (maxW - border * 2) / this.origW);
    const pw = Math.round(this.origW * scale);
    const ph = Math.round(this.origH * scale);

    this.exportCanvas.width = pw + border * 2;
    this.exportCanvas.height = ph + border * 2;
    const ctx = this.exportCtx;

    ctx.fillStyle = '#F5F2EB';
    ctx.fillRect(0, 0, this.exportCanvas.width, this.exportCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.devCanvas, border, border, pw, ph);

    if (isLeak) {
      const grad = ctx.createLinearGradient(border, border, border + pw, border + ph);
      grad.addColorStop(0, 'rgba(28, 18, 14, 0.65)');
      grad.addColorStop(0.5, 'rgba(110, 48, 28, 0.48)');
      grad.addColorStop(1, 'rgba(14, 10, 9, 0.82)');
      ctx.fillStyle = grad;
      ctx.fillRect(border, border, pw, ph);
    }

    return this.exportCanvas.toDataURL('image/jpeg', 0.9);
  }
}
