import { LOGO_CJK, TITLE_EN } from '../lib/brand';

export default function home(app: HTMLElement): void {
  document.body.classList.add('scrollable');
  document.title = TITLE_EN;
  app.style.position = 'static';

  const routes: [string, string, string][] = [
    ['/main', 'Enlarger projector · Mac + USB wide-angle camera', 'PROJ'],
    ['/door', 'Entrance screen · Upload QR & contact sheet', 'T-01'],
    ['/station1', 'SW terminal · Acoustic developer needle gauge', 'T-02'],
    ['/station2', 'NW terminal · Vertical fixation fader', 'T-03'],
    ['/upload', 'Audience phone · Upload photograph for next exposure', 'U-01'],
    ['/admin', 'Mobile control desk · Shutter, calibration & Instax print', 'DESK'],
  ];

  app.innerHTML = `
  <div class="home-v3">
    <header class="hv3-head">
      <div class="hv3-kicker">RH-30 · LIVE DARKROOM ENGINE (V3)</div>
      <div class="hv3-title-row">
        <h1>THIRTY SECONDS INTO THE FRAME</h1>
        <span class="hv3-seal cjk" aria-hidden="true">${LOGO_CJK}</span>
      </div>
      <p>Live architectural photogram &amp; acoustic developing apparatus. Zero pre-recorded media.</p>
    </header>
    <nav class="hv3-nav">
      ${routes
        .map(
          ([path, desc, code]) =>
            `<a href="${path}"><span class="code mono">${code}</span><span class="path mono">${path}</span><span class="desc">${desc}</span></a>`,
        )
        .join('')}
    </nav>
    <footer class="hv3-foot mono">
      <span>CAPTURE_CLEAN → 01 OBSERVE → 02 EXPOSE → 03 DEVELOP → 04 REVEAL</span>
    </footer>
  </div>`;
}
