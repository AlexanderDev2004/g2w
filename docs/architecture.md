# Architecture

## Goal

g2w is a TypeScript-first framework for building and shipping web games. 2D comes first with PixiJS as the initial rendering foundation; a Three.js adapter for 3D is planned for later. The long-term direction also includes optional integrations (React, Vue, Next.js, Bun, Effect) and AI-agent-friendly workflows, which are documented as roadmap items, not implemented.

## Packages and responsibilities

### `@g2w/core`

Owns the renderer-agnostic **contract** and the **game runtime**. Concretely, the public API is:
- `Renderer` — the lifecycle contract (`capabilities`, `initialized`, `initialize`, `dispose`) plus an optional `render()` hook that the game loop calls each frame when present.
- `RendererCapabilities` — renderer identity (`id`, `displayName`).
- `RendererInitOptions` — canvas, optional background color, optional resolution.
- `RendererError` — thrown for invalid renderer lifecycle usage.
- `Game` / `GameOptions` / `GameState` — the runtime that owns a renderer and a frame loop (see below).
- `Scene` / `SceneManager` / `SceneManagerOptions` / `SceneError` — the renderer-agnostic scene system (see below).
- `FrameScheduler` / `FrameRequestCallback` — the internal-facing scheduling abstraction, injectable for deterministic tests.

Core has **zero runtime dependencies** and **no rendering technology imports**. It owns scenes and other framework services, but every rendering capability stays behind the contract.

### `@g2w/renderer-pixi`

Implements the core contract on top of PixiJS 8. It wraps a PixiJS `Application`: async `initialize()` mirrors PixiJS v8's async `Application.init()`, and `dispose()` destroys the application while leaving a caller-provided canvas in the DOM (`removeView: false`). PixiJS's own ticker loop is disabled (`autoStart: false`) — rendering is on demand through `render()`, called by the game loop, and `stage` exposes the root container so applications can add content. This is a minimal adapter, not a complete renderer: no scene graph API, sprites, or asset handling.

### `Game` — lifecycle and frame loop

`Game` (in core) owns exactly one renderer and drives it with a `requestAnimationFrame` loop. The state model:

```text
new ──init()──► initializing ──ok──► initialized ──start()──► running
                  │                                        ▲       │
                  │ init failure: rethrow,                 │       │
                  ▼ returns to "new"                  start()   stop()
                 new                                        │       ▼
                                                            └─── stopped
any state ──dispose()──► disposed (terminal, idempotent)
```

Policy highlights (each is covered by tests in `packages/core/test/game.test.ts`):
- **Init** is only valid from `new`; concurrent calls share one in-flight promise, so the renderer initializes exactly once. A failure leaves the game back in `new` (retry allowed) and rethrows.
- **Start** is valid from `initialized` and `stopped`; it is a no-op while `running` and throws `GameError` otherwise. Repeated starts schedule only one frame at a time.
- **Stop** is always safe: from `running` it cancels the pending frame and enters `stopped`; during pending initialization it marks the game so it lands in `stopped` when init completes (the loop never starts); otherwise it is a no-op.
- **Dispose** is idempotent and terminal. It cancels frames, awaits any in-flight initialization, then disposes the renderer if it was initialized. After disposal, `init`/`start` throw and `stop`/`dispose` are safe no-ops.
- Each frame runs `onUpdate(deltaTime)` **before** `renderer.render()`. Delta time is in **seconds**, is `0` on the first frame after start/restart (the timestamp resets), and is clamped to `maxDeltaTime` (default `0.25`s) so a suspended tab cannot produce a huge jump.
- A throw from `onUpdate` is fatal to the loop: the pending frame is cancelled, the state becomes `stopped`, and the error is rethrown to the scheduler — never swallowed.

The scheduling mechanism is isolated behind the `FrameScheduler` interface (browser-only `requestAnimationFrame` code lives in its own module), so core lifecycle tests run in plain Node with a deterministic fake scheduler and never need a browser or GPU.

### `SceneManager` — scenes and transitions

`SceneManager` (in core) owns a fixed set of named, reusable scenes and updates only the active one. It runs no frame loop of its own: applications compose it with `Game` by driving it from the game's `onUpdate` callback, so there is exactly one loop and the scene update happens before each render, like any other update logic.

```ts
const scenes = new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });
const game = new Game({ renderer, canvas, onUpdate: (dt) => scenes.update(dt) });
await game.init();
scenes.start();
game.start();
```

The `Scene` contract is a plain object with optional, synchronous hooks: `init()`, `enter()`, `update(deltaTime)`, `exit()`, `dispose()`. There is no context parameter and no async-hook support — scenes do not load assets yet, so asynchronous setup has no lifecycle requirement; when one appears, the contract can grow without breaking this one. `deltaTime` is in seconds, forwarded unchanged from the game loop (which already clamps it).

Policy highlights (each is covered by tests in `packages/core/test/scene-manager.test.ts`):
- **Scenes are reusable instances.** `init` runs at most once per scene instance, lazily on first activation; a failed `init` may be retried, and `enter` never runs unless `init` completed. `enter`/`exit` pair on every activation and deactivation.
- **Activation order is deterministic:** `init` (first activation only), then `enter`. A scene becomes active only after `enter` returns.
- **Transitions** exit the previous scene before entering the next. They apply immediately when requested outside scene hooks; requested from inside a running hook (`update`, `enter`, `exit`), they are deferred to the start of the next `update` so the requesting update finishes on the scene that asked to leave, and the new scene updates in the same frame its transition applies. The most recent request always wins: it replaces any pending deferred transition, and requesting the already-active scene cancels a pending one and is otherwise a no-op. Unknown names throw `SceneError` without changing any state.
- **Hook errors are never wrapped or swallowed.** A throw propagates unchanged to the caller of `start`, `goTo`, or `update`; when that caller is the game loop, the loop stops (the existing `onUpdate` contract). The manager keeps its own state consistent: after a failed transition it has no active scene, the failed scene receives no `exit`, and a later `goTo` to any registered scene recovers (a failed `init` is retried on the next activation attempt).
- **Disposal** is immediate, idempotent, and terminal: the active scene is exited, then every scene whose `init` completed is disposed in registration order (scenes never initialized have no manager-managed resources). Cleanup is best-effort: one hook's failure does not prevent the remaining cleanup, and the first error is rethrown — as an `AggregateError` when several hooks fail — after all cleanup attempts complete. Afterwards `start`, `goTo`, and `update` throw `SceneError`. Disposing the manager does not stop a `Game` that drives it: the caller owns both and must dispose each (the demo disposes scenes, then the game, on `pagehide`).

Intentionally unsupported (documented scope, not omissions by accident): scene stacks, transition effects, scene persistence, and async hooks.

## Dependency direction

The single most important rule: **core must never depend on a renderer; renderers always depend on core.**

```text
┌──────────────────┐                ┌──────────────────────────┐
│    @g2w/core     │ ◄── depends on ┤    @g2w/renderer-pixi    │
│ renderer contract│                │ PixiJS implementation    │
│ no PixiJS imports│                │ depends on PixiJS        │
└──────────────────┘                └──────────────────────────┘
         ▲
         │ depends on
         │
┌────────┴───────────────────────────────────────────────────┐
│ future renderer packages (e.g. @g2w/renderer-three)        │
└────────────────────────────────────────────────────────────┘
```

Why core stays renderer-agnostic:
- Game code written against `@g2w/core` survives switching or upgrading renderers.
- The core framework (loop, scenes, assets) cannot accidentally couple to PixiJS APIs.
- A Three.js renderer can be added later without touching core.
- Core stays testable without a browser, GPU, or WebGL context.

## Dependency direction enforcement

- `packages/core/test/architecture.test.ts` asserts core declares no runtime dependencies, no `pixi.js` dependency in any group, and no renderer imports in its source.
- `packages/renderer-pixi/test/pixi-renderer.test.ts` asserts the adapter declares `@g2w/core` as a dependency and that core does not depend back on the adapter.
- `pnpm verify:exports` (also run in CI) loads the built packages through their real entry points.

## Tooling decisions

- **pnpm workspaces** for the monorepo; `workspace:*` links between packages.
- **TypeScript** with `NodeNext` module resolution, ESM-only packages, and strict settings (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`). Packages are built with `tsc -b` project references — no bundler for packages.
- **Vite** serves and builds the browser example (`pnpm dev` / `pnpm build:example`), with workspace package sources aliased directly so development needs no prior package build.
- **Biome** for formatting and linting (`pnpm check`).
- **Vitest** for tests, running against package sources via a resolve alias so tests do not require a prior build. Core tests use a fake renderer and a deterministic fake frame scheduler; they never need a browser or GPU.
- **pixi.js 8.22** as a dev dependency of the adapter with a `>=8` peer dependency, so consumers' PixiJS version is respected.

## Current vs provisional

Current (MVP 1B):
- The `Renderer` contract (including the optional `render()` hook) and the dependency direction it enforces.
- The `Game` lifecycle state model, frame scheduling, and delta-time semantics described above.
- The `Scene` contract and `SceneManager` lifecycle, transition, error, and disposal semantics described above.
- PixiJS 8 async lifecycle handling, on-demand rendering, and dispose semantics (canvas stays in the DOM).
- ESM-only packages with `exports` maps pointing at `dist/`.
- The hello-world Vite demo as the reference consumer of the public API; it renders scene content through the adapter's provisional `stage` and keeps all PixiJS objects at the example boundary.

Provisional (expect to change in later MVPs):
- The exact shape of `RendererInitOptions`; it will likely grow as core learns about sizing, scaling, and backends.
- The PixiJS adapter's internals; it will be reworked as core grows more rendering features.
- The `stage` accessor on the adapter: it leaks a PixiJS `Container` type to adapter consumers. Acceptable while the adapter is the only way to draw; a renderer-agnostic display API would replace it.
- The test aliasing setup; it may move to package-level configs when the workspace grows.
