import { Game, InputState, type Scene, SceneManager } from "@g2w/core";
import { DomInput } from "@g2w/input-dom";
import { createTextureAssetManager, PixiRenderer } from "@g2w/renderer-pixi";
import { Graphics, Sprite, Text } from "pixi.js";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const errorBox = document.querySelector<HTMLPreElement>("#error");
const loadingBox = document.querySelector<HTMLParagraphElement>("#loading");
if (canvas === null || errorBox === null || loadingBox === null) {
  throw new Error("hello-world: required DOM elements (#game, #error, #loading) are missing.");
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

  // The asset path: the app creates and owns one texture asset manager. All
  // game logic loads through this public API — no direct PixiJS Assets calls.
  const assets = createTextureAssetManager();
  const LOGO_URL = "assets/g2w-logo.png";
  loadingBox.hidden = false;
  const logo = await assets.load(LOGO_URL);
  // A repeated request is served from the cache: same manager call, same
  // texture instance, no second load.
  const logoFromCache = await assets.load(LOGO_URL);
  const logoWasCached = logoFromCache === logo;
  loadingBox.hidden = true;

  // PixiJS objects live here, at the adapter boundary: @g2w/core scenes are
  // renderer-agnostic and never touch PixiJS types.
  const title = new Text({
    text: "g2w asset demo",
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

  // The loaded texture is rendered through a sprite. The sprite belongs to
  // the gameplay scene and is destroyed with it; the texture comes from
  // PixiJS's shared Assets cache and is never destroyed by the manager, so
  // the sprite is destroyed without destroying the texture.
  const logoSprite = new Sprite(logo);
  logoSprite.position.set(16, VIEW_HEIGHT - logo.height - 16);

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
      const cacheNote = logoWasCached ? "texture cache: hit" : "texture cache: miss";
      menuHint.text = `click to play — ${pointer} — ${cacheNote}`;
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
      renderer.stage.addChild(square, playHint, logoSprite);
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
      renderer.stage.removeChild(square, playHint, logoSprite);
    },
    dispose() {
      // Destroy the sprite, not its texture: the texture is owned by the
      // asset manager and released by assets.dispose() during teardown.
      square.destroy();
      playHint.destroy();
      logoSprite.destroy();
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
    // destroy their sprites and remove their children from the stage), then
    // the game (releases the renderer), and finally the asset manager (it
    // releases its cache; the textures themselves are never destroyed by the
    // manager — the page unload reclaims them).
    try {
      domInput.dispose();
      scenes.dispose();
    } catch (error: unknown) {
      console.error(error);
    }
    void game
      .dispose()
      .then(() => assets.dispose())
      .catch((error: unknown) => console.error(error));
  });

  await game.init();
  domInput.attach();
  scenes.start();
  game.start();
} catch (error) {
  showError(error);
}
