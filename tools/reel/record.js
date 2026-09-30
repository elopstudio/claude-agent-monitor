// Records reel.html (served by demo-server.js) to an MP4: 1080×1920, 30 fps, H.264 — the Instagram reel.
// Frames come from Electron's offscreen rendering and go straight to ffmpeg; a few stills are kept for checking.
//   cd tools/reel && npm install && npm run record      →  out/reel.mp4, out/stills/
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(__dirname, 'out', 'profile'));   // a clean profile: no zoom remembered for 127.0.0.1
require('./demo-server.js');

const OUT = process.argv.find((a) => a.endsWith('.mp4')) || path.join(__dirname, 'out', 'reel.mp4');
const W = 1080, H = 1920, FPS = 30, LENGTH = 18.2;
const STILLS = [1.6, 5.2, 7.8, 10.9, 12.9, 14.6, 17.2];
const FFMPEG = require('ffmpeg-static');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(__dirname, 'out', 'stills'), { recursive: true });
  const w = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  w.setBounds({ x: 0, y: 0, width: W, height: H });   // taller than the screen: only possible after the window exists
  w.webContents.setFrameRate(FPS);
  let latest = null;
  w.webContents.on('paint', (_e, _dirty, image) => { latest = image; });
  w.webContents.on('console-message', (e) => { if (e.level === 'error') console.log('page error:', e.message); });
  await w.loadURL('http://127.0.0.1:4798/reel.html');
  w.webContents.setZoomFactor(1);
  await w.webContents.executeJavaScript('reelReady()');
  await wait(1200);
  const size = latest && latest.getSize();
  console.log('frame size', size);

  const ff = spawn(FFMPEG, ['-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', W + 'x' + H, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-3000); });
  const done = new Promise((r) => ff.on('exit', r));

  const bitmap = () => { let img = latest; const s = img.getSize(); if (s.width !== W || s.height !== H) img = img.resize({ width: W, height: H }); return img.toBitmap(); };
  w.webContents.executeJavaScript('reelStart()');
  const t0 = Date.now();
  let written = 0, still = 0;
  while ((Date.now() - t0) / 1000 < LENGTH) {
    const due = Math.floor(((Date.now() - t0) / 1000) * FPS);
    while (written < due) {
      if (!ff.stdin.write(bitmap())) await new Promise((r) => ff.stdin.once('drain', r));
      written++;
    }
    const t = (Date.now() - t0) / 1000;
    if (still < STILLS.length && t >= STILLS[still]) { fs.writeFileSync(path.join(__dirname, 'out', 'stills', 's' + still + '-' + STILLS[still] + 's.png'), latest.toPNG()); still++; }
    await wait(4);
  }
  ff.stdin.end();
  const code = await done;
  console.log('frames', written, 'ffmpeg exit', code, code ? ffErr : '');
  app.quit();
});
