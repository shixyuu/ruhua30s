import { filmStrip } from '../lib/unlock';
import { LOGO_CJK, TITLE_EN } from '../lib/brand';

export default function home(app: HTMLElement): void {
  document.body.classList.add('scrollable');
  document.title = TITLE_EN;
  app.style.position = 'static';
  const rows: [string, string, string][] = [
    ['/main', 'Main projector · Mac + wide-angle USB camera', 'PROJ'],
    ['/door', 'Tablet 1 · Entrance 35mm contact sheet', 'T-01'],
    ['/station1', 'Tablet 2 · South-west vocal & dodging terminal', 'T-02'],
    ['/station2', 'Tablet 3 · North-west dodging & fixation fader', 'T-03'],
    ['/admin', 'Control desk · Operator shutter & roll management', 'DESK'],
  ];
  const today = new Date();
  const dd = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getFullYear()).slice(2)}`;
  app.innerHTML = `
  <div class="home-desk">
    ${filmStrip(1)}
    <div class="home">
      <div class="home-head">
        <span class="kick">RH-30 · Archival apparatus</span>
        <span class="stamp seal cjk" aria-hidden="true">${LOGO_CJK}</span>
        <h1>Thirty<br>seconds<small>into the <em>frame</em></small></h1>
        <p>An archival darkroom and collective optical-dodging installation for 3–5 simultaneous visitors.</p>
        <div class="note">All five terminals synchronize to the server clock. Exposure rounds are released exclusively by the operator at the control desk.</div>
      </div>
      <div class="envelope">
        <div class="flap"></div>
        <div class="eh"><h2>Ruhua Film Lab<br>Archival dossier</h2><span class="no">№ 030</span></div>
        <div class="fields">
          <div class="field"><span class="k">Protocol</span><span class="v">RH-30 · V2</span></div>
          <div class="field"><span class="k">Emulsion</span><span class="v">SILVER B&amp;W</span></div>
          <div class="field"><span class="k">Date</span><span class="v">${dd}</span></div>
          <div class="field"><span class="k">Format</span><span class="v">135 · CONTACT</span></div>
          <div class="field"><span class="k">Capacity</span><span class="v">3–5 VISITORS</span></div>
          <div class="field"><span class="k">Exposure</span><span class="v">00:30.0</span></div>
        </div>
        <nav class="dir">
          ${rows.map(([r, d, n]) => `<a href="${r}"><span class="r">${r}</span><span class="d">${d}</span><span class="n">${n}</span></a>`).join('')}
        </nav>
        <div class="envelope-foot">
          <span class="stamp double">Archival</span>
          <span class="stamp b">Verified</span>
        </div>
      </div>
      <aside class="chart">
        <h3>Protocol schedule</h3>
        <table>
          <tr><td>BUF</td><td>Collective entry</td><td>6 S</td></tr>
          <tr class="on"><td>P01</td><td>Vocal calibration</td><td>04–16</td></tr>
          <tr><td>P02</td><td>Optical dodging</td><td>08–25</td></tr>
          <tr><td>P03</td><td>Fixation fader</td><td>21–30</td></tr>
          <tr><td>REV</td><td>Playback · Contact</td><td>+38 S</td></tr>
        </table>
        <p>Overlapping protocols allow 3–5 visitors in NB109 to divide roles freely across the 30-second exposure.</p>
      </aside>
    </div>
    ${filmStrip(21, 'bottom')}
  </div>`;
}
