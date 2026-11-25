/**
 * /main — Mac + projector + external wide-angle camera (v2 Archival Edition)
 * - 30-second camera recording stays strictly local (MediaRecorder → Blob URL replay) and is never uploaded.
 * - Only the monochrome freeze frame at 30s is uploaded to ./data/archive/roll-XX/.
 * - REPLAY_TRUTH plays back in complete system silence with neutral 300–3200 Hz filtered visitor audioClips and a corner archival timecode.
 */
import { Net, mountNetDot } from '../lib/net';
import { audioCtx, enlargerTimer, out, rewindSfx, setAudioSink, shutter, stopAllLoops, unlockAudio } from '../lib/sfx';
import { assetAvailable, dataURLToArrayBuffer, drawReferencePlate, filmFilter, pickVideoMime } from '../lib/media';
import { cropMarks, filmStrip, keepAwake, requestFullscreen, withTimeout } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { clear, drawIdle, drawNoRecording, drawRewind, drawSimFilm, preloadCanvasFonts, setupCanvas } from '../lib/film';
import type { AudioClip, Phase } from '../../../shared/protocol';

const LS_CAM = 'ruhua.main.camera';
const LS_SINK = 'ruhua.main.sink';

type SinkEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function waxCircleSvg(): string {
  return `<svg class="cctv-wax" viewBox="0 0 200 130" preserveAspectRatio="none" aria-hidden="true">
    <path d="M 16,65 C 14,22 58,8 104,9 C 154,10 188,27 187,66 C 186,104 148,121 97,120 C 46,119 14,101 21,57"
      fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>`;
}

export default async function mainPage(app: HTMLElement): Promise<void> {
  document.title = `Main projector · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer" id="fx"></canvas>
    <video class="layer hidden" id="base" playsinline preload="auto"></video>
    <video class="layer hidden" id="rewind" playsinline preload="auto"></video>
    <video class="layer hidden" id="replay" playsinline muted></video>
    <div class="countdown hidden" id="countdownBox">
      <div class="k"><span>PREPARE EXPOSURE</span><span class="meta" id="prepMeta">ROLL 01 · FR 01A</span></div>
      <div class="n" id="countdown"></div>
    </div>
    <div class="replay-hud hidden" id="replayHud"></div>
    <div class="cctv hidden" id="cctv">
      <div class="rule"><span><b>RH-30</b> · ARCHIVAL CONTACT PROOF · <span id="cctvRoll">ROLL 01</span></span><span id="cctvClock">--:--:--</span></div>
      <div class="pane left">
        <div class="neg">
          ${filmStrip(29)}
          <div class="frame"><img id="freezeImg" alt="" />${waxCircleSvg()}</div>
          ${filmStrip(30)}
        </div>
        <div class="cap"><span class="no" id="frameNo">FRAME 01A</span><span class="t">ADDED TO ENTRANCE CONTACT SHEET</span></div>
      </div>
      <div class="pane right">
        <div class="frame">
          <img id="cctvImg" class="hidden" alt="" />
          <div class="nosignal hidden" id="nosig">ENTRANCE MONITOR · STANDBY</div>
          <div class="osd"><span>MON-01</span><span class="live">ENTRANCE</span></div>
        </div>
        <div class="cap"><span class="no">MON-01</span><span class="t">Entrance live monitor · next group</span></div>
      </div>
      <div class="exit"><span>EXIT NORTH</span><span class="arr">↑</span></div>
    </div>
    <div class="flash" id="flash"></div>
    <video id="cam" class="hidden" muted playsinline autoplay></video>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const fx = $<HTMLCanvasElement>('#fx');
  const g = setupCanvas(fx);
  preloadCanvasFonts();
  const baseV = $<HTMLVideoElement>('#base');
  const rewindV = $<HTMLVideoElement>('#rewind');
  const replayV = $<HTMLVideoElement>('#replay');
  const countdown = $<HTMLDivElement>('#countdown');
  const countdownBox = $<HTMLDivElement>('#countdownBox');
  const prepMeta = $<HTMLSpanElement>('#prepMeta');
  const replayHud = $<HTMLDivElement>('#replayHud');
  const frameNo = $<HTMLSpanElement>('#frameNo');
  const cctvRoll = $<HTMLSpanElement>('#cctvRoll');
  const cctvClock = $<HTMLSpanElement>('#cctvClock');
  const cctv = $<HTMLDivElement>('#cctv');
  const freezeImg = $<HTMLImageElement>('#freezeImg');
  const cctvImg = $<HTMLImageElement>('#cctvImg');
  const nosig = $<HTMLDivElement>('#nosig');
  const flashEl = $<HTMLDivElement>('#flash');
  const camV = $<HTMLVideoElement>('#cam');

  const net = new Net('main');
  (window as any).__net = net;
  mountNetDot(net);

  // ====================================================================
  // asset probe (re-HEAD on every return to IDLE so files can be hot-swapped)
  // ====================================================================
  const assets = { base: false, rewind: false };
  async function checkAssets(): Promise<void> {
    const [b, r] = await Promise.all([assetAvailable('/assets/base.mp4'), assetAvailable('/assets/rewind.mp4')]);
    assets.base = b;
    assets.rewind = r;
    updateAssetInfo?.();
  }
  let updateAssetInfo: (() => void) | null = null;

  // ====================================================================
  // camera
  // ====================================================================
  let camStream: MediaStream | null = null;
  let camId = localStorage.getItem(LS_CAM) || '';
  let sinkId = localStorage.getItem(LS_SINK) || '';

  async function openCamera(deviceId: string): Promise<MediaStream | null> {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      camV.srcObject = camStream;
      await camV.play().catch(() => {});
    } catch (err) {
      console.warn('camera failed to open', err);
      camStream = null;
    }
    return camStream;
  }

  function camLive(): boolean {
    return !!camStream && camStream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  async function ensureCamera(): Promise<void> {
    if (!camLive()) await openCamera(camId);
  }

  // ====================================================================
  // local recording (never uploaded)
  // ====================================================================
  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let recRound = -1;
  let replayUrl: string | null = null;
  let replayRound = -1;

  function startRecording(roundId: number): void {
    if (recorder || !camLive()) return;
    const mime = pickVideoMime();
    try {
      recorder = new MediaRecorder(camStream!, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
    } catch {
      recorder = new MediaRecorder(camStream!);
    }
    recChunks = [];
    recRound = roundId;
    recorder.ondataavailable = (e) => e.data && e.data.size && recChunks.push(e.data);
    recorder.start(1000);
  }

  function stopRecording(keep: boolean): Promise<void> {
    return new Promise((resolve) => {
      const r = recorder;
      if (!r) return resolve();
      recorder = null;
      r.onstop = () => {
        if (keep && recChunks.length) {
          if (replayUrl) URL.revokeObjectURL(replayUrl);
          replayUrl = URL.createObjectURL(new Blob(recChunks, { type: r.mimeType || 'video/webm' }));
          replayRound = recRound;
        }
        recChunks = [];
        resolve();
      };
      try {
        r.stop();
      } catch {
        resolve();
      }
    });
  }

  // ====================================================================
  // multi-clip visitor voices: neutral laboratory intercom bandpass (300–3200 Hz)
  // ====================================================================
  interface DecodedClip {
    key: string;
    roundId: number;
    offsetMs: number;
    buffer: AudioBuffer | null;
    el: HTMLAudioElement | null;
    played: boolean;
  }

  let clipsRoundId = -1;
  let clips: DecodedClip[] = [];
  let clipTimers: number[] = [];
  let activeSources: AudioScheduledSourceNode[] = [];

  /** Clean, intelligible laboratory intercom passband (300 Hz – 3200 Hz, minimal coloration) */
  function intercomChain(): AudioNode {
    const c = audioCtx();
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.707;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    lp.Q.value = 0.707;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    const gain = c.createGain();
    gain.gain.value = 1.65;
    hp.connect(lp).connect(comp).connect(gain).connect(out());
    return hp;
  }

  async function ingestClip(clip: AudioClip, roundId: number, idxHint: number): Promise<void> {
    if (clipsRoundId !== roundId) {
      stopVoices();
      clipsRoundId = roundId;
      clips = [];
    }
    const key = `${roundId}:${clip.offsetMs}:${idxHint}`;
    if (clips.some((c) => c.key === key)) return;
    const entry: DecodedClip = {
      key,
      roundId,
      offsetMs: clip.offsetMs,
      buffer: null,
      el: null,
      played: false,
    };
    clips.push(entry);
    try {
      entry.buffer = await audioCtx().decodeAudioData(dataURLToArrayBuffer(clip.dataUrl));
    } catch {
      const el = new Audio();
      el.src = clip.dataUrl;
      el.preload = 'auto';
      entry.el = el;
    }
    if (net.phase === 'REPLAY_TRUTH' && net.round?.id === roundId) {
      scheduleClip(entry);
    }
  }

  net.on('audio', (m) => {
    void ingestClip(m.clip, m.roundId, m.index);
  });

  net.on('audio-sync', (m) => {
    m.clips.forEach((c, i) => void ingestClip(c, m.roundId, i));
  });

  function scheduleClip(entry: DecodedClip): void {
    const st = net.state;
    if (!st || st.state !== 'REPLAY_TRUTH' || entry.roundId !== st.round.id || entry.played) return;
    const startAtLocal = net.toLocal(st.phaseStartedAt + entry.offsetMs);
    const delayMs = startAtLocal - Date.now();
    const play = (skipSec: number) => {
      if (net.phase !== 'REPLAY_TRUTH' || entry.played) return;
      entry.played = true;
      const c = audioCtx();
      const input = intercomChain();
      if (entry.buffer) {
        if (skipSec >= entry.buffer.duration) return;
        const s = c.createBufferSource();
        s.buffer = entry.buffer;
        s.connect(input);
        s.start(c.currentTime + 0.01, Math.max(0, skipSec));
        activeSources.push(s);
      } else if (entry.el) {
        try {
          c.createMediaElementSource(entry.el).connect(input);
        } catch {
          /* already connected */
        }
        entry.el.currentTime = Math.max(0, skipSec);
        entry.el.play().catch(() => {});
      }
    };
    if (delayMs > 0) {
      const tid = window.setTimeout(() => play(0), delayMs);
      clipTimers.push(tid);
    } else {
      play(-delayMs / 1000);
    }
  }

  function scheduleAllVoices(): void {
    const st = net.state;
    if (!st) return;
    for (const entry of clips) {
      if (entry.roundId === st.round.id && !entry.played) scheduleClip(entry);
    }
  }

  function stopVoices(): void {
    for (const tid of clipTimers) clearTimeout(tid);
    clipTimers = [];
    for (const s of activeSources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    activeSources = [];
    for (const entry of clips) {
      entry.el?.pause();
    }
  }

  // ====================================================================
  // flash / freeze
  // ====================================================================
  function flash(ms = 200): void {
    flashEl.classList.add('on');
    shutter();
    window.setTimeout(() => flashEl.classList.remove('on'), ms);
  }
  net.on('flash', () => flash(200));

  let freezeDataUrl: string | null = null;
  let freezeRound = -1;
  function captureFreeze(roundId: number, rollNumber: number, frameNumber: number): void {
    if (freezeRound === roundId) return;
    freezeRound = roundId;
    let src: CanvasImageSource;
    if (camLive() && camV.videoWidth > 0) {
      src = camV;
    } else {
      drawSimFilm(g, 30, rollNumber, frameNumber);
      src = fx;
    }
    const c = filmFilter(src, 1280);
    freezeDataUrl = c.toDataURL('image/jpeg', 0.8);
    net.send({ type: 'freeze', data: freezeDataUrl });
  }

  // ====================================================================
  // phase changes
  // ====================================================================
  let curPhase: Phase | null = null;
  let curRound = -1;
  let lastCctvAt = 0;
  let cctvPhaseStart = 0;
  let baseFailed = false;
  let rewindFailed = false;

  const hideAll = () => {
    for (const el of [baseV, rewindV, replayV, countdownBox, replayHud, cctv]) el.classList.add('hidden');
  };

  function sinkAll(): void {
    for (const el of [baseV, rewindV] as SinkEl[]) {
      if (sinkId && typeof el.setSinkId === 'function') el.setSinkId(sinkId === 'default' ? '' : sinkId).catch(() => {});
    }
  }

  function videoSrc(v: HTMLVideoElement, name: string): void {
    v.src = `/assets/${name}?v=${Date.now()}`;
    v.load();
  }

  async function onPhase(phase: Phase, fresh: boolean): Promise<void> {
    const st = net.state!;
    const roundId = st.round.id;
    const rollNo = st.round.rollNumber ?? net.config?.rollNumber ?? 1;
    const frmNo = st.round.frameNumber ?? 1;
    const elapsedSec = net.elapsedMs() / 1000;
    hideAll();

    switch (phase) {
      case 'IDLE':
        stopAllLoops();
        stopVoices();
        await stopRecording(false);
        baseV.pause();
        rewindV.pause();
        replayV.pause();
        void checkAssets();
        break;

      case 'ENTER_BUFFER':
        stopAllLoops();
        stopVoices();
        if (clipsRoundId !== roundId) {
          clipsRoundId = roundId;
          clips = [];
        }
        prepMeta.textContent = `ROLL ${pad2(rollNo)} · FR ${pad2(frmNo)}A`;
        countdownBox.classList.remove('hidden');
        baseFailed = rewindFailed = false;
        await Promise.all([ensureCamera(), checkAssets()]);
        if (net.phase !== 'ENTER_BUFFER') break;
        if (assets.base) {
          videoSrc(baseV, 'base.mp4');
          baseV.currentTime = 0;
        }
        break;

      case 'ACTIVE_30S':
        enlargerTimer.start(0.85, 0.3);
        if (!camLive()) await ensureCamera();
        startRecording(roundId);
        if (assets.base && !baseFailed) {
          if (!baseV.src) videoSrc(baseV, 'base.mp4');
          baseV.classList.remove('hidden');
          if (elapsedSec > 0.3) baseV.currentTime = elapsedSec;
          baseV.play().catch(() => (baseFailed = true));
        }
        break;

      case 'FLASH_FREEZE':
        if (fresh && net.elapsedMs() < 600) flash(200);
        stopAllLoops();
        baseV.pause();
        captureFreeze(roundId, rollNo, frmNo);
        await stopRecording(true);
        if (assets.rewind) videoSrc(rewindV, 'rewind.mp4');
        break;

      case 'REWIND':
        stopAllLoops();
        rewindSfx(Math.max(0.3, net.remainingMs() / 1000));
        if (assets.rewind && !rewindFailed) {
          if (!rewindV.src) videoSrc(rewindV, 'rewind.mp4');
          rewindV.classList.remove('hidden');
          if (elapsedSec > 0.3) rewindV.currentTime = elapsedSec;
          rewindV.play().catch(() => (rewindFailed = true));
        }
        break;

      case 'REPLAY_TRUTH':
        // Total system silence: zero metronome, zero score, zero moralizing text — only visitor audioClips
        stopAllLoops();
        rewindV.pause();
        replayHud.classList.remove('hidden');
        if (replayUrl && replayRound === roundId) {
          replayV.src = replayUrl;
          replayV.classList.remove('hidden');
          try {
            if (elapsedSec > 0.5) replayV.currentTime = elapsedSec;
          } catch {
            /* webm may not be seekable */
          }
          replayV.play().catch(() => {});
        }
        scheduleAllVoices();
        break;

      case 'CCTV_REVEAL':
        stopAllLoops();
        stopVoices();
        replayV.pause();
        cctv.classList.remove('hidden');
        cctvRoll.textContent = `ROLL ${pad2(rollNo)}`;
        frameNo.textContent = `FRAME ${pad2(frmNo)}A`;
        cctvPhaseStart = Date.now();
        lastCctvAt = 0;
        cctvImg.classList.add('hidden');
        nosig.classList.add('hidden');
        if (freezeDataUrl && freezeRound === roundId) freezeImg.src = freezeDataUrl;
        else if (net.doorPhoto?.url) freezeImg.src = net.doorPhoto.url;
        else {
          const c = document.createElement('canvas');
          drawReferencePlate(c);
          freezeImg.src = c.toDataURL('image/jpeg', 0.8);
        }
        break;
    }
  }

  net.on('state', (m) => {
    const fresh = m.state !== curPhase || m.round.id !== curRound;
    if (!fresh) return;
    curPhase = m.state;
    curRound = m.round.id;
    void onPhase(m.state, true);
  });

  net.on('cctv', (m) => {
    if (net.phase !== 'CCTV_REVEAL') return;
    cctvImg.src = m.data;
    cctvImg.classList.remove('hidden');
    lastCctvAt = Date.now();
  });

  // ====================================================================
  // render loop
  // ====================================================================
  let lastDrift = 0;
  function frame(): void {
    const phase = net.phase;
    const t = net.storySec();
    const st = net.state;
    const rollNo = st?.round.rollNumber ?? net.config?.rollNumber ?? 1;
    const frmNo = st?.round.frameNumber ?? 1;

    switch (phase) {
      case 'IDLE':
        drawIdle(g, net.now(), rollNo);
        break;
      case 'ENTER_BUFFER': {
        drawIdle(g, net.now(), rollNo);
        const remain = Math.max(1, Math.ceil(net.remainingMs() / 1000 / net.timeScale));
        countdown.textContent = pad2(remain);
        break;
      }
      case 'ACTIVE_30S':
        if (!assets.base || baseFailed) {
          drawSimFilm(g, t, rollNo, frmNo);
        } else {
          clear(g);
          if (net.timeScale === 1 && performance.now() - lastDrift > 2000 && !baseV.paused) {
            lastDrift = performance.now();
            const want = net.elapsedMs() / 1000;
            if (Math.abs(baseV.currentTime - want) > 0.25 && want < (baseV.duration || 30)) baseV.currentTime = want;
          }
        }
        break;
      case 'REWIND':
        if (!assets.rewind || rewindFailed) drawRewind(g, net.elapsedMs() / Math.max(1, st?.phaseDurationMs || 3000), rollNo);
        else clear(g);
        break;
      case 'REPLAY_TRUTH': {
        if (!(replayUrl && replayRound === st?.round.id)) drawNoRecording(g);
        else clear(g);
        const tc = Math.min(30, Math.max(0, t)).toFixed(1).padStart(4, '0');
        replayHud.textContent = `ARCHIVAL PLAYBACK · ROLL ${pad2(rollNo)} · FR ${pad2(frmNo)}A · 00:${tc}`;
        break;
      }
      case 'CCTV_REVEAL': {
        clear(g);
        const now = Date.now();
        const firstWait = Math.min(1200, (st?.phaseDurationMs || 8000) * 0.2);
        const noFrames = lastCctvAt === 0 ? now - cctvPhaseStart > firstWait : now - lastCctvAt > 2000;
        nosig.classList.toggle('hidden', !noFrames);
        cctvClock.textContent = new Date(net.now()).toLocaleTimeString('en-GB', { hour12: false });
        if (noFrames) cctvImg.classList.add('hidden');
        break;
      }
      default:
        clear(g);
    }
    requestAnimationFrame(frame);
  }

  // ====================================================================
  // setup panel
  // ====================================================================
  await setupPanel();
  net.connect();
  requestAnimationFrame(frame);

  window.addEventListener('keydown', (e) => {
    if (e.key === 's' || e.key === 'S') void setupPanel();
    if (e.key === 'f' || e.key === 'F') void requestFullscreen();
  });

  function setupPanel(): Promise<void> {
    return new Promise((resolve) => {
      document.querySelector('.setup')?.remove();
      const el = document.createElement('div');
      el.className = 'setup';
      el.innerHTML = `
        <div class="ticket">
          <div class="head"><h2><small>RUHUA FILM LAB · ARCHIVAL TICKET · PROJ /main</small>Main projector<br>setup</h2><span class="stamp double">Pre-flight</span></div>
          <div class="fields">
            <label><span class="no">01 / CAMERA</span>Choose the external USB wide-angle camera<select id="camSel"></select></label>
            <label><span class="no">02 / AUDIO OUT</span>Audio output device<select id="sinkSel"></select></label>
            <div class="assets" id="assetInfo"></div>
            <div class="hint">While running: press S to reopen this panel, F for fullscreen.</div>
          </div>
          <div class="fields">
            <div class="pv"><video id="pv" muted playsinline autoplay></video>${cropMarks()}<span class="mono">PREVIEW · CAM</span></div>
            <div class="row">
              <button id="refresh" type="button">Refresh devices</button>
              <button class="primary" id="go" type="button">Unlock audio/video &amp; go fullscreen</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(el);
      const camSel = el.querySelector('#camSel') as HTMLSelectElement;
      const sinkSel = el.querySelector('#sinkSel') as HTMLSelectElement;
      const pv = el.querySelector('#pv') as HTMLVideoElement;
      const info = el.querySelector('#assetInfo') as HTMLDivElement;
      updateAssetInfo = () => {
        info.innerHTML =
          `<b>base.mp4</b> ··· ${assets.base ? '<span class="ok">FOUND</span>' : '<span class="warn">STANDBY → architectural daylight plate</span>'}<br>` +
          `<b>rewind.mp4</b> ··· ${assets.rewind ? '<span class="ok">FOUND</span>' : '<span class="warn">STANDBY → motorized transport</span>'}`;
      };
      void checkAssets();

      async function fill(): Promise<void> {
        try {
          let devs = await navigator.mediaDevices.enumerateDevices();
          if (!devs.some((d) => d.kind === 'videoinput' && d.label)) {
            const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
            tmp?.getTracks().forEach((t) => t.stop());
            devs = await navigator.mediaDevices.enumerateDevices();
          }
          const cams = devs.filter((d) => d.kind === 'videoinput');
          camSel.innerHTML = '';
          cams.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `Camera ${i + 1}`;
            camSel.appendChild(o);
          });
          if (!cams.length) camSel.innerHTML = '<option value="">(no camera detected)</option>';
          const saved = cams.find((d) => d.deviceId === camId);
          const external = cams.find((d) => !/facetime|built-?in|integrated|\u5185\u5efa/i.test(d.label));
          camSel.value = (saved || external || cams[0])?.deviceId || '';

          const sinks = devs.filter((d) => d.kind === 'audiooutput');
          sinkSel.innerHTML = '';
          const canSink = typeof (audioCtx() as any).setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
          if (!canSink || !sinks.length) {
            sinkSel.innerHTML = '<option value="">System default output (this browser cannot choose an output)</option>';
          } else {
            sinks.forEach((d, i) => {
              const o = document.createElement('option');
              o.value = d.deviceId;
              o.textContent = d.label || `Output ${i + 1}`;
              sinkSel.appendChild(o);
            });
            if (sinks.some((d) => d.deviceId === sinkId)) sinkSel.value = sinkId;
          }
          await preview();
        } catch (err) {
          info.innerHTML += `<br>Device enumeration failed: ${(err as Error).message} (HTTPS required)`;
        }
      }

      async function preview(): Promise<void> {
        camId = camSel.value;
        const s = await openCamera(camId);
        pv.srcObject = s;
        pv.play().catch(() => {});
      }

      camSel.addEventListener('change', () => void preview());
      (el.querySelector('#refresh') as HTMLButtonElement).addEventListener('click', () => void fill());
      (el.querySelector('#go') as HTMLButtonElement).addEventListener('click', async () => {
        const fsP = requestFullscreen();
        const auP = unlockAudio();
        void keepAwake();
        camId = camSel.value;
        sinkId = sinkSel.value;
        localStorage.setItem(LS_CAM, camId);
        localStorage.setItem(LS_SINK, sinkId);
        await Promise.allSettled([withTimeout(fsP), withTimeout(auP)]);
        if (sinkId) await withTimeout(setAudioSink(sinkId));
        sinkAll();
        for (const v of [baseV, rewindV, replayV]) {
          v.muted = v === replayV;
          v.play().catch(() => {});
          v.pause();
        }
        if (!camLive()) await withTimeout(openCamera(camId), 1500);
        pv.srcObject = null;
        el.remove();
        updateAssetInfo = null;
        resolve();
      });
      void fill();
    });
  }
}
