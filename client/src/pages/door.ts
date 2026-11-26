/**
 * /door — tablet 1: entrance 35mm contact sheet + extrapolated FORECAST slot (pure display, zero front camera)
 * - Pure #080706 background, adaptive 3×2 (<=6) or 4×3 (7..12) contact sheet grid.
 * - Shows chronological history frames (00A, 01A, 02A...) with strict `object-fit: contain`.
 * - Immediately after history frames, a dark-red bordered FORECAST cell shows the server-pushed `currentForecast`
 *   labeled `FORECAST · [NEXT FR]`.
 * - ENTER_BUFFER shows centered minimalist safelight-red prompt: SHUTTER RELEASED · LIFT CURTAIN & ENTER.
 * - Fixed opaque dark bottom bar: ROLL XX · HISTORY & EXTRAPOLATED NEXT FRAME.
 */
import { Net, mountNetDot } from '../lib/net';
import { escapeHtml, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { ContactSheetInfo, ForecastInfo, Phase } from '../../../shared/protocol';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Contact sheet · ${TITLE_EN}`;

  app.innerHTML = `
    <div class="door-sheet" id="sheetWrap">
      <main class="cs-stage">
        <div class="cs-grid cols-3" id="grid"></div>
      </main>
      <footer class="cs-foot">
        <span id="footText">ROLL 01 · HISTORY &amp; EXTRAPOLATED NEXT FRAME</span>
      </footer>
    </div>
    <div class="door-enter" id="enterModal">
      <div class="door-enter-txt">SHUTTER RELEASED · LIFT CURTAIN &amp; ENTER</div>
    </div>`;

  const sheetWrap = app.querySelector('#sheetWrap') as HTMLDivElement;
  const grid = app.querySelector('#grid') as HTMLDivElement;
  const footText = app.querySelector('#footText') as HTMLSpanElement;
  const enterModal = app.querySelector('#enterModal') as HTMLDivElement;

  const net = new Net('door');
  (window as any).__net = net;

  let sheetKey = '';

  function renderSheet(sheet?: ContactSheetInfo | null, stateForecast?: ForecastInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? net.round?.rollNumber ?? 1;
    const allFrames = sheet?.frames ?? [];
    const forecast = sheet?.forecast ?? stateForecast ?? net.state?.forecast ?? null;
    const totalExposed = sheet?.totalInRoll ?? allFrames.length;
    const fcKey = forecast ? `${forecast.has}:${forecast.version}:${forecast.targetFrameNo}:${forecast.url ?? ''}` : 'none';
    const key = JSON.stringify([rollNo, totalExposed, allFrames.map((f) => f.url), fcKey]);
    footText.textContent = `ROLL ${pad2(rollNo)} · HISTORY & EXTRAPOLATED NEXT FRAME`;

    if (key === sheetKey) return;
    sheetKey = key;

    // Leave at least 1 slot for the trailing FORECAST cell (up to 11 history + 1 forecast = 12)
    const visible = allFrames.slice(-11);
    const totalSlots = visible.length + 1 <= 6 ? 6 : 12;
    grid.className = `cs-grid ${totalSlots === 6 ? 'cols-3' : 'cols-4'}`;

    const cells: string[] = [];
    visible.forEach((f) => {
      cells.push(`
        <div class="cs-cell filled">
          <div class="cs-imgbox">
            <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.frameNo)}" loading="eager" />
          </div>
          <div class="cs-label">${escapeHtml(f.frameNo)}</div>
        </div>`);
    });

    // Trailing FORECAST slot highlighted in fine dark-red border
    const targetNo = forecast?.targetFrameNo || `${pad2(visible.length)}A`;
    if (forecast?.has && forecast.url) {
      cells.push(`
        <div class="cs-cell forecast">
          <div class="cs-imgbox">
            <img src="${escapeHtml(forecast.url)}" alt="Forecast ${escapeHtml(targetNo)}" loading="eager" />
          </div>
          <div class="cs-label">FORECAST · ${escapeHtml(targetNo)}</div>
        </div>`);
    } else {
      cells.push(`
        <div class="cs-cell forecast empty">
          <div class="cs-imgbox"></div>
          <div class="cs-label">${visible.length === 0 ? 'SEED · 00A' : `FORECAST · ${escapeHtml(targetNo)}`}</div>
        </div>`);
    }

    const startIdx = visible.length === 0 ? 1 : (visible[visible.length - 1]?.index ?? visible.length - 1) + 2;
    for (let k = visible.length + 1; k < totalSlots; k++) {
      const nextNo = startIdx + (k - (visible.length + 1));
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
    renderSheet(net.contactSheet, net.state?.forecast ?? null);
  }

  net.on('state', (m) => renderPhase(m.state));
  net.on('contact-sheet', (m) => renderSheet(m.sheet));
  net.on('config', () => renderSheet(net.contactSheet));
  net.on('open', () => {
    renderSheet(net.contactSheet, net.state?.forecast ?? null);
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
