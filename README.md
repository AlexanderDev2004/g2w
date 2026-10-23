# g2w

**g2w — Game to Website** is a TypeScript-first, AI-agent-ready framework for building and shipping web games: HTML5 games, 2D first with 3D planned, for desktop and mobile web browsers.

> **Status: MVP 1C — input system.** The repository provides a `Game` runtime (lifecycle + frame loop), a renderer-agnostic `SceneManager`, and a DOM-free `InputState` with a browser adapter on top of the MVP 0 foundation: monorepo, renderer contract, PixiJS adapter, and a working browser demo. There is no asset loading or game-object system yet. See [What is implemented](#what-is-implemented) below.

## Architecture

g2w is a pnpm monorepo of small packages with one strict rule: **`@g2w/core` never depends on a rendering technology.** Renderers implement the core contract and depend on core, never the other way around.

```text
packages/core/src/index.ts        Renderer contract + RendererError + Game runtime + SceneManager + InputState
packages/input-dom/src/           DOM (browser) adapter feeding InputState from real events
packages/renderer-pixi/src/       PixiJS implementation of the renderer contract
examples/hello-world/             Vite browser demo: Game + SceneManager + input + PixiRenderer
docs/architecture.md              Architecture decisions and direction
```

For the full picture, read [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 22 or newer
- pnpm 12 (activated automatically via `packageManager`, e.g. through Corepack)

## Getting started

```sh
pnpm install
```

## Development commands

| Command               | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm dev`            | Run the hello-world browser demo with Vite              |
| `pnpm build`          | Type-check and build all packages to `dist/`            |
| `pnpm build:example`  | Build the hello-world demo bundle (production build)    |
| `pnpm typecheck`      | Type-check all sources, tests, and examples (no output) |
| `pnpm check`          | Format and lint check with Biome                        |
| `pnpm format`         | Auto-format sources with Biome                          |
| `pnpm test`           | Run all tests with Vitest                               |
| `pnpm verify:exports` | Verify built packages load through their entry points   |

## What is implemented

- **Monorepo foundation** — pnpm workspaces, strict TypeScript (`tsconfig.base.json`), Biome formatting and linting, Vitest tests, GitHub Actions CI (`.github/workflows/ci.yml`).
- **Renderer contract** — `@g2w/core` defines `Renderer` (with an optional `render()` hook), `RendererCapabilities`, `RendererInitOptions`, and `RendererError`. Core has zero runtime dependencies and no PixiJS dependency; tests enforce this boundary.
- **Game runtime** — `Game` owns a renderer and a `requestAnimationFrame` frame loop with explicit lifecycle states (`new` → `initializing` → `initialized` → `running` ⇄ `stopped` → `disposed`), a seconds-based `deltaTime` update callback, and deterministic handling of concurrent init, stop-during-init, and disposal races. See [docs/architecture.md](docs/architecture.md) for the state model.
- **Scene system** — `SceneManager` owns a fixed set of named, reusable `Scene` objects: `init` runs once per instance, `enter`/`exit` pair on every activation, and only the active scene is updated. Transitions exit the previous scene before entering the next one, are immediate outside scene hooks, and deferred when requested from inside one — the most recent request always wins. Disposal is terminal, best-effort, and releases every initialized scene. See [docs/architecture.md](docs/architecture.md) for the full lifecycle and transition semantics.
- **PixiJS adapter** — `@g2w/renderer-pixi` implements the contract with PixiJS 8's async `Application` lifecycle and renders on demand (`render()`, `stage` access). It is a minimal adapter, not a complete renderer yet.
- **Browser demo** — `examples/hello-world` is a real Vite app: the `Game` loop updates the active scene, two scenes (menu and gameplay) demonstrate real transitions, and the gameplay square is moved with WASD/arrow keys through the input API. Run it with `pnpm dev`.
- **Input system** — `@g2w/core` provides the DOM-free `InputState` (keyboard held/pressed/released, pointer position, button state, focus-loss and pointer-leave policies) and `@g2w/input-dom` adapts real browser events onto it. Edge states reset at one explicit boundary (`input.endFrame()`) per game frame. See [docs/architecture.md](docs/architecture.md) for the frame semantics.

## Minimal usage

```ts
import { Game, InputState, SceneManager, type Scene } from "@g2w/core";
import { DomInput } from "@g2w/input-dom";
import { PixiRenderer } from "@g2w/renderer-pixi";

const renderer = new PixiRenderer();
const input = new InputState();
const domInput = new DomInput(input, { canvas: document.querySelector("canvas")! });

const menu: Scene = {
  enter() {
    /* show menu */
  },
  update() {
    if (input.wasButtonPressed(0)) scenes.goTo("gameplay");
  },
  exit() {
    /* hide menu */
  },
};
const gameplay: Scene = {
  update(deltaTime) {
    if (input.isKeyDown("KeyD")) x += 120 * deltaTime;
    if (input.wasKeyPressed("Escape")) scenes.goTo("menu");
  },
};

const scenes = new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });
const game = new Game({
  renderer,
  canvas: document.querySelector<HTMLCanvasElement>("#game")!,
  onUpdate: (deltaTime) => {
    scenes.update(deltaTime);
    input.endFrame(); // one boundary per frame, after every consumer
  },
});

await game.init();
domInput.attach();
scenes.start();
game.start();
```

Ownership: the caller owns the input state, the browser adapter, the scenes, and the game. On teardown, dispose the adapter first (so no further events reach the state), then the scenes, then the game — the demo does exactly that on `pagehide`.

## What is planned (not implemented yet)

- Game objects, assets, audio, physics, cameras, gamepad input, action mapping, scene stacks and transition effects.
- A Vite starter and project-generation CLI.
- A Three.js adapter for 3D.
- Optional integrations for React, Vue, Next.js, Bun, and Effect.

Packages are not published to npm yet; the workspace is for local development and CI.
