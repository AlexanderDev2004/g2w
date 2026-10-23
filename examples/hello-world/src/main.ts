import { Game } from "@g2w/core";
import { PixiRenderer } from "@g2w/renderer-pixi";
import { Graphics } from "pixi.js";

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
    errorBox.textContent = `Failed to start the g2w demo:\n${error instanceof Error ? error.message : String(error)}`;
    errorBox.hidden = false;
  }
  console.error(error);
}

try {
  const renderer = new PixiRenderer();
  const square = new Graphics().rect(0, 0, SQUARE_SIZE, SQUARE_SIZE).fill({ color: 0xffd166 });

  let distance = 0;
  const game = new Game({
    renderer,
    canvas,
    backgroundColor: "#1099bb",
    resolution: window.devicePixelRatio || 1,
    onUpdate: (deltaTime) => {
      distance = (distance + SPEED * deltaTime) % (VIEW_WIDTH - SQUARE_SIZE);
      square.x = distance;
      square.y = (VIEW_HEIGHT - SQUARE_SIZE) / 2;
    },
  });

  window.addEventListener("pagehide", () => {
    void game.dispose().catch((error: unknown) => console.error(error));
  });

  await game.init();
  renderer.stage.addChild(square);
  game.start();
} catch (error) {
  showError(error);
}
