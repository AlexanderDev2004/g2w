import { Game, InputState, type Scene, SceneManager } from "@g2w/core";
import { DomInput } from "@g2w/input-dom";
import { PixiRenderer } from "@g2w/renderer-pixi";
import { Graphics, Text } from "pixi.js";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const errorBox = document.querySelector<HTMLPreElement>("#error");
if (canvas === null || errorBox === null) {
  throw new Error("hello-world: required DOM elements (#game, #error) are missing.");
}

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 360;
const SQUARE_SIZE = 48;
const SPEED = 120; // logical pixels per second

function showError(error: unknown): void {
  if (errorBox !== null) {
    errorBox.textContent = `g2w demo error:\n${error instanceof Error ? error.message : String(error)}`;
    errorBox.hidden = false;
  }
  console.error(error);
}

try {
  const renderer = new PixiRenderer();

  // The input path: a DOM-free InputState from @g2w/core, fed by the browser
  // adapter from @g2w/input-dom. All game logic below reads input only through
  // this state — there are no DOM event handlers in game logic.
  const input = new InputState();
  const domInput = new DomInput(input, { canvas, keyTarget: window, blurTarget: window });

  // PixiJS objects live here, at the adapter boundary: @g2w/core scenes are
  // renderer-agnostic and never touch PixiJS types.
  const title = new Text({
    text: "g2w input demo",
    style: { fontFamily: "system-ui, sans-serif", fontSize: 32, fill: 0xffffff },
  });
  title.anchor.set(0.5);
  title.position.set(VIEW_WIDTH / 2, VIEW_HEIGHT / 2 - 24);

  const menuHint = new Text({
    text: "click to play",
    style: { fontFamily: "system-ui, sans-serif", fontSize: 16, fill: 0xaaccff },
  });
  menuHint.anchor.set(0.5);
  menuHint.position.set(VIEW_WIDTH / 2, VIEW_HEIGHT / 2 + 20);

  const playHint = new Text({
    text: "move: WASD/arrows — Esc returns to the menu",
    style: { fontFamily: "system-ui, sans-serif", fontSize: 16, fill: 0xaaccff },
  });
  playHint.anchor.set(0.5);
  playHint.position.set(VIEW_WIDTH / 2, VIEW_HEIGHT - 24);

  const square = new Graphics().rect(0, 0, SQUARE_SIZE, SQUARE_SIZE).fill({ color: 0xffd166 });
  let squareX = (VIEW_WIDTH - SQUARE_SIZE) / 2;
  let squareY = VIEW_HEIGHT - SQUARE_SIZE - 40;

  const menuScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(title, menuHint);
    },
    update() {
      // Pointer position and button edges come from the framework input state.
      const pointer = input.hasPointerPosition
        ? `pointer: ${Math.round(input.pointerX)}, ${Math.round(input.pointerY)}`
        : "pointer: move over the canvas";
      menuHint.text = `click to play — ${pointer}`;
      if (input.wasButtonPressed(0)) {
        scenes.goTo("gameplay");
      }
    },
    exit() {
      renderer.stage.removeChild(title, menuHint);
    },
    dispose() {
      title.destroy();
      menuHint.destroy();
    },
  };

  const gameplayScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(square, playHint);
    },
    update(deltaTime) {
      // Movement reads held keys from the framework input state.
      let moveX = 0;
      let moveY = 0;
      if (input.isKeyDown("KeyA") || input.isKeyDown("ArrowLeft")) {
        moveX -= 1;
      }
      if (input.isKeyDown("KeyD") || input.isKeyDown("ArrowRight")) {
        moveX += 1;
      }
      if (input.isKeyDown("KeyW") || input.isKeyDown("ArrowUp")) {
        moveY -= 1;
      }
      if (input.isKeyDown("KeyS") || input.isKeyDown("ArrowDown")) {
        moveY += 1;
      }
      squareX = Math.min(
        Math.max(squareX + moveX * SPEED * deltaTime, 0),
        VIEW_WIDTH - SQUARE_SIZE,
      );
      squareY = Math.min(
        Math.max(squareY + moveY * SPEED * deltaTime, 0),
        VIEW_HEIGHT - SQUARE_SIZE,
      );
      square.x = squareX;
      square.y = squareY;

      const heldKeys = [
        input.isKeyDown("KeyW"),
        input.isKeyDown("KeyS"),
        input.isKeyDown("KeyA"),
        input.isKeyDown("KeyD"),
      ].filter(Boolean).length;
      playHint.text = `held keys: ${heldKeys} — Esc returns to the menu`;
      if (input.wasKeyPressed("Escape")) {
        scenes.goTo("menu");
      }
    },
    exit() {
      renderer.stage.removeChild(square, playHint);
    },
    dispose() {
      square.destroy();
      playHint.destroy();
    },
  };

  const scenes = new SceneManager({
    scenes: { menu: menuScene, gameplay: gameplayScene },
    initial: "menu",
  });

  const game = new Game({
    renderer,
    canvas,
    backgroundColor: "#1099bb",
    resolution: window.devicePixelRatio || 1,
    // No second loop: the active scene is updated by the existing game loop,
    // and the input frame boundary sits right after every consumer.
    onUpdate: (deltaTime) => {
      scenes.update(deltaTime);
      input.endFrame();
    },
  });

  window.addEventListener("pagehide", () => {
    // Adapter first (no further events reach the state), then scenes (they
    // remove their children from the stage), then the game.
    try {
      domInput.dispose();
      scenes.dispose();
    } catch (error: unknown) {
      console.error(error);
    }
    void game.dispose().catch((error: unknown) => console.error(error));
  });

  await game.init();
  domInput.attach();
  scenes.start();
  game.start();
} catch (error) {
  showError(error);
}
