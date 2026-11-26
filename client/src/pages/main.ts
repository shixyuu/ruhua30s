/**
 * /main — Mac + projector + wide-angle USB camera (v3 Live Darkroom & Temporal Extrapolation Engine)
 * - 92%+ pure darkroom optical imagery; zero center arrow overlays or corner badges.
 * - Minimalist single-row bottom darkroom timeline bar (56px, hidden in IDLE) with 4 steps + live action prompt.
 * - Exported Instax / archive JPEGs render from offscreen exportCanvas and NEVER include the bottom timeline UI.
 */
import { Net, mountNetDot, triggerFlashPulse } from '../lib/net';
import {
  audioCtx,
  devBathAudio,
  enlargerTimer,
  lightLeakBurst,
  relayClick,
  safelightClick,
  setAudioSink,
  shutter,
  stopAllLoops,
  stopBathThud,
  unlockAudio,
} from '../lib/sfx';
import {
  DarkroomEngine,
  drawExposureBeam,
  drawIdleDarkroom,
  drawSafelightField,
  setupCanvas,
} from '../lib/darkroom';
import { keepAwake, requestFullscreen, withTimeout } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import { outcomeFullLabel, outcomeShortCode } from '../../../shared/protocol';
import type { Phase, PrintMode } from '../../../shared/protocol';

const LS_CAM = 'ruhua.main.camera';
const LS_SINK = 'ruhua.main.sink';
const SAMPLE_INTERVAL_MS = 55; // ~18 FPS live exposure sampling

function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export default async function mainPage(app: HTMLElement): Promise<void> {
  document.title = `Enlarger Projector · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer" id="fx"></canvas>
    <div class="main-countdown hidden" id="countdownBox"><span id="countdown">5</span></div>
    <footer class="main-timeline hidden" id="timelineBar" aria-hidden="true">
      <div class="tl-steps">
        <div class="tl-seg" id="segCompose"><span>01 COMPOSE</span><div class="tl-fill"></div></div>
        <div class="tl-seg" id="segExpose"><span>02 EXPOSE</span><div class="tl-fill" id="expFill"></div></div>
        <div class="tl-seg" id="segDevelop"><span>03 DEVELOP</span><div class="tl-fill" id="devFill"></div></div>
        <div class="tl-seg" id="segFixed"><span>04 FIXED</span><div class="tl-fill"></div></div>
      </div>
      <div class="tl-prompt" id="tlPrompt">STEP INTO POSITION</div>
    </footer>
    <video id="cam" class="hidden" muted playsinline autoplay></video>
    <video id="pastVid" class="hidden" muted playsinline></video>`;

  const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
  const fx = $<HTMLCanvasElement>('#fx');
  const g = setupCanvas(fx);
  const countdownBox = $<HTMLDivElement>('#countdownBox');
  const countdown = $<HTMLSpanElement>('#countdown');
  const timelineBar = $<HTMLElement>('#timelineBar');
  const segCompose = $<HTMLDivElement>('#segCompose');
  const segExpose = $<HTMLDivElement>('#segExpose');
  const segDevelop = $<HTMLDivElement>('#segDevelop');
  const segFixed = $<HTMLDivElement>('#segFixed');
  const expFill = $<HTMLDivElement>('#expFill');
  const devFill = $<HTMLDivElement>('#devFill');
  const tlPrompt = $<HTMLDivElement>('#tlPrompt');
  const camV = $<HTMLVideoElement>('#cam');
  const pastVid = $<HTMLVideoElement>('#pastVid');

  const engine = new DarkroomEngine();
  const net = new Net('main');
  (window as any).__net = net;
  mountNetDot(net);

  // ====================================================================
  // camera & audio sink
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
  // Recursive Past local MediaRecorder & Forecast image preloading
  // ====================================================================
  let lastRoundVideoUrl: string | null = null;
  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let trackedRollNumber: number | null = null;

  let safelightForecastImg: HTMLImageElement | null = null;
  let predictedRevealImg: HTMLImageElement | null = null;

  function loadImg(url: string | null | undefined): HTMLImageElement | null {
    if (!url) return null;
    const img = new Image();
    img.src = url;
    return img;
  }

  function clearRollMemory(): void {
    stopPastRecorder(false);
    if (lastRoundVideoUrl) {
      URL.revokeObjectURL(lastRoundVideoUrl);
      lastRoundVideoUrl = null;
    }
    pastVid.pause();
    pastVid.removeAttribute('src');
    pastVid.load();
    safelightForecastImg = null;
    predictedRevealImg = null;
    engine.resetMemory();
  }

  function startPastRecorder(): void {
    stopPastRecorder(false);
    if (typeof MediaRecorder === 'undefined') return;
    const stream = camLive() ? camStream : engine.getSimulatedStream(20);
    if (!stream) return;
    try {
      const mimeType = pickRecorderMime();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recChunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
      };
      recorder.start(250);
    } catch (err) {
      console.warn('MediaRecorder unavailable', err);
      recorder = null;
      recChunks = [];
    }
  }

  function stopPastRecorder(save: boolean): void {
    const rec = recorder;
    recorder = null;
    if (!rec) return;
    if (!save) {
      rec.onstop = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* ignore */
      }
      recChunks = [];
      return;
    }
    const chunksRef = recChunks;
    recChunks = [];
    const mime = rec.mimeType || 'video/webm';
    const commit = () => {
      if (!chunksRef.length) return;
      const blob = new Blob(chunksRef, { type: mime });
      if (blob.size < 256) return;
      if (lastRoundVideoUrl) URL.revokeObjectURL(lastRoundVideoUrl);
      lastRoundVideoUrl = URL.createObjectURL(blob);
    };
    if (rec.state === 'inactive') {
      commit();
    } else {
      rec.onstop = commit;
      try {
        rec.stop();
      } catch {
        commit();
      }
    }
  }

  // Test flash audio sync (shared flash overlay itself is mounted by mountNetDot)
  net.on('FLASH_PULSE', () => {
    try {
      shutter();
    } catch {
      /* ignore if audio locked */
    }
  });

  // ====================================================================
  // exposure sampler & developing state
  // ====================================================================
  let sampleTimer: number | null = null;
  let liveDevProgress = 0;
  let frozenDevProgress = 0;
  let frozenDeviationPct: number | null = null;
  let activePrintMode: PrintMode = 'photogram_negative';
  let freezeUploadedRound = -1;
  let devWarnTickStarted = false;

  function stopSampler(): void {
    if (sampleTimer !== null) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
  }

  function startSampler(roundId: number): void {
    stopSampler();
    engine.beginExposure(roundId);
    const sampleOnce = () => {
      if (net.phase !== 'EXPOSURE') return stopSampler();
      const totalSec = net.config?.exposureSec ?? 15;
      const elapsedSec = net.storySec();
      engine.sampleExposureFrame(camLive() ? camV : null, elapsedSec, totalSec);
    };
    sampleOnce();
    sampleTimer = window.setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
  }

  net.on('dev', (m) => {
    liveDevProgress = m.devProgress;
    if (net.phase === 'DEVELOPING') {
      devBathAudio.update(liveDevProgress);
    }
  });

  // ====================================================================
  // phase changes
  // ====================================================================
  let curPhase: Phase | null = null;
  let curRound = -1;

  function setActiveSegment(seg: HTMLDivElement | null, stateCls = ''): void {
    for (const s of [segCompose, segExpose, segDevelop, segFixed]) {
      s.classList.remove('active', 'done', 'gold', 'burn');
    }
    const order = [segCompose, segExpose, segDevelop, segFixed];
    const idx = seg ? order.indexOf(seg) : -1;
    order.forEach((s, i) => {
      if (idx > i) s.classList.add('done');
      if (idx === i) {
        s.classList.add('active');
        if (stateCls) s.classList.add(stateCls);
      }
    });
  }

  async function onPhase(phase: Phase, fresh: boolean, prevPhase: Phase | null): Promise<void> {
    const st = net.state!;
    const roundId = st.round.id;
    const isSeed = st.round.frameNumber === 0;
    activePrintMode = st.round.printMode ?? net.config?.printMode ?? 'photogram_negative';
    countdownBox.classList.add('hidden');
    stopSampler();
    devWarnTickStarted = false;
    if (phase !== 'EXPOSURE') {
      stopPastRecorder(phase === 'DEVELOPING' || phase === 'LIGHT_LEAK' || phase === 'FIXED_REVEAL');
      pastVid.pause();
    }

    switch (phase) {
      case 'IDLE':
        stopAllLoops();
        timelineBar.classList.add('hidden');
        break;

      case 'ENTER_BUFFER':
        stopAllLoops();
        liveDevProgress = 0;
        frozenDeviationPct = null;
        if (!isSeed) {
          safelightForecastImg = loadImg(st.forecast?.has ? st.forecast.url : st.round.predictedUrl);
          predictedRevealImg = loadImg(st.round.predictedUrl || (st.forecast?.has ? st.forecast.url : null));
        } else {
          safelightForecastImg = null;
          predictedRevealImg = null;
        }
        timelineBar.classList.add('hidden');
        countdownBox.classList.remove('hidden');
        await ensureCamera();
        break;

      case 'SAFELIGHT_COMPOSE':
        stopAllLoops();
        if (fresh) safelightClick();
        if (!isSeed) {
          safelightForecastImg = loadImg(st.forecast?.has ? st.forecast.url : st.round.predictedUrl);
          predictedRevealImg = loadImg(st.round.predictedUrl || (st.forecast?.has ? st.forecast.url : null));
        } else {
          safelightForecastImg = null;
          predictedRevealImg = null;
        }
        timelineBar.classList.remove('hidden');
        setActiveSegment(segCompose);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = isSeed ? 'SEED 00A · STEP INTO POSITION' : 'STEP INTO POSITION';
        await ensureCamera();
        break;

      case 'EXPOSURE':
        stopAllLoops();
        if (fresh) relayClick(true);
        enlargerTimer.start(0.85, 0.1, 1.0);
        timelineBar.classList.remove('hidden');
        setActiveSegment(segExpose);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = 'ALTER FRAME WITH BOARDS & FILMS';
        if (!isSeed && lastRoundVideoUrl) {
          pastVid.src = lastRoundVideoUrl;
          pastVid.currentTime = 0;
          void pastVid.play().catch(() => {});
        }
        await ensureCamera();
        if (net.phase === 'EXPOSURE') {
          startSampler(roundId);
          startPastRecorder();
        }
        break;

      case 'DEVELOPING':
        enlargerTimer.stop();
        if (fresh) relayClick(false);
        engine.finalizeLatent();
        liveDevProgress = st.round.devProgress ?? 0;
        timelineBar.classList.remove('hidden');
        devBathAudio.start();
        devBathAudio.update(liveDevProgress);
        break;

      case 'LIGHT_LEAK':
        stopAllLoops();
        engine.finalizeLatent();
        frozenDevProgress = st.round.finalDevProgress ?? st.round.devProgress ?? liveDevProgress;
        if (fresh) lightLeakBurst();
        timelineBar.classList.remove('hidden');
        setActiveSegment(segDevelop, 'burn');
        tlPrompt.className = 'tl-prompt burn';
        tlPrompt.textContent = 'UNFIXED · LIGHT LEAK — IMAGE DESTROYED';
        break;

      case 'FIXED_REVEAL': {
        stopAllLoops();
        engine.finalizeLatent();
        frozenDevProgress = st.round.finalDevProgress ?? st.round.devProgress ?? liveDevProgress;
        const outcome = st.round.outcome ?? (prevPhase === 'LIGHT_LEAK' ? 'UNFIXED_LIGHT_LEAK' : 'FIXED_OPTIMAL');
        const isLeak = outcome === 'UNFIXED_LIGHT_LEAK' || prevPhase === 'LIGHT_LEAK';
        if (fresh && !isLeak) {
          if (outcome === 'FIXED_OPTIMAL') {
            shutter();
            triggerFlashPulse(0.45, 70, 120);
          } else {
            stopBathThud();
            triggerFlashPulse(0.22, 50, 90);
          }
        }
        const jpegData = engine.exportCleanJpeg(frozenDevProgress, activePrintMode, isLeak);
        if (!isSeed && st.round.predictedUrl && !predictedRevealImg) {
          predictedRevealImg = loadImg(st.round.predictedUrl);
        }
        frozenDeviationPct = isSeed ? null : (st.round.deviationPct ?? engine.computeDeviationPct(predictedRevealImg));
        const { forecastDataUrl, collapseZone } = engine.computeAndExportForecast(isSeed, frozenDevProgress);
        if (freezeUploadedRound !== roundId) {
          freezeUploadedRound = roundId;
          net.send({
            type: 'freeze',
            data: jpegData,
            forecastData: forecastDataUrl,
            collapseZone,
            deviationPct: frozenDeviationPct,
          });
        }
        timelineBar.classList.remove('hidden');
        setActiveSegment(segFixed);
        tlPrompt.className = 'tl-prompt';
        tlPrompt.textContent = isSeed
          ? 'SEED 00A BASELINE ESTABLISHED · EXIT NORTH ↑'
          : `${outcomeShortCode(outcome)} · EXPOSURE LOCKED · EXIT NORTH ↑`;
        break;
      }
    }
  }

  net.on('config', (m) => {
    if (trackedRollNumber !== null && m.config.rollNumber !== trackedRollNumber) {
      clearRollMemory();
    }
    trackedRollNumber = m.config.rollNumber;
  });

  net.on('contact-sheet', (m) => {
    if (m.sheet.totalInRoll === 0 && net.phase === 'IDLE' && lastRoundVideoUrl !== null) {
      clearRollMemory();
    }
  });

  net.on('state', (m) => {
    if (trackedRollNumber !== null && m.round.rollNumber !== trackedRollNumber) {
      clearRollMemory();
    }
    trackedRollNumber = m.round.rollNumber;
    activePrintMode = m.round.printMode ?? net.config?.printMode ?? activePrintMode;
    const fresh = m.state !== curPhase || m.round.id !== curRound;
    if (!fresh) return;
    const prev = curPhase;
    curPhase = m.state;
    curRound = m.round.id;
    void onPhase(m.state, true, prev);
  });

  // ====================================================================
  // render loop
  // ====================================================================
  function frame(): void {
    const phase = net.phase;
    const st = net.state;
    const isSeed = (st?.round.frameNumber ?? 0) === 0;
    switch (phase) {
      case 'IDLE':
        drawIdleDarkroom(g, net.now());
        break;

      case 'ENTER_BUFFER': {
        drawIdleDarkroom(g, net.now());
        const remain = Math.max(1, Math.ceil(net.remainingMs() / 1000 / net.timeScale));
        countdown.textContent = String(remain);
        break;
      }

      case 'SAFELIGHT_COMPOSE': {
        const cz = isSeed ? null : (st?.round.collapseZone ?? st?.forecast?.collapseZone ?? null);
        drawSafelightField(g, isSeed ? null : safelightForecastImg, cz);
        break;
      }

      case 'EXPOSURE': {
        const pastOpacity = net.config?.pastOpacity ?? 0.48;
        drawExposureBeam(g, !isSeed && lastRoundVideoUrl ? pastVid : null, pastOpacity);
        const total = Math.max(1, net.config?.exposureSec ?? 15);
        const frac = Math.max(0, Math.min(1, net.storySec() / total));
        expFill.style.width = `${(frac * 100).toFixed(1)}%`;
        break;
      }

      case 'DEVELOPING': {
        engine.renderPrint(g, g.canvas.width, g.canvas.height, liveDevProgress, activePrintMode, 0.93);
        const remainSec = Math.max(0, net.remainingMs() / 1000 / net.timeScale);
        devFill.style.width = `${Math.min(100, (liveDevProgress / 1.2) * 100).toFixed(1)}%`;

        if (remainSec > 0 && remainSec <= 6) {
          setActiveSegment(segDevelop, 'burn');
          tlPrompt.className = 'tl-prompt burn';
          tlPrompt.textContent = `LIGHT LEAK IN ${Math.ceil(remainSec)}s — PULL FIX NOW →`;
        } else if (liveDevProgress > 1.0) {
          setActiveSegment(segDevelop, 'burn');
          tlPrompt.className = 'tl-prompt burn';
          tlPrompt.textContent = 'BURNING — PULL FIX NOW →';
        } else if (liveDevProgress >= 0.72) {
          setActiveSegment(segDevelop, 'gold');
          tlPrompt.className = 'tl-prompt gold';
          tlPrompt.textContent = 'OPTIMAL — PULL FIX AT RIGHT NOW →';
        } else if (liveDevProgress >= 0.25) {
          setActiveSegment(segDevelop);
          tlPrompt.className = 'tl-prompt';
          tlPrompt.textContent = 'KEEP DEVELOPING · PREPARE RIGHT LEVER';
        } else {
          setActiveSegment(segDevelop);
          tlPrompt.className = 'tl-prompt';
          tlPrompt.textContent = 'MAKE NOISE AT LEFT TO DEVELOP';
        }

        if (!devWarnTickStarted && remainSec > 0 && remainSec <= 5.0) {
          devWarnTickStarted = true;
          enlargerTimer.start(0.32, 0.06, 0.5);
        }
        break;
      }

      case 'LIGHT_LEAK':
        engine.renderLightLeak(g, g.canvas.width, g.canvas.height, net.storySec(), frozenDevProgress, activePrintMode);
        break;

      case 'FIXED_REVEAL': {
        if (isSeed) {
          engine.renderPrint(g, g.canvas.width, g.canvas.height, frozenDevProgress, activePrintMode, 1.0);
        } else {
          const frNo = `${pad2(st?.round.frameNumber ?? 1)}A`;
          const devPct = Math.round(frozenDevProgress * 100);
          const outcome = st?.round.outcome ?? 'FIXED_OPTIMAL';
          const devVal = frozenDeviationPct ?? st?.round.deviationPct ?? null;
          engine.drawSideBySideReveal(
            g,
            predictedRevealImg,
            frNo,
            outcomeFullLabel(outcome),
            devPct,
            devVal,
            outcome === 'UNDERDEVELOPED_TRACE_LOST',
          );
        }
        break;
      }
    }
    requestAnimationFrame(frame);
  }

  // ====================================================================
  // setup panel (S reopens, F fullscreen)
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
          <div class="head">
            <h2><small>RH-30 · LIVE ENLARGER · /main</small>Main projector setup</h2>
            <span class="mono">S = SETUP · F = FULLSCREEN</span>
          </div>
          <div class="fields">
            <label><span class="no">01 / CAMERA</span>External USB wide-angle camera<select id="camSel"></select></label>
            <label><span class="no">02 / AUDIO OUT</span>Audio output device<select id="sinkSel"></select></label>
            <div class="hint" id="camHint">Camera stream stays strictly local for live photogram accumulation &amp; recursive past overlay.</div>
          </div>
          <div class="fields">
            <div class="pv"><video id="pv" muted playsinline autoplay></video><span class="mono">LIVE CAMERA PREVIEW</span></div>
            <div class="row">
              <button id="refresh" type="button">Refresh devices</button>
              <button class="primary" id="go" type="button">UNLOCK &amp; GO FULLSCREEN</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(el);
      const camSel = el.querySelector('#camSel') as HTMLSelectElement;
      const sinkSel = el.querySelector('#sinkSel') as HTMLSelectElement;
      const pv = el.querySelector('#pv') as HTMLVideoElement;
      const hint = el.querySelector('#camHint') as HTMLDivElement;

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
          if (!cams.length) camSel.innerHTML = '<option value="">(no camera detected — procedural simulation active)</option>';
          const saved = cams.find((d) => d.deviceId === camId);
          const external = cams.find((d) => !/facetime|built-?in|integrated|\u5185\u5efa/i.test(d.label));
          camSel.value = (saved || external || cams[0])?.deviceId || '';

          const sinks = devs.filter((d) => d.kind === 'audiooutput');
          sinkSel.innerHTML = '';
          const canSink = typeof (audioCtx() as any).setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
          if (!canSink || !sinks.length) {
            sinkSel.innerHTML = '<option value="">System default output</option>';
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
          hint.textContent = `Device enumeration failed: ${(err as Error).message} (HTTPS required)`;
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
        if (!camLive()) await withTimeout(openCamera(camId), 1500);
        pv.srcObject = null;
        el.remove();
        resolve();
      });
      void fill();
    });
  }
}
