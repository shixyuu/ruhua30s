/**
 * /admin — operator & critique control desk (v2 Archival Edition)
 * - Huge shutter button "PRESS SHUTTER · ENTER THE FRAME" (IDLE only; Space triggers it)
 * - SKIP PHASE button (immediately advances active round to next phase for critique scheduling)
 * - NEW ROLL (CLEAR CONTACT SHEET) with two-tap confirmation (increments rollNumber, keeps all ./data/archive/ files)
 * - ENTER_BUFFER (2–10 s, default 6 s) and CCTV_REVEAL (4–15 s, default 8 s) steppers
 * - Online lamps for all 4 terminals, precise stopwatch, multi-clip readout, latest freeze, current-roll contact sleeve
 */
import { Net } from '../lib/net';
import type { ContactSheetInfo, Phase, Role } from '../../../shared/protocol';
import {
  CCTV_REVEAL_MAX,
  CCTV_REVEAL_MIN,
  ENTER_BUFFER_MAX,
  ENTER_BUFFER_MIN,
} from '../../../shared/protocol';
import { LOGO_CJK, TITLE_EN } from '../lib/brand';
import { cropMarks, escapeHtml } from '../lib/unlock';

const PHASE_DESC: Record<Phase, string> = {
  IDLE: 'Standby · awaiting shutter release',
  ENTER_BUFFER: 'Collective entry buffer',
  ACTIVE_30S: 'Exposure window · protocols active',
  FLASH_FREEZE: 'Shutter release & archival capture',
  REWIND: 'Film transport rewind',
  REPLAY_TRUTH: 'Silent archival playback',
  CCTV_REVEAL: 'Contact sheet proof & entrance monitor',
};

const ROLE_LABEL: Record<Exclude<Role, 'admin'>, string> = {
  main: 'Main projector',
  door: 'Contact sheet',
  station1: 'SW terminal',
  station2: 'NW terminal',
};

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

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
    <div class="desk-top">
      <span class="ttl">RH-30 · ARCHIVAL CONTROL DESK<span class="cjk" aria-hidden="true">${LOGO_CJK}</span></span>
      <span class="roll-pill" id="topRoll">ROLL 01</span>
      <span class="conn off" id="conn">OFFLINE</span>
      <span class="mono" id="clock">--:--:--</span>
    </div>
    <div class="desk">
      <div class="col">
        <section class="sec">
          <button class="shutter-btn" id="shutter" type="button" disabled>
            <span class="top"><span>MANUAL FLASH + SHUTTER RELEASE</span><span id="shutterRoll">ROLL 01 · FR 01A</span></span>
            <span class="big">PRESS SHUTTER · ENTER THE FRAME</span>
            <span class="meta"><span id="shutterHint">Available in standby only</span><span class="kbd">SPACE</span></span>
          </button>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="01">Phase &amp; timing</span><span id="roundNo">ROUND 000</span></h3>
          <div class="phase-row">
            <div><div class="phase-name" id="phase">—</div><span class="phase-cn" id="phaseCn"></span></div>
            <div class="stopwatch"><span class="el" id="swEl">0.000</span><span class="of" id="swOf"></span></div>
          </div>
          <div class="timeline" id="tl">
            <div data-p="ENTER_BUFFER">BUF</div><div data-p="ACTIVE_30S">EXPOSURE 30</div><div data-p="FLASH_FREEZE">FIX</div>
            <div data-p="REWIND">RWD</div><div data-p="REPLAY_TRUTH">PLAYBACK 30</div><div data-p="CCTV_REVEAL">PROOF</div>
          </div>
          <div class="chemrow"><span>ENTRY</span><span>P01 04–16 · P02 08–25 · P03 21–30</span><span>SHUTTER</span><span>SILENT REPLAY</span><span>SHEET</span></div>
          <div class="readout" id="ro"></div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="02">Operator controls</span></h3>
          <div class="btns">
            <button id="skipPhase" type="button" disabled>
              <span>Skip phase →</span>
              <small id="skipHint">ADVANCE TO NEXT STAGE</small>
            </button>
            <button class="danger" id="reset" type="button">
              <span id="resetLabel">Emergency stop · reset to IDLE</span>
              <small>TAP TWICE WITHIN 3 S</small>
            </button>
            <button class="amber" id="newRoll" type="button">
              <span id="newRollLabel">New roll (clear contact sheet)</span>
              <small>TAP TWICE · DISK ARCHIVE KEPT</small>
            </button>
            <button id="testFlash" type="button">
              <span>Test main flash</span>
              <small>/MAIN SHUTTER &amp; STROBE</small>
            </button>
          </div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="03">Phase durations</span><span>PERSISTED IN CONFIG.JSON</span></h3>
          <div class="dur-grid">
            <div class="dur-box">
              <div class="dur-lbl"><span>ENTER_BUFFER</span><span>${ENTER_BUFFER_MIN}–${ENTER_BUFFER_MAX} S</span></div>
              <div class="buffer-ctl">
                <button id="bufMinus" type="button" aria-label="Decrease entry buffer">−</button>
                <div class="val"><span id="bufVal">6</span><small>SECONDS</small></div>
                <button id="bufPlus" type="button" aria-label="Increase entry buffer">+</button>
              </div>
            </div>
            <div class="dur-box">
              <div class="dur-lbl"><span>CCTV_REVEAL</span><span>${CCTV_REVEAL_MIN}–${CCTV_REVEAL_MAX} S</span></div>
              <div class="buffer-ctl">
                <button id="cctvMinus" type="button" aria-label="Decrease CCTV reveal">−</button>
                <div class="val"><span id="cctvVal">8</span><small>SECONDS</small></div>
                <button id="cctvPlus" type="button" aria-label="Increase CCTV reveal">+</button>
              </div>
            </div>
          </div>
        </section>
      </div>
      <div class="col">
        <section class="sec">
          <h3 class="sec-h"><span data-no="04">Terminals</span><span id="onlineCount">0 / 4</span></h3>
          <div class="lights" id="lights"></div>
        </section>
        <section class="sec">
          <h3 class="sec-h"><span data-no="05">Latest proof</span><span id="latestTs">—</span></h3>
          <div class="preview">
            <div class="imgbox">
              <img id="latest" alt="Latest proof frame" class="hidden" />
              <div class="none" id="latestNone">No visitor frames on current roll yet. Entrance shows the 00A reference contact sheet.</div>
            </div>
            ${cropMarks()}
            <div class="slug"><span>RUHUA ARCHIVE · PROOF</span><span id="latestSlug">ROLL 01 · FR —</span></div>
          </div>
        </section>
        <section class="sec">
          <h3 class="sec-h">
            <span data-no="06">Current roll contact sleeve</span>
            <span id="archCount">ROLL 01 · 0 FR</span>
          </h3>
          <div class="archive" id="archive"></div>
          <div class="arch-foot">
            <span id="totalDisk">Disk archive: — total frames across all rolls</span>
            <button class="link-btn" id="reload" type="button">Reload</button>
          </div>
        </section>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const shutterBtn = $<HTMLButtonElement>('#shutter');
  const shutterRoll = $<HTMLSpanElement>('#shutterRoll');
  const shutterHint = $<HTMLElement>('#shutterHint');
  const topRoll = $<HTMLSpanElement>('#topRoll');
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
  const skipBtn = $<HTMLButtonElement>('#skipPhase');
  const skipHint = $<HTMLElement>('#skipHint');
  const resetBtn = $<HTMLButtonElement>('#reset');
  const resetLabel = $<HTMLSpanElement>('#resetLabel');
  const newRollBtn = $<HTMLButtonElement>('#newRoll');
  const newRollLabel = $<HTMLSpanElement>('#newRollLabel');
  const bufVal = $<HTMLSpanElement>('#bufVal');
  const cctvVal = $<HTMLSpanElement>('#cctvVal');
  const latest = $<HTMLImageElement>('#latest');
  const latestNone = $<HTMLDivElement>('#latestNone');
  const latestTs = $<HTMLSpanElement>('#latestTs');
  const latestSlug = $<HTMLSpanElement>('#latestSlug');
  const archive = $<HTMLDivElement>('#archive');
  const archCount = $<HTMLSpanElement>('#archCount');
  const totalDisk = $<HTMLSpanElement>('#totalDisk');
  const toastEl = document.getElementById('toast')!;

  const net = new Net('admin', token);
  (window as any).__net = net;

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2400);
  };

  // ---------------- shutter ----------------
  let lastShutter = 0;
  function fireShutter(): void {
    if (net.phase !== 'IDLE' || !net.connected) return;
    const now = Date.now();
    if (now - lastShutter < 1500) return;
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
    e.preventDefault();
    if (e.repeat) return;
    fireShutter();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') e.preventDefault();
  });

  // ---------------- skip phase ----------------
  skipBtn.addEventListener('click', () => {
    if (net.phase === 'IDLE' || !net.connected) return;
    net.send({ type: 'admin', action: 'skipPhase', token });
  });

  // ---------------- emergency stop (2 taps within 3 s) ----------------
  let resetTimer = 0;
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('armed')) {
      resetBtn.classList.add('armed');
      resetLabel.textContent = 'Tap again to confirm stop';
      resetTimer = window.setTimeout(disarmReset, 3000);
      return;
    }
    disarmReset();
    net.send({ type: 'admin', action: 'reset', token });
  });
  function disarmReset(): void {
    clearTimeout(resetTimer);
    resetBtn.classList.remove('armed');
    resetLabel.textContent = 'Emergency stop · reset to IDLE';
  }

  // ---------------- new roll (2 taps within 3 s, keeps disk archive) ----------------
  let rollTimer = 0;
  newRollBtn.addEventListener('click', () => {
    if (!newRollBtn.classList.contains('armed')) {
      const nextR = (net.config?.rollNumber ?? 1) + 1;
      newRollBtn.classList.add('armed');
      newRollLabel.textContent = `Confirm Roll ${pad2(nextR)} · archive kept`;
      rollTimer = window.setTimeout(disarmNewRoll, 3000);
      return;
    }
    disarmNewRoll();
    net.send({ type: 'admin', action: 'newRoll', token });
  });
  function disarmNewRoll(): void {
    clearTimeout(rollTimer);
    newRollBtn.classList.remove('armed');
    newRollLabel.textContent = 'New roll (clear contact sheet)';
  }

  $<HTMLButtonElement>('#testFlash').addEventListener('click', () => net.send({ type: 'admin', action: 'testFlash', token }));
  $<HTMLButtonElement>('#reload').addEventListener('click', () => void loadDiskSummary());

  // ---------------- ENTER_BUFFER & CCTV_REVEAL durations ----------------
  const adjustConfig = (patch: { enterBufferSec?: number; cctvRevealSec?: number }) => {
    const curBuf = net.config?.enterBufferSec ?? 6;
    const curCctv = net.config?.cctvRevealSec ?? 8;
    const nextBuf =
      patch.enterBufferSec != null
        ? Math.min(ENTER_BUFFER_MAX, Math.max(ENTER_BUFFER_MIN, Math.round(patch.enterBufferSec)))
        : curBuf;
    const nextCctv =
      patch.cctvRevealSec != null
        ? Math.min(CCTV_REVEAL_MAX, Math.max(CCTV_REVEAL_MIN, Math.round(patch.cctvRevealSec)))
        : curCctv;
    if (nextBuf === curBuf && nextCctv === curCctv) return;
    net.send({ type: 'admin', action: 'setConfig', config: { enterBufferSec: nextBuf, cctvRevealSec: nextCctv }, token });
  };
  $<HTMLButtonElement>('#bufMinus').addEventListener('click', () => adjustConfig({ enterBufferSec: (net.config?.enterBufferSec ?? 6) - 1 }));
  $<HTMLButtonElement>('#bufPlus').addEventListener('click', () => adjustConfig({ enterBufferSec: (net.config?.enterBufferSec ?? 6) + 1 }));
  $<HTMLButtonElement>('#cctvMinus').addEventListener('click', () => adjustConfig({ cctvRevealSec: (net.config?.cctvRevealSec ?? 8) - 1 }));
  $<HTMLButtonElement>('#cctvPlus').addEventListener('click', () => adjustConfig({ cctvRevealSec: (net.config?.cctvRevealSec ?? 8) + 1 }));

  net.on('config', (m) => {
    bufVal.textContent = String(m.config.enterBufferSec);
    cctvVal.textContent = String(m.config.cctvRevealSec);
    topRoll.textContent = `ROLL ${pad2(m.config.rollNumber)}`;
    renderRollSleeve(net.contactSheet);
  });

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
      (d.querySelector('.nm span') as HTMLElement).textContent = `${ROLE_LABEL[c.role as keyof typeof ROLE_LABEL]}${c.count > 1 ? ` ×${c.count}` : ''}`;
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
    void loadDiskSummary();
  });
  net.on('close', () => {
    toast('Disconnected from server, reconnecting…');
    conn.textContent = 'RECONNECTING';
    conn.classList.add('off');
    lights.querySelectorAll('.light').forEach((l) => l.classList.remove('on'));
  });

  // ---------------- latest proof & current roll sleeve ----------------
  function renderRollSleeve(sheet?: ContactSheetInfo | null): void {
    const rollNo = sheet?.rollNumber ?? net.config?.rollNumber ?? 1;
    const frames = sheet?.frames ?? [];
    archCount.textContent = `ROLL ${pad2(rollNo)} · ${frames.length} FR`;

    if (frames.length === 0) {
      archive.innerHTML = `<div class="empty">Roll ${pad2(rollNo)} has 0 visitor frames. Entrance screen displays the 00A baseline template.</div>`;
    } else {
      const reversed = [...frames].reverse();
      archive.innerHTML = reversed
        .map((f, idx) => {
          const hhmmss = new Date(f.timestamp).toLocaleTimeString('en-GB', { hour12: false });
          const url = f.url + (tq ? `?${tq}` : '');
          return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="${idx === 0 ? 'pick' : ''}">
            <img src="${escapeHtml(url)}" loading="lazy" alt="${escapeHtml(f.frameNo)}" />
            <div class="fn"><span>▸${escapeHtml(f.frameNo)}</span><span>${hhmmss}</span></div>
          </a>`;
        })
        .join('');
    }

    const nextFr = frames.length + 1;
    if (net.phase === 'IDLE') {
      shutterRoll.textContent = `ROLL ${pad2(rollNo)} · NEXT FR ${pad2(nextFr)}A`;
    }
  }

  net.on('contact-sheet', (m) => {
    renderRollSleeve(m.sheet);
    void loadDiskSummary();
  });

  net.on('door-photo', (m) => {
    const rollNo = net.round?.rollNumber ?? net.config?.rollNumber ?? 1;
    const frmNo = net.contactSheet?.totalInRoll || net.round?.frameNumber || 1;
    if (m.photo.url) {
      latest.src = m.photo.url;
      latestTs.textContent = new Date(m.photo.version).toLocaleTimeString('en-GB', { hour12: false });
      latestSlug.textContent = `ROLL ${pad2(rollNo)} · FR ${pad2(frmNo)}A · ${latestTs.textContent}`;
    } else {
      latest.removeAttribute('src');
      latestTs.textContent = '00A REF';
      latestSlug.textContent = `ROLL ${pad2(rollNo)} · 00A TEMPLATE`;
    }
    latest.classList.toggle('hidden', !m.photo.url);
    latestNone.classList.toggle('hidden', !!m.photo.url);
  });

  async function loadDiskSummary(): Promise<void> {
    try {
      const r = await fetch(`/api/archive?all=1${tq ? '&' + tq : ''}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) {
        totalDisk.textContent = 'Disk archive: token required';
        return;
      }
      totalDisk.textContent = `Disk archive: ${j.count} total frame${j.count === 1 ? '' : 's'} preserved across all rolls`;
    } catch {
      totalDisk.textContent = 'Disk archive: status unavailable';
    }
  }

  // ---------------- stopwatch & readout ----------------
  const ORDER: Phase[] = ['IDLE', 'ENTER_BUFFER', 'ACTIVE_30S', 'FLASH_FREEZE', 'REWIND', 'REPLAY_TRUTH', 'CCTV_REVEAL'];
  const NEXT_LABEL: Record<Phase, string> = {
    IDLE: 'AVAILABLE WHEN RUNNING',
    ENTER_BUFFER: 'NEXT → ACTIVE_30S',
    ACTIVE_30S: 'NEXT → FLASH_FREEZE',
    FLASH_FREEZE: 'NEXT → REWIND',
    REWIND: 'NEXT → REPLAY_TRUTH',
    REPLAY_TRUTH: 'NEXT → CCTV_REVEAL',
    CCTV_REVEAL: 'NEXT → IDLE',
  };
  const cell = (k: string, v: string, cls = '') => `<div><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  let roKey = '';

  function tick(): void {
    clockEl.textContent = new Date(net.now()).toLocaleTimeString('en-GB', { hour12: false });
    const st = net.state;
    if (st) {
      const p = st.state;
      phaseEl.textContent = p;
      phaseCn.textContent = PHASE_DESC[p];
      const el = net.elapsedMs() / 1000;
      const dur = st.phaseDurationMs / 1000;
      if (dur > 0) {
        swEl.textContent = el.toFixed(3);
        swOf.textContent = `/ ${dur.toFixed(1)} S · ${Math.max(0, dur - el).toFixed(1)} S LEFT`;
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
      topRoll.textContent = `ROLL ${pad2(r.rollNumber)}`;
      if (p !== 'IDLE') {
        shutterRoll.textContent = `ROLL ${pad2(r.rollNumber)} · FR ${pad2(r.frameNumber)}A`;
      }

      const key = JSON.stringify([r, net.offset | 0, net.rtt, st.timeScale]);
      if (key !== roKey) {
        roKey = key;
        const offsetsTxt =
          r.audioOffsetsMs && r.audioOffsetsMs.length
            ? r.audioOffsetsMs.map((ms) => `${(ms / st.timeScale / 1000).toFixed(1)}s`).join(', ')
            : '—';
        ro.innerHTML =
          cell('roll / frame', `R${pad2(r.rollNumber)} · ${pad2(r.frameNumber)}A`) +
          cell('audioClips', `${r.audioClipCount ?? 0} / 4`, (r.audioClipCount ?? 0) > 0 ? 'yes' : '') +
          cell('clipOffsets', offsetsTxt) +
          cell(
            'fixationFader',
            r.breakerPulledAtSec == null ? '—' : `${r.breakerPulledAtSec.toFixed(2)}s${r.breakerLocked ? ' LOCK' : ' FIXED'}`,
            r.didPullBreaker ? 'yes' : '',
          ) +
          cell('freezeSaved', String(r.hasFreeze), r.hasFreeze ? 'yes' : '') +
          cell('clockSync', `${net.offset.toFixed(0)}ms · RTT ${net.rtt}`) +
          (st.timeScale !== 1 ? cell('TIME_SCALE', `${st.timeScale} TEST MODE`, 'warn') : '');
      }

      const canStart = p === 'IDLE' && net.connected;
      shutterBtn.disabled = !canStart || Date.now() - lastShutter < 1500;
      shutterHint.textContent = canStart ? 'Standby · ready' : net.connected ? `Running · ${p}` : 'Server not connected';

      const canSkip = p !== 'IDLE' && net.connected;
      skipBtn.disabled = !canSkip;
      skipHint.textContent = NEXT_LABEL[p];
    }
    requestAnimationFrame(tick);
  }

  net.connect();
  renderRollSleeve(null);
  void loadDiskSummary();
  requestAnimationFrame(tick);
}
