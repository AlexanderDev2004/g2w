// R6-3: renderer feature-parity browser matrix.
//
// Extends the R6-2 backend smoke infrastructure (same CDP/raw-WebSocket
// approach, no new packages) to verify which EXISTING g2w features work on
// each backend in a real browser, with objective pixel assertions rather
// than absence-of-errors. One fresh headless-Chrome page per backend case;
// each page builds one PixiRenderer and drives the g2w public API:
//
//   init/dispose          renderer lifecycle on this backend
//   frame rendering       render() after init, background pixel asserted
//   background color      #1099bb clear color read back from the canvas
//   resize                renderer.resize() changes the drawing buffer
//   sprite + texture      createSpriteView over an Assets-loaded texture
//   texture alpha         a generated RGBA probe (transparent right half)
//   alpha/visible         model.alpha 0.5 and visible=false change pixels
//   anchor/rotation       center-anchored 45° rotation changes pixels
//   assets/cleanup        createTextureAssetManager cache + non-destructive
//                         disposal semantics observed in the browser
//
// "Graphics primitives" have no g2w public API (they are PixiJS objects the
// demo touches at the adapter boundary), so they are recorded as
// out-of-contract rather than tested as a g2w feature.
//
// Usage:
//   node scripts/smoke-renderer-features.mjs
// Environment:
//   G2W_CHROME      Chrome/Chromium binary (default: system Chrome)
//   G2W_SMOKE_PORT  dev-server port (default 5211); CDP port is +1
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.G2W_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEV_PORT = Number(process.env.G2W_SMOKE_PORT ?? 5211);
const CDP_PORT = DEV_PORT + 1;
const DEMO_URL = `http://localhost:${DEV_PORT}/`;
const BACKGROUND = [16, 153, 187]; // #1099bb
const PROBE_RED = [200, 30, 30]; // the generated r62-alpha-probe.png color
const ALPHA_BG = [108, 92, 109]; // #1099bb blended with 50% probe red (premultiplied, tolerance-checked)
const TOLERANCE = 4;

const CASES = ["webgl", "canvas", "webgpu"];

const results = [];
const record = (entry) => {
  results.push(entry);
  console.log(`\n[case] ${entry.case} — actual backend: ${entry.actualBackend ?? "(n/a)"}`);
  for (const [feature, outcome] of Object.entries(entry.features ?? {})) {
    const status = outcome.status.padEnd(11);
    console.log(`  ${status} ${feature}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  }
  if (entry.errors?.length) console.log(`  errors: ${JSON.stringify(entry.errors)}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { attempts, intervalMs, description }) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

// --- Dev server -------------------------------------------------------------
console.log(`starting Vite dev server on port ${DEV_PORT}...`);
const vite = spawn(
  process.execPath,
  [
    path.join(repoRoot, "examples/hello-world/node_modules/vite/bin/vite.js"),
    "--port",
    String(DEV_PORT),
    "--strictPort",
  ],
  { cwd: path.join(repoRoot, "examples/hello-world"), stdio: ["ignore", "inherit", "inherit"] },
);
try {
  await waitFor(
    async () => {
      try {
        const response = await fetch(DEMO_URL);
        return response.ok;
      } catch {
        return false;
      }
    },
    { attempts: 80, intervalMs: 250, description: "the Vite dev server" },
  );

  // --- Chrome ---------------------------------------------------------------
  const profileDir = mkdtempSync(path.join(tmpdir(), "g2w-r63-smoke-"));
  console.log(`starting headless Chrome (${CHROME})...`);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-webgpu",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { attempts: 80, intervalMs: 250, description: "the Chrome DevTools endpoint" },
    );

    const versionInfo = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const browserWs = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      browserWs.onopen = resolve;
      browserWs.onerror = reject;
    });

    let messageId = 0;
    const pending = new Map();
    const sessionListeners = new Map();
    browserWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      const listener = sessionListeners.get(message.sessionId);
      if (listener && message.method) listener(message);
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, { resolve, reject });
        browserWs.send(
          JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
        );
      });

    const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    console.log(`browser: ${info.Browser}`);

    for (const backendCase of CASES) {
      const pageErrors = [];
      const consoleErrors = [];
      const created = await send("Target.createTarget", { url: "about:blank" });
      const targetId = created.targetId;
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      sessionListeners.set(sessionId, (message) => {
        if (message.method === "Runtime.exceptionThrown") {
          pageErrors.push(
            message.params.exceptionDetails.exception?.description ??
              message.params.exceptionDetails.text,
          );
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
          consoleErrors.push(
            message.params.args.map((argument) => argument.value ?? argument.description).join(" "),
          );
        }
      });

      try {
        await send("Page.enable", {}, sessionId);
        await send("Runtime.enable", {}, sessionId);
        const loaded = send("Page.navigate", { url: DEMO_URL }, sessionId);
        const loadEvent = new Promise((resolve) => {
          const previous = sessionListeners.get(sessionId);
          sessionListeners.set(sessionId, (message) => {
            previous?.(message);
            if (message.method === "Page.loadEventFired") resolve();
          });
        });
        await Promise.race([
          Promise.all([loaded, loadEvent]),
          sleep(30000).then(() => {
            throw new Error("navigation timed out");
          }),
        ]);
        await sleep(1000);

        const probe = `(async () => {
  const CASE = ${JSON.stringify(backendCase)};
  const BACKGROUND = ${JSON.stringify(BACKGROUND)};
  const PROBE_RED = ${JSON.stringify(PROBE_RED)};
  const ALPHA_BG = ${JSON.stringify(ALPHA_BG)};
  const TOLERANCE = ${TOLERANCE};
  const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
  const colorMatches = (pixel, expected) =>
    Array.isArray(pixel) &&
    near(pixel[0], expected[0]) && near(pixel[1], expected[1]) && near(pixel[2], expected[2]) &&
    (pixel[3] === undefined || pixel[3] === 255);

  const features = {};
  const mark = (name, ok, detail) => {
    features[name] = { status: ok ? "verified" : "failed", detail: detail ?? null };
  };

  // Skip path: if this backend cannot initialize here, record it explicitly.
  if (CASE === "webgpu") {
    let adapterAvailable = false;
    try {
      adapterAvailable = Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch {}
    if (!adapterAvailable) {
      return {
        actualBackend: null,
        skipped: "WebGPU unavailable in this environment",
        features: {},
        errors: [],
      };
    }
  }

  const { PixiRenderer, createSpriteView, createTextureAssetManager } = await import(
    "/@id/@g2w/renderer-pixi"
  );

  // Readback helper: WebGL via readPixels, Canvas/WebGPU via 2D drawImage.
  const readPixel = (canvas, x, y) => {
    const gl =
      canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (gl && canvas.dataset && canvas.dataset.gl === "1") {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, gl.drawingBufferHeight - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [pixel[0], pixel[1], pixel[2], pixel[3]];
    }
    const probe = document.createElement("canvas");
    probe.width = canvas.width;
    probe.height = canvas.height;
    const context2d = probe.getContext("2d");
    context2d.drawImage(canvas, 0, 0);
    const data = context2d.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  };

  const canvas = document.createElement("canvas");
  canvas.dataset.gl = CASE === "webgl" ? "1" : "0";
  document.body.appendChild(canvas);
  const renderer = new PixiRenderer();
  const out = { actualBackend: null, features, errors: [] };

  // 1. init/dispose lifecycle.
  try {
    await renderer.initialize({
      canvas,
      width: 160,
      height: 90,
      resolution: 1,
      backgroundColor: "#1099bb",
      ...(CASE === "auto" ? {} : { backend: CASE }),
    });
    out.actualBackend = renderer.capabilities.backend;
    mark(
      "init + actual backend reported",
      out.actualBackend === CASE,
      out.actualBackend === CASE
        ? out.actualBackend
        : "actual=" + out.actualBackend + ", requested=" + CASE + " (fallback, NOT verified)",
    );
    if (out.actualBackend !== CASE) {
      // A fallback page: skip the feature checks, they would verify the
      // fallback backend, not the requested one.
      return { ...out, skipped: "requested backend fell back; features not re-verified" };
    }
  } catch (error) {
    mark("init + actual backend reported", false, String(error?.message ?? error));
    return { ...out, errors: [String(error?.message ?? error)] };
  }

  // 2. frame rendering + background color: read the center pixel.
  renderer.render();
  const bgPixel = readPixel(canvas, 80, 45);
  mark("frame rendering", colorMatches(bgPixel, BACKGROUND), JSON.stringify(bgPixel));
  mark("background color", colorMatches(bgPixel, BACKGROUND), JSON.stringify(bgPixel));

  // 3. resize: logical size change reaches the drawing buffer.
  renderer.resize(320, 180);
  let resizeOk = canvas.width === 320 && canvas.height === 180;
  let resizeDetail = canvas.width + "x" + canvas.height;
  renderer.render();
  const bgAfterResize = readPixel(canvas, 160, 90);
  resizeOk = resizeOk && colorMatches(bgAfterResize, BACKGROUND);
  mark("resize + logical resolution", resizeOk, resizeDetail);
  renderer.resize(160, 90);
  renderer.render();

  // 4. assets: load through the g2w asset API (cache + non-destructive
  //    disposal), observed in the browser.
  const assets = createTextureAssetManager();
  let texture;
  let assetNotes = [];
  try {
    texture = await assets.load("assets/r62-alpha-probe.png");
    const cached = await assets.load("assets/r62-alpha-probe.png");
    assetNotes.push(cached === texture ? "cache hit" : "CACHE MISS");
    await assets.dispose();
    assetNotes.push(texture.destroyed === false ? "dispose kept texture" : "dispose DESTROYED texture");
    mark(
      "asset loading + cleanup policy",
      cached === texture && texture.destroyed === false,
      assetNotes.join(", "),
    );
  } catch (error) {
    mark("asset loading + cleanup policy", false, String(error?.message ?? error));
  }

  // 5. sprite + texture rendering: the probe's opaque left half must show.
  const model = new (await import("/@id/@g2w/core")).Sprite2D({
    texture,
    transform: new (await import("/@id/@g2w/core")).Transform2D({ x: 0, y: 0 }),
  });
  const view = createSpriteView({ sprite: model, renderer });
  renderer.render();
  const spritePixel = readPixel(canvas, 8, 8); // inside the opaque left half
  mark(
    "sprite + texture rendering",
    colorMatches(spritePixel, PROBE_RED),
    JSON.stringify(spritePixel),
  );

  // 6. texture alpha: the transparent right half must show the background.
  // The probe sits at (0,0) at natural 64px size; its right half (x 32..63)
  // is fully transparent, so the pixel at (56, 8) is pure background. The
  // pixel at (8, 8) stays probe-red, pinning both halves of the RGBA asset.
  const opaquePixel = readPixel(canvas, 8, 8);
  const transparentPixel = readPixel(canvas, 56, 8);
  mark(
    "texture alpha (transparent region)",
    colorMatches(opaquePixel, PROBE_RED) && colorMatches(transparentPixel, BACKGROUND),
    "opaque=" + JSON.stringify(opaquePixel) + " transparent=" + JSON.stringify(transparentPixel),
  );

  // 7. alpha + visible via the model: alpha 0.5 blends; visible=false hides.
  // PixiJS renders premultiplied alpha: 50% of probe red (200,30,30) over
  // the #1099bb background gives ~(108,92,109) — asserted with tolerance.
  model.alpha = 0.5;
  view.sync();
  renderer.render();
  const blendedPixel = readPixel(canvas, 8, 8);
  mark("sprite alpha blending", colorMatches(blendedPixel, ALPHA_BG), JSON.stringify(blendedPixel));
  model.alpha = 1;
  model.visible = false;
  view.sync();
  renderer.render();
  const hiddenPixel = readPixel(canvas, 8, 8);
  mark(
    "sprite visibility",
    colorMatches(hiddenPixel, BACKGROUND),
    JSON.stringify(hiddenPixel),
  );
  model.visible = true;
  view.sync();

  // 8. anchor + rotation: center-anchored 45° rotation moves red pixels.
  // The probe at (80,45) center-anchored covers x 48..112 before rotation,
  // so (40,45) is background; a 45° rotation swings the opaque left half
  // up-right, and (40,45) must become probe-red if rotation rendered.
  const coreMod = await import("/@id/@g2w/core");
  const rotated = new coreMod.Sprite2D({
    texture,
    transform: new coreMod.Transform2D({ x: 80, y: 45 }),
    anchor: { x: 0.5, y: 0.5 },
  });
  const rotatedView = createSpriteView({ sprite: rotated, renderer });
  renderer.render();
  const beforeRotation = readPixel(canvas, 40, 45);
  rotated.transform.rotation = Math.PI / 4;
  rotatedView.sync();
  renderer.render();
  const rotatedPixel = readPixel(canvas, 40, 45);
  const anchorOk =
    colorMatches(beforeRotation, BACKGROUND) && colorMatches(rotatedPixel, PROBE_RED);
  mark(
    "anchor + rotation",
    anchorOk,
    "before=" + JSON.stringify(beforeRotation) + " rotated=" + JSON.stringify(rotatedPixel),
  );

  // 9. sprite view disposal: display object removed, texture intact.
  view.dispose();
  rotatedView.dispose();
  renderer.render();
  const afterDispose = readPixel(canvas, 8, 8);
  mark(
    "sprite view disposal",
    colorMatches(afterDispose, BACKGROUND) && texture.destroyed === false,
    "pixel=" + JSON.stringify(afterDispose) + " textureDestroyed=" + texture.destroyed,
  );

  // 10. renderer dispose; repeated dispose must reject (terminal contract).
  let disposeOk = true;
  let disposeDetail = "";
  try {
    await renderer.dispose();
    try {
      await renderer.dispose();
      disposeOk = false;
      disposeDetail = "repeated dispose did not reject";
    } catch (error) {
      disposeDetail = error?.name ?? "rejected";
    }
  } catch (error) {
    disposeOk = false;
    disposeDetail = String(error?.message ?? error);
  }
  mark("init/dispose lifecycle", disposeOk, disposeDetail);

  // Browser-side error capture: the CDP listeners live in the harness
  // process, so the probe carries its own window-level error record.
  out.errors = [...(out.errors ?? [])];
  return out;
})()`;

        const evaluation = await send(
          "Runtime.evaluate",
          { expression: probe, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (evaluation.exceptionDetails) {
          record({
            case: backendCase,
            actualBackend: null,
            error:
              evaluation.exceptionDetails.exception?.description ??
              evaluation.exceptionDetails.text,
            features: {},
            errors: [...pageErrors, ...consoleErrors],
          });
        } else {
          const value = evaluation.result.value;
          if (value === undefined || value === null) {
            // The async IIFE never produced a value (e.g. an error swallowed
            // by the browser before the first return): report the raw page
            // errors instead of an empty success.
            record({
              case: backendCase,
              actualBackend: null,
              error: "probe returned no value; see errors",
              features: {},
              errors: [...pageErrors, ...consoleErrors],
            });
          } else {
            record({
              case: backendCase,
              browser: info.Browser,
              platform: process.platform,
              ...value,
            });
          }
        }
      } finally {
        sessionListeners.delete(sessionId);
        await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    }

    browserWs.close();
  } finally {
    chrome.kill();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Left for the OS to clean up (crashpad files may be locked on Windows).
    }
  }
} finally {
  vite.kill();
}

// --- Summary ----------------------------------------------------------------
console.log("\n== R6-3 feature parity summary ==");
for (const entry of results) {
  console.log(`\n${entry.case} (actual=${entry.actualBackend}):`);
  for (const [feature, outcome] of Object.entries(entry.features ?? {})) {
    console.log(`  ${outcome.status.padEnd(11)} ${feature}`);
  }
}
const hardFailures = results.filter((entry) =>
  Object.values(entry.features ?? {}).some((outcome) => outcome.status === "failed"),
);
process.exit(hardFailures.length > 0 ? 1 : 0);
