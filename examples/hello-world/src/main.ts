import { WebAudioBackend } from "@g2w/audio-web";
import {
  AudioManager,
  Game,
  type GameObject,
  GameObjectCollection,
  GamepadState,
  InputState,
  type Scene,
  SceneManager,
  Sprite2D,
  Transform2D,
} from "@g2w/core";
import type { DevTools } from "@g2w/devtools";
import { DomInput } from "@g2w/input-dom";
import { GamepadInput } from "@g2w/input-gamepad";
import {
  createSpriteView,
  createTextureAssetManager,
  PixiRenderer,
  type SpriteView,
} from "@g2w/renderer-pixi";
import { Graphics, Text, type Texture } from "pixi.js";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const errorBox = document.querySelector<HTMLPreElement>("#error");
const loadingBox = document.querySelector<HTMLParagraphElement>("#loading");
if (canvas === null || errorBox === null || loadingBox === null) {
  throw new Error("hello-world: required DOM elements (#game, #error, #loading) are missing.");
}

// The development-only DevTools overlay; null in production builds.
let devtools: DevTools | null = null;

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
  const domInput = new DomInput(input, {
    canvas,
    keyTarget: window,
    blurTarget: window,
    // Pointer coordinates arrive in the game's logical space (the renderer's
    // stage coordinates), not the canvas's backing resolution.
    logicalSize: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
  });

  // The gamepad path (R5): a DOM-free GamepadState from @g2w/core, sampled
  // by the browser adapter from @g2w/input-gamepad. Sampling is explicit —
  // poll() runs once per game frame in the loop below, right before the
  // scenes read the state. No second loop, no hidden timers.
  const gamepadState = new GamepadState();
  const gamepadInput = new GamepadInput(gamepadState);

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

  // The audio path: a core AudioManager over the Web Audio backend. All game
  // logic plays through the public audio API — no direct AudioContext calls
  // in game logic. The context starts suspended under browser autoplay
  // policies; decoding works anyway, and the first resume() happens inside
  // the menu click handler below (a real user gesture) before the first
  // playback, so playback never fails silently.
  const audioBackend = new WebAudioBackend({ context: new AudioContext() });
  const audio = new AudioManager({ backend: audioBackend });
  const BEEP_URL = "assets/beep.wav";
  await audio.load(BEEP_URL);
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
    // Logical resolution: the stage coordinate space all game code uses.
    // The drawing buffer is width×height×resolution; the canvas's CSS size
    // (autoDensity) starts at width×height and the page scales it down
    // proportionally on smaller viewports.
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    resolution: window.devicePixelRatio || 1,
    // No second loop: the active scene is updated by the existing game loop,
    // and the input frame boundary sits right after every consumer. The
    // gamepad poll runs first so this frame's samples are what scenes read.
    onUpdate: (deltaTime) => {
      gamepadInput.poll();
      scenes.update(deltaTime);
      input.endFrame();
      gamepadState.endFrame();
    },
  });
  await game.init();

  // The loaded texture is rendered through the renderer-agnostic sprite API:
  // a core Sprite2D model plus a renderer-created view. Game logic mutates
  // the model and calls view.sync(); it never touches PixiJS objects. The
  // view owns its display object only — the shared texture is never
  // destroyed by view disposal. The center anchor (R11) makes the position
  // the logo's center point, so the gameplay rotation spins the logo around
  // its own middle instead of swinging its top-left corner.
  const logoModel = new Sprite2D({
    texture: logo,
    transform: new Transform2D({
      x: 16 + logo.width / 2,
      y: VIEW_HEIGHT - logo.height / 2 - 16,
    }),
    anchor: { x: 0.5, y: 0.5 },
  });
  const logoView = createSpriteView({ sprite: logoModel, renderer });

  // R2: the gameplay scene owns a GameObjectCollection. Each spark is a
  // renderer-agnostic game object: a shared Transform2D (the same instance
  // drives its Sprite2D model), an update hook, and a destroy hook that
  // releases exactly what the spark itself created — its sprite view. The
  // shared texture is never touched by object or collection cleanup.
  const sparks = new GameObjectCollection();
  const sparkModels: Sprite2D<Texture>[] = [];
  const sparkViews: SpriteView<Texture>[] = [];
  function spawnSpark(angle: number): void {
    const model = new Sprite2D<Texture>({
      texture: logo,
      transform: new Transform2D({
        x: VIEW_WIDTH / 2,
        y: VIEW_HEIGHT / 2,
        scaleX: 0.2,
        scaleY: 0.2,
      }),
      // Center anchor: each spark spins around its own middle as it orbits.
      anchor: { x: 0.5, y: 0.5 },
    });
    const view = createSpriteView({ sprite: model, renderer });
    sparkModels.push(model);
    sparkViews.push(view);
    let age = 0;
    const spark: GameObject = {
      transform: model.transform,
      update(deltaTime) {
        age += deltaTime;
        const radius = 60 + 20 * Math.sin(age * 2);
        spark.transform.x = VIEW_WIDTH / 2 + Math.cos(angle + age) * radius;
        spark.transform.y = VIEW_HEIGHT / 2 + Math.sin(angle + age) * radius;
        spark.transform.rotation += deltaTime * 4;
        // The view is a pure projection of the model: sync once per frame
        // after the model changes, exactly like the logo view.
        view.sync();
        if (age > 6) {
          // Removing during an update is safe: the object is skipped for the
          // rest of this frame and gone from the next one. The spark releases
          // its own view; the shared texture stays untouched.
          view.dispose();
          const index = sparkModels.indexOf(model);
          sparkModels.splice(index, 1);
          sparkViews.splice(index, 1);
          sparks.remove(spark);
        }
      },
      // Collection destroy calls this exactly once (idempotent with the
      // expiry path above): the spark releases its own view, never the
      // shared texture.
      destroy() {
        view.dispose();
      },
    };
    sparks.add(spark);
  }
  function setSparksVisible(visible: boolean): void {
    for (let i = 0; i < sparkModels.length; i++) {
      const model = sparkModels[i];
      const view = sparkViews[i];
      if (model === undefined || view === undefined) {
        continue;
      }
      model.visible = visible;
      view.sync();
    }
  }

  const menuScene: Scene = {
    init() {},
    enter() {
      renderer.stage.addChild(title, menuHint);
      // The logo and sparks live in the gameplay scene; hide them through
      // their models.
      logoModel.visible = false;
      logoView.sync();
      setSparksVisible(false);
    },
    update() {
      // Pointer position and button edges come from the framework input state.
      const pointer = input.hasPointerPosition
        ? `pointer: ${Math.round(input.pointerX)}, ${Math.round(input.pointerY)}`
        : "pointer: move over the canvas";
      const cacheNote = logoWasCached ? "texture cache: hit" : "texture cache: miss";
      menuHint.text = `click to play — ${pointer} — ${cacheNote}`;
      if (input.wasButtonPressed(0)) {
        // resume() runs inside the click handler — a real user gesture, which
        // is what the browser autoplay policy requires. The beep is already
        // loaded (cache hit), so the playback starts as soon as the context
        // runs. Failures surface through the demo error path, never silently.
        void audioBackend
          .resume()
          .then(() => audio.play(BEEP_URL))
          .catch(showError);
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
      // Spawn the initial sparks once; they respawn automatically as they
      // expire, and they keep their state across scene re-entries.
      if (sparks.size === 0) {
        for (let i = 0; i < 3; i++) {
          spawnSpark(i * 2.1);
        }
      }
      setSparksVisible(true);
    },
    update(deltaTime) {
      // R2: registered game objects update through the existing game loop —
      // no second loop, no extra scheduler.
      sparks.update(deltaTime);
      // Expired sparks remove themselves; top up so three are always orbiting.
      if (sparks.size < 3) {
        spawnSpark(Math.random() * Math.PI * 2);
      }
      // Movement reads held keys from the framework input state, plus the
      // left stick (axes 0/1) and d-pad (buttons 12–15) from the gamepad
      // state. The dead zone is this demo's choice, applied here — the
      // adapter delivers raw axis values.
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
      let controllerStatus = "no controller";
      if (gamepadState.isConnected(0)) {
        const [axisX, axisY] = [gamepadState.getAxis(0, 0), gamepadState.getAxis(0, 1)];
        if (Math.abs(axisX) > 0.2) {
          moveX += axisX;
        }
        if (Math.abs(axisY) > 0.2) {
          moveY += axisY;
        }
        if (gamepadState.isButtonDown(0, 14)) {
          moveX -= 1; // d-pad left
        }
        if (gamepadState.isButtonDown(0, 15)) {
          moveX += 1; // d-pad right
        }
        if (gamepadState.isButtonDown(0, 12)) {
          moveY -= 1; // d-pad up
        }
        if (gamepadState.isButtonDown(0, 13)) {
          moveY += 1; // d-pad down
        }
        controllerStatus = "controller 0 connected";
      }
      // Touch (R5): dragging on the canvas steers the square toward the
      // first active contact. Keyboard and mouse behavior is unchanged.
      const dragId = input.activeTouchIds()[0];
      if (dragId !== undefined) {
        const touch = input.getTouchPosition(dragId);
        if (touch !== undefined) {
          const dx = touch.x - (squareX + SQUARE_SIZE / 2);
          const dy = touch.y - (squareY + SQUARE_SIZE / 2);
          const distance = Math.hypot(dx, dy);
          if (distance > 4) {
            const dragSpeed = Math.min(distance, SPEED * 1.5);
            moveX += (dx / distance) * (dragSpeed / SPEED);
            moveY += (dy / distance) * (dragSpeed / SPEED);
          }
        }
      }
      moveX = Math.min(Math.max(moveX, -1), 1);
      moveY = Math.min(Math.max(moveY, -1), 1);
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

      playHint.text = `held keys: ${heldKeys} — ${controllerStatus} — Esc returns to the menu`;
      if (input.wasKeyPressed("Escape")) {
        scenes.goTo("menu");
      }
    },
    exit() {
      renderer.stage.removeChild(square, playHint);
      logoModel.visible = false;
      logoView.sync();
      // Sparks keep their objects alive but stop updating and hide.
      setSparksVisible(false);
    },
    dispose() {
      // Destroy the scene's display objects; the sprite view removes and
      // destroys only its own display object — never the shared texture.
      square.destroy();
      playHint.destroy();
      logoView.dispose();
      // The collection's destroy runs each spark's destroy hook, which
      // disposes exactly its own view; the shared texture survives.
      sparks.destroy();
    },
  };

  const scenes = new SceneManager({
    scenes: { menu: menuScene, gameplay: gameplayScene },
    initial: "menu",
  });

  window.addEventListener("pagehide", () => {
    // Adapter first (no further events reach the state), then scenes (they
    // destroy their sprites and remove their children from the stage), then
    // audio (stops playback and closes the AudioContext), then the game
    // (releases the renderer), and finally the asset manager (it releases
    // its cache). Neither the audio stack nor the managers nor the renderer
    // ever destroys textures — the renderer owns display objects only, and
    // the asset policy is non-destructive — so the page unload reclaims them.
    try {
      devtools?.dispose(); // DevTools only ever detaches itself.
      domInput.dispose();
      gamepadInput.dispose(); // stops gamepad observation before the state goes
      scenes.dispose();
      audio.dispose();
    } catch (error: unknown) {
      console.error(error);
    }
    void game
      .dispose()
      .then(() => assets.dispose())
      .catch((error: unknown) => console.error(error));
  });

  domInput.attach();
  gamepadInput.attach();
  scenes.start();
  game.start();

  // Dev-only runtime inspector, opt-in and dynamically imported so production
  // builds exclude it entirely (import.meta.env.DEV is statically false in a
  // production build, so the chunk is never even fetched). DevTools is
  // read-only: it observes the scene manager, the gameplay object collection,
  // and the input state, and its disposal never touches the runtime.
  if (import.meta.env.DEV) {
    try {
      const { createDevTools } = await import("@g2w/devtools");
      devtools = createDevTools({ scenes, objects: sparks, input });
      devtools.open();
    } catch (error: unknown) {
      console.error("g2w devtools failed to start:", error);
    }
  }
} catch (error) {
  showError(error);
}
