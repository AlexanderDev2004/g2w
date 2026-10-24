import { Game, InputState, type Scene, SceneManager, Sprite2D, Transform2D } from "@g2w/core";
import { DomInput } from "@g2w/input-dom";
import { createSpriteView, createTextureAssetManager, PixiRenderer } from "@g2w/renderer-pixi";
import { Graphics, Text } from "pixi.js";

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

  // The renderer must be initialized before any view can attach to its
  // stage: createSpriteView reads renderer.stage, which throws before init.
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
  await game.init();

  // The loaded texture is rendered through the renderer-agnostic sprite API:
  // a core Sprite2D model plus a renderer-created view. Game logic mutates
  // the model and calls view.sync(); it never touches PixiJS objects. The
  // view owns its display object only — the shared texture is never
  // destroyed by view disposal.
  const logoModel = new Sprite2D({
    texture: logo,
    transform: new Transform2D({ x: 16, y: VIEW_HEIGHT - logo.height - 16 }),
  });
  const logoView = createSpriteView({ sprite: logoModel, renderer });

  const menuScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(title, menuHint);
      // The logo lives in the gameplay scene; hide it through the model.
      logoModel.visible = false;
      logoView.sync();
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
      renderer.stage.addChild(square, playHint);
      logoModel.visible = true;
      logoView.sync();
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

      // The logo sprite is driven entirely through the core sprite model:
      // rotation accumulates with deltaTime (radians per second) and the
      // scale pulses between 1 and 1.25. One sync applies everything.
      logoModel.transform.rotation += deltaTime * 1.5;
      const pulse = 1 + 0.125 * Math.sin(performance.now() / 400);
      logoModel.transform.scaleX = pulse;
      logoModel.transform.scaleY = pulse;
      logoView.sync();

      playHint.text = `held keys: ${heldKeys} — Esc returns to the menu`;
      if (input.wasKeyPressed("Escape")) {
        scenes.goTo("menu");
      }
    },
    exit() {
      renderer.stage.removeChild(square, playHint);
      logoModel.visible = false;
      logoView.sync();
    },
    dispose() {
      // Destroy the scene's display objects; the sprite view removes and
      // destroys only its own display object — never the shared texture.
      square.destroy();
      playHint.destroy();
      logoView.dispose();
    },
  };

  const scenes = new SceneManager({
    scenes: { menu: menuScene, gameplay: gameplayScene },
    initial: "menu",
  });

  window.addEventListener("pagehide", () => {
    // Adapter first (no further events reach the state), then scenes (they
    // destroy their sprites and remove their children from the stage), then
    // the game (releases the renderer), and finally the asset manager (it
    // releases its cache). Neither the manager nor the renderer ever destroys
    // textures — the renderer owns display objects only, and the manager's
    // policy is non-destructive — so the page unload reclaims them.
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

  domInput.attach();
  scenes.start();
  game.start();
} catch (error) {
  showError(error);
}
