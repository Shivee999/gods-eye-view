#!/usr/bin/env node
/**
 * render.mjs
 *
 * Renders an animated "where I went" travel video from a list of stops.
 * A satellite globe (MapLibre + Esri World Imagery, no API key) is driven
 * frame-by-frame in headless Chromium, each frame waits for its tiles, and the
 * frames are piped straight into ffmpeg. Output is an H.264 MP4.
 *
 *   node tools/travel-reel/render.mjs --trip tools/travel-reel/trip.sample.json
 *   node tools/travel-reel/render.mjs --trip my-trip.json --vertical          # 1080x1920 for Reels/Shorts
 *   node tools/travel-reel/render.mjs --trip my-trip.json --preview           # fast low-fps draft
 *
 * Options:
 *   --trip      Trip JSON (see trip.sample.json)          (default: trip.sample.json)
 *   --mode      "tour" (fly stop to stop) or "overview" (one 3D shot of the whole route with terrain)
 *   --out       Output .mp4                               (default: output/travel-reel.mp4)
 *   --fps       Frames per second                         (default: 30)
 *   --width     Frame width                               (default: 1920)
 *   --height    Frame height                              (default: 1080)
 *   --vertical  Shortcut for 1080x1920
 *   --preview   8 fps, 960x540 draft render
 *   --fast      1280x720, 12 fps rendered, interpolated to 30 fps (for machines without a GPU)
 *   --from/--to Render only this time window, in seconds
 *   --ffmpeg    Path to ffmpeg                            (default: $FFMPEG or "ffmpeg")
 *
 * Dependencies: playwright (or a global install), ffmpeg
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    trip: resolve(__dirname, 'trip.sample.json'),
    out: resolve(PROJECT_ROOT, 'output', 'travel-reel.mp4'),
    fps: 30, width: 1920, height: 1080,
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--trip':     opts.trip = resolve(args[++i]); break;
      case '--mode':     opts.mode = args[++i]; break;
      case '--out':      opts.out = resolve(args[++i]); break;
      case '--fps':      opts.fps = parseInt(args[++i], 10); break;
      case '--render-fps': opts.renderFps = parseInt(args[++i], 10); break;
      case '--fast':     opts.width = 1280; opts.height = 720; opts.renderFps = 12; break;
      case '--width':    opts.width = parseInt(args[++i], 10); break;
      case '--height':   opts.height = parseInt(args[++i], 10); break;
      case '--vertical': opts.width = 1080; opts.height = 1920; break;
      case '--preview':  opts.fps = 8; opts.width = 960; opts.height = 540; opts.scale = 0.5; break;
      case '--from':     opts.from = parseFloat(args[++i]); break;
      case '--to':       opts.to = parseFloat(args[++i]); break;
      case '--ffmpeg':   opts.ffmpeg = args[++i]; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// Prefer a project-local playwright, fall back to a global install.
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(resolve(globalRoot, 'playwright'));
  }
}

// All network requests (library, fonts, tiles) are fetched by Node and cached on
// disk. Re-renders then reuse tiles, and the browser works behind proxies whose
// CA Chromium doesn't trust.
async function routeThroughNode(page, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  await page.route(/^https?:/, async (route) => {
    const url = route.request().url();
    const key = resolve(cacheDir, createHash('sha1').update(url).digest('hex'));
    try {
      if (existsSync(key)) {
        const meta = JSON.parse(readFileSync(key + '.json', 'utf8'));
        return route.fulfill({ status: 200, headers: meta, body: readFileSync(key) });
      }
      const res = await fetch(url, { headers: { 'User-Agent': 'gods-eye-view travel-reel' } });
      const body = Buffer.from(await res.arrayBuffer());
      const headers = { 'content-type': res.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' };
      if (res.ok) {
        writeFileSync(key, body);
        writeFileSync(key + '.json', JSON.stringify(headers));
      }
      return route.fulfill({ status: res.status, headers, body });
    } catch {
      return route.abort();
    }
  });
}

async function main() {
  // Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set at startup.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
    });
    child.on('close', (code) => process.exit(code ?? 1));
    return;
  }
  const opts = parseArgs();
  opts.renderFps = opts.renderFps || opts.fps;
  const trip = JSON.parse(readFileSync(opts.trip, 'utf8'));
  if (!Array.isArray(trip.stops) || trip.stops.length < 2) {
    console.error('Trip needs at least two stops.');
    process.exit(1);
  }
  mkdirSync(dirname(opts.out), { recursive: true });

  // --preview renders the 1920x1080 layout at half scale so the HUD matches the final cut.
  const scale = opts.scale || 1;
  const viewport = { width: Math.round(opts.width / scale), height: Math.round(opts.height / scale) };

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  page.on('pageerror', (err) => console.error('[page]', err.message));
  await routeThroughNode(page, resolve(dirname(opts.out), '.tile-cache'));
  await page.goto(pathToFileURL(resolve(__dirname, 'reel.html')).href);
  await page.waitForFunction(() => typeof maplibregl !== 'undefined');
  const duration = await page.evaluate(([t, o]) => window.setupReel(t, o), [trip, { mode: opts.mode || 'tour' }]);

  const t0 = opts.from ?? 0;
  const t1 = Math.min(opts.to ?? duration, duration);
  const frames = Math.round((t1 - t0) * opts.renderFps);
  console.log(`${trip.stops.length} stops, ${duration.toFixed(1)}s total, rendering ${frames} frames @ ${opts.renderFps}fps ${opts.width}x${opts.height}`);
  const filters = opts.renderFps < opts.fps
    ? ['-vf', `minterpolate=fps=${opts.fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`]
    : [];

  const ff = spawn(opts.ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(opts.renderFps), '-c:v', 'mjpeg', '-i', '-',
    ...filters, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', opts.out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));

  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.renderFrame(t), t0 + f / opts.renderFps);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % opts.renderFps === 0 || f === frames - 1) {
      const rate = (f + 1) / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  frame ${f + 1}/${frames}  ${rate.toFixed(1)} fps  eta ${Math.round((frames - f - 1) / rate)}s   `);
    }
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();
  console.log(`\nWrote ${opts.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
