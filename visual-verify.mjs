#!/usr/bin/env node
// visual-verify — the cat-cave control check: prove a page WORKS in a real
// browser, or fail the build.
//
// Law (vault: agent-ops/decisions — "the control-check law"): "it launches
// with no error" is not evidence. The only proof is the thing working: load
// the real artifact in a browser-class environment, assert it renders what
// it must, capture the screenshot as part of the record, exit nonzero with
// the evidence when it does not.
//
// Zero npm dependencies. Node >= 22 (global WebSocket). Vanilla CDP over the
// chromium remote-debugging WebSocket: console capture, page exceptions,
// network status capture, trusted input events, screenshots, pixel analysis.
// WebGL runs through SwiftShader (software) so no GPU is needed anywhere.
//
// Gates (any failure => exit 1, artifacts still written):
//   - a console message of type "error" not matched by --allow-console-error
//   - a page exception (uncaught error)
//   - (with --fail-on-http-4xx) any response >= 400 or failed load
//   - any --expect-* predicate that does not hold
//   - any --canvas-stats region outside its bounds
//   - any --baseline screenshot differing more than --baseline-max-diff
//
// Exit codes: 0 = proven; 1 = check failed (evidence in --out and on stdout);
// 2 = harness error (chromium did not start, bad usage).
//
// Usage (README.md has the full ladder):
//   node visual-verify.mjs --serve-dir web/ \
//     --expect-title 'pelican-ready' \
//     --expect-selector 'canvas#gamecanvas' \
//     --canvas-stats 'canvas#gamecanvas:150:92' \
//     --fail-on-http-4xx --out vv-artifacts

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

const SCRIPT = 'visual-verify';

function die(msg, code = 2) {
  console.error(`${SCRIPT}: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    headers: [],
    expectTitle: [],
    expectSelector: [],
    expectText: [],
    expectJs: [],
    canvasStats: [],
    baselines: [],
    allowConsoleError: [],
    allowHttp4xx: [],
    timeline: [],
    width: 1280,
    height: 860,
    settleMs: 2000,
    timeoutMs: 60000,
    baselineMaxDiff: 0.01,
    pixelChannelTolerance: 24,
    out: 'visual-verify-out',
    failOnHttp4xx: false,
  };
  const take = (arg) => {
    if (i + 1 >= argv.length) die(`--${arg} needs a value`);
    return argv[++i];
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    const arg = a.replace(/^--/, '');
    switch (arg) {
      case 'url': opts.url = take(arg); break;
      case 'serve-dir': opts.serveDir = take(arg); break;
      case 'serve-port': opts.servePort = Number(take(arg)); break;
      case 'serve-cmd': opts.serveCmd = take(arg); break;
      case 'ready-url': opts.readyUrl = take(arg); break;
      case 'header': opts.headers.push(take(arg)); break;
      case 'chromium': opts.chromium = take(arg); break;
      case 'connect': opts.connect = take(arg); break;
      case 'width': opts.width = Number(take(arg)); break;
      case 'height': opts.height = Number(take(arg)); break;
      case 'ready-js': opts.readyJs = take(arg); break;
      case 'settle-ms': opts.settleMs = Number(take(arg)); break;
      case 'timeout-ms': opts.timeoutMs = Number(take(arg)); break;
      case 'expect-title': opts.expectTitle.push(take(arg)); break;
      case 'expect-selector': opts.expectSelector.push(take(arg)); break;
      case 'expect-text': opts.expectText.push(take(arg)); break;
      case 'expect-js': opts.expectJs.push(take(arg)); break;
      case 'canvas-stats': opts.canvasStats.push(take(arg)); break;
      case 'baseline': opts.baselines.push(take(arg)); break;
      case 'baseline-max-diff': opts.baselineMaxDiff = Number(take(arg)); break;
      case 'allow-console-error': opts.allowConsoleError.push(take(arg)); break;
      case 'allow-http-4xx': opts.allowHttp4xx.push(take(arg)); break;
      case 'fail-on-http-4xx': opts.failOnHttp4xx = true; break;
      case 'click':
      case 'key':
      case 'shot':
      case 'eval': {
        const spec = take(arg);
        const at = spec.lastIndexOf('@');
        if (at < 1) die(`--${arg} takes SPEC@MS (got "${spec}")`);
        const body = spec.slice(0, at);
        const ms = Number(spec.slice(at + 1));
        if (!Number.isFinite(ms)) die(`--${arg} needs @MS (got "${spec}")`);
        const cmd = { t: arg, spec: body, ms };
        if (arg === 'click') {
          const [x, y] = body.split(',').map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) die(`--click takes X,Y@MS (got "${spec}")`);
          cmd.x = x; cmd.y = y;
        }
        opts.timeline.push(cmd);
        break;
      }
      case 'out': opts.out = take(arg); break;
      default: die(`unknown argument --${arg}`);
    }
  }
  if (!opts.url && !opts.serveDir && !opts.serveCmd) die('need --url (or --serve-dir / --serve-cmd to bring the target up)');
  if (opts.serveDir && !opts.url && !opts.servePort) opts.servePort = 0;
  if (!opts.url) {
    const port = opts.servePort || 8787;
    opts.url = `http://127.0.0.1:${port}/`;
  }
  return opts;
}

function parseHeaders(raw) {
  return raw.map((h) => {
    const i = h.indexOf(':');
    if (i < 1) die(`--header takes 'Name: value' (got "${h}")`);
    return { name: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

async function waitForHttp(url, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500 || r.status >= 400) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server never answered: ${url}`);
    await sleep(250);
  }
}

// static server with production-parity MIME (wasm!) — a .wasm served as
// octet-stream is a classic "works in dev tooling, dead in a real browser" trap
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
function startStaticServer(root, port) {
  const srv = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let p = path.join(root, urlPath);
    if (urlPath.endsWith('/')) p = path.join(p, 'index.html');
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res(srv)));
}

function findChromium(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) die(`--chromium not found: ${explicit}`);
    return explicit;
  }
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) return process.env.CHROMIUM_BIN;
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    for (const d of (process.env.PATH || '').split(':')) {
      const p = path.join(d, c);
      try { if (fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

// ---- pure-JS PNG decode (8-bit, color type 2/6 — chromium screenshots) ----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w, h, bd, ct;
  const idat = [];
  while (pos < buf.length) {
    const ln = buf.readUInt32BE(pos);
    const typ = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + ln);
    if (typ === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bd = body[8]; ct = body[9]; }
    else if (typ === 'IDAT') idat.push(body);
    else if (typ === 'IEND') break;
    pos += 12 + ln;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG (bitDepth=${bd} colorType=${ct})`);
  const bpp = ct === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    line.set(raw.subarray(p, p + stride)); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (f) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 255; break;
        case 2: line[i] = (line[i] + b) & 255; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          line[i] = (line[i] + pr) & 255;
          break;
        }
        default: throw new Error(`bad PNG filter ${f}`);
      }
    }
    out.set(line, y * stride);
    prev.set(line);
  }
  return { w, h, bpp, px: out };
}

// pixel diversity over a region (4-bit quantized, like the estate pngstats)
function regionStats(img, rect) {
  const counts = new Map();
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.w, Math.ceil(rect.x + rect.width)), y1 = Math.min(img.h, Math.ceil(rect.y + rect.height));
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.w + x) * img.bpp;
      const key = ((img.px[o] >> 4) << 8) | ((img.px[o + 1] >> 4) << 4) | (img.px[o + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
      total++;
    }
  }
  if (total === 0) return { total: 0, distinct: 0, topShare: 1 };
  let top = 0;
  for (const n of counts.values()) top = Math.max(top, n);
  return { total, distinct: counts.size, topShare: top / total };
}

function diffFraction(a, b, tol) {
  if (a.w !== b.w || a.h !== b.h) return null;
  let diff = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    const o = i * a.bpp, o2 = i * b.bpp;
    if (Math.abs(a.px[o] - b.px[o2]) > tol || Math.abs(a.px[o + 1] - b.px[o2 + 1]) > tol ||
        Math.abs(a.px[o + 2] - b.px[o2 + 2]) > tol) diff++;
  }
  return diff / n;
}

const KEYCODES = { Enter: 13, Escape: 27, Space: 32, ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, KeyD: 68, KeyA: 65, KeyR: 82, KeyW: 87, KeyS: 83 };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const headers = parseHeaders(opts.headers);
  const outDir = path.resolve(opts.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const log = { console: [], exceptions: [], network: [] };
  const failures = [];
  const passes = [];
  const cleanup = [];
  const finish = (code) => {
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort */ } }
    process.exit(code);
  };

  try {
    if (opts.serveDir) {
      const port = opts.servePort || (await freePort());
      if (!opts.servePort) opts.url = `http://127.0.0.1:${port}/`;
      const server = await startStaticServer(path.resolve(opts.serveDir), port);
      cleanup.push(() => new Promise((r) => server.close(r)));
      console.log(`[vv] serving ${opts.serveDir} -> ${opts.url}`);
    }
    if (opts.serveCmd) {
      const proc = spawn('sh', ['-c', opts.serveCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let srvLog = '';
      proc.stdout.on('data', (d) => { srvLog += d; });
      proc.stderr.on('data', (d) => { srvLog += d; });
      const logFile = path.join(outDir, 'server.log');
      fs.writeFileSync(logFile, '');
      const t = setInterval(() => fs.appendFileSync(logFile, srvLog), 1000);
      cleanup.push(() => { clearInterval(t); fs.appendFileSync(logFile, srvLog); proc.kill('SIGTERM'); });
      await waitForHttp(opts.readyUrl || opts.url, opts.timeoutMs);
      console.log(`[vv] serve-cmd up: ${opts.serveCmd}`);
    }

    // ---- browser up ----
    let wsUrl;
    let tabLoadedUrl = false;
    if (opts.connect) {
      const base = opts.connect.replace(/\/$/, '');
      let tab = null;
      for (const method of ['PUT', 'GET']) {
        try {
          const r = await fetch(`${base}/json/new?${encodeURIComponent(opts.url)}`, { method });
          if (r.ok) { tab = await r.json(); break; }
        } catch { /* older chromium rejects PUT; older still needs GET */ }
      }
      if (!tab || !tab.webSocketDebuggerUrl) {
        const list = await (await fetch(`${base}/json/list`)).json();
        tab = list.find((t) => t.type === 'page');
      }
      if (!tab) die(`no page target at ${base}`);
      tabLoadedUrl = !!(tab.url && tab.url !== 'about:blank' && tab.url !== '');
      wsUrl = tab.webSocketDebuggerUrl;
      const ver = await (await fetch(`${base}/json/version`)).json();
      console.log(`[vv] attached external chromium ${ver.Browser}`);
    } else {
      const bin = findChromium(opts.chromium);
      if (!bin) die('no chromium found: set CHROMIUM_BIN, pass --chromium PATH, or see provision.sh (PATH / nix / docker-socket ladder)');
      const port = await freePort();
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-profile-'));
      cleanup.push(() => fs.rmSync(profile, { recursive: true, force: true }));
      const chrome = spawn(bin, [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--window-size=${opts.width},${opts.height}`, '--hide-scrollbars',
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--v=0', '--no-first-run', 'about:blank',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let chromeErr = '';
      chrome.stderr.on('data', (d) => { chromeErr += d; });
      cleanup.push(() => chrome.kill('SIGKILL'));
      let up = false;
      for (let i = 0; i < 100; i++) {
        try { await fetch(`http://127.0.0.1:${port}/json/version`); up = true; break; } catch { await sleep(200); }
      }
      if (!up) { console.error(chromeErr); die('chromium failed to start'); }
      const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(opts.url)}`, { method: 'PUT' })).json();
      tabLoadedUrl = true;
      wsUrl = tab.webSocketDebuggerUrl;
      console.log(`[vv] chromium ${path.basename(bin)} (SwiftShader WebGL)`);
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('CDP websocket failed: ' + (e.message || 'connection refused'))); });
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        log.console.push({
          t: Date.now() - t0, type: m.params.type,
          text: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
        });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        log.exceptions.push({
          t: Date.now() - t0,
          text: String((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception'),
        });
      } else if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        log.network.push({ t: Date.now() - t0, url: r.url, status: r.status, mime: r.headers['Content-Type'] || r.headers['content-type'] || '' });
      } else if (m.method === 'Network.loadingFailed') {
        log.network.push({ t: Date.now() - t0, url: m.params.requestId, error: m.params.errorText, canceled: !!m.params.canceled });
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, 30000);
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(async()=>{ return (${expr}); })()`,
        awaitPromise: true, returnByValue: true,
      });
      if (r.result?.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error(String((d.exception && (d.exception.description || d.exception.value)) || d.text));
      }
      const res = r.result?.result;
      if (!res) throw new Error('no evaluate result');
      return res.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Log.enable').catch(() => {});
    if (headers.length) {
      const hdrs = {};
      for (const h of headers) hdrs[h.name] = h.value;
      await send('Network.setExtraHTTPHeaders', { headers: hdrs });
      console.log(`[vv] extra headers on every request: ${headers.map((h) => h.name).join(', ')}`);
    }

    const deadline = t0 + opts.timeoutMs;
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, name.endsWith('.png') ? name : name + '.png');
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      console.log(`[vv] shot ${file}`);
      return file;
    };

    // ---- navigate, wait ready, settle ----
    // a tab created with the URL is already loading it; navigating again
    // aborts the first load's in-flight fetches and manufactures a phantom
    // "TypeError: Failed to fetch" console error
    if (!tabLoadedUrl) await send('Page.navigate', { url: opts.url });
    if (opts.readyJs) {
      let ready = false;
      while (Date.now() < deadline) {
        try { if (await evalJs(opts.readyJs)) { ready = true; break; } } catch { /* page not ready to evaluate yet */ }
        await sleep(250);
      }
      if (ready) console.log(`[vv] ready-js satisfied at ${Date.now() - t0}ms`);
      else failures.push(`ready-js never became truthy within ${opts.timeoutMs}ms: ${opts.readyJs}`);
    }
    if (Date.now() + opts.settleMs > deadline) {
      failures.push(`timeout budget spent before settle (settle-ms=${opts.settleMs}, timeout-ms=${opts.timeoutMs})`);
    }
    await sleep(opts.settleMs);

    // ---- timeline (trusted input events, extra shots, evals) ----
    const tlStart = Date.now();
    for (const c of [...opts.timeline].sort((a, b) => a.ms - b.ms)) {
      const wait = c.ms - (Date.now() - tlStart);
      if (wait > 0) await sleep(wait);
      try {
        if (c.t === 'shot') await shot(c.spec);
        else if (c.t === 'click') {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          console.log(`[vv] click ${c.x},${c.y}`);
        } else if (c.t === 'key') {
          const code = KEYCODES[c.spec] ?? c.spec.toUpperCase().charCodeAt(0);
          const base = { key: c.spec.replace(/^Key/, ''), code: c.spec, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
          await sleep(40);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
          console.log(`[vv] key ${c.spec}`);
        } else if (c.t === 'eval') {
          const v = await evalJs(c.spec);
          console.log(`[vv] eval -> ${JSON.stringify(v)}`);
        }
      } catch (e) { failures.push(`timeline ${c.t} ${c.spec} failed: ${e.message}`); }
    }

    // ---- screenshot of record ----
    const finalShot = await shot('screenshot.png');

    // ---- page state ----
    const state = {
      title: await evalJs('document.title'),
      url: await evalJs('location.href'),
      readyState: await evalJs('document.readyState'),
    };

    // ---- predicates ----
    for (const re of opts.expectTitle) {
      if (new RegExp(re).test(state.title)) passes.push(`title matches /${re}/`);
      else failures.push(`expected document.title to match /${re}/; actual: "${state.title}"`);
    }
    for (const sel of opts.expectSelector) {
      try {
        const r = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
          const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
        if (r && r.w > 0 && r.h > 0) passes.push(`selector visible: ${sel} (${Math.round(r.w)}x${Math.round(r.h)})`);
        else failures.push(`expected visible selector ${sel}; ${r ? 'found but has zero size' : 'not found'}`);
      } catch (e) { failures.push(`selector ${sel} check errored: ${e.message}`); }
    }
    for (const txt of opts.expectText) {
      const bodyText = await evalJs('document.body ? document.body.innerText : ""');
      if (bodyText.includes(txt)) passes.push(`text present: "${txt.slice(0, 60)}"`);
      else failures.push(`expected body text to include "${txt}"`);
    }
    for (const expr of opts.expectJs) {
      try {
        const v = await evalJs(expr);
        if (v) passes.push(`js predicate holds: ${expr.slice(0, 80)}`);
        else failures.push(`js predicate falsy: ${expr}`);
      } catch (e) { failures.push(`js predicate threw: ${expr}\n    ${e.message}`); }
    }

    // pixel analysis on the screenshot of record
    const img = decodePng(fs.readFileSync(finalShot));
    for (const spec of opts.canvasStats) {
      const parts = spec.split(':');
      if (parts.length !== 3) die(`--canvas-stats takes SEL:MIN_COLORS:MAX_TOP_PCT (got "${spec}")`);
      const [sel, minC, maxTop] = [parts[0], Number(parts[1]), Number(parts[2])];
      try {
        const rect = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
          const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
        if (!rect) { failures.push(`canvas-stats: selector ${sel} not found`); continue; }
        const st = regionStats(img, rect);
        const topPct = (st.topShare * 100).toFixed(1);
        if (st.distinct >= minC && st.topShare * 100 <= maxTop) {
          passes.push(`canvas-stats ${sel}: ${st.distinct} distinct colors, top color ${topPct}% (required >=${minC} colors, <=${maxTop}%)`);
        } else {
          failures.push(`canvas-stats ${sel}: ${st.distinct} distinct colors, top color ${topPct}% — required >=${minC} colors and <=${maxTop}% (a flat/void render fails this)`);
        }
      } catch (e) { failures.push(`canvas-stats ${sel} errored: ${e.message}`); }
    }
    for (const base of opts.baselines) {
      try {
        const bImg = decodePng(fs.readFileSync(base));
        const frac = diffFraction(img, bImg, opts.pixelChannelTolerance);
        if (frac === null) failures.push(`baseline ${base}: size mismatch (got ${img.w}x${img.h}, baseline ${bImg.w}x${bImg.h})`);
        else if (frac <= opts.baselineMaxDiff) passes.push(`baseline ${path.basename(base)} diff ${(frac * 100).toFixed(3)}% <= ${(opts.baselineMaxDiff * 100).toFixed(2)}%`);
        else failures.push(`baseline ${path.basename(base)} diff ${(frac * 100).toFixed(3)}% > ${(opts.baselineMaxDiff * 100).toFixed(2)}%`);
      } catch (e) { failures.push(`baseline ${base} errored: ${e.message}`); }
    }

    // ---- console / exception / network gates ----
    // wasm frameworks (Bevy, rust log) emit errors via console.log with %c
    // styling ("%cERROR%c ...") — type alone would miss them, so styled
    // ERROR text counts as an error too (learned from the pelican incident)
    const isConsoleError = (c) => c.type === 'error' || /%cERROR/.test(c.text);
    const allowRe = opts.allowConsoleError.map((r) => new RegExp(r));
    const consoleErrors = log.console.filter((c) => isConsoleError(c) && !allowRe.some((re) => re.test(c.text)));
    if (consoleErrors.length) failures.push(`${consoleErrors.length} console error(s):`);
    else passes.push(`zero console errors (${log.console.length} console messages total)`);
    if (log.exceptions.length) failures.push(`${log.exceptions.length} page exception(s):`);
    else passes.push('zero page exceptions');
    let badRequests = [];
    if (opts.failOnHttp4xx) {
      const allowHttp = opts.allowHttp4xx.map((r) => new RegExp(r));
      badRequests = log.network.filter((n) => {
        if (n.error) return !n.canceled && !allowHttp.some((re) => re.test(n.url));
        if (n.status < 400) return false;
        return !allowHttp.some((re) => re.test(n.url));
      });
      if (badRequests.length) failures.push(`${badRequests.length} failed/4xx+5xx request(s):`);
      else passes.push(`zero failed requests (${log.network.length} total, allowlist ${opts.allowHttp4xx.length} pattern(s))`);
    }

    // ---- artifacts + verdict ----
    fs.writeFileSync(path.join(outDir, 'console.log'), log.console.map((c) => `[${c.t}ms] ${c.type}: ${c.text}`).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'network.log'), log.network.map((n) => JSON.stringify(n)).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({
      url: opts.url, state,
      passes, failures,
      stats: { consoleMessages: log.console.length, consoleErrors: consoleErrors.length, exceptions: log.exceptions.length, requests: log.network.length, elapsedMs: Date.now() - t0 },
    }, null, 2));
    const evidence = [];
    for (const c of consoleErrors.slice(0, 20)) evidence.push(`  [console.error ${c.t}ms] ${c.text.slice(0, 300)}`);
    for (const e of log.exceptions.slice(0, 10)) evidence.push(`  [exception ${e.t}ms] ${e.text.slice(0, 300)}`);
    for (const n of badRequests.slice(0, 20)) evidence.push(`  [${n.error ? 'load-failed' : `http ${n.status}`}] ${n.url} ${n.error || ''}`.trimEnd());
    const report = [
      `visual-verify ${failures.length === 0 ? 'PROVEN' : 'FAILED'}`,
      `url: ${state.url}`,
      `title: ${state.title}`,
      `elapsed: ${Date.now() - t0}ms`,
      `screenshot: ${finalShot}`,
      '',
      'passes:',
      ...passes.map((p) => `  ok  ${p}`),
      ...(failures.length ? ['', 'failures:', ...failures.map((f) => `  FAIL ${f}`), ...evidence] : []),
      '',
      `artifacts: ${outDir} (screenshot.png, console.log, network.log, run.json)`,
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'report.txt'), report + '\n');
    console.log(report);
    finish(failures.length ? 1 : 0);
  } catch (e) {
    console.error(`${SCRIPT}: harness error: ${e.message}`);
    fs.writeFileSync(path.join(outDir, 'harness-error.txt'), String(e.stack || e.message) + '\n');
    finish(2);
  }
}

main();
