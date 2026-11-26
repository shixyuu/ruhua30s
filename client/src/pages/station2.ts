/**
 * /station2 — tablet 3: north-west vertical fixation fader
 * - Pure black (#000000) outside DEVELOPING.
 * - Zero-resistance 1:1 pointer tracking across the entire fader well with setPointerCapture.
 * - Triggers TRIGGER_FIX cleanly at >= 80% (or fast downward flick >= 55%).
 * - 3-state "when to pull" visual cue synced to server devProgress & remaining seconds.
 */
import { Net, mountNetDot } from '../lib/net';
import { stationWakeChime } from '../lib/sfx';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';

const PULL_THRESHOLD = 0.8;
const FLICK_THRESHOLD = 0.55;
const FLICK_VELOCITY = 0.9; // px/ms

export default async function station2(app: HTMLElement): Promise<void> {
  document.title = `Fixation Fader · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="inst-screen black" id="root">
      <div class="fader-stage">
        <div class="fader-unit-v3" id="faderBox">
          <div class="fader-top-cue" id="topCue">
            <div class="fader-cue-main" id="cueMain">DEVELOPING AT LEFT...</div>
            <div class="fader-cue-arrow" id="cueArrow">↓</div>
          </div>
          <div class="fader-well" id="faderWell">
            <div class="fader-rails" aria-hidden="true"></div>
            <div class="fader-slot">
              <div class="fader-fill" id="faderFill"></div>
            </div>
            <div class="fader-handle" id="handle">
              <span class="bar"></span>
              <span class="txt" id="handleTxt">SLIDE</span>
              <span class="bar"></span>
            </div>
          </div>
          <div class="fader-end bot" id="botLbl">PULL DOWN TO FIX</div>
          <div class="fader-sub" id="botSub">Lock exposure before time runs out or burns black</div>
        </div>
      </div>
    </div>`;

  const root = app.querySelector('#root') as HTMLDivElement;
  const faderBox = app.querySelector('#faderBox') as HTMLDivElement;
  const faderWell = app.querySelector('#faderWell') as HTMLDivElement;
  const faderFill = app.querySelector('#faderFill') as HTMLDivElement;
  const handle = app.querySelector('#handle') as HTMLDivElement;
  const handleTxt = app.querySelector('#handleTxt') as HTMLSpanElement;
  const cueMain = app.querySelector('#cueMain') as HTMLDivElement;
  const botLbl = app.querySelector('#botLbl') as HTMLDivElement;
  const botSub = app.querySelector('#botSub') as HTMLDivElement;

  const net = new Net('station2');
  (window as any).__net = net;
  mountNetDot(net);

  let pos = 0; // 0 = top, 1 = bottom (FIXED)
  let dragging = false;
  let activePointerId: number | null = null;
  let startY = 0;
  let startPos = 0;
  let prevY = 0;
  let prevT = 0;
  let velocityY = 0; // px/ms
  let fixed = false;
  let roundId = -1;
  let latestDev = 0;

  const travelRange = () => Math.max(1, faderWell.clientHeight - handle.offsetHeight - 24);

  function place(): void {
    const r = travelRange();
    handle.style.top = `${12 + pos * r}px`;
    faderFill.style.height = `${Math.round(pos * 100)}%`;
  }

  function updateCue(): void {
    if (fixed || net.phase !== 'DEVELOPING') return;
    const remainSec = net.remainingMs() / 1000 / net.timeScale;
    const urgent = latestDev >= 0.72 || (remainSec > 0 && remainSec <= 6);
    const emerging = !urgent && latestDev >= 0.35;

    faderBox.classList.toggle('cue-urgent', urgent);
    faderBox.classList.toggle('cue-emerging', emerging);
    faderBox.classList.toggle('cue-idle', !urgent && !emerging);

    if (urgent) {
      cueMain.textContent = 'PULL DOWN NOW TO FIX ↓';
      botLbl.textContent = latestDev > 1.0 ? 'BURNING — PULL NOW' : 'OPTIMAL — PULL NOW';
    } else if (emerging) {
      cueMain.textContent = 'IMAGE EMERGING · PULL ANYTIME TO FIX';
      botLbl.textContent = 'PULL DOWN TO FIX';
    } else {
      cueMain.textContent = 'DEVELOPING AT LEFT...';
      botLbl.textContent = 'PULL DOWN TO FIX';
    }
  }

  function resetFader(): void {
    pos = 0;
    fixed = false;
    dragging = false;
    activePointerId = null;
    velocityY = 0;
    latestDev = 0;
    handle.classList.remove('snap');
    faderBox.classList.remove('locked', 'cue-urgent', 'cue-emerging');
    faderBox.classList.add('cue-idle');
    handleTxt.textContent = 'SLIDE';
    cueMain.textContent = 'DEVELOPING AT LEFT...';
    botLbl.textContent = 'PULL DOWN TO FIX';
    botSub.textContent = 'Lock exposure before time runs out or burns black';
    place();
  }

  // Full-well hotzone with 1:1 pointer tracking and setPointerCapture
  faderWell.addEventListener('pointerdown', (e) => {
    if (fixed || net.phase !== 'DEVELOPING') return;
    e.preventDefault();
    dragging = true;
    activePointerId = e.pointerId;
    startY = e.clientY;
    startPos = pos;
    prevY = e.clientY;
    prevT = performance.now();
    velocityY = 0;
    handle.classList.remove('snap');
    try {
      faderWell.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  faderWell.addEventListener('pointermove', (e) => {
    if (!dragging || fixed || e.pointerId !== activePointerId) return;
    e.preventDefault();
    const now = performance.now();
    const dt = Math.max(1, now - prevT);
    velocityY = (e.clientY - prevY) / dt;
    prevY = e.clientY;
    prevT = now;

    // 1:1 direct pixel mapping (zero artificial resistance)
    const r = travelRange();
    pos = Math.max(0, Math.min(1, startPos + (e.clientY - startY) / r));
    place();
    if (pos >= PULL_THRESHOLD) triggerFix();
  });

  const release = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    if (!fixed && pos >= FLICK_THRESHOLD && velocityY >= FLICK_VELOCITY) {
      triggerFix();
      return;
    }
    if (!fixed) {
      handle.classList.add('snap');
      pos = 0;
      place();
    }
  };
  faderWell.addEventListener('pointerup', release);
  faderWell.addEventListener('pointercancel', release);
  faderBox.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  function triggerFix(): void {
    if (fixed) return;
    fixed = true;
    dragging = false;
    pos = 1;
    handle.classList.add('snap');
    place();
    faderBox.classList.remove('cue-urgent', 'cue-emerging', 'cue-idle');
    faderBox.classList.add('locked');
    handleTxt.textContent = 'FIXED';
    cueMain.textContent = 'EXPOSURE FIXED';
    botLbl.textContent = 'FIXED';
    navigator.vibrate?.(60);
    net.send({ type: 'TRIGGER_FIX' });
  }

  let wasActive = false;

  function renderPhase(): void {
    const active = net.connected && net.phase === 'DEVELOPING';
    root.classList.toggle('black', !active);
    if (active && !wasActive) stationWakeChime();
    wasActive = active;
    if (active) {
      if (net.round && net.round.id !== roundId) {
        roundId = net.round.id;
        resetFader();
      }
      updateCue();
      requestAnimationFrame(place);
    }
  }

  net.on('dev', (m) => {
    latestDev = m.devProgress;
    updateCue();
  });
  net.on('state', renderPhase);
  net.on('open', renderPhase);
  window.addEventListener('resize', place);

  // Keep remaining-time urgent cue fresh during DEVELOPING
  window.setInterval(() => {
    if (net.connected && net.phase === 'DEVELOPING') updateCue();
  }, 400);

  await showStartOverlay({
    code: 'T-03',
    kicker: '/station2',
    title: 'FIXATION FADER',
    subtitle: 'Tap to lock fullscreen',
    button: 'TAP TO START',
  });
  net.connect();
  renderPhase();
}
