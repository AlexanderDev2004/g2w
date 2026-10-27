// E3 follow-up Part B: real-browser Web Audio autoplay verification.
//
// Boots the hello-world demo under the Vite dev server (same CDP harness
// family as the R6-2/R6-3 renderer smokes; no new packages), then drives one
// fresh headless-Chrome page through the WebAudioBackend public API to record
// ACTUAL browser autoplay behavior:
//
//   1. AudioContext creation before any user interaction (initial state).
//   2. load() while suspended (decode half of the public contract).
//   3. play() while suspended — the backend's documented autoplay guard.
//   4. backend.resume() BEFORE any user gesture (policy response recorded).
//   5. A trusted CDP click (Input.dispatchMouseEvent — real user activation,
//      never a synthetic DOM event), with backend.resume() + play() executed
//      inside the click handler.
//   6. dispose() — context closed, further use rejected, idempotent.
//
// Nothing here assumes autoplay is blocked or allowed: every state, error,
// and rejection is recorded and reported as observed. Fake-based unit tests
// are NOT evidence of browser behavior; only this harness is.
//
// CDP transport: every command connects to the PAGE's own
// `webSocketDebuggerUrl` (per-target socket). Chrome 156's browser-level
// socket only accepts browser-domain commands — page commands sent there
// answer "wasn't found", which is why a browser-socket harness hangs or
// fails here. Every await is bounded by a timeout with the pending command
// ID in the error, and all sockets/processes close in `finally` paths.
//
// Usage:
//   node scripts/smoke-audio-autoplay.mjs
// Environment:
//   G2W_CHROME      Chrome/Chromium binary (default: system Chrome)
//   G2W_SMOKE_PORT  dev-server port (default 5227); CDP port is +1
//
// This is a hardware/browser-dependent smoke harness: it is NOT part of the
// default `pnpm test` suite and needs a locally installed Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.G2W_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEV_PORT = Number(process.env.G2W_SMOKE_PORT ?? 5227);
const CDP_PORT = DEV_PORT + 1;
const DEMO_URL = `http://localhost:${DEV_PORT}/`;
const COMMAND_TIMEOUT_MS = 15000;
const STEP_TIMEOUT_MS = 30000;

const results = [];
const record = (step, entry) => {
  results.push({ step, ...entry });
  console.log(`\n[step] ${step}`);
  console.log(JSON.stringify(entry, null, 2));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { attempts, intervalMs, description }) {
  for (let i = 0; i < attempts; i++) {
    const found = await predicate();
    if (found) return found;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Attach a bounded, ID-correlated CDP client to one page's own socket. */
function connectPageSocket(wsUrl, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let messageId = 0;
    const pending = new Map();
    const eventLog = [];
    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`[${label}] WebSocket open timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      // Responses correlate by command ID; async events are handled
      // separately and only logged (no handler can stall a command).
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: res, reject: rej, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error)
          rej(
            new Error(
              `[${label}] CDP #${message.id} ${message.method ?? ""}: ${message.error.message}`,
            ),
          );
        else res(message.result);
        return;
      }
      if (message.method) eventLog.push(message.method);
    };
    ws.onopen = () => {
      clearTimeout(openTimer);
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++messageId;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(
              new Error(
                `[${label}] CDP command ${method} (id ${id}) timed out after ${COMMAND_TIMEOUT_MS}ms; pending: ${[...pending.keys()].join(", ") || "none"}`,
              ),
            );
          }, COMMAND_TIMEOUT_MS);
          pending.set(id, { resolve: res, reject: rej, timer, method });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({
        send,
        eventLog,
        close: () => ws.close(),
        pendingCount: () => pending.size,
      });
    };
    ws.onerror = (event) => {
      clearTimeout(openTimer);
      reject(new Error(`[${label}] WebSocket error: ${event?.message ?? "unknown"}`));
    };
  });
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`step "${label}" timed out after ${ms}ms`);
    }),
  ]);

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
let chrome = null;
let profileDir = null;
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
  profileDir = mkdtempSync(path.join(tmpdir(), "g2w-audio-smoke-"));
  console.log(`starting headless Chrome (${CHROME})...`);
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome's default autoplay policy, made explicit, so the recorded
      // behavior reflects what a normal user gets.
      "--autoplay-policy=document-user-activation-required",
      "--window-size=1280,800",
      // The initial page IS the demo: its /json target's own socket is what
      // we drive (no Target.createTarget/attachToTarget dance, which this
      // Chrome build answers only on browser-domain commands).
      DEMO_URL,
    ],
    { stdio: "ignore" },
  );

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

  // Wait for the demo page target to appear, then bind to ITS socket.
  // Chrome's /json page list also surfaces chrome:// UI targets; only a
  // real page whose URL is the demo counts.
  console.log(`waiting for the demo page target (expecting URL prefix ${DEMO_URL})...`);
  const pageTarget = await waitFor(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const pages = list.filter((target) => target.type === "page");
        const match = pages.find(
          (target) => target.webSocketDebuggerUrl && target.url.startsWith(DEMO_URL),
        );
        if (!match && pages.length > 0) {
          console.log(`  pages so far: ${pages.map((p) => p.url).join(" | ")}`);
        }
        return match ?? null;
      } catch {
        return null; // /json list not ready yet
      }
    },
    { attempts: 40, intervalMs: 500, description: "the demo page target" },
  );
  if (!pageTarget) {
    // Diagnostics: what DID /json contain? A stale Vite on the port or an
    // error page would show up here.
    const all = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json().catch(() => []);
    console.error(
      `page targets seen: ${JSON.stringify(
        all.map((t) => ({ type: t.type, url: t.url })),
        null,
        2,
      )}`,
    );
    throw new Error(
      "no page target matching the demo URL was found in /json (is the demo still loading?)",
    );
  }
  console.log(`demo page target: ${pageTarget.url}`);
  const versionInfo = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  console.log(`browser: ${versionInfo.Browser}`);

  const cdp = await connectPageSocket(pageTarget.webSocketDebuggerUrl, "page");
  try {
    await cdp.send("Runtime.enable");

    // Let the demo's async bootstrap settle, then run the pre-gesture probe.
    await sleep(1000);

    // Sanity probe first: prove this socket can evaluate at all, so a real
    // failure in the big probe is never mistaken for a dead transport.
    const sanity = await withTimeout(
      cdp.send("Runtime.evaluate", { expression: "1+1", returnByValue: true }),
      COMMAND_TIMEOUT_MS,
      "sanity evaluate",
    );
    if (sanity.result?.value !== 2) {
      throw new Error(
        `sanity evaluate returned ${JSON.stringify(sanity)} — transport is not usable`,
      );
    }
    console.log("CDP transport sanity check: OK (1+1 = 2)");

    // Minimal import probe first: dynamic import through Vite can itself be
    // the slow step; time it separately so the big probe never blames the
    // transport for what is module loading.
    const importProbe = await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: `import("/@id/@g2w/audio-web").then((m) => typeof m.WebAudioBackend)`,
        awaitPromise: true,
        returnByValue: true,
      }),
      COMMAND_TIMEOUT_MS,
      "audio-web import probe",
    );
    if (importProbe.exceptionDetails) {
      throw new Error(
        `audio-web import threw: ${importProbe.exceptionDetails.exception?.description ?? importProbe.exceptionDetails.text}`,
      );
    }
    console.log(`audio-web import probe: WebAudioBackend = ${importProbe.result?.value}`);

    const preGesture = await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: `(() => {
  return import("/@id/@g2w/audio-web").then((module) => {
    const { WebAudioBackend } = module;
    return (async () => {
    const steps = {};
    const record = (name, value) => { steps[name] = value; };
    const describeError = (error) => ({
      name: error?.name ?? String(error),
      message: String(error?.message ?? error),
    });
    const backend = new WebAudioBackend({ context: new AudioContext() });

    // 1. Context creation before any user interaction.
    record("stateAfterCreation", backend.state);

    // 2. load() while suspended: decoding must work for play() to have
    //    something to guard. Record reality, never assume it.
    let loadOutcome;
    try {
      await backend.load("assets/beep.wav");
      loadOutcome = { ok: true };
    } catch (error) {
      loadOutcome = { ok: false, error: describeError(error) };
    }
    record("loadWhileSuspended", loadOutcome);

    // 3. play() while suspended — the backend's documented autoplay guard.
    let playSuspendedOutcome;
    if (loadOutcome.ok) {
      try {
        const sound = await backend.load("assets/beep.wav");
        const playback = sound.play();
        playSuspendedOutcome = { ok: true, note: "playback started while suspended (inaudible)" };
        playback.stop();
      } catch (error) {
        playSuspendedOutcome = { ok: false, error: describeError(error) };
      }
    } else {
      playSuspendedOutcome = { skipped: "load failed; play guard not observable" };
    }
    record("playWhileSuspended", playSuspendedOutcome);

    // 4. resume() BEFORE any user gesture — record the policy response.
    //    Under Chrome's document-user-activation-required policy the resume
    //    promise never settles before a gesture (verified: pending
    //    indefinitely), so never await it unbounded; race it against a
    //    bounded in-page delay and record whether it settled.
    const RESUME_SETTLE_MS = 3000;
    let resumeBeforeGestureOutcome;
    try {
      let settled = false;
      await Promise.race([
        backend.resume().then(() => { settled = true; }),
        new Promise((resolve) => setTimeout(resolve, RESUME_SETTLE_MS)),
      ]);
      resumeBeforeGestureOutcome = { settled, stateAfter: backend.state };
    } catch (error) {
      resumeBeforeGestureOutcome = { ok: false, error: describeError(error), stateAfter: backend.state };
    }
    record("resumeBeforeGesture", resumeBeforeGestureOutcome);
    return steps;
    })();
  });
})()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      STEP_TIMEOUT_MS,
      "pre-gesture probe",
    );
    if (preGesture.exceptionDetails) {
      throw new Error(
        `pre-gesture probe threw: ${preGesture.exceptionDetails.exception?.description ?? preGesture.exceptionDetails.text}`,
      );
    }
    record("preGesture", preGesture.result.value);

    // 5. A REAL user gesture: a trusted CDP click, with resume() + play()
    //    executed inside the click handler — the same sequence the demo's
    //    menu scene runs for its beep.
    const gestureSetup = await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: `(() => {
  window.__audioSmoke = new Promise((resolve) => {
    document.addEventListener("click", () => {
      (async () => {
        const out = {};
        const describeError = (error) => ({
          name: error?.name ?? String(error),
          message: String(error?.message ?? error),
        });
        const { WebAudioBackend } = await import("/@id/@g2w/audio-web");
        const backend = new WebAudioBackend({ context: new AudioContext() });
        out.activationAtGesture = navigator.userActivation
          ? { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive }
          : "n/a";
        // resume() inside the gesture handler.
        try {
          await backend.resume();
          out.resumeInsideGesture = { ok: true, stateAfter: backend.state };
        } catch (error) {
          out.resumeInsideGesture = { ok: false, error: describeError(error) };
        }
        // play() after the gesture.
        if (out.resumeInsideGesture.ok) {
          try {
            const sound = await backend.load("assets/beep.wav");
            const playback = sound.play();
            playback.stop();
            out.playAfterGesture = { ok: true, stateDuring: backend.state };
          } catch (error) {
            out.playAfterGesture = { ok: false, error: describeError(error) };
          }
        }
        resolve(out);
      })();
    }, { once: true });
  });
  return "handler registered";
})()`,
        returnByValue: true,
      }),
      STEP_TIMEOUT_MS,
      "gesture handler registration",
    );
    if (gestureSetup.exceptionDetails) {
      throw new Error(
        `gesture registration threw: ${gestureSetup.exceptionDetails.exception?.description ?? gestureSetup.exceptionDetails.text}`,
      );
    }
    console.log(`\n[step] gesture handler: ${gestureSetup.result.value}`);

    // Trusted click via CDP input domain — user activation from the
    // browser's perspective, NOT a synthetic element.click().
    await withTimeout(
      cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 400,
        y: 300,
        button: "left",
        clickCount: 1,
      }),
      COMMAND_TIMEOUT_MS,
      "trusted click (press)",
    );
    await withTimeout(
      cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 400,
        y: 300,
        button: "left",
        clickCount: 1,
      }),
      COMMAND_TIMEOUT_MS,
      "trusted click (release)",
    );
    const gestureOutcome = await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: "window.__audioSmoke",
        awaitPromise: true,
        returnByValue: true,
      }),
      STEP_TIMEOUT_MS,
      "gesture promise",
    );
    if (gestureOutcome.exceptionDetails) {
      throw new Error(
        `gesture promise threw: ${gestureOutcome.exceptionDetails.exception?.description ?? gestureOutcome.exceptionDetails.text}`,
      );
    }
    record("postGesture", gestureOutcome.result.value);

    // 6. Disposal and cleanup on a fresh backend instance.
    const disposeOutcome = await withTimeout(
      cdp.send("Runtime.evaluate", {
        expression: `(() => {
  return (async () => {
    const out = {};
    const describeError = (error) => ({
      name: error?.name ?? String(error),
      message: String(error?.message ?? error),
    });
    const { WebAudioBackend } = await import("/@id/@g2w/audio-web");
    const backend = new WebAudioBackend({ context: new AudioContext() });
    const sound = await backend.load("assets/beep.wav");
    const playback = sound.play();
    out.stateBeforeDispose = backend.state;
    playback.stop();
    backend.dispose();
    out.disposeIdempotent = (() => { backend.dispose(); return true; })();
    out.stateAfterDispose = backend.state;
    try {
      await backend.load("assets/beep.wav");
      out.loadAfterDispose = { ok: true, note: "UNEXPECTED: load succeeded after disposal" };
    } catch (error) {
      out.loadAfterDispose = { ok: false, error: describeError(error) };
    }
    try {
      sound.play();
      out.playAfterDispose = { ok: true, note: "UNEXPECTED: play succeeded on a closed context" };
    } catch (error) {
      out.playAfterDispose = { ok: false, error: describeError(error) };
    }
    try {
      await backend.resume();
      out.resumeAfterDispose = { ok: true, note: "UNEXPECTED: resume succeeded after disposal" };
    } catch (error) {
      out.resumeAfterDispose = { ok: false, error: describeError(error) };
    }
    return out;
  })();
})()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      STEP_TIMEOUT_MS,
      "dispose probe",
    );
    if (disposeOutcome.exceptionDetails) {
      throw new Error(
        `dispose probe threw: ${disposeOutcome.exceptionDetails.exception?.description ?? disposeOutcome.exceptionDetails.text}`,
      );
    }
    record("dispose", disposeOutcome.result.value);

    // --- Verdict ------------------------------------------------------------
    const pre = preGesture.result.value;
    const gesture = gestureOutcome.result.value;
    const disposeRaw = disposeOutcome.result.value;
    const disposeVerdict = {
      contextClosed: disposeRaw.stateAfterDispose === "closed",
      idempotent: disposeRaw.disposeIdempotent === true,
      loadRejected: disposeRaw.loadAfterDispose.ok === false,
      playRejected: disposeRaw.playAfterDispose.ok === false,
      resumeRejected: disposeRaw.resumeAfterDispose.ok === false,
    };
    const summary = {
      browser: versionInfo.Browser,
      platform: "headless Chrome, Windows",
      contextStateAfterCreation: pre.stateAfterCreation,
      loadWhileSuspended: pre.loadWhileSuspended.ok
        ? "succeeded"
        : `failed: ${pre.loadWhileSuspended.error?.name}`,
      playWhileSuspended: pre.playWhileSuspended.ok
        ? "started (no autoplay block in this environment)"
        : pre.playWhileSuspended.skipped
          ? `skipped: ${pre.playWhileSuspended.skipped}`
          : `rejected: ${pre.playWhileSuspended.error?.name}: ${pre.playWhileSuspended.error?.message}`,
      resumeBeforeGesture: pre.resumeBeforeGesture.ok
        ? `succeeded -> ${pre.resumeBeforeGesture.stateAfter}`
        : pre.resumeBeforeGesture.error
          ? `rejected: ${pre.resumeBeforeGesture.error.name}`
          : pre.resumeBeforeGesture.settled
            ? `settled -> ${pre.resumeBeforeGesture.stateAfter}`
            : `did not settle before gesture (still ${pre.resumeBeforeGesture.stateAfter})`,
      activationAtGesture: gesture.activationAtGesture,
      resumeInsideGesture: gesture.resumeInsideGesture?.ok
        ? `succeeded -> ${gesture.resumeInsideGesture.stateAfter}`
        : `rejected: ${gesture.resumeInsideGesture?.error?.name}`,
      playAfterGesture: gesture.playAfterGesture?.ok
        ? "playback started and stopped cleanly"
        : `rejected: ${gesture.playAfterGesture?.error?.name}`,
      dispose: disposeVerdict,
      consoleOrPageEvents: cdp.eventLog.filter((name) => name.includes("error")).slice(0, 5),
      pendingCdpCommands: cdp.pendingCount(),
    };
    console.log("\n== E3 Part B Web Audio autoplay summary ==");
    console.log(JSON.stringify(summary, null, 2));

    const problems = [
      disposeVerdict.contextClosed ? null : "dispose did not close the context",
      disposeVerdict.idempotent ? null : "dispose was not idempotent",
      disposeVerdict.loadRejected ? null : "load after dispose was not rejected",
      disposeVerdict.playRejected ? null : "play after dispose was not rejected",
      gesture.resumeInsideGesture?.ok ? null : "resume inside a real gesture did not succeed",
      gesture.playAfterGesture?.ok ? null : "play after a real gesture did not start",
    ].filter(Boolean);
    if (problems.length > 0) {
      console.error(`problems: ${problems.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("verdict: autoplay policy behaves as documented; cleanup guarantees held");
    }
  } finally {
    cdp.close();
  }
} catch (error) {
  console.error(`\nsmoke failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  if (chrome) chrome.kill();
  if (profileDir) {
    // Chrome keeps crashpad files locked for a moment after kill on Windows;
    // the profile lives in the OS temp dir anyway, so cleanup is best-effort.
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Left for the OS to clean up.
    }
  }
  vite.kill();
}
