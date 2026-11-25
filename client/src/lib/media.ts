/** Media helpers: MIME detection, base64, film filter, default darkroom negative, asset probing */

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
 * High-contrast mono film grain filter.
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
  const contrast = opts.contrast ?? 1.9;
  const grain = opts.grain ?? 38;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      v = (v - 128) * contrast + 128; // high contrast
      v += (Math.random() - 0.5) * grain; // grain
      const r = Math.hypot(x - cx, y - cy) / maxR;
      v *= 1 - Math.pow(r, 2.4) * 0.65; // vignette
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  // occasional scratches
  g.globalAlpha = 0.18;
  g.strokeStyle = '#fff';
  for (let k = 0; k < 4; k++) {
    const x = Math.random() * w;
    g.lineWidth = Math.random() * 1.5 + 0.3;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + (Math.random() - 0.5) * 20, h);
    g.stroke();
  }
  g.globalAlpha = 1;
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
    v = (v - 128) * 1.4 + 128 + (Math.random() - 0.5) * 24;
    d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.font = "10px 'RH Mono', ui-monospace, monospace";
  g.fillText(label, 8, h - 8);
  g.textAlign = 'right';
  g.fillText(new Date().toLocaleTimeString('en-GB', { hour12: false }), w - 8, h - 8);
  g.textAlign = 'left';
}

/** procedurally generated darkroom default negative */
export function drawDefaultDoorPhoto(c: HTMLCanvasElement, w = 1280, h = 800): void {
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  // darkroom base tone
  const bg = g.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
  bg.addColorStop(0, '#5a5a5a');
  bg.addColorStop(0.45, '#2a2a2a');
  bg.addColorStop(1, '#050505');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // horizon and wall corner
  g.strokeStyle = 'rgba(200,200,200,0.18)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, h * 0.72);
  g.lineTo(w, h * 0.7);
  g.moveTo(w * 0.22, 0);
  g.lineTo(w * 0.25, h * 0.72);
  g.stroke();
  // subject silhouette (from behind)
  g.fillStyle = 'rgba(10,10,10,0.92)';
  const px = w * 0.62;
  const py = h * 0.72;
  g.beginPath();
  g.ellipse(px, py - 300, 34, 40, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(px - 70, py - 250);
  g.quadraticCurveTo(px, py - 275, px + 70, py - 250);
  g.lineTo(px + 55, py - 90);
  g.lineTo(px + 35, py);
  g.lineTo(px - 35, py);
  g.lineTo(px - 55, py - 90);
  g.closePath();
  g.fill();
  // anomalous shadow (blurred)
  g.save();
  g.filter = 'blur(18px)';
  g.fillStyle = 'rgba(0,0,0,0.85)';
  g.beginPath();
  g.ellipse(w * 0.33, h * 0.42, 70, 230, -0.08, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // grain
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 46;
    const v = Math.max(0, Math.min(255, d[i] + n));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  // film edge: black rebate + sprockets + invented edge print
  g.fillStyle = '#050505';
  g.fillRect(0, 0, w, 44);
  g.fillRect(0, h - 44, w, 44);
  g.fillStyle = 'rgba(235,229,214,0.22)';
  for (let x = 12; x < w; x += 34) {
    g.fillRect(x, 14, 16, 16);
    g.fillRect(x, h - 30, 16, 16);
  }
  g.fillStyle = 'rgba(200,137,44,0.75)';
  g.font = "13px 'RH Mono', ui-monospace, monospace";
  for (let x = 30, n = 0; x < w; x += 300, n++) g.fillText(`RUHUA SAFETY FILM  0${n}  ▸0${n}A`, x, 40 + 0 * n);
  g.fillText('NODE 000 · DEFAULT NEGATIVE', 30, h - 48);
}
