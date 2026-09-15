# visual-verify — the cat-cave control check

**The law**: "It launches with no error" is NOT evidence. The only proof is
the thing working. Every product repo grows a control check that renders or
uses the real artifact in a browser-class environment and gates PRs.
(Origin: pelican.catcave.dev shipped "proven" while visually broken on
2026-09-15 — a build-host path baked into the wasm 404'd every asset and the
page was a blue void. The estate paid for that lesson once.)

This repo is the shared tool: **load the page in headless chromium over CDP,
fail on any console error, assert at least one render predicate, capture the
screenshot, exit nonzero with the evidence when the thing is broken.**

Vanilla Node >= 22 (global WebSocket). Zero npm dependencies. WebGL via
SwiftShader, so no GPU is needed on CI runners. Full pattern and what counts
as a predicate: the vault note `agent-ops/decisions/` — "the control-check
law".

## Use

```sh
node visual-verify.mjs --serve-dir web/ \
  --ready-js "document.title === 'pelican-ready'" --settle-ms 8000 \
  --expect-title 'pelican-ready' \
  --expect-selector 'canvas#gamecanvas' \
  --canvas-stats 'canvas#gamecanvas:150:92' \
  --fail-on-http-4xx \
  --out vv-artifacts
```

Exit codes: `0` proven · `1` check failed (report + evidence on stdout,
artifacts under `--out`) · `2` harness error.

### Target

- `--url URL` — load this page.
- `--serve-dir DIR [--serve-port N]` — serve a built artifact dir locally
  with production-parity MIME (`application/wasm`!), then load it. The URL
  becomes `http://127.0.0.1:<port>/` unless `--url` is also given.
- `--serve-cmd CMD [--ready-url URL]` — bring the target up with an external
  server command (e.g. `wrangler dev`), wait for HTTP, kill it on exit.
- `--header 'Name: value'` (repeatable) — set on every request via CDP; use
  for `CF-Access-Client-Id` / `CF-Access-Client-Secret` legs behind
  Cloudflare Access.

### Browser

- `--chromium PATH` — explicit binary; else `$CHROMIUM_BIN`; else whatever
  chromium is on PATH.
- `--connect URL` — attach to an already-running CDP endpoint (what
  `provision.sh`'s container leg sets up) instead of spawning.
- `--width/--height` viewport (default 1280x860).

### Gates and predicates

- `--ready-js EXPR` — poll an in-page expression until truthy before
  asserting (e.g. `document.title === 'pelican-ready'`, a data attribute the
  app sets when it has actually drawn).
- `--settle-ms N` — extra settle after ready (SwiftShader draws slowly;
  8-15s for WebGL titles is normal). Default 2000.
- `--timeout-ms N` — overall budget. Default 60000.
- `--expect-title RE` — document.title must match.
- `--expect-selector SEL` — element exists and is visible (non-zero box).
- `--expect-text TXT` — body innerText contains TXT.
- `--expect-js EXPR` (repeatable) — in-page expression must resolve truthy;
  promises are awaited (`fetch('/api/status').then(r => r.ok)`).
- `--canvas-stats 'SEL:MIN_COLORS:MAX_TOP_PCT'` (repeatable) — pixel
  diversity inside the element's screen rect on the screenshot of record:
  at least MIN_COLORS distinct 4-bit-quantized colors and no single color
  above MAX_TOP_PCT of samples. This is how you assert "the canvas actually
  drew the scene" for canvas/WebGL apps where DOM selectors cannot see the
  pixels. A flat void, a cleared canvas, or an untextured background fails.
- `--baseline FILE [--baseline-max-diff F]` — pixel-diff the screenshot of
  record against a baseline PNG (commit the baseline next to the workflow;
  differ beyond F fraction of pixels at per-channel tolerance 24 => fail).
- `--fail-on-http-4xx` — any response >= 400 or failed load is a failure
  (catches asset 404s even when the app swallows them).
- `--allow-http-4xx RE` (repeatable) — allowlist 4xx/failed URLs by regex,
  for probes that fail by design (Bevy asset `.meta` lookups, `favicon.ico`
  on servers that ship none). Keep the regex tight.
- `--allow-console-error RE` (repeatable) — allowlist console errors by
  regex; use sparingly and name the upstream bug.

Console-error semantics: messages of type `error` fail the run, and so do
messages of any type carrying `%cERROR` styling — wasm frameworks (Bevy via
rust `log`) print their errors as styled `console.log`, and type alone
missed every one of them during the pelican incident.

### Interaction timeline (after ready + settle)

- `--click X,Y@MS` — trusted mouse event at MS after settle.
- `--key KEY@MS` — trusted key event (Enter, Escape, KeyD, arrows...).
- `--eval JS@MS` — run an in-page expression, log the result.
- `--shot NAME@MS` — extra named screenshot.

### Artifacts (`--out DIR`, default `visual-verify-out/`)

`screenshot.png` (the screenshot of record), any named shots, `console.log`,
`network.log`, `run.json`, `report.txt`. On failure the report prints every
failing predicate, the console errors, exceptions, failed requests, and the
screenshot path. Upload `--out` as a CI artifact on every run — the
screenshot is part of the PR record, not an optional extra.

## Chromium provisioning (CI runners)

`provision.sh` resolves chromium by ladder: `$CHROMIUM_BIN` → PATH →
`nix-shell -p chromium` → a sibling container through the shared podman
socket (`--network container:$(hostname)`, CDP on 127.0.0.1:9333). The
cat-cave runner containers have node 22 but no chromium and no nix; they
share one podman socket, so the first container-leg pull provisions the
whole fleet.

```sh
eval "$(./provision.sh)"          # sets CHROMIUM_BIN or VV_CONNECT
node visual-verify.mjs --connect "$VV_CONNECT" ...   # container leg
type vv_chromium_cleanup >/dev/null 2>&1 && vv_chromium_cleanup
```

## Exemplars

- `pelican-game` `.github/workflows/control-check.yml` — wasm build, local
  serve, zero-console-error + title + canvas-diversity gate; would have
  caught the 2026-09-15 blue-void ship.
- `portal` `.github/workflows/control-check.yml` — Access service-token
  legs against the live grid + local `wrangler dev` leg on PRs.
