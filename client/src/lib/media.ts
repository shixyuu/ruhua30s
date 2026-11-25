/** Media helpers: MIME detection, base64, silver-gelatin film filter, 00A baseline reference plate, asset probing */

export function pickMime(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** Chrome → audio/webm(opus)；iOS Safari → audio/mp4 */
export const pickAudioMime = () =>
  pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/ogg']);

export const pickVideoMime = () =>
  pickMime(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']);

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function dataURLToArrayBuffer(data: string): ArrayBuffer {
  const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** HEAD-probe whether an asset exists (no-store so hot-swapped files apply immediately) */
export async function assetAvailable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return false;
    const len = Number(r.headers.get('content-length') || '1');
    return len > 0;
  } catch {
    return false;
  }
}

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  const s = src as HTMLCanvasElement;
  return [s.width, s.height];
}

/**
 * Silver-gelatin monochrome archival film filter.
 * Returns the processed canvas (width <= maxW).
 */
export function filmFilter(src: CanvasImageSource, maxW = 1280, opts: { contrast?: number; grain?: number } = {}): HTMLCanvasElement {
  const [sw, sh] = sourceSize(src);
  const w = Math.max(1, Math.min(maxW, sw || maxW));
  const h = Math.max(1, Math.round(w * ((sh || 9) / (sw || 16))));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const contrast = opts.contrast ?? 1.55;
  const grain = opts.grain ?? 26;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      v = (v - 128) * contrast + 128;
      v += (Math.random() - 0.5) * grain;
      const r = Math.hypot(x - cx, y - cy) / maxR;
      v *= 1 - Math.pow(r, 2.5) * 0.42;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** low-resolution mono CCTV frame (320px wide) */
export function cctvFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, label: string): void {
  const w = 320;
  const h = Math.round((w * (video.videoHeight || 240)) / (video.videoWidth || 320));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.save();
  g.translate(w, 0);
  g.scale(-1, 1); // mirror the front camera
  g.drawImage(video, 0, 0, w, h);
  g.restore();
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    v = (v - 128) * 1.35 + 128 + (Math.random() - 0.5) * 20;
    d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(232,226,213,0.85)';
  g.font = "10px 'RH Mono', ui-monospace, monospace";
  g.fillText(label, 8, h - 8);
  g.textAlign = 'right';
  g.fillText(new Date().toLocaleTimeString('en-GB', { hour12: false }), w - 8, h - 8);
  g.textAlign = 'left';
}

/**
 * Clean 16:9 baseline architectural reference plate (00A) for empty contact sheets.
 * Depicts a quiet sunlit interior wall with slanted window-pane light and a 7-step density wedge.
 */
export function drawReferencePlate(c: HTMLCanvasElement, w = 1280, h = 720): void {
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;

  // calm interior grey-white architectural gradient
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#cfc9bc');
  bg.addColorStop(0.55, '#b8b2a5');
  bg.addColorStop(1, '#8c877c');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // slanted architectural window-mullion daylight patch across the center wall
  g.save();
  g.filter = 'blur(8px)';
  g.fillStyle = 'rgba(247, 243, 234, 0.72)';
  const skew = w * 0.085;
  const panes = [
    [w * 0.26, h * 0.16, w * 0.21, h * 0.54],
    [w * 0.5, h * 0.16, w * 0.21, h * 0.54],
  ];
  for (const [px, py, pw, ph] of panes) {
    g.beginPath();
    g.moveTo(px + skew * 0.4, py);
    g.lineTo(px + pw + skew * 0.4, py);
    g.lineTo(px + pw - skew * 0.4, py + ph);
    g.lineTo(px - skew * 0.4, py + ph);
    g.closePath();
    g.fill();
    // horizontal transom shadow bar
    g.fillStyle = 'rgba(165, 159, 148, 0.52)';
    const my = py + ph * 0.48;
    g.fillRect(px - skew * 0.4, my, pw + skew * 0.8, h * 0.022);
    g.fillStyle = 'rgba(247, 243, 234, 0.72)';
  }
  g.restore();

  // subtle architectural baseboard / floor line
  g.strokeStyle = 'rgba(40, 36, 32, 0.22)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(0, h * 0.82);
  g.lineTo(w, h * 0.82);
  g.stroke();

  // fine silver-halide grain
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);

  // Stouffer-style 7-step density calibration wedge at bottom right
  const steps = 7;
  const sw = 28;
  const sh = 14;
  const sx0 = w - 42 - steps * sw;
  const sy0 = h - 34;
  for (let s = 0; s < steps; s++) {
    const v = Math.round(28 + (s / (steps - 1)) * 208);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(sx0 + s * sw, sy0, sw, sh);
  }
  g.strokeStyle = 'rgba(20, 18, 16, 0.45)';
  g.lineWidth = 1;
  g.strokeRect(sx0, sy0, steps * sw, sh);

  // discreet reference plate mark
  g.fillStyle = 'rgba(25, 22, 19, 0.68)';
  g.font = "500 14px 'RH Mono', ui-monospace, monospace";
  g.fillText('REF 00A · BASELINE DAYLIGHT CALIBRATION PLATE', 40, h - 22);
}

export const drawDefaultDoorPhoto = drawReferencePlate;
