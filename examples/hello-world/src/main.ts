import { Game, type Scene, SceneManager } from "@g2w/core";
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

  // PixiJS objects live here, at the adapter boundary: @g2w/core scenes are
  // renderer-agnostic and never touch PixiJS types.
  const title = new Text({
    text: "g2w scene demo",
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
    text: "click to return to the menu",
    style: { fontFamily: "system-ui, sans-serif", fontSize: 16, fill: 0xaaccff },
  });
  playHint.anchor.set(0.5);
  playHint.position.set(VIEW_WIDTH / 2, VIEW_HEIGHT - 24);

  const square = new Graphics().rect(0, 0, SQUARE_SIZE, SQUARE_SIZE).fill({ color: 0xffd166 });

  // Per-scene frame counters make visible that only the active scene updates.
  let menuUpdates = 0;
  let gameplayUpdates = 0;
  let squareX = 0;
  let direction = 1;

  const menuScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(title, menuHint);
    },
    update() {
      menuUpdates += 1;
      menuHint.text = `click to play — menu updates: ${menuUpdates}`;
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
      // The square only moves while this scene is active.
      squareX += SPEED * deltaTime * direction;
      if (squareX > VIEW_WIDTH - SQUARE_SIZE) {
        squareX = VIEW_WIDTH - SQUARE_SIZE;
        direction = -1;
      } else if (squareX < 0) {
        squareX = 0;
        direction = 1;
      }
      square.x = squareX;
      square.y = (VIEW_HEIGHT - SQUARE_SIZE) / 2;
      gameplayUpdates += 1;
      playHint.text = `click to return to the menu — gameplay updates: ${gameplayUpdates}`;
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
    // No second loop: the active scene is updated by the existing game loop.
    onUpdate: (deltaTime) => scenes.update(deltaTime),
  });

  // Plain DOM events in the example; an input system is out of g2w's scope.
  canvas.addEventListener("click", () => {
    // active is null after disposal, which also guards against late clicks.
    try {
      if (scenes.active === "menu") {
        scenes.goTo("gameplay");
      } else if (scenes.active !== null) {
        scenes.goTo("menu");
      }
    } catch (error: unknown) {
      // A scene hook failure surfaces on the page instead of only the console.
      showError(error);
    }
  });

  window.addEventListener("pagehide", () => {
    // Scenes first (they remove their children from the stage), then the game.
    try {
      scenes.dispose();
    } catch (error: unknown) {
      console.error(error);
    }
    void game.dispose().catch((error: unknown) => console.error(error));
  });

  await game.init();
  scenes.start();
  game.start();
} catch (error) {
  showError(error);
}
