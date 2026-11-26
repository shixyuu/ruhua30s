/**
 * /admin — mobile-first single-hand operator desk & remote homography calibration (v3.2)
 */
import { Net, mountFlashOverlay } from '../lib/net';
import { computeHomographyInv } from '../lib/homography';
import type { ContactSheetInfo, PersistedState, Point2D, Role, StorageStats } from '../../../shared/protocol';
import { CONFIG_BOUNDS, outcomeShortCode } from '../../../shared/protocol';
import { TITLE_EN } from '../lib/brand';
import { triggerDownload } from '../lib/media';
import { escapeHtml } from '../lib/unlock';

const ROLE_LABEL: Record<Exclude<Role, 'admin'>, string> = {
  main: 'Projector',
  door: 'Entrance QR',
  station1: 'Mic Gauge',
  station2: 'Fix Fader',
};

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

export default function admin(app: HTMLElement): void {
  document.title = `Control desk · ${TITLE_EN}`;
  document.body.classList.add('scrollable');
  app.style.position = 'static';

  const params = new URLSearchParams(location.search);
  const qTok = params.get('token');
  if (qTok) localStorage.setItem('ruhua.admin.token', qTok);
  const token = qTok || localStorage.getItem('ruhua.admin.token') || undefined;
  const tq = token ? `token=${encodeURIComponent(token)}` : '';

  app.innerHTML = `
  <div class="admin-v3">
    <header class="desk-top">
      <span class="ttl">RH-30 · COLOR DARKROOM DESK</span>
      <span class="roll-pill" id="topRoll">ROLL 01</span>
      <span class="conn off" id="conn">OFFLINE</span>
    </header>

    <main class="desk-v3">
      <!-- 1. Trigger & Queue Source -->
      <section class="card trigger-card">
        <button class="shutter-v3" id="shutter" type="button" disabled>
          <span class="s-meta"><span id="shutterRoll">ROLL 01 · NEXT FR 01A</span><span class="kbd">SPACE</span></span>
          <span class="s-main">START SESSION</span>
          <span class="s-hint" id="shutterHint">Connecting…</span>
        </button>

        <div class="queue-strip">
          <span class="mono" id="queueState">QUEUE: WAITING FOR UPLOAD</span>
          <button class="btn-mini" id="sampleBtn" type="button">USE BUILT-IN SAMPLE: OFF</button>
        </div>

        <div class="phase-strip">
          <div>
            <div class="p-name" id="phase">IDLE</div>
            <div class="p-sub" id="roundMeta">ROUND 000 · STANDBY</div>
          </div>
          <div class="p-time mono" id="phaseClock">0.0 S</div>
        </div>

        <div class="quick-row">
          <button class="btn-act" id="skipPhase" type="button" disabled>SKIP PHASE →</button>
          <button class="btn-act danger" id="reset" type="button">RESET TO IDLE</button>
          <button class="btn-act" id="testFlash" type="button">TEST FLASH</button>
        </div>
      </section>

      <!-- 2. Instax Express Print Card -->
      <section class="card instax-card">
        <div class="card-h">
          <span>INSTAX EXPRESS PRINT</span>
          <span class="mono" id="latestSlug">NO PRINT YET</span>
        </div>
        <div class="instax-pv">
          <img id="latest" alt="Latest archival print" class="hidden" />
          <div class="instax-empty" id="latestNone">No print fixed yet. Start a session to capture a color darkroom print.</div>
        </div>
        <button class="btn-instax" id="shareInstax" type="button" disabled>SAVE / SHARE FOR INSTAX</button>
      </section>

      <!-- 3. Calibration & Home Test -->
      <section class="card cal-card">
        <div class="card-h">
          <span>CALIBRATION &amp; TEST</span>
          <span class="mono" id="calBadge">UNSET</span>
        </div>

        <div class="cal-btn-row">
          <button class="btn-act" id="calModeBtn" type="button">ENTER CALIBRATION</button>
          <button class="btn-act" id="simBtn" type="button">SIMULATOR: OFF</button>
        </div>

        <div class="sliders">
          <label class="slider-ctl">
            <div class="sl-head"><span>Easel Margin</span><span class="mono" id="marginVal">6%</span></div>
            <input id="marginRange" type="range" min="${CONFIG_BOUNDS.easelMargin.min}" max="${CONFIG_BOUNDS.easelMargin.max}" step="1" value="6" />
          </label>
          <label class="slider-ctl">
            <div class="sl-head"><span>Detect Threshold (lower = more sensitive)</span><span class="mono" id="diffVal">0.12</span></div>
            <input id="diffRange" type="range" min="${CONFIG_BOUNDS.diffSensitivity.min}" max="${CONFIG_BOUNDS.diffSensitivity.max}" step="0.01" value="0.12" />
          </label>
        </div>

        <div class="cal-snap-wrap">
          <canvas id="calCanvas" width="640" height="360"></canvas>
          <div class="cal-hint mono" id="calHint">Tap GRAB CAMERA SNAPSHOT, then tap/drag TL → TR → BR → BL.</div>
        </div>

        <div class="cal-btn-row">
          <button class="btn-act" id="grabSnap" type="button">GRAB CAMERA SNAPSHOT</button>
          <button class="btn-act primary-act" id="saveHomog" type="button">SAVE HOMOGRAPHY</button>
        </div>
      </section>

      <!-- 3b. Camera Dodge Detection (live tuning) -->
      <section class="card cal-card detect-card">
        <div class="card-h">
          <span>CAMERA DETECTION · TRIGGER AREA</span>
          <span class="mono det-lamp" id="detLamp">OFF</span>
        </div>
        <div class="cal-btn-row">
          <button class="btn-act" id="detViewBtn" type="button">DETECT VIEW: OFF</button>
          <button class="btn-act" id="detRerefBtn" type="button">RE-REFERENCE (EMPTY EASEL)</button>
        </div>
        <div class="det-view">
          <img id="detImg" alt="detection view from /main" class="hidden" />
          <div class="cal-hint mono" id="detHint">Turn DETECT VIEW on: /main streams its camera (~2.5 fps). Left: camera + calibrated quad. Right: easel grid, red = above threshold, amber = accumulated dodge, dashed = photo area.</div>
        </div>
        <div class="meter-row det-meter">
          <div class="det-bar"><div class="det-fill" id="detFill"></div><div class="det-line" id="detLine"></div></div>
          <span class="mono" id="detReadout">ACTIVE 0.0% · TRIGGER ≥ 0.2%</span>
        </div>
        <div class="sliders">
          <label class="slider-ctl">
            <div class="sl-head"><span>Noise Filter (blur radius)</span><span class="mono" id="blurVal">0</span></div>
            <input id="blurRange" type="range" min="${CONFIG_BOUNDS.detectBlur.min}" max="${CONFIG_BOUNDS.detectBlur.max}" step="1" value="0" />
          </label>
          <label class="slider-ctl">
            <div class="sl-head"><span>Min Area (ignore frames below)</span><span class="mono" id="areaVal">0.0%</span></div>
            <input id="areaRange" type="range" min="${CONFIG_BOUNDS.detectMinArea.min}" max="${CONFIG_BOUNDS.detectMinArea.max}" step="0.1" value="0" />
          </label>
          <label class="slider-ctl">
            <div class="sl-head"><span>Full Dodge After (hold time)</span><span class="mono" id="holdVal">18s</span></div>
            <input id="holdRange" type="range" min="${CONFIG_BOUNDS.fullDodgeSec.min}" max="${CONFIG_BOUNDS.fullDodgeSec.max}" step="1" value="18" />
          </label>
        </div>
      </section>

      <!-- 4. Acoustic Calibration -->
      <section class="card cal-card">
        <div class="card-h">
          <span>ACOUSTIC DEVELOPING</span>
          <span class="mono" id="devReadout">DEV 0% · MIC 0%</span>
        </div>

        <div class="meter-row">
          <div class="meter-lbl"><span>MIC ENERGY (/station1)</span><span class="mono" id="micPct">0%</span></div>
          <div class="bar-track">
            <div class="bar-fill mic" id="micBar"></div>
            <div class="thresh-line" id="floorLine" title="Noise Floor"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-lbl"><span>DEVELOP (0–25% UNDER · 75–105% GOLD · &gt;105% BURN)</span><span class="mono" id="devPct">0%</span></div>
          <div class="bar-track dev-track">
            <div class="zone-under"></div>
            <div class="zone-gold"></div>
            <div class="zone-burn"></div>
            <div class="bar-fill dev" id="devBar"></div>
          </div>
        </div>

        <div class="sliders">
          <label class="slider-ctl">
            <div class="sl-head"><span>Noise Floor</span><span class="mono" id="floorVal">0.08</span></div>
            <input id="floorRange" type="range" min="${CONFIG_BOUNDS.noiseFloor.min}" max="${CONFIG_BOUNDS.noiseFloor.max}" step="0.01" value="0.08" />
          </label>
          <label class="slider-ctl">
            <div class="sl-head"><span>Develop Speed</span><span class="mono" id="speedVal">0.20</span></div>
            <input id="speedRange" type="range" min="${CONFIG_BOUNDS.devSpeed.min}" max="${CONFIG_BOUNDS.devSpeed.max}" step="0.01" value="0.20" />
          </label>
        </div>
        <button class="btn-act btn-pulse" id="testDev" type="button" disabled>TEST DEVELOP PULSE (SOLO CAL)</button>
      </section>

      <!-- 5. Phase Timings & Roll -->
      <section class="card timing-card">
        <div class="card-h">
          <span>PHASE TIMINGS &amp; ROLL</span>
          <button class="btn-mini amber" id="newRoll" type="button">NEW ROLL</button>
        </div>
        <div class="steppers">
          ${stepperHtml('observeSec', '01 OBSERVE (SAFELIGHT)', '3–20s', 8)}
          ${stepperHtml('exposeSec', '02 EXPOSE (DODGE)', '10–60s', 30)}
          ${stepperHtml('developSec', '03 DEVELOP (SOUND)', '10–45s', 25)}
          ${stepperHtml('revealSec', '04 REVEAL (COMPARE)', '6–25s', 12)}
        </div>
      </section>

      <!-- 6. Device Heartbeats & Archive & VPS Storage -->
      <section class="card devices-card">
        <div class="card-h">
          <span>TERMINALS</span>
          <span class="mono" id="onlineCount">0 / 4</span>
        </div>
        <div class="lights-v3" id="lights"></div>
      </section>

      <section class="card archive-card">
        <div class="card-h">
          <span id="archTitle">ROLL 01 ARCHIVE</span>
          <span class="mono" id="totalDisk">0 TOTAL</span>
        </div>
        <div class="archive-v3" id="archive"></div>
      </section>

      <section class="card storage-card">
        <div class="card-h">
          <span>VPS STORAGE &amp; QUEUE</span>
          <span class="mono" id="queueStat">QUEUE: 0</span>
        </div>
        <div class="storage-stat mono" id="storageStat">VPS STORAGE: 0.0 MB · 0 ROLLS · 0 FRAMES</div>
        <div class="cache-actions">
          <button class="btn-act" id="clearTemp" type="button">CLEAR TEMP CACHE</button>
          <button class="btn-act danger" id="purgeAll" type="button">PURGE ALL DATA</button>
        </div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast"></div>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const topRoll = $<HTMLSpanElement>('#topRoll');
  const conn = $<HTMLSpanElement>('#conn');
  const shutterBtn = $<HTMLButtonElement>('#shutter');
  const shutterRoll = $<HTMLSpanElement>('#shutterRoll');
  const shutterHint = $<HTMLSpanElement>('#shutterHint');
  const queueState = $<HTMLSpanElement>('#queueState');
  const sampleBtn = $<HTMLButtonElement>('#sampleBtn');
  const phaseEl = $<HTMLDivElement>('#phase');
  const roundMeta = $<HTMLDivElement>('#roundMeta');
  const phaseClock = $<HTMLDivElement>('#phaseClock');
  const skipBtn = $<HTMLButtonElement>('#skipPhase');
  const resetBtn = $<HTMLButtonElement>('#reset');
  const testFlashBtn = $<HTMLButtonElement>('#testFlash');
  const latestImg = $<HTMLImageElement>('#latest');
  const latestNone = $<HTMLDivElement>('#latestNone');
  const latestSlug = $<HTMLSpanElement>('#latestSlug');
  const shareBtn = $<HTMLButtonElement>('#shareInstax');

  const calBadge = $<HTMLSpanElement>('#calBadge');
  const calModeBtn = $<HTMLButtonElement>('#calModeBtn');
  const simBtn = $<HTMLButtonElement>('#simBtn');
  const marginRange = $<HTMLInputElement>('#marginRange');
  const marginVal = $<HTMLSpanElement>('#marginVal');
  const diffRange = $<HTMLInputElement>('#diffRange');
  const diffVal = $<HTMLSpanElement>('#diffVal');
  const detLamp = $<HTMLSpanElement>('#detLamp');
  const detViewBtn = $<HTMLButtonElement>('#detViewBtn');
  const detRerefBtn = $<HTMLButtonElement>('#detRerefBtn');
  const detImg = $<HTMLImageElement>('#detImg');
  const detHint = $<HTMLDivElement>('#detHint');
  const detFill = $<HTMLDivElement>('#detFill');
  const detLine = $<HTMLDivElement>('#detLine');
  const detReadout = $<HTMLSpanElement>('#detReadout');
  const blurRange = $<HTMLInputElement>('#blurRange');
  const blurVal = $<HTMLSpanElement>('#blurVal');
  const areaRange = $<HTMLInputElement>('#areaRange');
  const areaVal = $<HTMLSpanElement>('#areaVal');
  const holdRange = $<HTMLInputElement>('#holdRange');
  const holdVal = $<HTMLSpanElement>('#holdVal');
  const calCanvas = $<HTMLCanvasElement>('#calCanvas');
  const calCtx = calCanvas.getContext('2d')!;
  const calHint = $<HTMLDivElement>('#calHint');
  const grabSnapBtn = $<HTMLButtonElement>('#grabSnap');
  const saveHomogBtn = $<HTMLButtonElement>('#saveHomog');

  const devReadout = $<HTMLSpanElement>('#devReadout');
  const micPct = $<HTMLSpanElement>('#micPct');
  const micBar = $<HTMLDivElement>('#micBar');
  const floorLine = $<HTMLDivElement>('#floorLine');
  const devPctEl = $<HTMLSpanElement>('#devPct');
  const devBar = $<HTMLDivElement>('#devBar');
  const floorRange = $<HTMLInputElement>('#floorRange');
  const floorVal = $<HTMLSpanElement>('#floorVal');
  const speedRange = $<HTMLInputElement>('#speedRange');
  const speedVal = $<HTMLSpanElement>('#speedVal');
  const testDevBtn = $<HTMLButtonElement>('#testDev');
  const newRollBtn = $<HTMLButtonElement>('#newRoll');
  const lights = $<HTMLDivElement>('#lights');
  const onlineCount = $<HTMLSpanElement>('#onlineCount');
  const archTitle = $<HTMLSpanElement>('#archTitle');
  const totalDisk = $<HTMLSpanElement>('#totalDisk');
  const archive = $<HTMLDivElement>('#archive');
  const queueStat = $<HTMLSpanElement>('#queueStat');
  const storageStat = $<HTMLDivElement>('#storageStat');
  const clearTempBtn = $<HTMLButtonElement>('#clearTemp');
  const purgeAllBtn = $<HTMLButtonElement>('#purgeAll');
  const toastEl = document.getElementById('toast')!;

  const net = new Net('admin', token);
  (window as any).__net = net;
  mountFlashOverlay(net);

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2400);
  };

  // ---------------- Shutter & Queue ----------------
  let lastShutter = 0;
  function fireShutter(): void {
    if (net.phase !== 'IDLE' || !net.connected) return;
    const now = Date.now();
    if (now - lastShutter < 1500) return;
    lastShutter = now;
    shutterBtn.disabled = true;
    navigator.vibrate?.(30);
    net.send({ type: 'START_SESSION', token });
  }
  shutterBtn.addEventListener('click', fireShutter);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    if (!e.repeat) fireShutter();
  });

  skipBtn.addEventListener('click', () => {
    if (net.phase === 'IDLE' || !net.connected) return;
    net.send({ type: 'admin', action: 'skipPhase', token });
  });
  testFlashBtn.addEventListener('click', () => net.send({ type: 'TEST_FLASH', token }));

  sampleBtn.addEventListener('click', () => {
    const cur = net.config?.sampleFallback ?? 0;
    const next = (cur + 1) % 8; // 0=OFF, 1..6=sample photos, 7=last print
    sendConfigPatch({ sampleFallback: next }, true);
  });

  // ---------------- Two-tap buttons ----------------
  function wireTwoTap(btn: HTMLButtonElement, idleTxt: string, armTxt: string, onConfirm: () => void): void {
    let t = 0;
    const disarm = () => {
      clearTimeout(t);
      btn.classList.remove('armed');
      btn.textContent = idleTxt;
    };
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = armTxt;
        t = window.setTimeout(disarm, 3500);
        return;
      }
      disarm();
      onConfirm();
    });
  }

  wireTwoTap(resetBtn, 'RESET TO IDLE', 'CONFIRM RESET?', () => net.send({ type: 'admin', action: 'reset', token }));
  wireTwoTap(newRollBtn, 'NEW ROLL', 'CONFIRM NEW ROLL?', () => net.send({ type: 'admin', action: 'newRoll', token }));
  wireTwoTap(clearTempBtn, 'CLEAR TEMP CACHE', 'CONFIRM CLEAR?', async () => {
    const r = await fetch('/api/cache/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'runtime', token }),
    });
    const j = await r.json();
    if (j.ok) {
      updatePersistedUi(j.state, j.storage);
      toast('✓ Queue cache cleared');
    }
  });
  wireTwoTap(purgeAllBtn, 'PURGE ALL DATA', 'CONFIRM PURGE ALL?', async () => {
    const r = await fetch('/api/cache/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all', token }),
    });
    const j = await r.json();
    if (j.ok) {
      updatePersistedUi(j.state, j.storage);
      toast('✓ All rolls & queue purged');
    }
  });

  // ---------------- Calibration Snapshot & 4-Corner Homography UI ----------------
  let snapImg: HTMLImageElement | null = null;
  let corners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 0.08, y: 0.08 },
    { x: 0.92, y: 0.08 },
    { x: 0.92, y: 0.92 },
    { x: 0.08, y: 0.92 },
  ];
  let dragCornerIdx = -1;
  const LABELS = ['TL', 'TR', 'BR', 'BL'];

  function drawCalCanvas(): void {
    const w = calCanvas.width;
    const h = calCanvas.height;
    calCtx.fillStyle = '#050504';
    calCtx.fillRect(0, 0, w, h);

    if (snapImg && snapImg.complete && snapImg.naturalWidth > 0) {
      calCtx.drawImage(snapImg, 0, 0, w, h);
    } else {
      calCtx.fillStyle = 'rgba(232, 226, 213, 0.25)';
      calCtx.font = '14px "RH Mono", monospace';
      calCtx.textAlign = 'center';
      calCtx.fillText('NO SNAPSHOT YET — TAP GRAB CAMERA SNAPSHOT', w / 2, h / 2);
      calCtx.textAlign = 'left';
    }

    // Quad outline
    calCtx.strokeStyle = '#C48A3A';
    calCtx.lineWidth = 2;
    calCtx.beginPath();
    corners.forEach((p, idx) => {
      const x = p.x * w;
      const y = p.y * h;
      if (idx === 0) calCtx.moveTo(x, y);
      else calCtx.lineTo(x, y);
    });
    calCtx.closePath();
    calCtx.stroke();

    // Corner handles
    corners.forEach((p, idx) => {
      const x = p.x * w;
      const y = p.y * h;
      calCtx.fillStyle = '#9A0A0A';
      calCtx.beginPath();
      calCtx.arc(x, y, 11, 0, Math.PI * 2);
      calCtx.fill();
      calCtx.strokeStyle = '#E8E2D5';
      calCtx.lineWidth = 2;
      calCtx.stroke();

      calCtx.fillStyle = '#E8E2D5';
      calCtx.font = 'bold 11px "RH Mono", monospace';
      calCtx.fillText(LABELS[idx], x + 13, y + 4);
    });
  }

  function eventToNorm(e: PointerEvent): Point2D {
    const r = calCanvas.getBoundingClientRect();
    return {
      x: Math.max(0.01, Math.min(0.99, (e.clientX - r.left) / r.width)),
      y: Math.max(0.01, Math.min(0.99, (e.clientY - r.top) / r.height)),
    };
  }

  calCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = eventToNorm(e);
    let best = 0;
    let bestD = Infinity;
    corners.forEach((c, idx) => {
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    dragCornerIdx = best;
    corners[best] = p;
    drawCalCanvas();
    try {
      calCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  calCanvas.addEventListener('pointermove', (e) => {
    if (dragCornerIdx < 0) return;
    e.preventDefault();
    corners[dragCornerIdx] = eventToNorm(e);
    drawCalCanvas();
  });
  calCanvas.addEventListener('pointerup', () => {
    dragCornerIdx = -1;
  });

  calModeBtn.addEventListener('click', () => {
    if (!net.connected) return;
    if (net.phase === 'CALIBRATING') {
      net.send({ type: 'EXIT_CALIBRATION', token });
    } else {
      net.send({ type: 'ENTER_CALIBRATION', token });
    }
  });

  simBtn.addEventListener('click', () => {
    const next = !(net.config?.mouseSimulator ?? false);
    sendConfigPatch({ mouseSimulator: next }, true);
  });

  grabSnapBtn.addEventListener('click', () => {
    if (!net.connected) return;
    net.send({ type: 'REQUEST_SNAPSHOT', token });
    toast('Requesting camera snapshot from /main…');
  });

  net.on('SNAPSHOT_READY', (m) => {
    const im = new Image();
    im.onload = () => {
      snapImg = im;
      drawCalCanvas();
      calHint.textContent = 'Drag TL / TR / BR / BL to match the 4 target corners, then tap SAVE HOMOGRAPHY.';
    };
    im.src = m.imageData;
  });

  net.on('calibration', (m) => {
    if (m.calibration.corners) {
      corners = m.calibration.corners;
      drawCalCanvas();
    }
    calBadge.textContent = m.calibration.hInv ? 'CALIBRATED' : 'UNSET';
  });

  saveHomogBtn.addEventListener('click', async () => {
    const hInv = computeHomographyInv(corners);
    if (!hInv) return toast('✗ Degenerate corners — adjust 4 points');
    try {
      const r = await fetch('/api/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corners, hInv, token }),
      });
      const j = await r.json();
      if (j.ok) {
        calBadge.textContent = 'CALIBRATED';
        toast('✓ Homography saved to VPS');
      } else toast(`✗ ${j.error}`);
    } catch {
      toast('✗ Failed to save homography');
    }
  });

  // ---------------- Instax Share / Download ----------------
  let cachedUrl = '';
  let cachedFileName = 'RH30-print.jpg';
  let cachedFile: File | null = null;

  async function cacheLatestForInstax(url: string, filename: string): Promise<void> {
    cachedUrl = url;
    cachedFileName = filename;
    cachedFile = null;
    shareBtn.disabled = !url;
    if (!url) return;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      const blob = await resp.blob();
      if (cachedUrl === url) cachedFile = new File([blob], filename, { type: 'image/jpeg' });
    } catch {
      cachedFile = null;
    }
  }

  shareBtn.addEventListener('click', async () => {
    if (!cachedUrl) return;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (cachedFile && typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [cachedFile] }))) {
      try {
        await nav.share({ files: [cachedFile], title: cachedFileName });
        return;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    }
    triggerDownload(cachedUrl, cachedFileName);
    toast(`Downloading ${cachedFileName}`);
  });

  // ---------------- Config Sliders & Steppers ----------------
  let cfgSendTimer = 0;
  function sendConfigPatch(patch: Record<string, unknown>, immediate = false): void {
    clearTimeout(cfgSendTimer);
    const run = () => net.send({ type: 'admin', action: 'setConfig', config: patch as any, token });
    if (immediate) run();
    else cfgSendTimer = window.setTimeout(run, 80);
  }

  marginRange.addEventListener('input', () => {
    const v = Number(marginRange.value);
    marginVal.textContent = `${v}%`;
    sendConfigPatch({ easelMargin: v });
  });
  // ---------------- camera detection tuning + live view ----------------
  let detOn = false;
  let detLastFrameAt = 0;
  const DET_METER_MAX = 10; // meter full scale, % of photo area
  function setDetOn(on: boolean): void {
    detOn = on;
    detViewBtn.textContent = `DETECT VIEW: ${on ? 'ON' : 'OFF'}`;
    detViewBtn.classList.toggle('primary-act', on);
    if (!on) {
      detLamp.textContent = 'OFF';
      detLamp.className = 'mono det-lamp';
      detImg.classList.add('hidden');
    }
  }
  detViewBtn.addEventListener('click', () => net.send({ type: 'DETECT_VIEW', on: !detOn, token }));
  detRerefBtn.addEventListener('click', () => {
    net.send({ type: 'DETECT_VIEW', on: true, reref: true, token });
    toast('Reference re-captured on /main (keep the easel empty)');
  });
  net.on('DETECT_VIEW', (m) => setDetOn(m.on));
  net.on('DETECT_FRAME', (m) => {
    if (!detOn) setDetOn(true);
    detLastFrameAt = Date.now();
    detImg.src = m.imageData;
    detImg.classList.remove('hidden');
    const st = m.stats;
    const floor = Math.max(0.2, st.minAreaPct);
    detFill.style.width = `${Math.min(100, (st.photoActivePct / DET_METER_MAX) * 100).toFixed(1)}%`;
    detLine.style.left = `${Math.min(100, (floor / DET_METER_MAX) * 100).toFixed(1)}%`;
    detFill.classList.toggle('hot', st.triggered);
    const ref = !st.camLive ? 'NO CAMERA' : st.refKind === 'round' ? 'vs ROUND CLEAN PLATE' : 'vs PREVIEW REFERENCE';
    detReadout.textContent = `ACTIVE ${st.photoActivePct.toFixed(1)}% · TRIGGER ≥ ${floor.toFixed(1)}% · THR ${st.threshold.toFixed(2)} · AE ×${st.aeScale.toFixed(2)} · ${st.phase} · ${ref}`;
    detLamp.textContent = !st.camLive ? 'NO CAMERA' : st.triggered ? 'TRIGGERED' : 'CLEAR';
    detLamp.className = `mono det-lamp ${st.triggered ? 'hot' : st.camLive ? 'ok' : ''}`;
    detHint.classList.add('hidden');
  });
  window.setInterval(() => {
    if (detOn && detLastFrameAt && Date.now() - detLastFrameAt > 3000) {
      detLamp.textContent = 'NO FRAMES (/main offline?)';
      detLamp.className = 'mono det-lamp';
    }
  }, 1000);
  blurRange.addEventListener('input', () => {
    const v = Number(blurRange.value);
    blurVal.textContent = String(v);
    sendConfigPatch({ detectBlur: v });
  });
  areaRange.addEventListener('input', () => {
    const v = Number(areaRange.value);
    areaVal.textContent = `${v.toFixed(1)}%`;
    sendConfigPatch({ detectMinArea: v });
  });
  holdRange.addEventListener('input', () => {
    const v = Number(holdRange.value);
    holdVal.textContent = `${v}s`;
    sendConfigPatch({ fullDodgeSec: v });
  });

  diffRange.addEventListener('input', () => {
    const v = Number(diffRange.value);
    diffVal.textContent = v.toFixed(2);
    sendConfigPatch({ diffSensitivity: v });
  });
  floorRange.addEventListener('input', () => {
    const v = Number(floorRange.value);
    floorVal.textContent = v.toFixed(2);
    floorLine.style.left = `${Math.round(v * 100)}%`;
    sendConfigPatch({ noiseFloor: v });
  });
  speedRange.addEventListener('input', () => {
    const v = Number(speedRange.value);
    speedVal.textContent = v.toFixed(2);
    sendConfigPatch({ devSpeed: v });
  });
  testDevBtn.addEventListener('click', () => {
    if (net.phase === 'DEVELOP' && net.connected) net.send({ type: 'admin', action: 'testDevelop', token });
  });

  app.querySelectorAll<HTMLButtonElement>('[data-step-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.stepKey as keyof typeof CONFIG_BOUNDS;
      const delta = Number(btn.dataset.stepDelta || 0);
      const cur = Number((net.config as any)?.[key] ?? CONFIG_BOUNDS[key].min);
      const b = CONFIG_BOUNDS[key];
      const next = Math.min(b.max, Math.max(b.min, Math.round(cur + delta)));
      if (next !== cur) sendConfigPatch({ [key]: next }, true);
    });
  });

  function updateSampleLabel(sampleIdx: number): void {
    const map = ['OFF', 'SAMPLE #1', 'SAMPLE #2', 'SAMPLE #3', 'SAMPLE #4', 'SAMPLE #5', 'SAMPLE #6', 'LAST PRINT'];
    sampleBtn.textContent = `USE BUILT-IN SAMPLE: ${map[sampleIdx] ?? 'OFF'}`;
    sampleBtn.classList.toggle('armed', sampleIdx > 0);
  }

  net.on('config', (m) => {
    const c = m.config;
    topRoll.textContent = `ROLL ${pad2(c.rollNumber)}`;
    marginRange.value = String(c.easelMargin);
    marginVal.textContent = `${c.easelMargin}%`;
    diffRange.value = String(c.diffSensitivity);
    diffVal.textContent = c.diffSensitivity.toFixed(2);
    blurRange.value = String(c.detectBlur);
    blurVal.textContent = String(c.detectBlur);
    areaRange.value = String(c.detectMinArea);
    areaVal.textContent = `${c.detectMinArea.toFixed(1)}%`;
    holdRange.value = String(c.fullDodgeSec);
    holdVal.textContent = `${c.fullDodgeSec}s`;
    floorRange.value = String(c.noiseFloor);
    floorVal.textContent = c.noiseFloor.toFixed(2);
    floorLine.style.left = `${Math.round(c.noiseFloor * 100)}%`;
    speedRange.value = String(c.devSpeed);
    speedVal.textContent = c.devSpeed.toFixed(2);

    simBtn.textContent = `SIMULATOR: ${c.mouseSimulator ? 'MOUSE DODGE ON' : 'OFF'}`;
    simBtn.classList.toggle('primary-act', c.mouseSimulator);
    updateSampleLabel(c.sampleFallback);

    for (const key of ['observeSec', 'exposeSec', 'developSec', 'revealSec'] as const) {
      const el = app.querySelector(`[data-step-val="${key}"]`);
      if (el) el.textContent = String(c[key]);
    }
    renderArchive(net.contactSheet);
  });

  // ---------------- Live meters & clients ----------------
  net.on('dev', (m) => {
    const mic = Math.round(Math.max(0, Math.min(1, m.audioLevel)) * 100);
    const dev = Math.round(Math.max(0, m.devProgress) * 100);
    micPct.textContent = `${mic}%`;
    micBar.style.width = `${mic}%`;
    devPctEl.textContent = `${dev}%`;
    devBar.style.width = `${Math.min(100, (dev / 150) * 100)}%`;
    devBar.classList.toggle('gold', dev >= 75 && dev <= 105);
    devBar.classList.toggle('burn', dev > 105);
    devReadout.textContent = `DEV ${dev}% · MIC ${mic}%`;
  });

  net.on('clients', (m) => {
    lights.innerHTML = '';
    let on = 0;
    for (const c of m.clients) {
      if (c.role === 'admin') continue;
      if (c.online) on++;
      const d = document.createElement('div');
      d.className = 'light' + (c.online ? ' on' : '');
      d.innerHTML = `<div class="bulb"></div><div class="nm"><span></span><span class="r"></span></div>`;
      (d.querySelector('.nm span') as HTMLElement).textContent = `${ROLE_LABEL[c.role as keyof typeof ROLE_LABEL]}${c.count > 1 ? ` ×${c.count}` : ''}`;
      (d.querySelector('.nm .r') as HTMLElement).textContent = c.online ? 'ON' : 'OFF';
      lights.appendChild(d);
    }
    onlineCount.textContent = `${on} / 4`;
  });

  net.on('ack', (m) => toast(`${m.ok ? '✓' : '✗'} ${m.message || m.what}`));
  net.on('open', () => {
    toast('Connected');
    conn.textContent = 'ONLINE';
    conn.classList.remove('off');
    void loadDiskTotal();
  });
  net.on('close', () => {
    toast('Reconnecting…');
    conn.textContent = 'OFFLINE';
    conn.classList.add('off');
    lights.querySelectorAll('.light').forEach((l) => l.classList.remove('on'));
  });

  // ---------------- Archive & Storage ----------------
  function renderArchive(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? 1;
    const frames = sheet?.frames ?? [];
    archTitle.textContent = `ROLL ${pad2(rollNo)} ARCHIVE (${frames.length})`;
    if (net.phase === 'IDLE') {
      shutterRoll.textContent = `ROLL ${pad2(rollNo)} · NEXT FR ${pad2(frames.length + 1)}A`;
    }

    if (frames.length === 0) {
      archive.innerHTML = `<div class="arch-empty">Roll ${pad2(rollNo)} is empty.</div>`;
      return;
    }

    const latestFrame = frames[frames.length - 1];
    const dlName = `RH30_R${pad2(rollNo)}_FR${latestFrame.frameNo}.jpg`;
    const code = latestFrame.outcomeCode || outcomeShortCode(latestFrame.outcome);
    latestImg.src = latestFrame.url;
    latestImg.classList.remove('hidden');
    latestNone.classList.add('hidden');
    latestSlug.textContent = `R${pad2(rollNo)} · ${latestFrame.frameNo} · ${code}${latestFrame.devPercent != null ? ` · DEV ${latestFrame.devPercent}%` : ''}`;
    void cacheLatestForInstax(latestFrame.url, dlName);

    const reversed = [...frames].reverse();
    archive.innerHTML = reversed
      .map((f, idx) => {
        const fn = `RH30_R${pad2(rollNo)}_FR${f.frameNo}.jpg`;
        const fc = f.outcomeCode || outcomeShortCode(f.outcome);
        return `<div class="arch-item${idx === 0 ? ' latest' : ''}">
          <a href="${escapeHtml(f.url)}" download="${escapeHtml(fn)}" title="Download ${escapeHtml(fn)}">
            <img src="${escapeHtml(f.url)}" loading="lazy" alt="${escapeHtml(f.frameNo)}" />
          </a>
          <div class="arch-fn"><span>${escapeHtml(f.frameNo)} · ${escapeHtml(fc)}</span><span>${f.devPercent != null ? `${f.devPercent}%` : ''}</span></div>
        </div>`;
      })
      .join('');
  }

  function updatePersistedUi(st?: PersistedState | null, storage?: StorageStats | null): void {
    if (st) {
      queueState.textContent = st.hasQueuedPhoto ? 'QUEUE: READY (UPLOADED)' : 'QUEUE: WAITING FOR UPLOAD';
      queueState.classList.toggle('q-ready', st.hasQueuedPhoto);
    }
    if (storage) {
      const mb = (storage.totalBytes / (1024 * 1024)).toFixed(2);
      storageStat.textContent = `VPS STORAGE: ${mb} MB · ${storage.rollsCount} ROLLS · ${storage.framesCount} FRAMES`;
      queueStat.textContent = `QUEUE: ${storage.queueCount}`;
    }
  }

  net.on('STATE_SYNC', (m) => updatePersistedUi(m.persisted, m.storage));
  net.on('contact-sheet', (m) => {
    renderArchive(m.sheet);
    void loadDiskTotal();
  });

  async function loadDiskTotal(): Promise<void> {
    try {
      const [archR, stateR] = await Promise.all([
        fetch(`/api/archive?all=1${tq ? '&' + tq : ''}`, { cache: 'no-store' }),
        fetch('/api/state', { cache: 'no-store' }),
      ]);
      const j = await archR.json();
      if (j.ok) totalDisk.textContent = `${j.count} TOTAL ON DISK`;
      const sj = await stateR.json();
      if (sj.ok) updatePersistedUi(sj.state, sj.storage);
    } catch {
      /* ignore */
    }
  }

  // ---------------- Tick ----------------
  function tick(): void {
    const st = net.state;
    if (st) {
      const p = st.state;
      phaseEl.textContent = p;
      const r = st.round;
      roundMeta.textContent = `ROUND ${String(r.id).padStart(3, '0')} · ROLL ${pad2(r.rollNumber)} · ${pad2(r.frameNumber)}A`;
      if (p !== 'IDLE') shutterRoll.textContent = `ROLL ${pad2(r.rollNumber)} · FR ${pad2(r.frameNumber)}A`;

      const el = net.elapsedMs() / 1000;
      const dur = st.phaseDurationMs / 1000;
      phaseClock.textContent = dur > 0 ? `${Math.max(0, dur - el).toFixed(1)} S LEFT` : `${el.toFixed(1)} S`;

      const canStart = p === 'IDLE' && net.connected;
      shutterBtn.disabled = !canStart || Date.now() - lastShutter < 1500;
      shutterHint.textContent = canStart ? 'Standby · tap or press SPACE' : net.connected ? `Running · ${p}` : 'Offline';
      skipBtn.disabled = p === 'IDLE' || !net.connected;
      testDevBtn.disabled = p !== 'DEVELOP' || !net.connected;
      calModeBtn.textContent = p === 'CALIBRATING' ? 'EXIT CALIBRATION' : 'ENTER CALIBRATION';
      calModeBtn.classList.toggle('primary-act', p === 'CALIBRATING');
    }
    requestAnimationFrame(tick);
  }

  drawCalCanvas();
  net.connect();
  renderArchive(null);
  void loadDiskTotal();
  requestAnimationFrame(tick);
}

function stepperHtml(key: string, label: string, rangeTxt: string, defVal: number): string {
  return `<div class="step-row">
    <div class="step-meta"><span>${label}</span><small>${rangeTxt}</small></div>
    <div class="step-ctl">
      <button type="button" data-step-key="${key}" data-step-delta="-1" aria-label="Decrease ${label}">−</button>
      <span class="mono" data-step-val="${key}">${defVal}</span>
      <button type="button" data-step-key="${key}" data-step-delta="1" aria-label="Increase ${label}">+</button>
    </div>
  </div>`;
}
