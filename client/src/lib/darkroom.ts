/**
 * Live Silver-Gelatin Photogram & Optical Enlarger Engine (/main)
 * - Zero pre-recorded video: samples live external USB camera (or procedural fallback when no camera is attached)
 *   during EXPOSURE at 15–20 FPS into 960×540 dual float accumulators (avgAccum + minAccum).
 * - Synthesizes normalized latentMap (0.72 * avg + 0.28 * min + 2%–98% histogram stretch + static silver grain).
 * - Renders live developing paper in real time driven by server devProgress (0.0 → 0.85 → 1.0 → 1.45+ burned black)
 *   in either 'photogram_negative' or 'positive_print' optical mode.
 * - Exports borderless, watermark-free 1280×720 JPEG (q=0.88) optimized for Instax printing.
 */
import type { PrintMode } from '../../../shared/protocol';

export const DISPLAY_W = 1280;
export const DISPLAY_H = 720;
const LW = 960;
const LH = 540;
const N = LW * LH;
const FW = 320;
const FH = 180;
const FN = FW * FH;

function drawContain(
  g: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  g.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

function drawCover(
  g: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const targetRatio = dw / dh;
  const srcRatio = sw / sh;
  let sx = 0;
  let sy = 0;
  let cw = sw;
  let ch = sh;
  if (srcRatio > targetRatio) {
    cw = sh * targetRatio;
    sx = (sw - cw) / 2;
  } else {
    ch = sw / targetRatio;
    sy = (sh - ch) / 2;
  }
  g.drawImage(src, sx, sy, cw, ch, 0, 0, dw, dh);
}

export function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  c.width = DISPLAY_W;
  c.height = DISPLAY_H;
  return c.getContext('2d')!;
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

/** SAFELIGHT_COMPOSE: pure #9A0A0A safelight field with optional semi-transparent deep-red forecast ghost */
export function drawSafelightField(g: CanvasRenderingContext2D, forecastImg?: HTMLImageElement | null): void {
  g.fillStyle = '#9A0A0A';
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

  if (forecastImg && forecastImg.complete && forecastImg.naturalWidth > 0) {
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = 0.42;
    drawContain(g, forecastImg, forecastImg.naturalWidth, forecastImg.naturalHeight, 0, 0, DISPLAY_W, DISPLAY_H);
    g.restore();
  }

  const v = g.createRadialGradient(
    DISPLAY_W * 0.5,
    DISPLAY_H * 0.5,
    DISPLAY_H * 0.28,
    DISPLAY_W * 0.5,
    DISPLAY_H * 0.5,
    DISPLAY_W * 0.72,
  );
  v.addColorStop(0, 'rgba(154, 10, 10, 0)');
  v.addColorStop(1, 'rgba(42, 2, 2, 0.36)');
  g.fillStyle = v;
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
}

/** EXPOSURE: bright warm enlarger beam #F6F2E8 with optional Recursive Past video shadow overlay */
export function drawExposureBeam(
  g: CanvasRenderingContext2D,
  pastVideo?: HTMLVideoElement | null,
  pastOpacity = 0.48,
): void {
  g.fillStyle = '#F6F2E8';
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

  if (pastVideo && pastVideo.readyState >= 2 && pastVideo.videoWidth > 0 && pastVideo.videoHeight > 0 && !pastVideo.ended) {
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = Math.max(0.15, Math.min(0.85, pastOpacity));
    drawCover(g, pastVideo, pastVideo.videoWidth, pastVideo.videoHeight, DISPLAY_W, DISPLAY_H);
    g.restore();
  }

  const v = g.createRadialGradient(
    DISPLAY_W * 0.5,
    DISPLAY_H * 0.5,
    DISPLAY_H * 0.34,
    DISPLAY_W * 0.5,
    DISPLAY_H * 0.5,
    DISPLAY_W * 0.74,
  );
  v.addColorStop(0, 'rgba(246, 242, 232, 0)');
  v.addColorStop(1, 'rgba(220, 212, 194, 0.42)');
  g.fillStyle = v;
  g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
}

export class DarkroomEngine {
  private sampleCanvas: HTMLCanvasElement;
  private sampleCtx: CanvasRenderingContext2D;
  private devCanvas: HTMLCanvasElement;
  private devCtx: CanvasRenderingContext2D;
  private devImg: ImageData;
  private exportCanvas: HTMLCanvasElement;
  private exportCtx: CanvasRenderingContext2D;
  private forecastSrcCanvas: HTMLCanvasElement;
  private forecastSrcCtx: CanvasRenderingContext2D;
  private forecastOutCanvas: HTMLCanvasElement;
  private forecastOutCtx: CanvasRenderingContext2D;
  private forecastImg: ImageData;

  private avgAccum = new Float32Array(N);
  private minAccum = new Float32Array(N);
  private rawBuf = new Float32Array(N);
  private latentMap = new Float32Array(N);
  private grainMap = new Float32Array(N);
  private hist = new Uint32Array(1024);
  private prevGray: Float32Array | null = null;

  private sampleCount = 0;
  private latentReady = false;
  private roundSeed = 0;

  constructor() {
    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = LW;
    this.sampleCanvas.height = LH;
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true })!;

    this.devCanvas = document.createElement('canvas');
    this.devCanvas.width = LW;
    this.devCanvas.height = LH;
    this.devCtx = this.devCanvas.getContext('2d')!;
    this.devImg = this.devCtx.createImageData(LW, LH);

    this.exportCanvas = document.createElement('canvas');
    this.exportCanvas.width = DISPLAY_W;
    this.exportCanvas.height = DISPLAY_H;
    this.exportCtx = this.exportCanvas.getContext('2d')!;

    this.forecastSrcCanvas = document.createElement('canvas');
    this.forecastSrcCanvas.width = FW;
    this.forecastSrcCanvas.height = FH;
    this.forecastSrcCtx = this.forecastSrcCanvas.getContext('2d', { willReadFrequently: true })!;

    this.forecastOutCanvas = document.createElement('canvas');
    this.forecastOutCanvas.width = FW;
    this.forecastOutCanvas.height = FH;
    this.forecastOutCtx = this.forecastOutCanvas.getContext('2d')!;
    this.forecastImg = this.forecastOutCtx.createImageData(FW, FH);

    this.regenerateGrain();
  }

  /** Generate static spatially smoothed silver-halide paper grain (-1..+1) anchored to the sheet */
  private regenerateGrain(): void {
    const tmp = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      tmp[i] = (Math.random() + Math.random() - 1); // triangular distribution -1..+1
    }
    for (let y = 0; y < LH; y++) {
      const row = y * LW;
      for (let x = 0; x < LW; x++) {
        const i = row + x;
        const left = x > 0 ? tmp[i - 1] : tmp[i];
        const up = y > 0 ? tmp[i - LW] : tmp[i];
        this.grainMap[i] = tmp[i] * 0.56 + left * 0.22 + up * 0.22;
      }
    }
  }

  /** Reset in-memory temporal prediction baseline (called on NEW ROLL) */
  resetMemory(): void {
    this.prevGray = null;
  }

  /** Capture stream of sampleCanvas for local MediaRecorder fallback when no USB camera is attached */
  getSimulatedStream(fps = 20): MediaStream | null {
    const fn = (this.sampleCanvas as HTMLCanvasElement & { captureStream?: (f?: number) => MediaStream }).captureStream;
    return typeof fn === 'function' ? fn.call(this.sampleCanvas, fps) : null;
  }

  /** Reset accumulators at the start of each EXPOSURE round */
  beginExposure(roundId = 0): void {
    this.avgAccum.fill(0);
    this.minAccum.fill(1);
    this.latentMap.fill(0.5);
    this.sampleCount = 0;
    this.latentReady = false;
    this.roundSeed = roundId;
    this.regenerateGrain();
  }

  /** Sample 1 frame from live camera (or simulated moving photogram objects when no camera is available) */
  sampleExposureFrame(videoEl: HTMLVideoElement | null, elapsedSec: number, totalSec: number): void {
    const ctx = this.sampleCtx;
    if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      // 16:9 cover crop from camera
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      const targetRatio = LW / LH;
      const srcRatio = vw / vh;
      let sx = 0;
      let sy = 0;
      let sw = vw;
      let sh = vh;
      if (srcRatio > targetRatio) {
        sw = vh * targetRatio;
        sx = (vw - sw) / 2;
      } else {
        sh = vw / targetRatio;
        sy = (vh - sh) / 2;
      }
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, LW, LH);
    } else {
      this.drawSimulatedExposureInput(ctx, elapsedSec, Math.max(1, totalSec));
    }

    const px = ctx.getImageData(0, 0, LW, LH).data;
    const first = this.sampleCount === 0;
    this.sampleCount++;

    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const lum = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
      this.avgAccum[i] += lum;
      if (first) {
        this.minAccum[i] = lum;
      } else {
        const cur = this.minAccum[i];
        // Fast attack on dark shadows, slow leaky release for crisp stationary edges
        this.minAccum[i] = lum < cur ? cur + (lum - cur) * 0.38 : cur + (lum - cur) * 0.018;
      }
    }
  }

  /** Procedural simulation when debugging without a USB camera: held perforated board + transparency lines + moving shadows */
  private drawSimulatedExposureInput(ctx: CanvasRenderingContext2D, elapsedSec: number, totalSec: number): void {
    const u = Math.max(0, Math.min(1, elapsedSec / totalSec));

    // Bright enlarger-lit wall with subtle vignette
    const bg = ctx.createRadialGradient(LW * 0.5, LH * 0.5, 40, LW * 0.5, LH * 0.5, LW * 0.65);
    bg.addColorStop(0, '#F3EFE4');
    bg.addColorStop(1, '#DCD5C5');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, LW, LH);

    // 1. Held perforated board with crisp square aperture & transparency film lines (shifts subtly per round)
    const phaseShift = (this.roundSeed % 5) * 18;
    const bx = LW * 0.32 + phaseShift + Math.sin(elapsedSec * 1.4) * 2.5;
    const by = LH * 0.24 + Math.cos(elapsedSec * 1.1) * 2.2;
    const bw = 200;
    const bh = 250;
    const hx = bx + 54;
    const hy = by + 62;
    const hw = 92;
    const hh = 92;

    ctx.save();
    ctx.fillStyle = '#181614';
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.rect(hx + hw, hy, -hw, hh); // square cutout window (counter-clockwise hole)
    ctx.fill();

    // Fine botanical / optical grid lines printed on acetate across the aperture
    ctx.strokeStyle = 'rgba(28, 25, 22, 0.65)';
    ctx.lineWidth = 1.6;
    for (let k = 1; k <= 4; k++) {
      const gx = hx + (hw * k) / 5;
      ctx.beginPath();
      ctx.moveTo(gx, hy);
      ctx.lineTo(gx, hy + hh);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(hx + hw * 0.5, hy + hh * 0.5, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 2. Stationary small object silhouette (sharp in minAccum)
    ctx.fillStyle = '#161412';
    ctx.beginPath();
    ctx.ellipse(LW * 0.72, LH * 0.66, 32, 68, -0.18, 0, Math.PI * 2);
    ctx.fill();

    // 3. Moving geometric shadows sweeping across the beam (ghosting trail in avgAccum)
    ctx.save();
    ctx.fillStyle = 'rgba(20, 18, 16, 0.88)';
    const mx1 = LW * (0.14 + u * 0.66);
    const my1 = LH * (0.56 - Math.sin(u * Math.PI) * 0.18);
    ctx.beginPath();
    ctx.ellipse(mx1, my1, 46, 130, 0.08, 0, Math.PI * 2);
    ctx.fill();

    const mx2 = LW * (0.82 - u * 0.42);
    const my2 = LH * 0.36;
    ctx.beginPath();
    ctx.rect(mx2 - 28, my2 - 74, 56, 148);
    ctx.fill();
    ctx.restore();
  }

  /** Synthesize final latentMap at end of EXPOSURE: 0.72*avg + 0.28*min + 2%–98% histogram stretch */
  finalizeLatent(): void {
    if (this.latentReady) return;
    if (this.sampleCount === 0) {
      this.sampleExposureFrame(null, 7.5, 15);
    }

    const invN = 1 / Math.max(1, this.sampleCount);
    this.hist.fill(0);

    for (let i = 0; i < N; i++) {
      const avg = this.avgAccum[i] * invN;
      const min = this.minAccum[i];
      const v = Math.max(0, Math.min(1, 0.72 * avg + 0.28 * min));
      this.rawBuf[i] = v;
      const bin = Math.min(1023, Math.max(0, Math.floor(v * 1023)));
      this.hist[bin]++;
    }

    const lowTarget = Math.floor(N * 0.02);
    const highTarget = Math.floor(N * 0.98);
    let acc = 0;
    let p02Bin = 0;
    let p98Bin = 1023;
    let foundLow = false;
    for (let b = 0; b < 1024; b++) {
      acc += this.hist[b];
      if (!foundLow && acc >= lowTarget) {
        p02Bin = b;
        foundLow = true;
      }
      if (acc >= highTarget) {
        p98Bin = b;
        break;
      }
    }

    const p02 = p02Bin / 1023;
    const p98 = p98Bin / 1023;
    const span = Math.max(0.06, p98 - p02);

    for (let i = 0; i < N; i++) {
      let x = (this.rawBuf[i] - p02) / span;
      if (x < 0) x = 0;
      else if (x > 1) x = 1;
      // Gentle S-curve toe/shoulder characteristic of silver-gelatin paper
      const s = x * x * (3 - 2 * x);
      let g = x * 0.55 + s * 0.45 + this.grainMap[i] * 0.024;
      if (g < 0) g = 0;
      else if (g > 1) g = 1;
      this.latentMap[i] = g;
    }

    this.latentReady = true;
  }

  /**
   * Render developing paper at `devProgress` (0.0 -> 0.85 -> 1.0 -> 1.45+ fogged/burned black).
   * `ambientDim` dims output slightly during live darkroom tray viewing (e.g. 0.93) vs 1.0 for FIXED_REVEAL/export.
   */
  renderPrint(
    targetCtx: CanvasRenderingContext2D,
    targetW: number,
    targetH: number,
    devProgress: number,
    printMode: PrintMode,
    ambientDim = 1.0,
  ): void {
    if (!this.latentReady) this.finalizeLatent();

    const p = Math.max(0, devProgress);
    const k = Math.min(1, p / 0.85);
    const boost = p > 0.85 ? Math.min(1, (p - 0.85) / 0.15) : 0;
    const over = p > 1.0 ? Math.min(1, (p - 1.0) / 0.45) : 0;

    const gamma = 1.38 - 0.22 * k;
    const kPow = Math.pow(k, 1.15);
    const gain = 0.88 + 0.12 * boost;
    const baseFog = over > 0 ? Math.pow(over, 1.18) * 0.985 : 0;
    const negMode = printMode === 'photogram_negative';

    const out = this.devImg.data;
    const latent = this.latentMap;
    const grain = this.grainMap;

    // Warm fiber paper white -> deep archival silver black
    const paperR = 240 * ambientDim;
    const paperG = 234 * ambientDim;
    const paperB = 220 * ambientDim;
    const dmaxR = 9;
    const dmaxG = 8;
    const dmaxB = 8;

    for (let i = 0, q = 0; i < N; i++, q += 4) {
      const u = latent[i];
      const exposure = negMode ? u : 1 - u;

      let density = Math.pow(exposure, gamma) * kPow * gain;
      if (over > 0) {
        let fog = baseFog + over * 0.045 * grain[i];
        if (fog < 0) fog = 0;
        else if (fog > 1) fog = 1;
        density = density + (1 - density) * fog;
      }

      // Subtle paper grain modulation in midtones
      const midWeight = density * (1 - density) * 4;
      let d = density + grain[i] * 0.022 * midWeight;
      if (d < 0) d = 0;
      else if (d > 1) d = 1;

      const inv = 1 - d;
      // Slight warm-amber chemical fog tint in early/mid overdevelopment
      const stain = over > 0 ? over * (1 - over) * 26 : 0;
      out[q] = dmaxR + (paperR - dmaxR) * inv + stain * 0.8;
      out[q + 1] = dmaxG + (paperG - dmaxG) * inv + stain * 0.35;
      out[q + 2] = dmaxB + (paperB - dmaxB) * inv;
      out[q + 3] = 255;
    }

    this.devCtx.putImageData(this.devImg, 0, 0);
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(this.devCanvas, 0, 0, targetW, targetH);
  }

  /** Export a 100% clean, borderless, watermark-free 1280×720 JPEG for Instax printing & Contact Sheet */
  exportCleanJpeg(finalDevProgress: number, printMode: PrintMode): string {
    this.renderPrint(this.exportCtx, DISPLAY_W, DISPLAY_H, finalDevProgress, printMode, 1.0);
    return this.exportCanvas.toDataURL('image/jpeg', 0.88);
  }

  /**
   * 320×180 pixel-level Temporal Extrapolation:
   * - Seed round (00A / no prevGray): directional dark-shadow dilation + contrast boost -> FORECAST 01A
   * - Subsequent rounds: predicted = clamp(current + (current - prev) * 1.15, 0, 1) + light Gaussian blur + grain
   */
  computeAndExportForecast(isSeedRound: boolean): string {
    this.forecastSrcCtx.drawImage(this.exportCanvas, 0, 0, FW, FH);
    const srcPx = this.forecastSrcCtx.getImageData(0, 0, FW, FH).data;
    const currentGray = new Float32Array(FN);
    for (let i = 0, p = 0; i < FN; i++, p += 4) {
      currentGray[i] = (0.299 * srcPx[p] + 0.587 * srcPx[p + 1] + 0.114 * srcPx[p + 2]) / 255;
    }

    const rawPred = new Float32Array(FN);
    if (isSeedRound || !this.prevGray) {
      // Seed frame 00A: directional dark shadow dilation + contrast boost
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          let minVal = currentGray[i];
          for (let dy = -1; dy <= 1; dy++) {
            const sy = Math.max(0, Math.min(FH - 1, y - 1 + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const sx = Math.max(0, Math.min(FW - 1, x - 2 + dx));
              const v = currentGray[sy * FW + sx];
              if (v < minVal) minVal = v;
            }
          }
          const dilated = currentGray[i] * 0.42 + minVal * 0.58;
          rawPred[i] = Math.max(0, Math.min(1, (dilated - 0.5) * 1.28 + 0.5));
        }
      }
    } else {
      const prev = this.prevGray;
      for (let i = 0; i < FN; i++) {
        const v = currentGray[i] + (currentGray[i] - prev[i]) * 1.15;
        rawPred[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }

    this.prevGray = currentGray;

    // Light 3×3 Gaussian smoothing + subtle darkroom fog grain
    const out = this.forecastImg.data;
    for (let y = 0; y < FH; y++) {
      const y0 = Math.max(0, y - 1) * FW;
      const y1 = y * FW;
      const y2 = Math.min(FH - 1, y + 1) * FW;
      for (let x = 0; x < FW; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = x;
        const x2 = Math.min(FW - 1, x + 1);
        const blur =
          (rawPred[y0 + x0] +
            rawPred[y0 + x1] * 2 +
            rawPred[y0 + x2] +
            rawPred[y1 + x0] * 2 +
            rawPred[y1 + x1] * 4 +
            rawPred[y1 + x2] * 2 +
            rawPred[y2 + x0] +
            rawPred[y2 + x1] * 2 +
            rawPred[y2 + x2]) /
          16;
        const fog = blur + (Math.random() - 0.5) * 0.04;
        const v = fog < 0 ? 0 : fog > 1 ? 1 : fog;
        const q = (y1 + x1) * 4;
        out[q] = 9 + 231 * v;
        out[q + 1] = 8 + 226 * v;
        out[q + 2] = 8 + 212 * v;
        out[q + 3] = 255;
      }
    }
    this.forecastOutCtx.putImageData(this.forecastImg, 0, 0);
    return this.forecastOutCanvas.toDataURL('image/jpeg', 0.86);
  }

  /**
   * Side-by-side West Wall Reveal for regular rounds (01A+):
   * Left = PREDICTED [FR], Right = ACTUAL [FR] (from exportCanvas)
   */
  drawSideBySideReveal(
    g: CanvasRenderingContext2D,
    predictedImg: HTMLImageElement | null,
    frameNo: string,
    devPct: number,
  ): void {
    g.fillStyle = '#080706';
    g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    const padX = 48;
    const gap = 32;
    const cardW = (DISPLAY_W - padX * 2 - gap) / 2;
    const cardH = Math.round((cardW * 9) / 16);
    const topY = Math.round((DISPLAY_H - cardH) / 2) - 18;

    const leftX = padX;
    const rightX = padX + cardW + gap;

    // Frame borders
    g.strokeStyle = 'rgba(184, 50, 40, 0.72)';
    g.lineWidth = 1.5;
    g.strokeRect(leftX - 1, topY - 1, cardW + 2, cardH + 2);

    g.strokeStyle = 'rgba(232, 226, 213, 0.35)';
    g.strokeRect(rightX - 1, topY - 1, cardW + 2, cardH + 2);

    // Left: PREDICTED
    if (predictedImg && predictedImg.complete && predictedImg.naturalWidth > 0) {
      drawContain(g, predictedImg, predictedImg.naturalWidth, predictedImg.naturalHeight, leftX, topY, cardW, cardH);
    } else {
      g.fillStyle = '#12100E';
      g.fillRect(leftX, topY, cardW, cardH);
      g.fillStyle = 'rgba(232, 226, 213, 0.4)';
      g.font = '14px "RH Mono", monospace';
      g.fillText('NO PRIOR FORECAST', leftX + 20, topY + cardH / 2);
    }

    // Right: ACTUAL (frozen exportCanvas)
    g.drawImage(this.exportCanvas, rightX, topY, cardW, cardH);

    // Minimalist labels below frames
    g.font = '13px "RH Mono", monospace';
    g.fillStyle = '#B83228';
    g.fillText(`PREDICTED · ${frameNo}`, leftX, topY + cardH + 26);

    g.fillStyle = '#E8E2D5';
    g.fillText(`ACTUAL · ${frameNo} · DEV ${devPct}% · FIXED`, rightX, topY + cardH + 26);
  }
}
