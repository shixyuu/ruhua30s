/**
 * /station2 — tablet 3: north-west vertical fixation fader
 * - Pure black (#000000) outside DEVELOPING.
 * - During DEVELOPING: full-height heavy industrial vertical damped fader (DEVELOPING -> PULL TO FIX).
 * - Reaching >= 92% sends `{ type: 'TRIGGER_FIX' }` immediately and locks with `FIXED`.
 */
import { Net, mountNetDot } from '../lib/net';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';

const RESISTANCE = 0.55;
const PULL_THRESHOLD = 0.92;

export default async function station2(app: HTMLElement): Promise<void> {
  document.title = `Fixation Fader · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="inst-screen black" id="root">
      <div class="fader-stage">
        <div class="fader-unit-v3" id="faderBox">
          <div class="fader-end top">DEVELOPING</div>
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
          <div class="fader-end bot" id="botLbl">PULL TO FIX</div>
        </div>
      </div>
    </div>`;

  const root = app.querySelector('#root') as HTMLDivElement;
  const faderBox = app.querySelector('#faderBox') as HTMLDivElement;
  const faderWell = app.querySelector('#faderWell') as HTMLDivElement;
  const faderFill = app.querySelector('#faderFill') as HTMLDivElement;
  const handle = app.querySelector('#handle') as HTMLDivElement;
  const handleTxt = app.querySelector('#handleTxt') as HTMLSpanElement;
  const botLbl = app.querySelector('#botLbl') as HTMLDivElement;

  const net = new Net('station2');
  (window as any).__net = net;
  mountNetDot(net);

  let pos = 0; // 0 = top (DEVELOPING), 1 = bottom (PULL TO FIX)
  let dragging = false;
  let startY = 0;
  let startPos = 0;
  let fixed = false;
  let roundId = -1;

  const travelRange = () => Math.max(0, faderWell.clientHeight - handle.offsetHeight - 24);

  function place(): void {
    const r = travelRange();
    handle.style.top = `${12 + pos * r}px`;
    faderFill.style.height = `${Math.round(pos * 100)}%`;
  }

  function resetFader(): void {
    pos = 0;
    fixed = false;
    dragging = false;
    faderBox.classList.remove('locked');
    handleTxt.textContent = 'SLIDE';
    botLbl.textContent = 'PULL TO FIX';
    place();
  }

  handle.addEventListener('pointerdown', (e) => {
    if (fixed || net.phase !== 'DEVELOPING') return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startPos = pos;
    handle.classList.remove('snap');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || fixed) return;
    e.preventDefault();
    const r = Math.max(1, travelRange());
    const raw = ((e.clientY - startY) * RESISTANCE) / r;
    pos = Math.max(0, Math.min(1, startPos + raw));
    place();
    if (pos >= PULL_THRESHOLD) triggerFix();
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    if (!fixed) {
      handle.classList.add('snap');
      pos = 0;
      place();
    }
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  faderBox.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  function triggerFix(): void {
    if (fixed) return;
    fixed = true;
    dragging = false;
    pos = 1;
    place();
    faderBox.classList.add('locked');
    handleTxt.textContent = 'FIXED';
    botLbl.textContent = 'FIXED';
    navigator.vibrate?.(60);
    net.send({ type: 'TRIGGER_FIX' });
  }

  function renderPhase(): void {
    const active = net.connected && net.phase === 'DEVELOPING';
    root.classList.toggle('black', !active);
    if (active) {
      if (net.round && net.round.id !== roundId) {
        roundId = net.round.id;
        resetFader();
      }
      requestAnimationFrame(place);
    }
  }

  net.on('state', renderPhase);
  net.on('open', renderPhase);
  window.addEventListener('resize', place);

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
