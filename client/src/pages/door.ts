/**
 * /door — tablet 1: entrance 35mm archival contact sheet (display only)
 * - Renders a live-growing 35mm contact sheet of the current roll (adaptive 3×2 or 4×3 grid, max 12 latest frames).
 * - Each frame uses strict `object-fit: contain` (16:9 preserved), labeled with frame number (01A, 02A...) and capture time.
 * - Latest frame is circled with a fine red china-marker stroke; remaining slots show dim dashed unexposed frames.
 * - When current roll has 0 visitor frames, slot 00A displays a clean baseline architectural reference plate.
 * - Fixed high-contrast dark bottom bar never overlaps the imagery.
 * - During CCTV_REVEAL it optionally streams 3–4 FPS front-camera mono frames to /main; failures are skipped silently.
 */
import { Net, mountNetDot } from '../lib/net';
import { cctvFrame, drawReferencePlate } from '../lib/media';
import { escapeHtml, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { ContactSheetInfo, Phase } from '../../../shared/protocol';

const CCTV_INTERVAL_MS = 280; // ~3.6 FPS

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function waxCircleSvg(): string {
  return `<svg class="wax-ring" viewBox="0 0 200 130" preserveAspectRatio="none" aria-hidden="true">
    <path d="M 18,64 C 16,24 58,9 103,10 C 152,11 187,27 186,65 C 185,103 147,120 98,119 C 48,118 15,100 22,58"
      fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
  </svg>`;
}

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Entrance contact sheet · ${TITLE_EN}`;

  // Generate clean 16:9 00A baseline reference plate once
  const refCanvas = document.createElement('canvas');
  drawReferencePlate(refCanvas, 1280, 720);
  const refDataUrl = refCanvas.toDataURL('image/jpeg', 0.85);

  app.innerHTML = `
    <div class="door-sheet" id="sheetWrap">
      <header class="cs-head">
        <div class="cs-title"><b>RH-30</b><span>35MM ARCHIVAL CONTACT SHEET · T-01</span></div>
        <div class="cs-meta"><span id="rollBadge">ROLL 01</span><span id="countBadge">00 EXPOSED</span></div>
      </header>
      <main class="cs-stage" id="stage">
        <div class="cs-grid cols-3" id="grid"></div>
      </main>
      <footer class="cs-foot" id="foot">
        <span class="cs-foot-k">CONTACT SHEET · 00:30 EXPOSURE WINDOW</span>
        <span class="cs-foot-sep">—</span>
        <span class="cs-foot-t">Previous attempts to correct the frame. Await the operator's flash.</span>
      </footer>
    </div>
    <div class="door-modal" id="enterModal">
      <div class="door-card">
        <small>ENTRANCE · T-01 · <span id="enterRoll">ROLL 01</span></small>
        <div class="door-card-main">SHUTTER RELEASED · LIFT THE CURTAIN AND ENTER TOGETHER</div>
      </div>
    </div>
    <div class="door-modal" id="standbyModal">
      <div class="door-standby-bar">
        <span class="badge">DARKROOM IN USE</span>
        <span class="txt">EXPOSURE IN PROGRESS · PLEASE WAIT</span>
      </div>
    </div>`;

  const sheetWrap = app.querySelector('#sheetWrap') as HTMLDivElement;
  const grid = app.querySelector('#grid') as HTMLDivElement;
  const rollBadge = app.querySelector('#rollBadge') as HTMLSpanElement;
  const countBadge = app.querySelector('#countBadge') as HTMLSpanElement;
  const enterRoll = app.querySelector('#enterRoll') as HTMLSpanElement;
  const enterModal = app.querySelector('#enterModal') as HTMLDivElement;
  const standbyModal = app.querySelector('#standbyModal') as HTMLDivElement;

  const net = new Net('door');
  (window as any).__net = net;

  let sheetKey = '';

  function renderSheet(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? net.round?.rollNumber ?? 1;
    const allFrames = sheet?.frames ?? [];
    const totalExposed = sheet?.totalInRoll ?? allFrames.length;
    const key = JSON.stringify([rollNo, totalExposed, allFrames.map((f) => f.url)]);
    rollBadge.textContent = `ROLL ${pad2(rollNo)}`;
    enterRoll.textContent = `ROLL ${pad2(rollNo)}`;
    countBadge.textContent = totalExposed === 0 ? '00 EXPOSED · TEMPLATE' : `${pad2(totalExposed)} EXPOSED`;

    if (key === sheetKey) return;
    sheetKey = key;

    if (allFrames.length === 0) {
      // Clean empty contact sheet template: 00A is baseline reference negative, 01A–05A are unexposed slots
      grid.className = 'cs-grid cols-3';
      const cells: string[] = [];
      cells.push(`
        <div class="cs-cell ref">
          <div class="cs-strip-top"><span class="fr">▸00A</span><span>BASELINE REF</span></div>
          <div class="cs-imgbox"><img src="${refDataUrl}" alt="00A Baseline reference plate" /></div>
          <div class="cs-strip-bot"><span>RH-30 SAFETY</span><span>CALIBRATION</span></div>
        </div>`);
      for (let i = 1; i <= 5; i++) {
        cells.push(`
          <div class="cs-cell empty">
            <div class="cs-strip-top"><span class="fr">${pad2(i)}A</span><span>UNEXPOSED</span></div>
            <div class="cs-imgbox"><div class="cs-slot-dash"><span>AWAITING EXPOSURE</span></div></div>
            <div class="cs-strip-bot"><span>RH-30</span><span>—:—:—</span></div>
          </div>`);
      }
      grid.innerHTML = cells.join('');
      return;
    }

    const visible = allFrames.slice(-12);
    const totalSlots = visible.length <= 6 ? 6 : 12;
    grid.className = `cs-grid ${totalSlots === 6 ? 'cols-3' : 'cols-4'}`;

    const cells: string[] = [];
    visible.forEach((f, idx) => {
      const isLatest = idx === visible.length - 1;
      cells.push(`
        <div class="cs-cell filled${isLatest ? ' latest' : ''}">
          <div class="cs-strip-top"><span class="fr">▸${escapeHtml(f.frameNo)}</span><span>${isLatest ? 'LATEST PROOF' : 'ARCHIVED'}</span></div>
          <div class="cs-imgbox">
            <img src="${escapeHtml(f.url)}" alt="Frame ${escapeHtml(f.frameNo)}" loading="eager" />
            ${isLatest ? waxCircleSvg() : ''}
          </div>
          <div class="cs-strip-bot"><span>ROLL ${pad2(rollNo)}</span><span>${fmtTime(f.timestamp)}</span></div>
        </div>`);
    });

    const lastIndex = visible[visible.length - 1]?.index ?? visible.length;
    for (let k = visible.length; k < totalSlots; k++) {
      const nextNo = lastIndex + (k - visible.length + 1);
      cells.push(`
        <div class="cs-cell empty">
          <div class="cs-strip-top"><span class="fr">${pad2(nextNo)}A</span><span>UNEXPOSED</span></div>
          <div class="cs-imgbox"><div class="cs-slot-dash"><span>AWAITING EXPOSURE</span></div></div>
          <div class="cs-strip-bot"><span>ROLL ${pad2(rollNo)}</span><span>—:—:—</span></div>
        </div>`);
    }
    grid.innerHTML = cells.join('');
  }

  async function refreshSheetHttp(): Promise<void> {
    try {
      const r = await fetch('/api/contact-sheet', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j.sheet) {
        net.contactSheet = j.sheet;
        renderSheet(j.sheet);
      }
    } catch {
      /* ignore */
    }
  }

  function renderPhase(phase: Phase): void {
    const dim = phase !== 'IDLE' && phase !== 'CCTV_REVEAL';
    sheetWrap.classList.toggle('dim', dim);
    enterModal.classList.toggle('show', phase === 'ENTER_BUFFER');
    standbyModal.classList.toggle('show', ['ACTIVE_30S', 'FLASH_FREEZE', 'REWIND', 'REPLAY_TRUTH'].includes(phase));
    renderSheet(net.contactSheet);
    if (phase === 'CCTV_REVEAL') startCctv();
    else stopCctv();
  }

  // ---------------- optional front-camera CCTV feed (CCTV_REVEAL only) ----------------
  let stream: MediaStream | null = null;
  let camVideo: HTMLVideoElement | null = null;
  let timer: number | null = null;
  let starting = false;
  const frameCanvas = document.createElement('canvas');

  async function startCctv(): Promise<void> {
    if (timer || starting) return;
    starting = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
        audio: false,
      });
      if (net.phase !== 'CCTV_REVEAL') return stopCctv();
      camVideo = document.createElement('video');
      camVideo.muted = true;
      camVideo.playsInline = true;
      camVideo.setAttribute('playsinline', '');
      camVideo.srcObject = stream;
      await camVideo.play();
      timer = window.setInterval(() => {
        try {
          if (!camVideo || camVideo.readyState < 2 || net.phase !== 'CCTV_REVEAL') return;
          if (net.buffered() > 256 * 1024) return;
          cctvFrame(camVideo, frameCanvas, 'MON-01 ENTRANCE');
          net.send({ type: 'cctv', data: frameCanvas.toDataURL('image/jpeg', 0.5) });
        } catch {
          /* silent */
        }
      }, CCTV_INTERVAL_MS);
    } catch {
      stopCctv();
    } finally {
      starting = false;
    }
  }

  function stopCctv(): void {
    if (timer) clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (camVideo) camVideo.srcObject = null;
    camVideo = null;
  }

  net.on('state', (m) => renderPhase(m.state));
  net.on('contact-sheet', (m) => renderSheet(m.sheet));
  net.on('config', () => renderSheet(net.contactSheet));
  net.on('open', () => {
    renderSheet(net.contactSheet);
    void refreshSheetHttp();
  });
  mountNetDot(net);
  renderSheet(null);

  await showStartOverlay({
    code: 'T-01',
    kicker: '/door',
    title: 'Entrance contact sheet',
    subtitle: 'Tap to go fullscreen and keep the screen awake.\nDisplay only. No microphone needed.',
    button: 'Tap to start',
  });
  net.connect();
  renderPhase(net.phase);
}
