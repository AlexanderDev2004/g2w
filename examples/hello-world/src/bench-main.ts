// R13 Phase 1 runtime benchmark scene: N sprites driven through the public
// g2w API (core Game loop, GameObjectCollection, Sprite2D + createSpriteView).
// The headless harness (scripts/benchmark-runtime.mjs) opens this page with
// ?sprites=N, waits for the ready flag, then samples the counters below.
//
// This page exists for measurement only and ships nowhere: it is an extra
// dev-server entry in the hello-world example, not part of the demo itself.
import { Game, type GameObject, GameObjectCollection, Sprite2D, Transform2D } from "@g2w/core";
import { createSpriteView, PixiRenderer, type SpriteView } from "@g2w/renderer-pixi";
import { Texture } from "pixi.js";

const canvas = document.querySelector<HTMLCanvasElement>("#bench-canvas");
const errorBox = document.querySelector<HTMLPreElement>("#bench-error");
if (canvas === null || errorBox === null) {
  throw new Error("bench: required DOM elements (#bench-canvas, #bench-error) are missing.");
}

const params = new URLSearchParams(window.location.search);
const SPRITES = Number.parseInt(params.get("sprites") ?? "1000", 10);
if (!Number.isInteger(SPRITES) || SPRITES <= 0 || SPRITES > 50_000) {
  throw new Error(`bench: invalid ?sprites value "${params.get("sprites")}"`);
}

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 360;

// Counters the harness polls. `ready` flips true after the first rendered
// frame, so the harness never samples a cold start.
interface BenchCounters {
  ready: boolean;
  sprites: number;
  frames: number;
  /** Sum of per-frame intervals (ms) as seen by the update hook. */
  frameMsTotal: number;
  /** Ring buffer of the last ~900 frame intervals (ms) for percentiles. */
  ring: number[];
}
declare global {
  interface Window {
    __g2wBench?: BenchCounters;
  }
}
const counters: BenchCounters = {
  ready: false,
  sprites: SPRITES,
  frames: 0,
  frameMsTotal: 0,
  ring: [],
};
window.__g2wBench = counters;

function showError(error: unknown): void {
  if (errorBox !== null) {
    errorBox.textContent = `g2w bench error:\n${error instanceof Error ? error.message : String(error)}`;
    errorBox.hidden = false;
  }
  console.error(error);
}

try {
  // A shared 8x8 white texture generated locally — no network, no asset
  // loading: the benchmark measures the sprite pipeline, not downloads.
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const context = tile.getContext("2d");
  if (context === null) throw new Error("bench: 2d context unavailable");
  context.fillStyle = "#ffd166";
  context.fillRect(0, 0, 8, 8);
  const texture = Texture.from(tile);

  const renderer = new PixiRenderer();
  const objects = new GameObjectCollection();
  const views: SpriteView<Texture>[] = [];

  // The core Game — the reference implementation of the frame loop. The hot
  // path is identical to the G2WGame path: one synchronous update per frame,
  // no Effect, no promises. Frame intervals are observed from the update
  // hook, which is the whole frame as the game experiences it (update +
  // render happen inside the loop's tick).
  let lastTick = performance.now();
  const game = new Game({
    renderer,
    canvas,
    backgroundColor: "#1099bb",
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    resolution: 1,
    onUpdate: () => {
      const now = performance.now();
      const frameMs = now - lastTick;
      lastTick = now;
      objects.update(frameMs / 1000);
      counters.frames += 1;
      counters.frameMsTotal += frameMs;
      if (counters.ring.length >= 900) counters.ring.shift();
      counters.ring.push(frameMs);
      if (!counters.ready && counters.frames >= 2) counters.ready = true;
    },
  });
  await game.init();

  // Views attach to the renderer's stage, which exists only after init —
  // createSpriteView throws before it (same ordering as the demo's main.ts).
  interface BenchSprite extends GameObject {
    phase: number;
  }
  for (let i = 0; i < SPRITES; i++) {
    const model = new Sprite2D({
      texture,
      transform: new Transform2D({
        x: VIEW_WIDTH / 2,
        y: VIEW_HEIGHT / 2,
        scaleX: 0.75,
        scaleY: 0.75,
      }),
      anchor: { x: 0.5, y: 0.5 },
    });
    const view = createSpriteView({ sprite: model, renderer });
    views.push(view);
    const phase = (i / SPRITES) * Math.PI * 2;
    const sprite: BenchSprite = {
      transform: model.transform,
      phase,
      update(deltaTime) {
        const age = performance.now() / 1000;
        const radius = 120 + 40 * Math.sin(age + phase);
        sprite.transform.x = VIEW_WIDTH / 2 + Math.cos(age * 0.8 + phase) * radius;
        sprite.transform.y = VIEW_HEIGHT / 2 + Math.sin(age * 1.3 + phase) * radius * 0.6;
        sprite.transform.rotation += deltaTime * 2;
        view.sync();
      },
    };
    objects.add(sprite);
  }

  lastTick = performance.now();
  game.start();
} catch (error) {
  showError(error);
}
