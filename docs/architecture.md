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
- `InputState` — the DOM-free keyboard and pointer state machine (see below).
- `AssetManager` / `AssetLoader` / `AssetManagerOptions` / `AssetError` — the renderer-agnostic asset cache (see below).
- `Transform2D` / `Sprite2D` / `Sprite2DInit` / `Transform2DInit` — the renderer-agnostic 2D transform and sprite model (see below).
- `GameObject` / `GameObjectCollection` — the minimal renderer-agnostic game-object layer (see below).
- `FrameScheduler` / `FrameRequestCallback` — the internal-facing scheduling abstraction, injectable for deterministic tests.

Core has **zero runtime dependencies** and **no rendering technology imports**. It owns scenes and other framework services, but every rendering capability stays behind the contract.

### `@g2w/renderer-pixi`

Implements the core contract on top of PixiJS 8. It wraps a PixiJS `Application`: async `initialize()` mirrors PixiJS v8's async `Application.init()`, honors the core sizing contract (`width`/`height` logical resolution — both or neither, validated), and `dispose()` destroys the application while leaving a caller-provided canvas in the DOM (`removeView: false`). `resize(width, height)` forwards to PixiJS's renderer resize — buffer and (with `autoDensity`) CSS size update together; textures are never touched. PixiJS's own ticker loop is disabled (`autoStart: false`) — rendering is on demand through `render()`, called by the game loop, and `stage` exposes the root container so applications can add content. `createTextureAssetManager()` returns a core `AssetManager<Texture>` that loads textures by URL through PixiJS's `Assets` and is deliberately non-destructive on disposal (see below). `createSpriteView()` turns a core `Sprite2D` model into a PixiJS sprite attached to the stage and synchronizes it through an explicit `sync()` (see below). This is a minimal adapter, not a complete renderer: no scene graph API beyond sprites and the texture loader.

### `@g2w/input-dom`

Implements the browser side of the input system on top of the core contract. `DomInput` subscribes to real DOM events (keyboard on an injectable target, default `window`; pointer events on the canvas; `pointerup` on `window` so off-canvas releases are caught; `blur` for focus loss), normalizes them (pointer coordinates become canvas-relative, scaled into the configured `logicalSize` game space when provided — see the sizing section — otherwise into the canvas's backing pixels), and feeds the core `InputState`. It owns no input logic: `attach()` is idempotent, `dispose()` removes every listener it registered, and it never calls `preventDefault()`. Like the renderer adapter, it depends on `@g2w/core` and never the other way around.

### `@g2w/devtools`

A read-only developer overlay for debugging running games. `DevTools` is constructed with plain references — `scenes` (a `SceneManager`), optional `objects` (a `GameObjectCollection` or a function returning one), and `input` with explicit `watchKeys`/`watchButtons` watch lists — and polls immutable snapshots at a fixed refresh rate (default 10 Hz, injectable scheduler for tests). It renders a fixed-position DOM panel: scene explorer, object list with positional `#N` labels, a transform inspector for the selected object, FPS/frame time computed from a ring buffer of recent frame samples, a watched-input monitor, and a bounded, drop-oldest log buffer that also records scene transitions as they are observed. It is strictly observational: it never mutates the runtime and never disposes it — its own `dispose()` only removes the panel and stops its refresh tick (a single injected `requestAnimationFrame` schedule). `open()`/`close()`/`toggle()` are idempotent; after `dispose()` every method throws `DevToolsError`. The package depends only on `@g2w/core` (plus DOM APIs, injected for tests) and is meant to be loaded only in development: the demo imports it dynamically behind `import.meta.env.DEV`, so production builds exclude it entirely. A disabled "3D — Coming Soon" button marks the future 3D inspector.

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

`SceneManager` (in core) owns a fixed set of named, reusable scenes and updates only the active one. A scene instance belongs to exactly one manager for its lifetime: registering the same instance in another manager (or twice in one record) throws `SceneError`, and the claim survives the owning manager's disposal — `exit` deactivates a scene, disposal is what is permanent. It runs no frame loop of its own: applications compose it with `Game` by driving it from the game's `onUpdate` callback, so there is exactly one loop and the scene update happens before each render, like any other update logic.

```ts
const scenes = new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });
const game = new Game({ renderer, canvas, onUpdate: (dt) => scenes.update(dt) });
await game.init();
scenes.start();
game.start();
```

The `Scene` contract is a plain object with optional, synchronous hooks: `init()`, `enter()`, `update(deltaTime)`, `exit()`, `dispose()`. There is no context parameter and no async-hook support — scenes do not load assets themselves. Games that use assets pass an `AssetManager` to their scenes through plain composition (a closure or constructor argument), so asynchronous setup happens before `game.start()` and scene hooks stay synchronous; when an async lifecycle need appears, the contract can grow without breaking this one. `deltaTime` is in seconds, forwarded unchanged from the game loop (which already clamps it).

Policy highlights (each is covered by tests in `packages/core/test/scene-manager.test.ts`):
- **Scenes are reusable instances.** `init` runs at most once per scene instance, lazily on first activation; a failed `init` may be retried, and `enter` never runs unless `init` completed. `enter`/`exit` pair on every activation and deactivation.
- **Activation order is deterministic:** `init` (first activation only), then `enter`. A scene becomes active only after `enter` returns.
- **Transitions** exit the previous scene before entering the next. They apply immediately when requested outside scene hooks; requested from inside a running hook (`update`, `enter`, `exit`), they are deferred to the start of the next `update` so the requesting update finishes on the scene that asked to leave, and the new scene updates in the same frame its transition applies. The most recent request always wins: it replaces any pending deferred transition, and requesting the already-active scene cancels a pending one and is otherwise a no-op. Unknown names throw `SceneError` without changing any state.
- **Hook errors are never wrapped or swallowed.** A throw propagates unchanged to the caller of `start`, `goTo`, or `update`; when that caller is the game loop, the loop stops (the existing `onUpdate` contract). The manager keeps its own state consistent: after a failed transition it has no active scene, the failed scene receives no `exit`, and a later `goTo` to any registered scene recovers (a failed `init` is retried on the next activation attempt).
- **Disposal** is immediate, idempotent, and terminal: the active scene is exited, then every scene whose `init` completed is disposed in registration order (scenes never initialized have no manager-managed resources). Cleanup is best-effort: one hook's failure does not prevent the remaining cleanup, and the first error is rethrown — as an `AggregateError` when several hooks fail — after all cleanup attempts complete. Afterwards `start`, `goTo`, and `update` throw `SceneError`. Disposing the manager does not stop a `Game` that drives it: the caller owns both and must dispose each (the demo disposes scenes, then the game, on `pagehide`).

Intentionally unsupported (documented scope, not omissions by accident): scene stacks, transition effects, scene persistence, and async hooks.

### `InputState` — input and frame semantics

`InputState` (in core) is a DOM-free, renderer-agnostic state machine for keyboard and pointer input. Browser adapters feed it normalized events (`handleKeyDown`, `handleKeyUp`, `handlePointerMove`, `handleButtonDown`, `handleButtonUp`, `handleFocusLoss`, `handlePointerLeave`); game and scene code reads it through query methods (`isKeyDown`, `wasKeyPressed`, `wasKeyReleased`, `isButtonDown`, `wasButtonPressed`, `wasButtonReleased`, `pointerX`/`pointerY`). It is a plain class with no dependencies and no access to `window`, `document`, or DOM event types at runtime — the architecture test enforces this.

Frame semantics (all covered by tests in `packages/core/test/input.test.ts`):
- **Held state is continuous** (`down`); **pressed/released are per-frame edges**. Edges are set by input events and reset — all at once — only at the explicit boundary `endFrame()`.
- **The boundary is composed, not built in:** applications call `input.endFrame()` exactly once per frame, after every consumer, typically as the last statement of `Game.onUpdate` after scene updates. Events arriving between frames accumulate into the next frame's edges; no second loop or hidden timer exists.
- **A tap between two frames is not lost:** a key pressed and released before the next boundary reports `wasKeyPressed` _and_ `wasKeyReleased` in that frame while `isKeyDown` is already `false`.
- **OS key repeat is not a new press:** repeated `keydown` events while a key is held are ignored; the press edge fires once per physical press.
- **Focus loss** releases every held key and button and generates the matching released edges (game logic observes a normal release); the pointer position is kept. **Pointer leaving the canvas** releases held buttons the same way (the `pointerup` may happen off-canvas) and keeps the position.
- Key identifiers are standard `KeyboardEvent.code` strings (`"KeyW"`, `"ArrowLeft"`, `"Space"`, ...); pointer buttons are numbered as in `MouseEvent.button` (0 = primary).

Intentionally unsupported (documented scope, not omissions by accident): gamepad, touch gestures, action mapping or rebinding, input recording, drag-and-drop, and preventing default browser behavior from the framework.

### `AssetManager` — assets, caching, and ownership

`AssetManager` (in core) is a minimal, dependency-free asset cache. Keys are opaque strings; values are whatever an injected `AssetLoader` returns, so the API is generic and core never learns about PixiJS, URLs, or file formats:

```ts
const textures = new AssetManager<Texture>({
  load: (url) => pixiAssetsLoad(url), // supplied by the caller or an adapter
  disposeAsset: (texture) => texture.destroy(true), // optional: manager-owned resources
});
const logo = await textures.load("logo.png");
```

Semantics (all covered by tests in `packages/core/test/asset-manager.test.ts`):
- **Caching:** the first `load(key)` invokes the loader; every later request returns the same promise — and therefore the same value — without invoking the loader again. Different keys load independently.
- **Concurrent requests deduplicate:** requests made while a load is in flight share that one load.
- **Failure is retryable, never poisonous:** a rejected load drops its cache entry, so a later `load(key)` invokes the loader again. Loader errors propagate unchanged (never wrapped); every concurrent requester of a failing key observes the same rejection.
- **Disposal is terminal and idempotent:** repeated `dispose()` calls return the first disposal's promise. `load` on a disposed manager throws `AssetError` immediately, even while a disposal is still in flight.
- **In-flight loads during disposal** still settle for their callers (the caller's promise is not altered), but after `dispose()` resolves every owned value has been cleaned up: values that fulfilled after disposal was requested are disposed and never enter the cache. Callers of such loads receive a disposed value and must not use it.
- **Ownership is explicit, not automatic:** with a `disposeAsset`, the manager owns its resources — it destroys each distinct value exactly once, and a value shared between keys (identity) is destroyed only on its first cleanup, so shared resources are never destroyed twice. Without a `disposeAsset`, the manager merely caches caller-owned values and disposal clears the cache without touching them. The manager never calls resource-specific methods (`destroy()`, `close()`, ...) on values that were not explicitly handed a disposer.
- **Cleanup is best-effort:** one disposer failure does not prevent the remaining cleanups; the first error is rethrown as-is, or as an `AggregateError` when several fail, after all attempts complete.

Intentionally unsupported: automatic unloading on scene transitions, reference counting, and resource dependency graphs. The caller owns the manager, decides when it lives and dies, and passes it to scenes through plain composition — there is no scene context or injection framework for assets.

### PixiJS texture loading — `createTextureAssetManager()`

`@g2w/renderer-pixi` adapts the core contract to PixiJS 8: `createTextureAssetManager()` returns an `AssetManager<Texture>` whose loader is PixiJS's `Assets.load` (injectable for tests). Keys are URLs (or PixiJS resolver aliases); because PixiJS's shared `Assets` cache resolves every request for the same URL to one texture instance, two keys — or two managers — referring to the same URL share one texture. Ownership rules:
- **The adapter never destroys textures.** `Assets.load` stores every texture in PixiJS's global shared cache, where any other manager, `Sprite.from`, or subsystem can reach the same instance, and PixiJS offers no supported way to establish exclusive ownership of a cached texture (`Assets.unload` destroys the texture no matter who else still holds it — it is URL-scoped, not ownership-scoped). Destroying on manager disposal could therefore invalidate textures other code still uses, so the adapter leaves the value caller-owned: `dispose()` releases the manager's own cache entries and the textures stay valid.
- **Texture lifetime is the session.** Textures remain in PixiJS's cache until the page unloads, which reclaims all GPU and CPU memory. This is a deliberate trade-off: a long-lived single-page game that loads and abandons many large textures would accumulate them. When an application knows — outside the framework — that nothing else uses a texture any more, it can call PixiJS's `Assets.unload(url)` explicitly; that decision belongs to the application, not the manager.
- **Scenes still destroy their display objects, never their textures.** `sprite.destroy()` does not touch the texture by default, which matches this policy; the demo's teardown order is: adapter → scenes → game → assets (the last step releases only the manager itself).

### `Sprite2D` / `Transform2D` — the 2D sprite model, and `createSpriteView()`

Core provides a minimal, renderer-independent 2D sprite model (see `packages/core/test/sprite.test.ts`):
- **`Transform2D`** is a mutable value: `x`/`y` position in logical pixels (default `0`), `rotation` in **radians** (default `0`; direction follows the renderer's screen space — for PixiJS, positive values rotate clockwise because the y axis points down), and `scaleX`/`scaleY` multipliers where `1` means natural scale (default `1`). Plain mutable numbers — no setters, validation, or observers.
- **`Sprite2D<TTexture>`** holds a typed texture handle (generic — core never inspects or destroys it), a `Transform2D` (shared when supplied, fresh when omitted), plus the visual properties the current demos need: `visible` (default `true`) and `alpha` (default `1`). It is plain mutable data; mutating it never touches a renderer.

`@g2w/renderer-pixi` projects the model onto the stage: **`createSpriteView({ sprite, renderer })`** creates one PixiJS `Sprite` for the model, applies the model state immediately, and attaches it to the renderer's stage. The view exposes:
- **`sync()`** — applies the current model state (position, rotation, scale, visibility, alpha) to the display object. Called explicitly, typically once per frame at the end of the scene update, right where `input.endFrame()` sits — the existing Game loop is the only driver; there is no second loop, ticker, or subscription. Changes without a `sync()` have no effect until the next sync.
- **`dispose()`** — removes the display object from its parent and destroys it. Idempotent and terminal. It **never destroys the texture** (textures live in the shared `Assets` cache; see the asset section) and never touches the stage or sibling display objects. `sync()` after disposal throws `SpriteViewError`.

Ownership: the caller owns the **model**; whoever creates a **view** owns it and disposes it (typically the owning scene's `dispose()` hook); the **texture** is owned by nobody and lives for the session. Because `enter`/`exit` pair per activation, scenes that toggle `visible` through the model (the demo's approach) reuse one view across transitions without duplicating display objects; a scene that instead creates views in `enter()` must dispose them in `exit()`.

Intentionally unsupported: parent/child transform hierarchies, anchors/pivots, z-ordering, tint, blend modes, animation timelines, and renderer-independent scene graphs (the minimal `GameObject` layer below does not change this — it adds no display semantics of its own).

### `GameObject` / `GameObjectCollection` — the minimal game-object layer

Core provides a minimal game-object layer (see `packages/core/test/game-object.test.ts`) so games stop hand-managing sprite arrays — deliberately **not** an ECS or a scene graph:
- **`GameObject`** is a plain object: a `Transform2D` plus an optional `update(deltaTime)` hook and an optional `destroy()` hook. There is no base class, no components, and no display contract — an object associates itself with rendering by sharing its `Sprite2D` model's transform (mutating one moves both).
- **`GameObjectCollection`** is a registry with `add`, `remove`, `update(deltaTime)`, `destroy()`, and a `size` getter. Its contract:
  - **Claiming:** a collection claims each object; the same object cannot be registered in two collections (or twice in one collection) — both throw `SceneError`. A removed object may be registered again; an object destroyed through a collection may not.
  - **Updates:** `update(deltaTime)` calls `update` on every registered object in insertion order, iterated over a snapshot. An object added during the update starts next frame; an object removed during the update — including one removing itself mid-callback — is skipped for the rest of that frame and gone afterwards. Calling `update` reentrantly from inside an update throws `SceneError`. Hook errors propagate unwrapped to the caller (typically the scene update).
  - **Ownership and destroy:** the collection owns only the _registration_, never the object's external resources. `destroy()` is terminal, idempotent, and best-effort: it removes every still-registered object and calls each `destroy` hook exactly once, in insertion order. A single hook failure is rethrown; multiple failures are reported as an `AggregateError` after all hooks ran. The collection never touches textures, sprite views, or anything else it does not own — a `destroy` hook releases exactly what its own object created (in the demo, the object's sprite view).
  - **After destroy:** the collection is dead — `add`, `remove`, and `update` all throw `SceneError`.

Scenes compose collections the same way they compose everything else: the scene (or the game code) creates a collection, calls `objects.update(deltaTime)` from the scene's `update` hook, and destroys it from the scene's `dispose()` hook. Objects update through the existing game loop — there is no second loop, ticker, or scheduler, and `SceneManager` knows nothing about them.

### Renderer sizing — logical resolution, resolution, and display size

R3 defines three distinct sizes and one policy:
- **Logical resolution** — the coordinate space game code positions content in (the stage space). Set with `width`/`height` on `GameOptions`/`RendererInitOptions`; both or neither, finite and greater than zero — `Game` rejects violations with `GameError` and renderers with `RendererError`. Omitted, the renderer uses its own default (PixiJS's 800×600 for the adapter — the pre-R3 behavior).
- **Render resolution (drawing buffer)** — `logical × resolution`. With `resolution: 2` and a 640×360 logical size the backing store is 1280×720. `resolution` keeps its existing meaning (device pixel ratio).
- **Display size** — pure CSS, owned by the application. The PixiJS adapter's `autoDensity` sets the canvas's CSS size to the logical size; applications scale it further (e.g. `max-width: 100%; height: auto` for proportional shrinking) without affecting game coordinates.

The renderer contract gains an optional `resize(width, height)` with the same validation rules: it changes the logical space and drawing buffer at runtime and must never destroy textures or other assets. `PixiRenderer.resize` forwards to PixiJS's `renderer.resize` (which, with `autoDensity`, updates both the buffer and the CSS size); repeated resizes are safe and disposal semantics are unchanged.

**Resize policy (chosen default): fixed logical resolution with proportional display scaling.** The game keeps one stable coordinate space; the page scales the canvas with plain CSS. The demo uses exactly this (`#game { max-width: 100%; height: auto }`). Trade-off: on very wide or very tall viewports the canvas keeps its aspect ratio rather than filling the container; container-driven logical resizing is available through `resize()` for games that want it, and a ResizeObserver-driven policy or letterboxing can be added later without breaking this contract. There is deliberately no framework-managed ResizeObserver yet — none of the current needs require one, and CSS scaling avoids resize loops and observer-lifecycle hazards entirely.

**Pointer coordinates:** `DomInput` accepts an optional `logicalSize` ({ width, height }). When provided, pointer positions are mapped into that space using the canvas's bounding rectangle, so they stay correct under any CSS scaling or offset (including proportional shrinking); when omitted, the pre-R3 mapping into `canvas.width`/`canvas.height` backing pixels applies. Core's `InputState` stays DOM-free — the mapping lives entirely in the browser adapter.

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

- `packages/core/test/architecture.test.ts` asserts core declares no runtime dependencies, no `pixi.js` dependency in any group, no renderer imports in its source, and no runtime access to browser globals or DOM event APIs (`window`, `document`, `addEventListener`, `KeyboardEvent`, `PointerEvent`) in its source.
- `packages/renderer-pixi/test/pixi-renderer.test.ts` asserts the adapter declares `@g2w/core` as a dependency and that core does not depend back on the adapter.
- `packages/renderer-pixi/test/assets.test.ts` asserts the texture asset manager composes with the core `AssetManager` and that shared textures are destroyed exactly once.
- `packages/input-dom/test/package.test.ts` asserts the DOM input adapter declares `@g2w/core` as a dependency and composes with the core `InputState`.
- `packages/devtools/test/package.test.ts` asserts the DevTools package declares only `@g2w/core` as a dependency and composes with the core `SceneManager`/`InputState` through the public entry points.
- `pnpm verify:exports` (also run in CI) loads the built packages through their real entry points.

## Tooling decisions

- **pnpm workspaces** for the monorepo; `workspace:*` links between packages.
- **TypeScript** with `NodeNext` module resolution, ESM-only packages, and strict settings (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`). Packages are built with `tsc -b` project references — no bundler for packages.
- **Vite** serves and builds the browser example (`pnpm dev` / `pnpm build:example`), with workspace package sources aliased directly so development needs no prior package build.
- **Biome** for formatting and linting (`pnpm check`).
- **Vitest** for tests, running against package sources via a resolve alias so tests do not require a prior build. Core tests use a fake renderer and a deterministic fake frame scheduler; they never need a browser or GPU.
- **pixi.js 8.22** as a dev dependency of the adapter with a `>=8` peer dependency, so consumers' PixiJS version is respected.

## Current vs provisional

Current (R2 — game objects, plus the DevTools MVP):
- The `Renderer` contract (including the optional `render()` hook) and the dependency direction it enforces.
- The `Game` lifecycle state model, frame scheduling, and delta-time semantics described above.
- The `Scene` contract and `SceneManager` lifecycle, transition, error, and disposal semantics described above.
- The `InputState` input state machine and its frame, focus-loss, and pointer-leave semantics described above, with the `@g2w/input-dom` browser adapter.
- The `AssetManager` cache/dedup/ownership semantics and the `@g2w/renderer-pixi` texture loader described above.
- The `Transform2D`/`Sprite2D` model and the `@g2w/renderer-pixi` sprite view described above.
- The `GameObject`/`GameObjectCollection` layer described above: claimed registration, snapshot-iterated updates through the existing game loop, and terminal best-effort destroy.
- The renderer sizing contract described above: logical `width`/`height` with validation, `logical × resolution` drawing buffer, app-owned display size, the optional `resize()`, and the fixed-logical-resolution display policy.
- The `@g2w/devtools` read-only overlay described above: snapshot-polling observation, explicit input watch lists, a bounded log buffer, and dev-only loading.
- PixiJS 8 async lifecycle handling, on-demand rendering, and dispose semantics (canvas stays in the DOM).
- ESM-only packages with `exports` maps pointing at `dist/`.
- The hello-world Vite demo as the reference consumer of the public API; it renders scene content through the adapter, loads its texture through the adapter's asset API, drives its logo sprite through the core sprite model and `sync()`, runs orbiting spark game objects through a `GameObjectCollection` inside the gameplay scene, and keeps all other PixiJS objects at the example boundary.

Provisional (expect to change in later MVPs):
- The exact shape of `RendererInitOptions`; it will likely grow as core learns about backends, display-fit policies (letterboxing, container-driven resizing), and more.
- The PixiJS adapter's internals; it will be reworked as core grows more rendering features.
- The `stage` accessor on the adapter: it leaks a PixiJS `Container` type to adapter consumers. Acceptable while the adapter is the only way to draw; a renderer-agnostic display API would replace it.
- The asset system's single-loader contract: one `AssetManager` instance handles one value type; richer manifests, bulk loading, and per-type loaders are future work.
- The texture loader's non-destructive policy: textures from PixiJS's shared `Assets` cache live for the session (no manager-driven destruction); if texture churn ever matters for a real game, cache eviction or explicit `Assets.unload` guidance can be added without breaking the current API.
- The sprite model's minimal scope: `Sprite2D` covers position/rotation/scale/visible/alpha; anchors, z-ordering, tint, hierarchies, and more are expected to grow the model later, and the `stage` accessor may be superseded by a broader renderer-agnostic display API.
- The game-object layer's minimal scope: `GameObject` is a transform plus update/destroy hooks; components, parent/child hierarchies, query systems, and automatic registration (e.g. by scenes or managers) are future work — composition stays explicit for now.
- The DevTools overlay's minimal scope: read-only snapshots with positional `#N` object labels (not stable IDs), watched-keys-only input, and no tap into the game's `deltaTime` (FPS is measured from the overlay's own frame samples); selection, editing, and stable object identity are future work.
- The test aliasing setup; it may move to package-level configs when the workspace grows.
