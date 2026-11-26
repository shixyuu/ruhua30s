/**
 * Pure TypeScript 2D Perspective Homography (zero OpenCV / CV deps).
 * Solves an 8x8 linear system via Gaussian elimination with partial pivoting
 * to map canonical working grid (320x180) -> normalized camera coordinates [0..1].
 */
import type { Point2D } from '../../../shared/protocol';

export const GRID_W = 320;
export const GRID_H = 180;

/**
 * Solve 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solve8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxVal) {
        maxVal = v;
        pivot = row;
      }
    }
    if (maxVal < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }

    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Compute 3x3 inverse homography `hInv` (9 floats) mapping
 * grid pixel (gx in 0..320, gy in 0..180) -> camera normalized (cx, cy in 0..1).
 * `camCorners` order: [TL, TR, BR, BL].
 */
export function computeHomographyInv(
  camCorners: [Point2D, Point2D, Point2D, Point2D],
  gridW = GRID_W,
  gridH = GRID_H,
): number[] | null {
  const src: Point2D[] = [
    { x: 0, y: 0 },
    { x: gridW, y: 0 },
    { x: gridW, y: gridH },
    { x: 0, y: gridH },
  ];

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const u = src[i].x;
    const v = src[i].y;
    const x = camCorners[i].x;
    const y = camCorners[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solve8x8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Warp a camera RGBA buffer into a 320x180 grayscale Float32Array [0..1]
 * using bilinear interpolation and `hInv`.
 */
export function warpCameraToGridGray(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  hInv: number[] | null,
  outGray: Float32Array,
  gridW = GRID_W,
  gridH = GRID_H,
): void {
  // Default identity mapping if not yet calibrated
  const m = hInv && hInv.length === 9 ? hInv : [1 / gridW, 0, 0, 0, 1 / gridH, 0, 0, 0, 1];
  const m0 = m[0],
    m1 = m[1],
    m2 = m[2],
    m3 = m[3],
    m4 = m[4],
    m5 = m[5],
    m6 = m[6],
    m7 = m[7],
    m8 = m[8];

  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let gy = 0; gy < gridH; gy++) {
    const rowOff = gy * gridW;
    const u0 = m1 * gy + m2;
    const v0 = m4 * gy + m5;
    const w0 = m7 * gy + m8;
    for (let gx = 0; gx < gridW; gx++) {
      const w = m6 * gx + w0;
      const invW = Math.abs(w) > 1e-8 ? 1 / w : 1;
      const nx = (m0 * gx + u0) * invW;
      const ny = (m3 * gx + v0) * invW;

      const sx = Math.max(0, Math.min(maxX, nx * maxX));
      const sy = Math.max(0, Math.min(maxY, ny * maxY));

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 < maxX ? x0 + 1 : maxX;
      const y1 = y0 < maxY ? y0 + 1 : maxY;
      const fx = sx - x0;
      const fy = sy - y0;

      const p00 = (y0 * srcW + x0) * 4;
      const p10 = (y0 * srcW + x1) * 4;
      const p01 = (y1 * srcW + x0) * 4;
      const p11 = (y1 * srcW + x1) * 4;

      const l00 = 0.299 * srcRgba[p00] + 0.587 * srcRgba[p00 + 1] + 0.114 * srcRgba[p00 + 2];
      const l10 = 0.299 * srcRgba[p10] + 0.587 * srcRgba[p10 + 1] + 0.114 * srcRgba[p10 + 2];
      const l01 = 0.299 * srcRgba[p01] + 0.587 * srcRgba[p01 + 1] + 0.114 * srcRgba[p01 + 2];
      const l11 = 0.299 * srcRgba[p11] + 0.587 * srcRgba[p11 + 1] + 0.114 * srcRgba[p11 + 2];

      const top = l00 + (l10 - l00) * fx;
      const bot = l01 + (l11 - l01) * fx;
      outGray[rowOff + gx] = (top + (bot - top) * fy) / 255;
    }
  }
}
