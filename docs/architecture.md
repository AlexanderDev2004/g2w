# Architecture

## Goal

g2w is a TypeScript-first framework for building and shipping web games. 2D comes first with PixiJS as the initial rendering foundation; a Three.js adapter for 3D is planned for later. The long-term direction also includes optional integrations (React, Vue, Next.js, Bun, Effect) and AI-agent-friendly workflows, which are documented as roadmap items, not implemented.

## Packages and responsibilities

### `@g2w/core`

Owns the renderer-agnostic **contract** and the **game runtime**. Concretely, the public API is:
- `Renderer` — the lifecycle contract (`capabilities`, `initialized`, `initialize`, `dispose`) plus an optional `render()` hook that the game loop calls each frame when present.
- `RendererCapabilities` — renderer identity (`id`, `displayName`) plus the optional `backend` field reporting the rendering backend that was actually initialized (`undefined` before the first successful initialization, after a failed initialization, and after disposal).
- `RendererBackend` / `RendererInitOptions` — canvas, optional backend **preference** (`"webgl" | "webgpu" | "canvas"` — a hint, never a guarantee; the actual backend is reported through `RendererCapabilities.backend`), optional background color, optional resolution, optional logical size.
- `RendererError` — thrown for invalid renderer lifecycle usage.
- `Game` / `GameOptions` / `GameState` — the runtime that owns a renderer and a frame loop (see below).
- `Scene` / `SceneManager` / `SceneManagerOptions` / `SceneError` — the renderer-agnostic scene system (see below).
- `InputState` — the DOM-free keyboard, pointer, and touch state machine (see below).
- `GamepadState` / `GamepadSnapshot` — the DOM-free gamepad state machine (see below).
- `AssetManager` / `AssetLoader` / `AssetManagerOptions` / `AssetError` — the renderer-agnostic asset cache (see below).
- `Transform2D` / `Anchor2D` / `Sprite2D` / `Sprite2DInit` / `Transform2DInit` / `Anchor2DInit` — the renderer-agnostic 2D transform and sprite model (see below).
- `GameObject` / `GameObjectCollection` — the minimal renderer-agnostic game-object layer (see below).
- `AudioManager` / `AudioBackend` / `Sound` / `SoundPlayback` / `SoundPlayOptions` / `AudioError` — the renderer-agnostic audio contract (see below).
- `FrameScheduler` / `FrameRequestCallback` — the internal-facing scheduling abstraction, injectable for deterministic tests.

Core has **zero runtime dependencies** and **no rendering technology imports**. It owns scenes and other framework services, but every rendering capability stays behind the contract.

### `@g2w/renderer-pixi`

Implements the core contract on top of PixiJS 8. It wraps a PixiJS `Application`: async `initialize()` mirrors PixiJS v8's async `Application.init()`, honors the core sizing contract (`width`/`height` logical resolution — both or neither, validated), and `dispose()` destroys the application while leaving a caller-provided canvas in the DOM (`removeView: false`). `resize(width, height)` forwards to PixiJS's renderer resize — buffer and (with `autoDensity`) CSS size update together; textures are never touched. PixiJS's own ticker loop is disabled (`autoStart: false`) — rendering is on demand through `render()`, called by the game loop, and `stage` exposes the root container so applications can add content. `createTextureAssetManager()` returns a core `AssetManager<Texture>` that loads textures by URL through PixiJS's `Assets` and is deliberately non-destructive on disposal (see below). `createSpriteView()` turns a core `Sprite2D` model into a PixiJS sprite attached to the stage and synchronizes it through an explicit `sync()` (see below). This is a minimal adapter, not a complete renderer: no scene graph API beyond sprites and the texture loader. Adapter surface: `createTextureAssetManager()` and `createSpriteView()` are adapter-specific conveniences outside the core `Renderer` contract (`stage` likewise is a `PixiRenderer` extension, not a contract member) — the contract covers only `capabilities`/`initialized`/`initialize`/`dispose` plus the optional `render()`/`resize()` hooks. The adapter passes no backend preference by default — PixiJS auto-detects the rendering backend (WebGL first, then WebGPU, then Canvas 2D; order verified in the installed PixiJS 8.22.0 source). Since R6-1, `RendererInitOptions.backend` forwards an explicit preference to PixiJS's `preference` option: PixiJS tries the preferred backend first and falls back to the remaining ones, so an unavailable backend degrades to a fallback rather than failing initialization. The backend actually created is reported through `capabilities.backend` and `PixiRenderer.backend`, read from PixiJS's public `renderer.name` property after a successful `init()` — set by the concrete renderer class, so it always reflects what runs, never what was requested. The report is cleared on failed initialization (rollback) and on disposal. Real-browser verification (R6-2 + R6-3): auto-detection, `webgl`, `canvas`, and `webgpu` are verified at the initialization / rendered-frame / cleanup level by `node scripts/smoke-renderer-backends.mjs`, and the g2w feature set (resize, texture assets with the non-destructive cleanup policy, sprites, RGBA transparency, alpha blending, visibility, anchor+rotation, view disposal) is verified per backend by `node scripts/smoke-renderer-features.mjs` — both on headless Chrome (Windows), each case in a fresh CDP page, with objective pixel assertions; fallback is recorded, never counted (see [renderer-audit-r6.md](renderer-audit-r6.md) for the backend support statement).

### `@g2w/input-dom`

Implements the browser side of the input system on top of the core contract. `DomInput` subscribes to real DOM events (keyboard on an injectable target, default `window`; pointer events on the canvas; `pointerup` and `pointercancel` on `window` so off-canvas releases and cancellations are caught; `blur` for focus loss), normalizes them (pointer coordinates become canvas-relative, scaled into the configured `logicalSize` game space when provided — see the sizing section — otherwise into the canvas's backing pixels), and feeds the core `InputState`. Touch contacts ride the same Pointer Events stream: contacts with `pointerType === "touch"` are additionally fed into `InputState`'s multi-touch contract keyed by `pointerId`, and `pointercancel` cancels the touch contact (or releases held buttons for non-touch pointers) so a browser-claimed gesture never leaves state stuck as held. It owns no input logic: `attach()` is idempotent and failure-safe (a registration that fails part-way through rolls back every listener added during that call, leaving the adapter detached and retryable; a rollback failure is aggregated with the registration error), `dispose()` removes every listener it registered, is terminal, and attempts every removal even when one fails (failures surface as an `AggregateError`), so successful removals stop event delivery to the `InputState` after disposal — a removal that itself failed may leave that listener attached until a retry succeeds; and it never calls `preventDefault()`. Like the renderer adapter, it depends on `@g2w/core` and never the other way around.

### `@g2w/input-gamepad`

Implements the browser side of the gamepad system on top of the core contract. `GamepadInput` samples controllers and feeds the core `GamepadState`: the polling source is injectable (default `navigator.getGamepads()`, mapped to a structural view so tests pass plain objects and hardware availability is never required to import, construct, or test the package), connection events arrive on injectable `EventTarget`s (default `window`, resolved at `attach()` so construction needs no browser). Sampling is explicit with no second loop and no timers — the host calls `poll()` once per game frame, and any previously connected index absent from the poll result is treated as disconnected so stale button/axis state is never retained for a controller that vanished without an event. Source errors propagate to the caller (state untouched; the next poll retries). `attach()` is idempotent and failure-safe (a registration that fails part-way through rolls back every listener added during that call, leaving the adapter detached and retryable; a rollback failure is aggregated with the registration error), `dispose()` removes every listener and is terminal (attempting every removal even when one fails, surfacing failures as an `AggregateError`), so successful removals stop event delivery to the `GamepadState` after disposal — a removal that itself failed may leave that listener attached until a retry succeeds — and `poll()` rejects sampling after disposal so no sample reaches the `GamepadState` once the adapter is disposed. Axes are passed through raw — no dead zone is imposed. The package depends only on `@g2w/core` and never the other way around.

### `@g2w/audio-web`

Implements the browser side of the audio system on top of the core contract. `WebAudioBackend` implements the core `AudioBackend` shape: it downloads sound files through an injectable `fetch`, decodes them through an injectable `AudioContext`, and hands out `Sound` values that start real Web Audio playbacks (`AudioBufferSourceNode` → `GainNode` → destination) with volume and looping. `resume()` exists for the browser autoplay policy: a fresh context starts `suspended`, `play()` on a suspended context throws `WebAudioError` instead of starting silently inaudible playback, and `resume()` must be called from a real user-gesture handler. `dispose()` closes the context (at most once, idempotent), which reclaims every decoded buffer. The package depends only on `@g2w/core` and never the other way around.

### `@g2w/devtools`

A read-only developer overlay for debugging running games. `DevTools` is constructed with plain references — `scenes` (a `SceneManager`), optional `objects` (a `GameObjectCollection` or a function returning one), and `input` with explicit `watchKeys`/`watchButtons` watch lists — and polls immutable snapshots at a fixed refresh rate (default 10 Hz, injectable scheduler for tests). It renders a fixed-position DOM panel: scene explorer, object list with positional `#N` labels, a transform inspector for the selected object, FPS/frame time computed from a ring buffer of recent frame samples, a watched-input monitor, and a bounded, drop-oldest log buffer that also records scene transitions as they are observed. It is strictly observational: it never mutates the runtime and never disposes it — its own `dispose()` only removes the panel and stops its refresh tick (a single injected `requestAnimationFrame` schedule). `open()`/`close()`/`toggle()` are idempotent; after `dispose()` every method throws `DevToolsError`. The package depends only on `@g2w/core` (plus DOM APIs, injected for tests) and is meant to be loaded only in development: the demo imports it dynamically behind `import.meta.env.DEV`, so production builds exclude it entirely. A disabled "3D — Coming Soon" button marks the future 3D inspector.


### `@g2w/runtime`

The Effect-based runtime and bootstrap foundation (E1 of the Effect-native runtime RFC, delivered ahead of any migration). `createG2WRuntime()` builds exactly one managed Effect runtime (Effect `ManagedRuntime`) from an optional application `Layer`, owns its lifecycle scope, and builds the layer eagerly so a failing layer reports through `createG2WRuntime` itself as `RuntimeBootstrapError` with the original cause preserved - after resources the partial build already acquired are released. The returned `G2WRuntime` handle is deliberately small: `run()` executes an Effect program against the runtime's services (reusing the single managed runtime - never one per frame or per call), `addFinalizer()` registers a plain callback cleanup (LIFO order, plain callbacks so non-Effect hosts can use them), and `shutdown()` is explicit and idempotent - repeated or concurrent calls share one shutdown and never execute cleanup twice. Shutdown attempts every registered finalizer even after a failure, then releases the layer resources; every cleanup failure (host finalizer or layer-disposal defect) is collected into `RuntimeShutdownError.failures` in execution order, so no failure hides another. Errors are Effect-native typed errors (`Schema.TaggedError`): `RuntimeBootstrapError`, `RuntimeCleanupFailure`, `RuntimeShutdownError`. The package depends on `@g2w/core` (composition only; core stays dependency-free and Effect-free) and `effect` 4.0.6 (exact pin).

**Effect-native game lifecycle (E2).** `G2WGame` (with `G2WGameOptions`) migrates the game lifecycle onto this foundation while mirroring core `Game`'s contract exactly — the same state model (`new → initializing → initialized → running ⇄ stopped → disposed`), the same concurrent-init/stop-during-init/dispose race behavior, and the same synchronous frame loop. The differences are all in orchestration:
- `init()` runs the renderer's `initialize()` as one lifecycle effect on the managed runtime (`Effect.promise`, so the original rejection cause is rethrown unchanged). A failed init returns the game to `"new"` with nothing acquired and nothing registered — retry is safe.
- On the first successful init the game registers ownership as runtime finalizers: renderer release, then owned scene-manager disposal (skipped with `ownScenes: false`), then any caller finalizer registered earlier (those were buffered until the runtime resolved). LIFO shutdown therefore releases caller finalizers first, then scenes, then the renderer they may still be rendering with.
- `dispose()` is idempotent and terminal. It cancels the frame, waits for in-flight initialization (swallowing its failure — an init failure is not a disposal failure), flushes buffered finalizers if init never completed, and shuts the managed runtime down. Every finalizer is attempted even after a failure, and cleanup failures stay observable: `dispose()` rejects with `RuntimeShutdownError` (original causes collected) after the game is marked disposed.
- The frame hot path is untouched by Effect: exactly one injected `FrameScheduler` (defaulting to `requestAnimationFrame`, re-exported from core), synchronous update/render dispatch, and no runtime, effect, or promise allocation per frame.

Core `Game` remains the reference implementation. The hello-world demo now boots through `G2WGame` (E4), making the Effect runtime the primary application path: the demo's scene manager, audio stack, and asset manager are registered as caller finalizers, so `G2WGame.dispose()` releases assets, audio, scenes, and the renderer in one LIFO chain. The demo bundle now includes Effect (measured: 706,420 B total across `examples/hello-world/dist`, up from 623,910 B — see [Hello-world demo](#hello-world-demo)).
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
- **Disposal** is immediate, idempotent, and terminal: the active scene is exited, then every scene whose `init` completed is disposed in registration order (scenes never initialized have no manager-managed resources). Cleanup is best-effort: one hook's failure does not prevent the remaining cleanup, and the first error is rethrown — as an `AggregateError` when several hooks fail — after all cleanup attempts complete. Afterwards `start`, `goTo`, and `update` throw `SceneError`. In the demo, the scene manager's disposal is owned by `G2WGame` (registered as a caller finalizer), so one `game.dispose()` call on `pagehide` exits the active scene, disposes every scene, and releases the renderer.

Intentionally unsupported (documented scope, not omissions by accident): scene stacks, transition effects, scene persistence, and async hooks.

### `InputState` — input and frame semantics

`InputState` (in core) is a DOM-free, renderer-agnostic state machine for keyboard, pointer, and touch input. Browser adapters feed it normalized events (`handleKeyDown`, `handleKeyUp`, `handlePointerMove`, `handleButtonDown`, `handleButtonUp`, `handleFocusLoss`, `handlePointerLeave`, and the touch-contact feed `handleTouchStart`/`handleTouchMove`/`handleTouchEnd`/`handleTouchCancel`); game and scene code reads it through query methods (`isKeyDown`, `wasKeyPressed`, `wasKeyReleased`, `isButtonDown`, `wasButtonPressed`, `wasButtonReleased`, `pointerX`/`pointerY`, and the touch queries `touchCount`, `activeTouchIds`, `isTouchActive`, `getTouchPosition`, `wasTouchStarted`, `wasTouchEnded`, `wasTouchCancelled`). It is a plain class with no dependencies and no access to `window`, `document`, or DOM event types at runtime — the architecture test enforces this.

Frame semantics (all covered by tests in `packages/core/test/input.test.ts`):
- **Held state is continuous** (`down`); **pressed/released are per-frame edges**. Edges are set by input events and reset — all at once — only at the explicit boundary `endFrame()`.
- **The boundary is composed, not built in:** applications call `input.endFrame()` exactly once per frame, after every consumer, typically as the last statement of `Game.onUpdate` after scene updates. Events arriving between frames accumulate into the next frame's edges; no second loop or hidden timer exists.
- **A tap between two frames is not lost:** a key pressed and released before the next boundary reports `wasKeyPressed` _and_ `wasKeyReleased` in that frame while `isKeyDown` is already `false`.
- **OS key repeat is not a new press:** repeated `keydown` events while a key is held are ignored; the press edge fires once per physical press.
- **Focus loss** releases every held key and button and generates the matching released edges (game logic observes a normal release); the pointer position is kept, and every active touch contact is cancelled with a cancelled edge. **Pointer leaving the canvas** releases held buttons the same way (the `pointerup` may happen off-canvas) and keeps the position.
- Key identifiers are standard `KeyboardEvent.code` strings (`"KeyW"`, `"ArrowLeft"`, `"Space"`, ...); pointer buttons are numbered as in `MouseEvent.button` (0 = primary).

**Touch contacts (R5):** beyond the single-pointer view, adapters feed each contact individually, keyed by a stable id (the DOM `pointerId` for pointer-event adapters), so multiple simultaneous contacts are trackable (`touchCount`, `activeTouchIds`, `getTouchPosition(id)`). Touch edges follow the same per-frame semantics as keys and buttons. Cancellation is distinct from a normal end (`wasTouchCancelled`), so game code can tell an intentional lift from the browser claiming the gesture (page scroll, incoming call, palm rejection). Non-finite coordinates are ignored — a broken event payload cannot poison positions. The single-pointer view is unaffected by touch feeding, so mouse and keyboard behavior is unchanged.

Intentionally unsupported (documented scope, not omissions by accident): action mapping or rebinding, input recording, drag-and-drop, and preventing default browser behavior from the framework.

### `GamepadState` — gamepad and frame semantics

`GamepadState` (in core) is the DOM-free gamepad counterpart to `InputState`: a plain state machine keyed by controller index (tests in `packages/core/test/gamepad.test.ts`). A browser adapter samples hardware and feeds `handleConnected(index)`, `handleDisconnected(index)`, and `handleSample(index, snapshot)` where a snapshot is `{ pressed: readonly boolean[], axes: readonly number[] }` — plain values, no DOM `Gamepad` types in core.
- **Edges are per game frame, not per sample.** An adapter may poll many times between two boundaries; a button that went down and up within one frame reports both `wasButtonPressed` and `wasButtonReleased` that frame. `endFrame()` resets all edges across all controllers and touches nothing else.
- **Disconnection clears everything.** `handleDisconnected(index)` — from a `gamepaddisconnected` event or an adapter noticing a vacant slot in a poll result — releases every held button with released edges and drops the axes; a reconnected controller (possibly at a different slot) starts from a clean slate. Hardware indices are not stable across reconnects; `index` means "the controller currently at this slot".
- **Axes are raw.** Values are stored as sampled; no dead zone, no normalization — game code applies its own thresholds. Unsampled axes read neutral `0`; non-finite values from a broken sample are ignored.
- **A sample implies connection.** The first sample for an index marks it connected; adapters that only sample (no connection events) still work.

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
- **Scenes still destroy their display objects, never their textures.** `sprite.destroy()` does not touch the texture by default, which matches this policy; the demo's teardown order is: adapter → game (`G2WGame.dispose()` releases the caller finalizers — assets, audio, scenes — then the renderer; the final step releases only the manager itself).

### `Sprite2D` / `Transform2D` — the 2D sprite model, and `createSpriteView()`

Core provides a minimal, renderer-independent 2D sprite model (see `packages/core/test/sprite.test.ts`):
- **`Transform2D`** is a mutable value: `x`/`y` position in logical pixels (default `0`), `rotation` in **radians** (default `0`; direction follows the renderer's screen space — for PixiJS, positive values rotate clockwise because the y axis points down), and `scaleX`/`scaleY` multipliers where `1` means natural scale (default `1`). Plain mutable numbers — no setters, validation, or observers.
- **`Sprite2D<TTexture>`** holds a typed texture handle (generic — core never inspects or destroys it), a `Transform2D` (shared when supplied, fresh when omitted), plus the visual properties the current demos need: `visible` (default `true`), `alpha` (default `1`), a normalized **`anchor`** (`Anchor2D`, default `(0, 0)`), and a **`zIndex`** (default `0`). It is plain mutable data; mutating it never touches a renderer.
- **`Anchor2D`** is the sprite's normalized origin: `0` is the left/top edge, `0.5` the center, `1` the right/bottom edge. Position is where the anchor lands, and rotation and scale revolve around it — `(0.5, 0.5)` spins a sprite around its center, `(0.5, 1)` makes the position its feet. The default `(0, 0)` preserves the original top-left placement. The anchor belongs to the sprite, not to the (possibly shared) `Transform2D`: a game object has no visual, so a transform-level anchor would be meaningless. `x`/`y` are read-only; `set(x, y)` is the only mutation path, and it rejects non-finite or out-of-range values with `SpriteError` instead of clamping (a rejected call leaves the anchor unchanged).
- **`zIndex`** is a plain mutable number like `visible`/`alpha`: higher values render in front of lower ones, and sprites with equal `zIndex` keep their current order (the sort is stable). A renderer is free to ignore it; the PixiJS adapter applies it. In the PixiJS adapter, applying a nonzero `zIndex` enables `sortableChildren` on the shared renderer stage, which makes render-time sorting cover **all** children of that stage — including display objects not managed by g2w (texts, graphics, containers added directly by the app). Those default to z-index `0` and keep their relative order (the sort is stable), but a sprite with `zIndex > 0` will render in front of unmanaged children that were attached after it; attach-order alone no longer decides the final order on a stage that hosts a z-ordered sprite.

`@g2w/renderer-pixi` projects the model onto the stage: **`createSpriteView({ sprite, renderer })`** creates one PixiJS `Sprite` for the model, applies the model state immediately, and attaches it to the renderer's stage. The view exposes:
- **`sync()`** — applies the current model state (position, rotation, scale, visibility, alpha, anchor, z-order) to the display object. Called explicitly, typically once per frame at the end of the scene update, right where `input.endFrame()` sits — the existing Game loop is the only driver; there is no second loop, ticker, or subscription. Changes without a `sync()` have no effect until the next sync. PixiJS's `Sprite.anchor` uses the same normalized `0`–`1` space as `Anchor2D`, so the mapping is direct with no offset math and no double application. The view attaches the display object before applying the model because PixiJS only marks a parent's sort dirty when a `zIndex` changes on an attached child.
- **`dispose()`** — removes the display object from its parent and destroys it. Idempotent and terminal. It **never destroys the texture** (textures live in the shared `Assets` cache; see the asset section) and never touches the stage or sibling display objects. `sync()` after disposal throws `SpriteViewError`.

Ownership: the caller owns the **model**; whoever creates a **view** owns it and disposes it (typically the owning scene's `dispose()` hook); the **texture** is owned by nobody and lives for the session. Because `enter`/`exit` pair per activation, scenes that toggle `visible` through the model (the demo's approach) reuse one view across transitions without duplicating display objects; a scene that instead creates views in `enter()` must dispose them in `exit()`.

Intentionally unsupported: parent/child transform hierarchies, tint, blend modes, animation timelines, and renderer-independent scene graphs (the minimal `GameObject` layer below does not change this — it adds no display semantics of its own). Anchors and z-ordering are supported as of R11; hierarchical scene graphs, ECS, and 3D anchors are not.

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

### `AudioManager` — audio, playbacks, and ownership

Core provides a small, renderer-agnostic audio contract (`packages/core/test/audio-manager.test.ts`) following the asset-manager pattern:
- **`AudioBackend`** is the injected, browser-free loader contract: `load(key)` returns a `Promise<Sound>` and optional `dispose()` releases backend resources. Everything platform-specific lives behind it, exactly like the asset system's injected loader.
- **`AudioManager`** composes a non-owning core `AssetManager<Sound>`, so caching, concurrent-request deduplication, and retryable failures are inherited — not reimplemented. `play(key, options?)` loads (usually a cache hit), starts one playback, and tracks the returned `SoundPlayback`; invalid options (non-finite or negative `volume`) throw `AudioError` before any backend call, and backend playback refusals propagate unchanged.
- **`SoundPlayback`** is a handle with idempotent `stop()` and a `stopped` flag that also flips on natural completion, so the manager's active set stays bounded (finished playbacks are pruned on the next `play()`).
- **Ownership:** the manager owns _playback lifetimes_, never sounds. `dispose()` is terminal and idempotent: it stops every active playback, clears the cache, and calls `backend.dispose()` once if provided. It **never destroys `Sound` values** — decoded audio is caller/backend-owned and may be shared (the same file loaded by two managers is one decoded buffer in the browser, and neither manager may destroy it for the other). Backend disposal errors propagate to the disposer.
- **Autoplay policy is the backend's documented contract:** core never hides a backend refusal. The Web Audio adapter throws `WebAudioError` on `play()` against a suspended context; the application resumes from a user gesture (see `@g2w/audio-web` above).
- **No second loop and no hidden timers:** audio is fire-and-forget, driven entirely by the backend.

Intentionally unsupported: mixers, spatial/3D audio, adaptive music, streaming, and autoplay queues (roadmap-level future work, not stubs).

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
- `packages/core/test/renderer-conformance.ts` (R6-2) defines the shared renderer conformance suite against the `Renderer` interface only — the contract's executable definition of lifecycle, capability-truthfulness, error semantics, optional `render()`/`resize()` support, disposal, and failed-init recovery. It imports no adapter, PixiJS, browser API, or Effect.
- `packages/renderer-pixi/test/renderer-conformance.test.ts` adopts the shared suite for `PixiRenderer` over a deterministic gated fake of the PixiJS `Application`; PixiJS-specific behavior (texture ownership, option forwarding, destroy flags) stays in `pixi-renderer.test.ts`.
- `packages/renderer-pixi/test/pixi-renderer.test.ts` asserts the adapter declares `@g2w/core` as a dependency and that core does not depend back on the adapter.
- `packages/renderer-pixi/test/assets.test.ts` asserts the texture asset manager composes with the core `AssetManager` and that shared textures are destroyed exactly once.
- `packages/input-dom/test/package.test.ts` asserts the DOM input adapter declares `@g2w/core` as a dependency and composes with the core `InputState`.
- `packages/input-gamepad/test/package.test.ts` asserts the gamepad adapter declares only `@g2w/core` as a dependency and composes with the core `GamepadState` through the public entry points.
- `packages/devtools/test/package.test.ts` asserts the DevTools package declares only `@g2w/core` as a dependency and composes with the core `SceneManager`/`InputState` through the public entry points.
- `packages/audio-web/test/package.test.ts` asserts the audio backend declares only `@g2w/core` as a dependency and implements the core `AudioBackend` contract through the public entry points.
- `packages/runtime/test/package.test.ts` asserts the runtime declares exactly `@g2w/core` and `effect` (pinned) as dependencies and that core stays free of Effect and browser imports.
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
- The hello-world Vite demo as the reference consumer of the public API; it boots through the Effect-native `G2WGame` (E4), renders scene content through the adapter, loads its texture through the adapter's asset API, drives its logo sprite through the core sprite model and `sync()`, runs orbiting spark game objects through a `GameObjectCollection` inside the gameplay scene, and keeps all other PixiJS objects at the example boundary.

Provisional (expect to change in later MVPs):
- The exact shape of `RendererInitOptions`; it will likely grow as core learns about backends, display-fit policies (letterboxing, container-driven resizing), and more.
- The PixiJS adapter's internals; it will be reworked as core grows more rendering features.
- The `stage` accessor on the adapter: it leaks a PixiJS `Container` type to adapter consumers. Acceptable while the adapter is the only way to draw; a renderer-agnostic display API would replace it.
- The asset system's single-loader contract: one `AssetManager` instance handles one value type; richer manifests, bulk loading, and per-type loaders are future work.
- The texture loader's non-destructive policy: textures from PixiJS's shared `Assets` cache live for the session (no manager-driven destruction); if texture churn ever matters for a real game, cache eviction or explicit `Assets.unload` guidance can be added without breaking the current API.
- The sprite model's minimal scope: `Sprite2D` covers position/rotation/scale/visible/alpha plus the R11 `anchor`/`zIndex`; per-axis pivots beyond the normalized anchor (e.g. pixel-space pivots), tint, hierarchies, and more are expected to grow the model later, and the `stage` accessor may be superseded by a broader renderer-agnostic display API.
- The game-object layer's minimal scope: `GameObject` is a transform plus update/destroy hooks; components, parent/child hierarchies, query systems, and automatic registration (e.g. by scenes or managers) are future work — composition stays explicit for now.
- The DevTools overlay's minimal scope: read-only snapshots with positional `#N` object labels (not stable IDs), watched-keys-only input, and no tap into the game's `deltaTime` (FPS is measured from the overlay's own frame samples); selection, editing, and stable object identity are future work.
- The test aliasing setup; it may move to package-level configs when the workspace grows.
