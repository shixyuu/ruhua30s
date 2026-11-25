/**
 * /admin — control desk (Chromebook / phone)
 * - Huge shutter button "PRESS SHUTTER · ENTER THE FRAME" at the top (IDLE only; Space triggers it)
 * - Emergency stop (confirm twice within 3 s), reset entrance photo, test main flash, ENTER_BUFFER 2–8 s
 * - Online lamps for the four devices, current phase + precise stopwatch, latest freeze, today's archive
 */
import { Net } from '../lib/net';
import type { Phase, Role } from '../../../shared/protocol';
import { ENTER_BUFFER_MAX, ENTER_BUFFER_MIN } from '../../../shared/protocol';
import { LOGO_CJK, TITLE_EN } from '../lib/brand';
import { cropMarks } from '../lib/unlock';

const PHASE_CN: Record<Phase, string> = {
  IDLE: 'Standby, waiting for the shutter',
  ENTER_BUFFER: 'Entry buffer, visitor steps in',
  ACTIVE_30S: 'In the frame, thirty seconds',
  FLASH_FREEZE: 'Flash and freeze',
  REWIND: 'Rewind',
  REPLAY_TRUTH: 'Truth replay',
  CCTV_REVEAL: 'CCTV reveal',
};
const ROLE_CN: Record<Exclude<Role, 'admin'>, string> = {
  main: 'Main projector',
  door: 'Entrance',
  station1: 'Comms term.',
  station2: 'Breaker',
};

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
  <div class="admin">
    <div class="desk-top"><span class="ttl">RH-30 · LAB CONTROL DESK<span class="cjk" aria-hidden="true">${LOGO_CJK}</span></span><span class="conn off" id="conn">OFFLINE</span><span class="mono" id="clock">--:--:--</span></div>
    <div class="desk">
      <div class="col">
        <section class="sec">
          <button class="shutter-btn" id="shutter" disabled>
            <span class="top"><span>EXPOSURE · RELEASE</span><span>1 / 30 S</span></span>
            <span class="big">PRESS SHUTTER · ENTER THE FRAME</span>
            <span class="meta"><span id="shutterHint">Available in standby only</span><span class="kbd">SPACE</span></span>
          </button>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="01">Phase</span><span id="roundNo">ROUND 000</span></h3>
          <div class="phase-row">
            <div><div class="phase-name" id="phase">—</div><span class="phase-cn" id="phaseCn"></span></div>
            <div class="stopwatch"><span class="el" id="swEl">0.000</span><span class="of" id="swOf"></span></div>
          </div>
          <div class="timeline" id="tl">
            <div data-p="ENTER_BUFFER">BUF</div><div data-p="ACTIVE_30S">ACTIVE 30</div><div data-p="FLASH_FREEZE">FLASH</div>
            <div data-p="REWIND">RWD</div><div data-p="REPLAY_TRUTH">REPLAY 30</div><div data-p="CCTV_REVEAL">CCTV</div>
          </div>
          <div class="chemrow"><span>IN</span><span>DEV 05 · STOP 13 · FIX 21</span><span>FREEZE</span><span>WASH</span><span>DRY</span></div>
          <div class="readout" id="ro"></div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="02">Controls</span></h3>
          <div class="btns">
            <button class="danger" id="reset"><span id="resetLabel">Emergency stop · reset to IDLE</span><small>PRESS TWICE WITHIN 3 S</small></button>
            <button id="resetDoor"><span>Reset entrance photo</span><small>BACK TO DEFAULT · ARCHIVE KEPT</small></button>
            <button id="testFlash"><span>Test main flash</span><small>/MAIN ONLY</small></button>
            <button id="reload"><span>Reload archive</span><small>/API/ARCHIVE</small></button>
          </div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="03">Entry buffer</span><span>${ENTER_BUFFER_MIN}–${ENTER_BUFFER_MAX} S</span></h3>
          <div class="buffer-ctl">
            <button id="bufMinus" aria-label="One second less">−</button>
            <div class="val"><span id="bufVal">4</span><small>SECONDS</small></div>
            <button id="bufPlus" aria-label="One second more">+</button>
          </div>
        </section>
      </div>
      <div class="col">
        <section class="sec">
          <h3 class="sec-h"><span data-no="04">Devices</span><span id="onlineCount">0 / 4</span></h3>
          <div class="lights" id="lights"></div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="05">Latest freeze</span><span id="latestTs">—</span></h3>
          <div class="preview"><div class="imgbox"><img id="latest" alt="Latest freeze frame" class="hidden" /><div class="none" id="latestNone">No freeze yet. The entrance shows the default negative.</div></div>${cropMarks()}<div class="slug"><span>RUHUA LAB · PROOF</span><span id="latestSlug">FR —</span></div></div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="06">Today’s archive · negative sleeve</span><span id="archCount"></span></h3>
          <div class="archive" id="archive"></div>
        </section>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const shutterBtn = $<HTMLButtonElement>('#shutter');
  const shutterHint = $<HTMLElement>('#shutterHint');
  const phaseEl = $<HTMLDivElement>('#phase');
  const phaseCn = $<HTMLSpanElement>('#phaseCn');
  const swEl = $<HTMLSpanElement>('#swEl');
  const swOf = $<HTMLSpanElement>('#swOf');
  const roundNo = $<HTMLSpanElement>('#roundNo');
  const ro = $<HTMLDivElement>('#ro');
  const tl = Array.from(app.querySelectorAll<HTMLDivElement>('#tl > div'));
  const conn = $<HTMLSpanElement>('#conn');
  const clockEl = $<HTMLSpanElement>('#clock');
  const lights = $<HTMLDivElement>('#lights');
  const onlineCount = $<HTMLSpanElement>('#onlineCount');
  const resetBtn = $<HTMLButtonElement>('#reset');
  const resetLabel = $<HTMLSpanElement>('#resetLabel');
  const bufVal = $<HTMLSpanElement>('#bufVal');
  const latest = $<HTMLImageElement>('#latest');
  const latestNone = $<HTMLDivElement>('#latestNone');
  const latestTs = $<HTMLSpanElement>('#latestTs');
  const latestSlug = $<HTMLSpanElement>('#latestSlug');
  const archive = $<HTMLDivElement>('#archive');
  const archCount = $<HTMLSpanElement>('#archCount');
  const toastEl = document.getElementById('toast')!;

  const net = new Net('admin', token);
  (window as any).__net = net; // debugging / automated tests

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
  };

  // ---------------- shutter ----------------
  let lastShutter = 0;
  function fireShutter(): void {
    if (net.phase !== 'IDLE' || !net.connected) return;
    const now = Date.now();
    if (now - lastShutter < 1500) return; // debounce
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
    e.preventDefault(); // no page scroll, and no Space "click" on a focused button
    if (e.repeat) return;
    fireShutter();
  });
  // stop a Space keyup from clicking a focused button
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') e.preventDefault();
  });

  // ---------------- emergency stop (confirm twice within 3 s) ----------------
  let armedTimer = 0;
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('armed')) {
      resetBtn.classList.add('armed');
      resetLabel.textContent = 'Press again to confirm stop';
      armedTimer = window.setTimeout(disarm, 3000);
      return;
    }
    disarm();
    net.send({ type: 'admin', action: 'reset', token });
  });
  function disarm(): void {
    clearTimeout(armedTimer);
    resetBtn.classList.remove('armed');
    resetLabel.textContent = 'Emergency stop · reset to IDLE';
  }

  $<HTMLButtonElement>('#resetDoor').addEventListener('click', () => {
    if (confirm('Reset the entrance photo to the default negative? (The archive is not affected.)')) net.send({ type: 'admin', action: 'resetDoor', token });
  });
  $<HTMLButtonElement>('#testFlash').addEventListener('click', () => net.send({ type: 'admin', action: 'testFlash', token }));
  $<HTMLButtonElement>('#reload').addEventListener('click', loadArchive);

  // ---------------- ENTER_BUFFER ----------------
  const setBuffer = (delta: number) => {
    const cur = net.config?.enterBufferSec ?? 4;
    const next = Math.min(ENTER_BUFFER_MAX, Math.max(ENTER_BUFFER_MIN, Math.round(cur + delta)));
    if (next === cur) return;
    net.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: next }, token });
  };
  $<HTMLButtonElement>('#bufMinus').addEventListener('click', () => setBuffer(-1));
  $<HTMLButtonElement>('#bufPlus').addEventListener('click', () => setBuffer(1));
  net.on('config', (m) => (bufVal.textContent = String(m.config.enterBufferSec)));

  // ---------------- online lamps ----------------
  const fmtAgo = (ts: number | null) => {
    if (!ts) return 'never seen';
    const s = Math.max(0, Math.round((net.now() - ts) / 1000));
    const hhmmss = new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
    return `${hhmmss} · ${s}s ago`;
  };
  net.on('clients', (m) => {
    lights.innerHTML = '';
    let on = 0;
    for (const c of m.clients) {
      if (c.role === 'admin') continue;
      if (c.online) on++;
      const d = document.createElement('div');
      d.className = 'light' + (c.online ? ' on' : '');
      d.innerHTML = `<div class="bulb"></div><div class="nm"><span></span><span class="r"></span></div><div class="ls"></div>`;
      (d.querySelector('.nm span') as HTMLElement).textContent = `${ROLE_CN[c.role as keyof typeof ROLE_CN]}${c.count > 1 ? ` ×${c.count}` : ''}`;
      (d.querySelector('.nm .r') as HTMLElement).textContent = `/${c.role}`;
      (d.querySelector('.ls') as HTMLElement).textContent = `${c.online ? 'ON ' : 'OFF'} · ${fmtAgo(c.lastSeen)}`;
      lights.appendChild(d);
    }
    onlineCount.textContent = `${on} / 4`;
  });

  net.on('ack', (m) => toast(`${m.ok ? '✓' : '✗'} ${m.message || m.what}`));
  net.on('open', () => {
    toast('Connected to server');
    conn.textContent = 'ONLINE';
    conn.classList.remove('off');
  });
  net.on('close', () => {
    toast('Disconnected from server, reconnecting…');
    conn.textContent = 'RECONNECTING';
    conn.classList.add('off');
    lights.querySelectorAll('.light').forEach((l) => l.classList.remove('on'));
  });

  // ---------------- freeze frame & archive ----------------
  net.on('door-photo', (m) => {
    if (m.photo.url) {
      latest.src = m.photo.url;
      latestTs.textContent = new Date(m.photo.version).toLocaleTimeString('en-GB', { hour12: false });
      latestSlug.textContent = `FR ${String(net.round?.id ?? 0).padStart(2, '0')}A · ${latestTs.textContent}`;
    } else {
      latest.removeAttribute('src');
      latestTs.textContent = 'DEFAULT';
      latestSlug.textContent = 'FR — · DEFAULT PLATE';
    }
    latest.classList.toggle('hidden', !m.photo.url);
    latestNone.classList.toggle('hidden', !!m.photo.url);
    loadArchive();
  });

  async function loadArchive(): Promise<void> {
    try {
      const r = await fetch(`/api/archive${tq ? '?' + tq : ''}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) {
        archCount.textContent = 'NO ACCESS';
        return;
      }
      archCount.textContent = `${j.count} FR`;
      archive.innerHTML = j.count ? '' : '<div class="empty">No visitor photos archived today. The sleeve is empty.</div>';
      const items = j.items as { name: string; url: string }[];
      items.forEach((it, idx) => {
        const a = document.createElement('a');
        const url = it.url + (tq ? `?${tq}` : '');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = url;
        a.appendChild(img);
        const fn = document.createElement('div');
        fn.className = 'fn';
        const m = /^(\d{8})-(\d{2})(\d{2})(\d{2})/.exec(it.name);
        fn.innerHTML = `<span>${String(items.length - idx).padStart(2, '0')}A</span><span>${m ? `${m[2]}:${m[3]}:${m[4]}` : ''}</span>`;
        fn.title = it.name;
        a.appendChild(fn);
        if (idx === 0) {
          a.classList.add('pick');
          a.insertAdjacentHTML('beforeend', '<span class="grease">✓</span>');
        }
        archive.appendChild(a);
      });
    } catch {
      archCount.textContent = 'LOAD FAILED';
    }
  }

  // ---------------- stopwatch ----------------
  const ORDER: Phase[] = ['IDLE', 'ENTER_BUFFER', 'ACTIVE_30S', 'FLASH_FREEZE', 'REWIND', 'REPLAY_TRUTH', 'CCTV_REVEAL'];
  const cell = (k: string, v: string, cls = '') => `<div><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  let roKey = '';
  function tick(): void {
    clockEl.textContent = new Date(net.now()).toLocaleTimeString('en-GB', { hour12: false });
    const st = net.state;
    if (st) {
      const p = st.state;
      phaseEl.textContent = p;
      phaseCn.textContent = PHASE_CN[p];
      const el = net.elapsedMs() / 1000;
      const dur = st.phaseDurationMs / 1000;
      if (dur > 0) {
        swEl.textContent = el.toFixed(3);
        swOf.textContent = `/ ${dur.toFixed(3)} S · ${Math.max(0, dur - el).toFixed(1)} S LEFT`;
      } else {
        swEl.textContent = el.toFixed(1);
        swOf.textContent = 'S · STANDBY';
      }
      const idx = ORDER.indexOf(p);
      for (const c of tl) {
        const ci = ORDER.indexOf(c.dataset.p as Phase);
        c.classList.toggle('cur', ci === idx);
        c.classList.toggle('done', idx > 0 && ci < idx);
      }
      const r = st.round;
      roundNo.textContent = `ROUND ${String(r.id).padStart(3, '0')}`;
      const key = JSON.stringify([r, net.offset | 0, net.rtt, st.timeScale]);
      if (key !== roKey) {
        roKey = key;
        ro.innerHTML =
          cell('didSpeak', String(r.didSpeak), r.didSpeak ? 'yes' : '') +
          cell('didPullBreaker', String(r.didPullBreaker), r.didPullBreaker ? 'yes' : '') +
          cell('audioOffsetMs', r.audioOffsetMs == null ? '—' : String(r.audioOffsetMs)) +
          cell('breaker', r.breakerPulledAtSec == null ? '—' : `${r.breakerPulledAtSec.toFixed(2)}s${r.breakerLocked ? ' LOCK' : ''}`) +
          cell('trigger', r.trigger ?? '—') +
          cell('clock', `${net.offset.toFixed(0)}ms · RTT ${net.rtt}`) +
          (st.timeScale !== 1 ? cell('TIME_SCALE', `${st.timeScale} TEST MODE`, 'warn') : '');
      }
      const canStart = p === 'IDLE' && net.connected;
      shutterBtn.disabled = !canStart || Date.now() - lastShutter < 1500;
      shutterHint.textContent = canStart ? 'Standby · ready' : net.connected ? `Running · ${p}` : 'Server not connected';
    }
    requestAnimationFrame(tick);
  }

  net.connect();
  loadArchive();
  requestAnimationFrame(tick);
}
