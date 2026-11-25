/**
 * /station2 — tablet 3: north-west optical dodging & fixation terminal
 *  t = 08s ~ 21s: PROTOCOL 02 · OPTICAL DODGING (early wake-up guiding companions into the center projection beam)
 *  t = 21s ~ 30s: PROTOCOL 03 · FIXATION (minimalist damped Fixation Fader: DEVELOPING → FIXED)
 *  Early-pull guard: pulled at t < 28.5s → locks at FIXED with "FIXING EXPOSURE..." until 29.5s;
 *                    pulled at t >= 28.5s or reaching 30.0s → enters FLASH_FREEZE naturally.
 */
import { Net, mountNetDot } from '../lib/net';
import { cueBeep } from '../lib/sfx';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { TIMELINE } from '../../../shared/protocol';

const TITLE_P2 = 'PROTOCOL 02 · OPTICAL DODGING';
const COPY_P2 =
  'Highlight overexposure across the projection plane. Step into the light beam together and use your bodies to dodge the center of the frame.';

const TITLE_P3 = 'PROTOCOL 03 · FIXATION';
const COPY_P3 = 'Development window closing. Pull down steadily to arrest the exposure and fix the negative.';

const RESISTANCE = 0.45;
const PULL_THRESHOLD = 0.94;

type Seg = 'black' | 'P2' | 'P3';

export default async function station2(app: HTMLElement): Promise<void> {
  document.title = `North-west terminal · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="station black" id="root">
      <div class="st-band">
        <span class="id"><span>T-03</span></span>
        <span class="zone" id="zone">NW fixation terminal</span>
        <span class="clock" id="clock">--.-</span>
      </div>
      <div class="st-body" id="body">
        <div class="st-copy">
          <div class="st-kicker" id="kicker"></div>
          <p class="st-msg" id="msg"></p>
          <div class="st-lock hidden" id="lock">FIXING EXPOSURE...</div>
        </div>
        <div class="st-aside hidden" id="faderAside">
          <div class="fader-unit" id="breaker">
            <div class="fader-lbl top">DEVELOPING</div>
            <div class="fader-body">
              <div class="fader-scale" aria-hidden="true"></div>
              <div class="fader-slot">
                <div class="fader-fill" id="faderFill"></div>
              </div>
              <div class="fader-cap" id="handle">
                <span class="grip"></span>
                <span class="cap-txt" id="handleTxt">PULL DOWN</span>
                <span class="grip"></span>
              </div>
            </div>
            <div class="fader-lbl bot">FIXED</div>
          </div>
          <div class="st-sub" id="sub">DAMPED TRACK · SLIDE FULL TRAVEL</div>
        </div>
      </div>
      <div class="st-foot">
        <span>RH-30 / NW TERMINAL · <span id="foot">STANDBY</span></span>
        <span class="chem" id="chem">
          <span data-s="P2"><b>P02</b> 08–21</span>
          <span data-s="P3"><b>P03</b> 21–30</span>
        </span>
      </div>
    </div>`;

  const root = app.querySelector('#root') as HTMLDivElement;
  const body = app.querySelector('#body') as HTMLDivElement;
  const zone = app.querySelector('#zone') as HTMLSpanElement;
  const clock = app.querySelector('#clock') as HTMLSpanElement;
  const foot = app.querySelector('#foot') as HTMLSpanElement;
  const kicker = app.querySelector('#kicker') as HTMLDivElement;
  const msgEl = app.querySelector('#msg') as HTMLParagraphElement;
  const lockEl = app.querySelector('#lock') as HTMLDivElement;
  const faderAside = app.querySelector('#faderAside') as HTMLDivElement;
  const breaker = app.querySelector('#breaker') as HTMLDivElement;
  const faderBody = breaker.querySelector('.fader-body') as HTMLDivElement;
  const faderFill = app.querySelector('#faderFill') as HTMLDivElement;
  const handle = app.querySelector('#handle') as HTMLDivElement;
  const handleTxt = app.querySelector('#handleTxt') as HTMLSpanElement;
  const subEl = app.querySelector('#sub') as HTMLDivElement;
  const chem = Array.from(app.querySelectorAll<HTMLSpanElement>('#chem > span'));

  const net = new Net('station2');
  (window as any).__net = net;
  mountNetDot(net);

  // ---------------- damped fixation fader ----------------
  let pos = 0; // 0 = top (DEVELOPING), 1 = bottom (FIXED)
  let dragging = false;
  let startY = 0;
  let startPos = 0;
  let pulled = false;
  let locked = false;

  const travelRange = () => Math.max(0, faderBody.clientHeight - handle.offsetHeight - 20);

  function place(): void {
    const r = travelRange();
    const y = 10 + pos * r;
    handle.style.top = `${y}px`;
    faderFill.style.height = `${Math.round(pos * 100)}%`;
  }

  function resetFader(): void {
    pos = 0;
    pulled = false;
    locked = false;
    dragging = false;
    breaker.classList.remove('locked');
    lockEl.classList.add('hidden');
    handleTxt.textContent = 'PULL DOWN';
    subEl.textContent = 'DAMPED TRACK · SLIDE FULL TRAVEL';
    place();
  }

  handle.addEventListener('pointerdown', (e) => {
    if (pulled || seg !== 'P3') return;
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
    if (!dragging || pulled) return;
    e.preventDefault();
    const r = Math.max(1, travelRange());
    const raw = ((e.clientY - startY) * RESISTANCE) / r;
    pos = Math.max(0, Math.min(1, startPos + raw));
    place();
    if (pos >= PULL_THRESHOLD) doPull();
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    if (!pulled) {
      handle.classList.add('snap');
      pos = 0;
      place();
    }
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  breaker.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  function doPull(): void {
    if (pulled) return;
    pulled = true;
    dragging = false;
    pos = 1;
    place();
    handleTxt.textContent = 'FIXED';
    navigator.vibrate?.(40);
    net.send({ type: 'breaker' });
    const t = net.storySec();
    if (t < TIMELINE.breakerSpoilerGuard) engageLock();
    else subEl.textContent = 'FIXATION COMPLETE';
  }

  function engageLock(): void {
    if (locked) return;
    locked = true;
    breaker.classList.add('locked');
    lockEl.classList.remove('hidden');
    handleTxt.textContent = 'FIXED';
    subEl.textContent = 'BATH LOCKED · COMPLETING CYCLE';
  }

  net.on('breaker', (m) => {
    if (m.status === 'locked') {
      pulled = true;
      pos = 1;
      place();
      engageLock();
    }
  });

  // ---------------- phase rendering ----------------
  let seg: Seg = 'black';
  let roundId = -1;

  function setSeg(next: Seg): void {
    if (next === seg) return;
    seg = next;
    chem.forEach((c) => c.classList.toggle('on', c.dataset.s === next));

    if (next === 'P2') {
      cueBeep();
      root.className = 'station st-p2';
      body.classList.add('single');
      zone.textContent = 'NW terminal · Optical dodging';
      foot.textContent = 'PROTOCOL 02';
      kicker.textContent = TITLE_P2;
      msgEl.textContent = COPY_P2;
      lockEl.classList.add('hidden');
      faderAside.classList.add('hidden');
    } else if (next === 'P3') {
      cueBeep();
      if (net.round?.id !== roundId) {
        roundId = net.round?.id ?? -1;
        resetFader();
      }
      root.className = 'station st-p3';
      body.classList.remove('single');
      zone.textContent = 'NW terminal · Fixation fader';
      foot.textContent = 'PROTOCOL 03';
      kicker.textContent = TITLE_P3;
      msgEl.textContent = COPY_P3;
      faderAside.classList.remove('hidden');
      requestAnimationFrame(place);
      if (net.round?.breakerLocked) {
        pulled = true;
        pos = 1;
        place();
        engageLock();
      }
    } else {
      root.className = 'station black';
      body.classList.remove('single');
      faderAside.classList.add('hidden');
      lockEl.classList.add('hidden');
      kicker.textContent = '';
      msgEl.textContent = '';
    }
  }

  function tick(): void {
    let next: Seg = 'black';
    if (net.connected && net.phase === 'ACTIVE_30S') {
      const t = net.storySec();
      if (t >= TIMELINE.station2P2[0] && t < TIMELINE.station2P2[1]) next = 'P2';
      else if (t >= TIMELINE.station2P3[0] && t <= TIMELINE.station2P3[1] + 0.5) next = 'P3';
    }
    setSeg(next);
    if (next !== 'black') {
      const end = next === 'P2' ? TIMELINE.station2P2[1] : TIMELINE.station2P3[1];
      clock.textContent = Math.max(0, end - net.storySec()).toFixed(1).padStart(4, '0');
    }
    requestAnimationFrame(tick);
  }
  window.addEventListener('resize', place);

  await showStartOverlay({
    code: 'T-03',
    kicker: '/station2',
    title: 'North-west fixation terminal',
    subtitle: 'Tap to go fullscreen and keep the screen awake.',
    button: 'Tap to start',
  });
  net.connect();
  requestAnimationFrame(tick);
}
