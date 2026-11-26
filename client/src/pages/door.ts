/**
 * /door — tablet 1: entrance darkroom display
 * - Prominent pure-JS QR code pointing to `${location.origin}/upload` + `SCAN TO LOAD A MEMORY FOR THE NEXT EXPOSURE`
 * - Queue status indicator: `NEXT PHOTO: READY (UPLOADED)` or `WAITING FOR UPLOAD` (or `BUILT-IN SAMPLE READY`)
 * - Contact sheet grid of recent finished prints
 */
import { Net, mountNetDot } from '../lib/net';
import { generateQrSvg } from '../lib/qr';
import { escapeHtml, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { ContactSheetInfo, PersistedState, Phase } from '../../../shared/protocol';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Entrance & Upload QR · ${TITLE_EN}`;

  const uploadUrl = `${location.origin}/upload`;
  const qrSvg = generateQrSvg(uploadUrl, '#E8E2D5', '#080706');

  app.innerHTML = `
    <div class="door-sheet" id="sheetWrap">
      <main class="door-split door-qr-split">
        <section class="door-qr-panel">
          <div class="zone-head future"><span>NEXT EXPOSURE QUEUE</span><span class="mono" id="queuePill">WAITING FOR UPLOAD</span></div>
          <div class="qr-stage">
            <div class="qr-frame">${qrSvg}</div>
            <div class="qr-prompt">SCAN TO LOAD A MEMORY FOR THE NEXT EXPOSURE</div>
            <div class="qr-url mono">${escapeHtml(uploadUrl)}</div>
          </div>
        </section>
        <section class="door-past">
          <div class="zone-head"><span>CONTACT SHEET · ARCHIVED PRINTS</span><span class="mono" id="rollTag">ROLL 01</span></div>
          <div class="past-grid cols-3" id="pastGrid"></div>
        </section>
      </main>
      <footer class="cs-foot">
        <span>Your uploaded photograph is used only for this live exposure and permanently deleted afterward.</span>
      </footer>
    </div>`;

  const sheetWrap = app.querySelector('#sheetWrap') as HTMLDivElement;
  const queuePill = app.querySelector('#queuePill') as HTMLSpanElement;
  const rollTag = app.querySelector('#rollTag') as HTMLSpanElement;
  const pastGrid = app.querySelector('#pastGrid') as HTMLDivElement;

  const net = new Net('door');
  (window as any).__net = net;

  let sheetKey = '';

  function updateQueueStatus(st?: PersistedState | null): void {
    const sampleIdx = net.config?.sampleFallback ?? 0;
    if (st?.hasQueuedPhoto) {
      queuePill.textContent = 'NEXT PHOTO: READY (UPLOADED)';
      queuePill.className = 'mono q-ready';
    } else if (sampleIdx > 0) {
      queuePill.textContent = `NEXT PHOTO: BUILT-IN SAMPLE #${sampleIdx}`;
      queuePill.className = 'mono q-ready';
    } else {
      queuePill.textContent = 'WAITING FOR UPLOAD';
      queuePill.className = 'mono q-wait';
    }
  }

  function renderSheet(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? net.round?.rollNumber ?? 1;
    const allFrames = sheet?.frames ?? [];
    const totalExposed = sheet?.totalInRoll ?? allFrames.length;
    const key = JSON.stringify([rollNo, totalExposed, allFrames.map((f) => [f.url, f.outcomeCode])]);
    rollTag.textContent = `ROLL ${pad2(rollNo)}`;
    updateQueueStatus(net.persisted);

    if (key === sheetKey) return;
    sheetKey = key;

    const visible = allFrames.slice(-9);
    const totalSlots = visible.length <= 4 ? 4 : visible.length <= 6 ? 6 : 9;
    pastGrid.className = `past-grid ${totalSlots === 4 ? 'cols-2' : 'cols-3'}`;

    const cells: string[] = [];
    visible.forEach((f) => {
      const code = f.outcomeCode || 'FIXED';
      cells.push(`
        <div class="cs-cell filled">
          <div class="cs-imgbox">
            <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.frameNo)}" loading="eager" />
          </div>
          <div class="cs-label">${escapeHtml(f.frameNo)} · ${escapeHtml(code)}</div>
        </div>`);
    });

    const startIdx = visible.length === 0 ? 1 : (visible[visible.length - 1]?.index ?? visible.length) + 1;
    for (let k = visible.length; k < totalSlots; k++) {
      const nextNo = startIdx + (k - visible.length);
      cells.push(`
        <div class="cs-cell empty">
          <div class="cs-imgbox"></div>
          <div class="cs-label">${pad2(nextNo)}A</div>
        </div>`);
    }
    pastGrid.innerHTML = cells.join('');
  }

  async function refreshStateHttp(): Promise<void> {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j.state) {
        net.persisted = j.state;
        const sheet: ContactSheetInfo = {
          rollNumber: j.state.rollNumber,
          totalInRoll: j.state.frames?.length ?? 0,
          frames: j.state.frames ?? [],
        };
        net.contactSheet = sheet;
        renderSheet(sheet);
      }
    } catch {
      /* ignore */
    }
  }

  function renderPhase(phase: Phase): void {
    const isDim = phase === 'OBSERVE' || phase === 'EXPOSE' || phase === 'DEVELOP' || phase === 'LIGHT_LEAK';
    sheetWrap.classList.toggle('dim', isDim);
    renderSheet(net.contactSheet);
  }

  net.on('state', (m) => renderPhase(m.state));
  net.on('contact-sheet', (m) => renderSheet(m.sheet));
  net.on('STATE_SYNC', (m) => {
    updateQueueStatus(m.persisted);
    void refreshStateHttp();
  });
  net.on('config', () => renderSheet(net.contactSheet));
  net.on('open', () => {
    renderSheet(net.contactSheet);
    void refreshStateHttp();
  });

  mountNetDot(net);
  renderSheet(null);

  await showStartOverlay({
    code: 'T-01',
    kicker: '/door',
    title: 'ENTRANCE & UPLOAD QR',
    subtitle: 'Tap to lock fullscreen',
    button: 'TAP TO START',
  });
  net.connect();
  renderPhase(net.phase);
}
