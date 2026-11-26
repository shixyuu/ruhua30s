/**
 * /upload — Mobile Audience Photo Upload (Color Darkroom Queue)
 * - Compresses selected image long edge to 1600px (preserving original color & aspect ratio, JPEG q=0.90)
 * - Uploads via POST /api/upload -> FIFO queue in ./data/queue/ (max QUEUE_MAX, 429 when full)
 */
import { TITLE_EN } from '../lib/brand';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.9;

async function compressImageToJpeg(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Failed to decode image'));
      im.src = url;
    });
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function upload(app: HTMLElement): void {
  document.title = `Upload Memory · ${TITLE_EN}`;
  document.body.classList.add('scrollable');
  app.style.position = 'static';

  app.innerHTML = `
    <main class="upload-page">
      <div class="up-card">
        <div class="up-kicker mono">THIRTY SECONDS INTO THE FRAME · DARKROOM QUEUE</div>
        <h1 class="up-title">IF YOU COULD STEP BACK INTO ONE PHOTOGRAPH TO ALTER IT, WHICH ONE WOULD YOU CHOOSE?</h1>
        <p class="up-sub">Upload a photo from your phone. Your original file is used only for this live exposure and permanently deleted afterward.</p>

        <div class="up-preview hidden" id="previewBox">
          <img id="previewImg" alt="Uploaded photograph" />
        </div>

        <label class="up-pick" id="pickLabel">
          <input id="fileInput" type="file" accept="image/*" />
          <span id="pickText">SELECT PHOTOGRAPH</span>
        </label>

        <div class="up-status hidden" id="statusBox">
          <div class="up-badge">PHOTO LOADED · STEP UP WHEN CALLED</div>
          <div class="up-meta mono" id="metaText"></div>
        </div>

        <div class="up-err hidden" id="errBox"></div>
      </div>
    </main>`;

  const fileInput = app.querySelector('#fileInput') as HTMLInputElement;
  const pickText = app.querySelector('#pickText') as HTMLSpanElement;
  const previewBox = app.querySelector('#previewBox') as HTMLDivElement;
  const previewImg = app.querySelector('#previewImg') as HTMLImageElement;
  const statusBox = app.querySelector('#statusBox') as HTMLDivElement;
  const metaText = app.querySelector('#metaText') as HTMLDivElement;
  const errBox = app.querySelector('#errBox') as HTMLDivElement;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    errBox.classList.add('hidden');
    pickText.textContent = 'PREPARING DARKROOM PLATE...';
    try {
      const { dataUrl, width, height } = await compressImageToJpeg(file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData: dataUrl }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429 || json.error === 'queue_full') {
        throw new Error(json.message || 'The darkroom queue is full. Please try again in a few minutes.');
      }
      if (!res.ok || !json.ok) throw new Error(json.message || json.error || 'Upload failed');

      previewImg.src = dataUrl;
      previewBox.classList.remove('hidden');
      statusBox.classList.remove('hidden');
      const pos = typeof json.queueLength === 'number' ? ` · POSITION ${json.queueLength} IN QUEUE` : '';
      metaText.textContent = `${width} × ${height} PX${pos} · USED FOR ONE EXPOSURE, THEN DELETED`;
      pickText.textContent = 'REPLACE PHOTOGRAPH';
    } catch (err) {
      errBox.textContent = (err as Error).message;
      errBox.classList.remove('hidden');
      pickText.textContent = 'SELECT PHOTOGRAPH';
    }
  });
}
