/**
 * /door — tablet 1: entrance darkroom display (OBSERVED PAST vs PREDICTED FUTURE)
 * - Pure #080706 background.
 * - Left (~62%): OBSERVED PAST — adaptive grid of up to 9 latest frames (00A, 01A...), strict `object-fit: contain`,
 *   each labeled with frameNo & outcome short code (FIXED / BURNED / UNDER / LEAK).
 * - Right (~38%): PREDICTED FUTURE · [NEXT FR] — enlarged red-bordered forecast frame with SVG crayon collapseZone
 *   overlay (or clean empty frame `AWAITING SEED 00A`).
 * - Bottom independent bar: `Projected from past traces. Step into the light to alter this frame.`
 * - ENTER_BUFFER: `SHUTTER RELEASED · LIFT CURTAIN & ENTER`.
 */
import { Net, mountNetDot } from '../lib/net';
import { escapeHtml, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { CollapseZone, ContactSheetInfo, ForecastInfo, Phase } from '../../../shared/protocol';

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function collapseSvg(cz?: CollapseZone | null): string {
  if (!cz) return '';
  const cx = (cz.cx * 320).toFixed(1);
  const cy = (cz.cy * 180).toFixed(1);
  const rx = (cz.rx * 320).toFixed(1);
  const ry = (cz.ry * 180).toFixed(1);
  return `<svg class="door-cz-svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#e13a2e" stroke-width="2.6" stroke-dasharray="10 3" opacity="0.92" />
    <ellipse cx="${Number(cx) + 1.5}" cy="${Number(cy) - 1.2}" rx="${Number(rx) - 1.5}" ry="${Number(ry) + 1.2}" fill="none" stroke="#ff6c60" stroke-width="1.2" opacity="0.55" />
  </svg>`;
}

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Contact sheet · ${TITLE_EN}`;

  app.innerHTML = `
    <div class="door-sheet" id="sheetWrap">
      <main class="door-split">
        <section class="door-past">
          <div class="zone-head"><span>OBSERVED PAST</span><span class="mono" id="rollTag">ROLL 01</span></div>
          <div class="past-grid cols-3" id="pastGrid"></div>
        </section>
        <section class="door-future">
          <div class="zone-head future"><span id="futureHead">PREDICTED FUTURE · 00A</span></div>
          <div class="future-box" id="futureBox"></div>
        </section>
      </main>
      <footer class="cs-foot">
        <span>Projected from past traces. Step into the light to alter this frame.</span>
      </footer>
    </div>
    <div class="door-enter" id="enterModal">
      <div class="door-enter-txt">SHUTTER RELEASED · LIFT CURTAIN &amp; ENTER</div>
    </div>`;

  const sheetWrap = app.querySelector('#sheetWrap') as HTMLDivElement;
  const rollTag = app.querySelector('#rollTag') as HTMLSpanElement;
  const pastGrid = app.querySelector('#pastGrid') as HTMLDivElement;
  const futureHead = app.querySelector('#futureHead') as HTMLSpanElement;
  const futureBox = app.querySelector('#futureBox') as HTMLDivElement;
  const enterModal = app.querySelector('#enterModal') as HTMLDivElement;

  const net = new Net('door');
  (window as any).__net = net;

  let sheetKey = '';

  function renderSheet(sheet?: ContactSheetInfo | null, stateForecast?: ForecastInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? net.round?.rollNumber ?? 1;
    const allFrames = sheet?.frames ?? [];
    const forecast = sheet?.forecast ?? stateForecast ?? net.state?.forecast ?? null;
    const totalExposed = sheet?.totalInRoll ?? allFrames.length;
    const cz = forecast?.collapseZone ?? null;
    const fcKey = forecast
      ? `${forecast.has}:${forecast.version}:${forecast.targetFrameNo}:${forecast.url ?? ''}:${cz ? `${cz.cx},${cz.cy}` : ''}`
      : 'none';
    const key = JSON.stringify([rollNo, totalExposed, allFrames.map((f) => [f.url, f.outcomeCode]), fcKey]);
    rollTag.textContent = `ROLL ${pad2(rollNo)}`;

    if (key === sheetKey) return;
    sheetKey = key;

    const visible = allFrames.slice(-9);
    const totalSlots = visible.length <= 4 ? 4 : visible.length <= 6 ? 6 : 9;
    pastGrid.className = `past-grid ${totalSlots === 4 ? 'cols-2' : 'cols-3'}`;

    const cells: string[] = [];
    visible.forEach((f) => {
      const code = f.index === 0 ? 'BASELINE' : f.outcomeCode || 'FIXED';
      cells.push(`
        <div class="cs-cell filled">
          <div class="cs-imgbox">
            <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.frameNo)}" loading="eager" />
          </div>
          <div class="cs-label">${escapeHtml(f.frameNo)} · ${escapeHtml(code)}</div>
        </div>`);
    });

    const startIdx = visible.length === 0 ? 0 : (visible[visible.length - 1]?.index ?? visible.length - 1) + 1;
    for (let k = visible.length; k < totalSlots; k++) {
      const nextNo = startIdx + (k - visible.length);
      cells.push(`
        <div class="cs-cell empty">
          <div class="cs-imgbox"></div>
          <div class="cs-label">${pad2(nextNo)}A</div>
        </div>`);
    }
    pastGrid.innerHTML = cells.join('');

    const targetNo = forecast?.targetFrameNo || (allFrames.length === 0 ? '00A' : `${pad2(allFrames.filter((f) => f.index >= 1).length + 1)}A`);
    if (forecast?.has && forecast.url) {
      futureHead.textContent = `PREDICTED FUTURE · ${targetNo}`;
      futureBox.className = 'future-box active';
      futureBox.innerHTML = `
        <div class="future-frame">
          <img src="${escapeHtml(forecast.url)}" alt="Predicted ${escapeHtml(targetNo)}" loading="eager" />
          ${collapseSvg(cz)}
        </div>`;
    } else {
      futureHead.textContent = `PREDICTED FUTURE · ${targetNo}`;
      futureBox.className = 'future-box empty';
      futureBox.innerHTML = `<div class="future-empty">${allFrames.length === 0 ? 'AWAITING SEED 00A' : `FORECASTING ${escapeHtml(targetNo)}`}</div>`;
    }
  }

  async function refreshStateHttp(): Promise<void> {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j.state) {
        const st = j.state;
        const sheet: ContactSheetInfo = {
          rollNumber: st.rollNumber,
          totalInRoll: st.frames?.length ?? 0,
          frames: st.frames ?? [],
          forecast: st.forecastUrl
            ? {
                has: true,
                version: st.baseCapturedAt || Date.now(),
                targetFrameNo: `${pad2((st.frames?.filter((f: any) => f.index >= 1).length ?? 0) + 1)}A`,
                url: st.forecastUrl,
                collapseZone: st.collapseZone ?? null,
              }
            : undefined,
        };
        net.contactSheet = sheet;
        renderSheet(sheet);
      }
    } catch {
      /* ignore */
    }
  }

  function renderPhase(phase: Phase): void {
    const isEnter = phase === 'ENTER_BUFFER';
    const isDim =
      phase === 'CAPTURING_BASE' ||
      phase === 'SAFELIGHT_COMPOSE' ||
      phase === 'EXPOSURE' ||
      phase === 'DEVELOPING' ||
      phase === 'LIGHT_LEAK';
    enterModal.classList.toggle('show', isEnter);
    sheetWrap.classList.toggle('dim-deep', isEnter);
    sheetWrap.classList.toggle('dim', isDim);
    renderSheet(net.contactSheet, net.state?.forecast ?? null);
  }

  net.on('state', (m) => renderPhase(m.state));
  net.on('contact-sheet', (m) => renderSheet(m.sheet));
  net.on('STATE_SYNC', () => void refreshStateHttp());
  net.on('config', () => renderSheet(net.contactSheet));
  net.on('open', () => {
    renderSheet(net.contactSheet, net.state?.forecast ?? null);
    void refreshStateHttp();
  });

  mountNetDot(net);
  renderSheet(null);

  await showStartOverlay({
    code: 'T-01',
    kicker: '/door',
    title: 'OBSERVED PAST · FORECAST',
    subtitle: 'Tap to lock fullscreen',
    button: 'TAP TO START',
  });
  net.connect();
  renderPhase(net.phase);
}
