import { InputState, type Scene, SceneManager } from "@g2w/core";
import { DomInput } from "@g2w/input-dom";
import { PixiRenderer } from "@g2w/renderer-pixi";
import { G2WGame } from "@g2w/runtime";
import { Graphics } from "pixi.js";
import { nextPlayerPosition, PLAYER_SIZE } from "./scenes/play-scene.js";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 360;

function showError(error: unknown): void {
  const errorBox = document.querySelector<HTMLPreElement>("#error");
  if (errorBox !== null) {
    errorBox.textContent = `game error:\n${error instanceof Error ? error.message : String(error)}`;
    errorBox.hidden = false;
  }
  console.error(error);
}

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#game");
  if (canvas === null) {
    throw new Error("required DOM element #game is missing.");
  }

  // The renderer and input adapters are created here at the application
  // boundary. All game logic reads input only through the core InputState —
  // there are no DOM event handlers in game code.
  const renderer = new PixiRenderer();
  const input = new InputState();
  const domInput = new DomInput(input, {
    canvas,
    keyTarget: window,
    blurTarget: window,
    // Pointer and key coordinates arrive in the game's logical space.
    logicalSize: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
  });

  // PixiJS display objects stay at the adapter boundary: core scenes are
  // renderer-agnostic and never touch PixiJS types. This demo draws one
  // square that the player steers with WASD or the arrow keys.
  const square = new Graphics().rect(0, 0, PLAYER_SIZE, PLAYER_SIZE).fill({ color: 0xffd166 });

  // G2WGame owns the application lifecycle: it drives the renderer, the
  // frame loop, and disposal. The frame path is a plain synchronous update —
  // no Effect work, promises, or allocations per frame.
  const game = new G2WGame({
    renderer,
    canvas,
    backgroundColor: "#1099bb",
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    resolution: window.devicePixelRatio || 1,
    onUpdate: (deltaTime) => {
      scenes.update(deltaTime);
      // The input frame boundary: per-frame pressed/released edges reset
      // here, after every consumer has read this frame's state.
      input.endFrame();
    },
  });
  await game.init();

  const player = { x: (VIEW_WIDTH - PLAYER_SIZE) / 2, y: VIEW_HEIGHT - PLAYER_SIZE - 40 };
  const playScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(square);
    },
    update(deltaTime) {
      const next = nextPlayerPosition(input, player, deltaTime, {
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
      });
      player.x = next.x;
      player.y = next.y;
      square.x = next.x;
      square.y = next.y;
    },
    exit() {
      renderer.stage.removeChild(square);
    },
    dispose() {
      square.destroy();
    },
  };

  const scenes = new SceneManager({ scenes: { play: playScene }, initial: "play" });
  // Scene disposal joins the game's LIFO finalizer chain, so shutdown
  // releases scenes before the renderer.
  game.addFinalizer(() => scenes.dispose());

  window.addEventListener("pagehide", () => {
    // Adapters first (no further events reach the state), then the game.
    // G2WGame disposal is idempotent, so a repeated pagehide is safe.
    try {
      domInput.dispose();
    } catch (error: unknown) {
      console.error(error);
    }
    void game.dispose().catch((error: unknown) => console.error(error));
  });

  domInput.attach();
  scenes.start();
  game.start();
  // Smoke-test hook: proves the loop is up without inspecting pixels.
  (window as { __G2W_STARTED?: boolean }).__G2W_STARTED = true;
} catch (error) {
  showError(error);
}
