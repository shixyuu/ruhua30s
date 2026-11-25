/**
 * /station2 — tablet 3: north-west emergency breaker
 *  Window C 21s–30s: red strobe + danger alarm + a vertical high-resistance knife switch
 *  Spoiler guard: pulled at t < 28.5s → locks with "FORCING POWER CUT..." and shakes; the server flashes at 29.5s.
 *                 pulled at t >= 28.5s → the server flashes immediately.
 */
import { Net, mountNetDot } from '../lib/net';
import { alarm, stopAllLoops } from '../lib/sfx';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { TIMELINE } from '../../../shared/protocol';

const TEXT_C = 'NO TIME LEFT! RUN OVER AND PULL THE MAIN BREAKER DOWN — CUT THE TIMELINE!';
const RESISTANCE = 0.42; // 1px of finger travel moves the blade only 0.42px
const PULL_THRESHOLD = 0.94;

export default async function station2(app: HTMLElement): Promise<void> {
  document.title = `Emergency breaker · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="station black" id="root">
      <div class="st-band"><span class="id"><span>T-03</span></span><span class="zone">NW emergency breaker · Main breaker</span><span class="clock" id="clock">--.-</span></div>
      <div class="st-body">
        <div>
          <p class="st-msg" id="msg"></p>
          <div class="st-lock hidden" id="lock">FORCING POWER CUT...</div>
        </div>
        <div class="st-aside">
          <div class="breaker" id="breaker">
            <div class="scale"></div>
            <div class="lbl on">ON</div>
            <div class="track"></div>
            <div class="handle" id="handle">MAIN</div>
            <div class="lbl offl">OFF</div>
          </div>
          <div class="st-sub" id="sub"></div>
        </div>
      </div>
      <div class="st-foot"><span>RH-30 / BRK 03 · PULL ALL THE WAY DOWN</span><span class="chem"><span><b>DEV</b> 05–13</span><span><b>STOP</b> 13–21</span><span class="on"><b>FIX</b> 21–30</span></span></div>
    </div>`;
  const root = app.querySelector('#root') as HTMLDivElement;
  const lockEl = app.querySelector('#lock') as HTMLDivElement;
  const clock = app.querySelector('#clock') as HTMLSpanElement;
  const msgEl = app.querySelector('#msg') as HTMLDivElement;
  const subEl = app.querySelector('#sub') as HTMLDivElement;
  const breaker = app.querySelector('#breaker') as HTMLDivElement;
  const handle = app.querySelector('#handle') as HTMLDivElement;

  const net = new Net('station2');
  (window as any).__net = net; // debugging / automated tests
  mountNetDot(net);

  // ---------------- breaker interaction ----------------
  let pos = 0; // 0 = top (ON), 1 = bottom (OFF)
  let dragging = false;
  let startY = 0;
  let startPos = 0;
  let pulled = false;
  let locked = false;

  const range = () => breaker.clientHeight - handle.offsetHeight - 28;
  const place = () => {
    handle.style.top = `${14 + pos * Math.max(0, range())}px`;
  };

  function resetBreaker(): void {
    pos = 0;
    pulled = false;
    locked = false;
    dragging = false;
    breaker.classList.remove('shake');
    lockEl.classList.add('hidden');
    handle.textContent = 'MAIN';
    place();
  }

  handle.addEventListener('pointerdown', (e) => {
    if (pulled || seg !== 'C') return;
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
    const r = Math.max(1, range());
    // high resistance: the blade moves only 42% of the finger travel, so it must be pulled all the way
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
      pos = 0; // not pulled far enough: spring back
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
    handle.textContent = 'OFF';
    navigator.vibrate?.(80);
    net.send({ type: 'breaker' });
    const t = net.storySec();
    if (t < TIMELINE.breakerSpoilerGuard) lockShake();
    else subEl.textContent = 'Power cut';
  }

  function lockShake(): void {
    if (locked) return;
    locked = true;
    breaker.classList.add('shake');
    lockEl.classList.remove('hidden');
    subEl.textContent = '';
    navigator.vibrate?.([200, 60, 200, 60, 200, 60, 400]);
  }

  net.on('breaker', (m) => {
    if (m.status === 'locked') {
      pulled = true;
      pos = 1;
      place();
      lockShake();
    }
  });

  // ---------------- phase rendering ----------------
  type Seg = 'black' | 'C';
  let seg: Seg = 'black';
  let roundId = -1;
  function setSeg(next: Seg): void {
    if (next === seg) return;
    seg = next;
    root.className = 'station black';
    subEl.textContent = '';
    alarm.stop();
    if (next === 'C') {
      if (net.round?.id !== roundId) {
        roundId = net.round?.id ?? -1;
        resetBreaker();
      }
      root.className = 'station st-danger';
      msgEl.textContent = TEXT_C;
      requestAnimationFrame(place);
      if (net.round?.breakerLocked) lockShake();
      alarm.start('danger', 0.8);
    } else {
      stopAllLoops();
      breaker.classList.remove('shake');
    }
  }

  function tick(): void {
    let next: Seg = 'black';
    if (net.connected && net.phase === 'ACTIVE_30S') {
      const t = net.storySec();
      if (t >= TIMELINE.station2C[0] && t < TIMELINE.station2C[1] + 0.5) next = 'C';
    }
    setSeg(next);
    if (next === 'C') clock.textContent = Math.max(0, 30 - net.storySec()).toFixed(1).padStart(4, '0');
    requestAnimationFrame(tick);
  }
  window.addEventListener('resize', place);

  await showStartOverlay({
    code: 'T-03',
    kicker: '/station2',
    title: 'North-west emergency breaker',
    subtitle: 'Tap to go fullscreen and keep the screen awake.',
    button: 'Tap to start',
  });
  net.connect();
  requestAnimationFrame(tick);
}
