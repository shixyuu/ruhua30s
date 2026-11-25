/**
 * /door — tablet 1: entrance darkroom screen (display only)
 * - Never asks for the microphone and detects nothing; only /admin starts a round.
 * - During CCTV_REVEAL it optionally opens the front camera and pushes 3–4 FPS mono frames; any failure is skipped silently.
 */
import { Net, mountNetDot } from '../lib/net';
import { cctvFrame, drawDefaultDoorPhoto } from '../lib/media';
import { cropMarks, filmStrip, showStartOverlay } from '../lib/unlock';
import { TITLE_EN } from '../lib/brand';
import type { Phase } from '../../../shared/protocol';

const CAPTION_T = 'Node time 00:30';
const CAPTION = 'An anomalous shadow collapsed the frame';
const CCTV_INTERVAL_MS = 280; // ~3.6 FPS

export default async function door(app: HTMLElement): Promise<void> {
  document.title = `Entrance · ${TITLE_EN}`;
  app.innerHTML = `
    <canvas class="layer door-photo" id="def"></canvas>
    <img class="layer door-photo hidden" id="photo" alt="" />
    <div class="door-shade"></div>
    <div class="door-crops">${cropMarks()}</div>
    <div class="door-edge">${filmStrip(7, 'v')}</div>
    <div class="door-msg" id="msg"><small>ENTRANCE · T-01</small><span id="msgText"><span class="l1">LIFT THE CURTAIN</span><span class="sep"> · </span><span class="l2">STEP INTO THE PHOTOGRAPH</span></span></div>
    <div class="door-standby" id="standby"><span>SHOOTING IN PROGRESS · PLEASE WAIT</span></div>
    <div class="door-caption" id="cap"><div class="tag" id="tag"></div><div class="line" id="capLine"></div></div>`;
  const def = app.querySelector('#def') as HTMLCanvasElement;
  const photo = app.querySelector('#photo') as HTMLImageElement;
  const msg = app.querySelector('#msg') as HTMLDivElement;
  const standby = app.querySelector('#standby') as HTMLDivElement;
  const cap = app.querySelector('#cap') as HTMLDivElement;
  const tag = app.querySelector('#tag') as HTMLDivElement;
  (app.querySelector('#capLine') as HTMLDivElement).innerHTML = `<span class="t">${CAPTION_T.toUpperCase()}</span> · ${CAPTION.toUpperCase()}`;
  drawDefaultDoorPhoto(def);

  const net = new Net('door');
  (window as any).__net = net; // debugging / automated tests

  // ---------------- negative display ----------------
  let showingUrl: string | null = null;
  const applyPhoto = () => {
    const p = net.doorPhoto;
    if (p?.has && p.url) {
      if (showingUrl !== p.url) {
        showingUrl = p.url;
        const pre = new Image();
        pre.onload = () => {
          if (showingUrl !== p.url) return;
          photo.src = p.url!;
          photo.classList.remove('hidden');
          def.classList.add('hidden');
        };
        pre.onerror = () => {
          photo.classList.add('hidden');
          def.classList.remove('hidden');
        };
        pre.src = p.url;
      }
    } else {
      showingUrl = null;
      drawDefaultDoorPhoto(def);
      photo.classList.add('hidden');
      def.classList.remove('hidden');
    }
  };

  const render = (phase: Phase) => {
    const dim = phase !== 'IDLE' && phase !== 'CCTV_REVEAL';
    for (const el of [photo, def]) el.classList.toggle('dim', dim);
    msg.classList.toggle('show', phase === 'ENTER_BUFFER');
    standby.classList.toggle('show', ['ACTIVE_30S', 'FLASH_FREEZE', 'REWIND', 'REPLAY_TRUTH'].includes(phase));
    cap.style.opacity = phase === 'IDLE' ? '1' : '0';
    const p = net.doorPhoto;
    const fr = String(net.round?.id ?? 0).padStart(2, '0');
    tag.innerHTML = p?.has
      ? `<span class="fr">FR ${fr}A</span><span>RH-30 · ENTRANCE NEGATIVE</span><span>EXPOSED ${new Date(p.version).toLocaleTimeString('en-GB', { hour12: false })}</span>`
      : '<span class="fr">FR 00</span><span>RH-30 · ENTRANCE NEGATIVE</span><span>DEFAULT PLATE</span>';
    if (phase === 'CCTV_REVEAL') startCctv();
    else stopCctv();
  };

  // ---------------- optional front-camera CCTV feed (CCTV_REVEAL only) ----------------
  let stream: MediaStream | null = null;
  let camVideo: HTMLVideoElement | null = null;
  let timer: number | null = null;
  let starting = false;
  const frameCanvas = document.createElement('canvas');

  async function startCctv(): Promise<void> {
    if (timer || starting) return;
    starting = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
        audio: false,
      });
      if (net.phase !== 'CCTV_REVEAL') return stopCctv();
      camVideo = document.createElement('video');
      camVideo.muted = true;
      camVideo.playsInline = true;
      camVideo.setAttribute('playsinline', '');
      camVideo.srcObject = stream;
      await camVideo.play();
      timer = window.setInterval(() => {
        try {
          if (!camVideo || camVideo.readyState < 2 || net.phase !== 'CCTV_REVEAL') return;
          if (net.buffered() > 256 * 1024) return; // back-pressure on weak networks: drop the frame
          cctvFrame(camVideo, frameCanvas, 'CAM-01 ENTRANCE');
          net.send({ type: 'cctv', data: frameCanvas.toDataURL('image/jpeg', 0.5) });
        } catch {
          /* silent */
        }
      }, CCTV_INTERVAL_MS);
    } catch {
      // no camera / permission denied / anything else: skip silently, display is unaffected
      stopCctv();
    } finally {
      starting = false;
    }
  }

  function stopCctv(): void {
    if (timer) clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (camVideo) camVideo.srcObject = null;
    camVideo = null;
  }

  net.on('state', (m) => render(m.state));
  net.on('door-photo', () => {
    applyPhoto();
    render(net.phase);
  });
  net.on('open', applyPhoto);
  net.on('state', applyPhoto);
  mountNetDot(net);

  await showStartOverlay({
    code: 'T-01',
    kicker: '/door',
    title: 'Entrance darkroom screen',
    subtitle: 'Tap to go fullscreen and keep the screen awake.\nDisplay only. No microphone needed.',
    button: 'Tap to start',
  });
  net.connect();
  render(net.phase);
}
