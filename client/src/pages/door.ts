/**
 * /door — tablet 1: entrance 35mm contact sheet (pure display, zero front camera)
 * - Pure #080706 background, adaptive 3×2 (<=6) or 4×3 (7..12 latest frames) contact sheet grid.
 * - Each frame uses strict `object-fit: contain` (16:9 preserved) with only frame number (01A, 02A...) below.
 * - Latest frame is circled with a fine red china-marker stroke; remaining empty slots show dim hairline frames.
 * - ENTER_BUFFER shows centered minimalist safelight-red prompt: LIFT CURTAIN · ENTER TOGETHER.
 * - Fixed opaque dark bottom bar: ROLL XX · CONTACT SHEET.
 */
import { Net, mountNetDot } from '../lib/net';
import { escapeHtml, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { ContactSheetInfo, Phase } from '../../../shared/protocol';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function waxCircleSvg(): string {
  return `<svg class="wax-ring" viewBox="0 0 200 130" preserveAspectRatio="none" aria-hidden="true">
    <path d="M 18,64 C 16,24 58,9 103,10 C 152,11 187,27 186,65 C 185,103 147,120 98,119 C 48,118 15,100 22,58"
      fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
  </svg>`;
}

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Contact sheet · ${TITLE_EN}`;

  app.innerHTML = `
    <div class="door-sheet" id="sheetWrap">
      <main class="cs-stage">
        <div class="cs-grid cols-3" id="grid"></div>
      </main>
      <footer class="cs-foot">
        <span id="footText">ROLL 01 · CONTACT SHEET</span>
      </footer>
    </div>
    <div class="door-enter" id="enterModal">
      <div class="door-enter-txt">LIFT CURTAIN · ENTER TOGETHER</div>
    </div>`;

  const sheetWrap = app.querySelector('#sheetWrap') as HTMLDivElement;
  const grid = app.querySelector('#grid') as HTMLDivElement;
  const footText = app.querySelector('#footText') as HTMLSpanElement;
  const enterModal = app.querySelector('#enterModal') as HTMLDivElement;

  const net = new Net('door');
  (window as any).__net = net;

  let sheetKey = '';

  function renderSheet(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? net.round?.rollNumber ?? 1;
    const allFrames = sheet?.frames ?? [];
    const totalExposed = sheet?.totalInRoll ?? allFrames.length;
    const key = JSON.stringify([rollNo, totalExposed, allFrames.map((f) => f.url)]);
    footText.textContent = `ROLL ${pad2(rollNo)} · CONTACT SHEET`;

    if (key === sheetKey) return;
    sheetKey = key;

    const visible = allFrames.slice(-12);
    const totalSlots = visible.length <= 6 ? 6 : 12;
    grid.className = `cs-grid ${totalSlots === 6 ? 'cols-3' : 'cols-4'}`;

    const cells: string[] = [];
    visible.forEach((f, idx) => {
      const isLatest = idx === visible.length - 1;
      cells.push(`
        <div class="cs-cell filled${isLatest ? ' latest' : ''}">
          <div class="cs-imgbox">
            <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.frameNo)}" loading="eager" />
            ${isLatest ? waxCircleSvg() : ''}
          </div>
          <div class="cs-label">${escapeHtml(f.frameNo)}</div>
        </div>`);
    });

    const lastIndex = visible[visible.length - 1]?.index ?? visible.length;
    for (let k = visible.length; k < totalSlots; k++) {
      const nextNo = lastIndex + (k - visible.length + 1);
      cells.push(`
        <div class="cs-cell empty">
          <div class="cs-imgbox"></div>
          <div class="cs-label">${pad2(nextNo)}A</div>
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
    const isEnter = phase === 'ENTER_BUFFER';
    const isDim = phase === 'SAFELIGHT_COMPOSE' || phase === 'EXPOSURE' || phase === 'DEVELOPING';
    enterModal.classList.toggle('show', isEnter);
    sheetWrap.classList.toggle('dim-deep', isEnter);
    sheetWrap.classList.toggle('dim', isDim);
    renderSheet(net.contactSheet);
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
    title: 'CONTACT SHEET',
    subtitle: 'Tap to lock fullscreen',
    button: 'TAP TO START',
  });
  net.connect();
  renderPhase(net.phase);
}
