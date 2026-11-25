/**
 * /station1 — tablet 2: south-west archival terminal
 *  t = 04s ~ 16s: PROTOCOL 01 · VOCAL CALIBRATION (hold to speak, up to 4 clips/round, max 6s/clip, calm VU meter + TRANSMITTING)
 *  t = 16s ~ 25s: PROTOCOL 02 · OPTICAL DODGING IN PROGRESS (steady darkroom notice)
 *  t = 25s ~ 30s: AWAITING FIXATION AT NORTH-WEST STATION (dimmed notice)
 */
import { Net, mountNetDot } from '../lib/net';
import { audioCtx, cueBeep } from '../lib/sfx';
import { blobToDataURL, pickAudioMime } from '../lib/media';
import { showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { TIMELINE } from '../../../shared/protocol';

const TITLE_P1 = 'PROTOCOL 01 · VOCAL CALIBRATION';
const COPY_P1 =
  "Exposure drift detected in the archival footage. Hold the receiver and speak clearly to keep the subject's attention within the frame.";

const TITLE_P2 = 'PROTOCOL 02 · OPTICAL DODGING IN PROGRESS';
const COPY_P2 = 'Maintain physical shadow coverage across the overexposed center until fixation.';

const TITLE_WAIT = 'PROTOCOL 03 · FIXATION STANDBY';
const COPY_WAIT = 'AWAITING FIXATION AT NORTH-WEST STATION';

type Seg = 'black' | 'P1' | 'P2' | 'WAIT';

const VU_BARS = 16;

export default async function station1(app: HTMLElement): Promise<void> {
  document.title = `South-west terminal · ${TITLE_EN}`;
  app.innerHTML = `
    <div class="station black" id="root">
      <div class="st-band">
        <span class="id"><span>T-02</span></span>
        <span class="zone" id="zone">SW archival terminal</span>
        <span class="clock" id="clock">--.-</span>
      </div>
      <div class="st-body stack" id="body">
        <div class="st-copy">
          <div class="st-kicker" id="kicker"></div>
          <p class="st-msg" id="msg"></p>
        </div>
        <div class="st-aside hidden" id="aside">
          <div class="vu-panel">
            <div class="vu-head">
              <span id="vuStatus">READY · HOLD RECEIVER TO TRANSMIT</span>
              <span class="mono" id="clipCount">0 / ${TIMELINE.maxAudioClips} CLIPS</span>
            </div>
            <div class="vu-bars" id="vuBars">${Array.from({ length: VU_BARS }, () => '<i></i>').join('')}</div>
            <div class="st-sub" id="sub">MAX ${TIMELINE.maxClipDurationSec}.0 S PER TRANSMISSION</div>
          </div>
          <button class="speak-btn" id="talk" type="button">
            <span class="speak-ring"></span>
            <span class="speak-cap">HOLD<br>TO SPEAK</span>
          </button>
        </div>
      </div>
      <div class="st-foot">
        <span>RH-30 / SW TERMINAL · <span id="foot">STANDBY</span></span>
        <span class="chem" id="chem">
          <span data-s="P1"><b>P01</b> 04–16</span>
          <span data-s="P2"><b>P02</b> 16–25</span>
          <span data-s="WAIT"><b>FIX</b> 25–30</span>
        </span>
      </div>
    </div>`;

  const root = app.querySelector('#root') as HTMLDivElement;
  const aside = app.querySelector('#aside') as HTMLDivElement;
  const zone = app.querySelector('#zone') as HTMLSpanElement;
  const clock = app.querySelector('#clock') as HTMLSpanElement;
  const foot = app.querySelector('#foot') as HTMLSpanElement;
  const kicker = app.querySelector('#kicker') as HTMLDivElement;
  const msgEl = app.querySelector('#msg') as HTMLParagraphElement;
  const vuStatus = app.querySelector('#vuStatus') as HTMLSpanElement;
  const clipCountEl = app.querySelector('#clipCount') as HTMLSpanElement;
  const vuBars = Array.from(app.querySelectorAll<HTMLElement>('#vuBars > i'));
  const subEl = app.querySelector('#sub') as HTMLDivElement;
  const btn = app.querySelector('#talk') as HTMLButtonElement;
  const chem = Array.from(app.querySelectorAll<HTMLSpanElement>('#chem > span'));

  const net = new Net('station1');
  (window as any).__net = net;
  mountNetDot(net);

  let mic: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let micSrc: MediaStreamAudioSourceNode | null = null;
  const freqBuf = new Uint8Array(64);
  const mime = pickAudioMime();

  // ---------------- multi-clip recording + VU meter ----------------
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let recStartServer = 0;
  let recStartLocal = 0;
  let recRound = -1;
  let maxClipTimer: number | null = null;
  let activeRoundId = -1;
  let sentCount = 0;

  async function ensureMic(): Promise<MediaStream | null> {
    if (mic && mic.getAudioTracks().some((t) => t.readyState === 'live')) return mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
      });
      try {
        const c = audioCtx();
        analyser = c.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        micSrc?.disconnect();
        micSrc = c.createMediaStreamSource(mic);
        micSrc.connect(analyser);
      } catch {
        analyser = null;
      }
    } catch (e) {
      console.warn('microphone unavailable', e);
      mic = null;
      analyser = null;
    }
    return mic;
  }

  function syncClipCounter(): void {
    const srvCount = net.round?.id === activeRoundId ? (net.round?.audioClipCount ?? 0) : 0;
    const count = Math.max(sentCount, srvCount);
    clipCountEl.textContent = `${count} / ${TIMELINE.maxAudioClips} CLIPS`;
    const full = count >= TIMELINE.maxAudioClips;
    if (seg === 'P1' && !rec) {
      btn.disabled = full;
      if (full) {
        vuStatus.textContent = 'CALIBRATION LOG COMPLETE';
        subEl.textContent = 'MAXIMUM 4 TRANSMISSIONS RECORDED';
      }
    }
  }

  function clearVu(): void {
    for (const b of vuBars) b.className = '';
  }

  function updateVu(): void {
    if (!rec) {
      clearVu();
      return;
    }
    let level = 0;
    if (analyser) {
      analyser.getByteTimeDomainData(freqBuf);
      let sum = 0;
      for (let i = 0; i < freqBuf.length; i++) {
        const d = (freqBuf[i] - 128) / 128;
        sum += d * d;
      }
      level = Math.min(1, Math.sqrt(sum / freqBuf.length) * 3.4);
    } else {
      // gentle fallback activity pulse if browser lacks AnalyserNode stream
      level = 0.18 + 0.12 * Math.sin(performance.now() / 140);
    }
    const lit = Math.round(level * VU_BARS);
    vuBars.forEach((bar, idx) => {
      const on = idx < lit;
      bar.className = on ? (idx >= VU_BARS - 3 ? 'hi' : 'on') : '';
    });
    const heldSec = Math.min(TIMELINE.maxClipDurationSec, (performance.now() - recStartLocal) / 1000);
    subEl.textContent = `TRANSMITTING · ${heldSec.toFixed(1)} / ${TIMELINE.maxClipDurationSec}.0 S`;
  }

  async function startRec(): Promise<void> {
    const r = net.round;
    if (rec || !r || seg !== 'P1') return;
    if (r.id !== activeRoundId) {
      activeRoundId = r.id;
      sentCount = r.audioClipCount ?? 0;
    }
    if (sentCount >= TIMELINE.maxAudioClips || (r.audioClipCount ?? 0) >= TIMELINE.maxAudioClips) {
      syncClipCounter();
      return;
    }
    const s = await ensureMic();
    if (!s || seg !== 'P1') {
      if (!s) {
        vuStatus.textContent = 'MICROPHONE UNAVAILABLE';
        subEl.textContent = 'CHECK HTTPS & BROWSER PERMISSION';
      }
      return;
    }
    try {
      rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
    } catch {
      rec = new MediaRecorder(s);
    }
    chunks = [];
    recRound = r.id;
    recStartServer = net.now();
    recStartLocal = performance.now();
    const activeRecorder = rec;
    activeRecorder.onstart = () => {
      recStartServer = net.now();
      recStartLocal = performance.now();
    };
    activeRecorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    activeRecorder.onstop = async () => {
      if (maxClipTimer) {
        clearTimeout(maxClipTimer);
        maxClipTimer = null;
      }
      const type = activeRecorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type });
      const round = net.round;
      if (rec === activeRecorder) rec = null;
      btn.classList.remove('rec');
      clearVu();
      if (!round || round.id !== recRound || blob.size < 400 || !round.activeStartedAt) {
        if (seg === 'P1') {
          vuStatus.textContent = 'HOLD LONGER TO LOG VOICE';
          subEl.textContent = `MAX ${TIMELINE.maxClipDurationSec}.0 S PER TRANSMISSION`;
        }
        return;
      }
      const offsetMs = Math.max(0, Math.round(recStartServer - round.activeStartedAt));
      const dataUrl = await blobToDataURL(blob);
      if (net.send({ type: 'speak', mime: type, dataUrl, offsetMs })) {
        sentCount = Math.min(TIMELINE.maxAudioClips, Math.max(sentCount + 1, (round.audioClipCount ?? 0) + 1));
        vuStatus.textContent = `TRANSMISSION ${sentCount} LOGGED`;
        subEl.textContent =
          sentCount < TIMELINE.maxAudioClips ? 'READY FOR NEXT SPEAKER' : 'MAXIMUM 4 TRANSMISSIONS RECORDED';
        syncClipCounter();
      }
    };

    activeRecorder.start(200);
    btn.classList.add('rec');
    vuStatus.textContent = 'TRANSMITTING';
    if (maxClipTimer) clearTimeout(maxClipTimer);
    maxClipTimer = window.setTimeout(() => stopRec(), TIMELINE.maxClipDurationSec * 1000 * net.timeScale);
  }

  function stopRec(): void {
    if (maxClipTimer) {
      clearTimeout(maxClipTimer);
      maxClipTimer = null;
    }
    if (rec && rec.state !== 'inactive') {
      try {
        rec.requestData();
      } catch {
        /* ignore */
      }
      try {
        rec.stop();
      } catch {
        rec = null;
      }
    }
  }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    void startRec();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    btn.addEventListener(ev, () => stopRec());
  }

  net.on('state', () => {
    if (net.round && net.round.id !== activeRoundId) {
      activeRoundId = net.round.id;
      sentCount = net.round.audioClipCount ?? 0;
    }
    syncClipCounter();
  });

  // ---------------- phase rendering ----------------
  let seg: Seg = 'black';
  function setSeg(next: Seg): void {
    if (next === seg) return;
    const prev = seg;
    seg = next;
    chem.forEach((c) => c.classList.toggle('on', c.dataset.s === next));
    if (next !== 'P1') stopRec();

    if (next === 'P1') {
      if (prev !== 'P1') cueBeep();
      root.className = 'station st-p1';
      zone.textContent = 'SW terminal · Vocal calibration';
      foot.textContent = 'PROTOCOL 01';
      kicker.textContent = TITLE_P1;
      msgEl.textContent = COPY_P1;
      aside.classList.remove('hidden');
      vuStatus.textContent = 'READY · HOLD RECEIVER TO TRANSMIT';
      subEl.textContent = `MAX ${TIMELINE.maxClipDurationSec}.0 S PER TRANSMISSION`;
      syncClipCounter();
    } else if (next === 'P2') {
      cueBeep();
      root.className = 'station st-p2';
      zone.textContent = 'SW terminal · Optical dodging assist';
      foot.textContent = 'PROTOCOL 02';
      kicker.textContent = TITLE_P2;
      msgEl.textContent = COPY_P2;
      aside.classList.add('hidden');
    } else if (next === 'WAIT') {
      root.className = 'station st-dim';
      zone.textContent = 'SW terminal · Standby';
      foot.textContent = 'AWAITING FIXATION';
      kicker.textContent = TITLE_WAIT;
      msgEl.textContent = COPY_WAIT;
      aside.classList.add('hidden');
    } else {
      root.className = 'station black';
      aside.classList.add('hidden');
      kicker.textContent = '';
      msgEl.textContent = '';
    }
  }

  function tick(): void {
    let next: Seg = 'black';
    if (net.connected && net.phase === 'ACTIVE_30S') {
      const t = net.storySec();
      if (t >= TIMELINE.station1P1[0] && t < TIMELINE.station1P1[1]) next = 'P1';
      else if (t >= TIMELINE.station1P2[0] && t < TIMELINE.station1P2[1]) next = 'P2';
      else if (t >= TIMELINE.station1Wait[0] && t <= TIMELINE.station1Wait[1] + 0.3) next = 'WAIT';
    }
    setSeg(next);
    if (next !== 'black') {
      const end =
        next === 'P1' ? TIMELINE.station1P1[1] : next === 'P2' ? TIMELINE.station1P2[1] : TIMELINE.station1Wait[1];
      clock.textContent = Math.max(0, end - net.storySec()).toFixed(1).padStart(4, '0');
    }
    if (next === 'P1') updateVu();
    requestAnimationFrame(tick);
  }

  await showStartOverlay({
    code: 'T-02',
    kicker: '/station1',
    title: 'South-west archival terminal',
    subtitle: 'Tap to allow the microphone, go fullscreen\nand keep the screen awake.',
    button: 'Tap to start',
    onUnlock: async () => {
      await ensureMic();
    },
  });
  net.connect();
  requestAnimationFrame(tick);
}
