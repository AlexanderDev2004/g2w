# Roadmap

This document tracks where g2w is going. It is based on the actual repository state and is updated as milestones land.

**g2w — Game to Website** is a TypeScript-first, AI-agent-ready framework for building and shipping web games: HTML5 games, 2D first with 3D planned, for desktop and mobile web browsers.

## Roadmap principles

- **Small, strict contracts first.** Core stays renderer-agnostic with zero runtime dependencies; every rendering capability lives behind an adapter.
- **Explicit ownership.** Resources (textures, display objects, event listeners, loops) always have a documented owner and a safe disposal path.
- **Deterministic tests over hope.** Every lifecycle, transition, and ownership rule is enforced by tests, not conventions.
- **Documented ≠ implemented.** Planned features are listed here, never stubbed in code.

## Status definitions

- **Done** — implemented, tested, and validated by CI.
- **In Progress** — actively being worked on.
- **Planned** — intended, with the prerequisites identified; not started.
- **Exploratory** — a direction under consideration; may change shape or be dropped.

## Priority definitions

- **P0** — required for the framework to be correct or safe.
- **P1** — required for a usable minimum game framework.
- **P2** — valuable quality-of-life and ecosystem work.
- **P3** — nice to have; opportunistic.

## Completed capabilities

All verified by the test suite and CI (see [docs/architecture.md](docs/architecture.md) for details):
- **MVP 0 — Foundation** `Done` `P1`: pnpm monorepo, strict TypeScript, Biome, Vitest, GitHub Actions CI, renderer contract, PixiJS adapter, browser demo.
- **MVP 1A — Game runtime** `Done` `P1`: `Game` lifecycle (`new → initializing → initialized → running ⇄ stopped → disposed`), rAF frame loop with injectable `FrameScheduler`, seconds-based clamped `deltaTime`, deterministic init/stop/dispose races.
- **MVP 1B — Scene system** `Done` `P1`: `Scene` contract (init/enter/update/exit/dispose), `SceneManager` with exactly one active scene, exit-before-enter transitions, deferred reentrant transitions (latest request wins), unwrapped hook errors with defined recovery, terminal best-effort disposal, one-manager-per-scene-instance ownership.
- **MVP 1C — Input system** `Done` `P1`: DOM-free `InputState` (keyboard held/pressed/released edges, pointer position/buttons, focus-loss release), `@g2w/input-dom` browser adapter with idempotent attach, full listener cleanup, and CSS-scale-aware coordinates; per-frame `endFrame()` edge reset.
- **MVP 1D — Asset management** `Done` `P1`: generic `AssetManager` (async loading, caching, concurrent deduplication, retryable failures, optional `disposeAsset` ownership transfer, terminal idempotent disposal with `AggregateError` cleanup reporting) and the non-destructive `createTextureAssetManager()` PixiJS adapter.
- **MVP 1E — 2D transform & sprite API** `Done` `P1`: `Transform2D`, `Sprite2D<TTexture>`, `createSpriteView()` with explicit `sync()`, idempotent disposal, and never-destroy-shared-texture semantics; animated demo through the existing game loop.
- **MVP 1F — Scene ownership hardening** `Done` `P2`: permanent one-manager-per-scene claim enforced at registration.
- **CI & supply-chain hardening** `Done` `P1`: least-privilege workflow permissions (`contents: read`), third-party Actions pinned to verified commit SHAs, Dependabot version updates (Actions + npm ecosystems, weekly), CONTRIBUTING.md with AI-contribution policy.
- **R1 — Renderer-disposal texture semantics** `Done` `P0`: `PixiRenderer.dispose()` destroys stage display objects only, never textures or texture sources; the single framework-wide texture lifetime is the non-destructive asset policy, pinned by regression tests.
- **R2 — Game objects** `Done` `P1`: `GameObject` + `GameObjectCollection` in core — a claimed, snapshot-iterated update/destroy registry that runs through the existing game loop, with explicit ownership, terminal idempotent destroy, and no second loop.
- **DevTools MVP — read-only runtime overlay** `Done` `P2`: `@g2w/devtools` — an opt-in, dev-only DOM overlay observing scenes (via a new `SceneManager.keys` accessor), game objects and transforms (via a new `GameObjectCollection.objects()` snapshot accessor), explicitly watched input keys/buttons, FPS/frame time, and a bounded runtime log; snapshot-polling only, never mutating or disposing the runtime, and excluded from production builds.

- **E3 — Adapter lifecycle hardening** `Done` `P0`: E3-A audit (#6), E3-B PixiRenderer lifecycle (#7, PR #9), and E3-C DOM/Gamepad attachment lifecycle (#8, PR #10). Initialization/attachment rollback, concurrent/repeated lifecycle calls, terminal disposal, listener cleanup, and shared-texture ownership are covered by regression tests. Adapters stay imperative and depend on core only; Effect ownership remains at the higher-level runtime boundary.
- **E4 — Effect as the primary application runtime** `Done` `P1`: the hello-world demo boots through the Effect-native `G2WGame` (`@g2w/runtime`) instead of wiring `Game`/`SceneManager`/renderer/input/assets/audio by hand. Scenes, assets, and audio are registered as caller finalizers released LIFO (assets → audio → scenes → renderer); `pagehide` disposes adapters then the game once, idempotently. Core `Game` remains the reference implementation and `@g2w/core` stays Effect-free; no Effect work enters the frame hot path and adapters remain imperative (E3 boundary intact). Evidence: 4 new deterministic runtime tests (finalizer release order, failure observability via `RuntimeShutdownError.failures`, finalizers surviving failed-init retry, exactly-once disposal-before-init) — full suite 385 tests; bundle 706,420 B (+82,510 B, Effect now a demo dependency by design); headless-browser smoke via CDP: 13/13 checks, zero console/page errors, pixel-verified menu ⇄ gameplay transitions, and double-pagehide disposal without duplicate cleanup or uncaught errors.
- **R6 — Renderer capability and architecture audit** `Done` `P1`: audit of the renderer contract, the PixiJS 8 backend landscape (all three backends verified in the installed package source; the "canvas renderer dropped" claim corrected), and the gap list in [docs/renderer-audit-r6.md](docs/renderer-audit-r6.md).
- **R6-1 — Renderer backend selection and capability reporting** `Done` `P1`: optional `backend` preference on `RendererInitOptions` (forwarded to PixiJS's `preference`; PixiJS falls back from an unavailable backend) and `capabilities.backend` reporting the actually initialized backend (PixiJS's public `renderer.name`), cleared before init / after failed init / after disposal. Existing callers keep auto-detection unchanged; core stays dependency-free. Evidence: 8 new deterministic tests, exports verification.
- **R6-2 — Shared renderer conformance suite and real-browser backend verification** `Done` `P1`: the renderer contract's lifecycle invariants are pinned by a reusable conformance suite owned by `@g2w/core` (defined against the `Renderer` interface only, no PixiJS/browser/Effect imports) and adopted by `PixiRenderer` with a deterministic gated fake; a CDP smoke harness (`node scripts/smoke-renderer-backends.mjs`) verifies auto, `webgl`, `canvas`, and `webgpu` in a real headless Chrome — initialization, actual-backend reporting, a rendered background frame (pixel-verified where the backend allows readback), and clean terminal disposal. Evidence: 23 conformance tests; smoke summary 4/4 verified (HeadlessChrome/156, Windows).
- **R6-3 — Renderer feature parity across backends** `Done` `P1`: the existing g2w feature set (frame rendering, background color, resize/logical resolution, texture asset loading with the non-destructive cleanup policy, sprite rendering, RGBA texture transparency, alpha blending, visibility, anchor+rotation, sprite-view disposal, init/dispose lifecycle) is verified **per backend** in a real browser by `node scripts/smoke-renderer-features.mjs` (extension of the R6-2 CDP harness; one fresh page per backend, objective pixel assertions, fallback recorded but never counted). Evidence: 12/12 features verified on WebGL, Canvas, and WebGPU (Chrome/156.0.8078.48, Windows); feature-level graphics primitives (PixiJS `Graphics`/masks/filters) remain demo-boundary objects without a g2w public API and stay out of the contract.

## Near-term (current focus)

### R1 — Reconcile renderer-disposal texture semantics

**Status:** Done · **Priority:** P0
- **Objective:** make texture lifetime unambiguous across the whole stack.
- **Resolution (implemented and tested):** `PixiRenderer.dispose()` destroys the display objects still attached to the stage (`children: true`) but never textures or texture sources — the `texture: true, textureSource: true` flags were removed. The renderer cannot prove exclusive ownership of stage-attached textures (they come from PixiJS's shared `Assets` cache and may be referenced by other managers, sprites, or subsystems), so the renderer owns display objects only. Exactly one framework-wide texture lifetime now exists: shared-cache textures live until page unload, and applications unload explicitly with `Assets.unload(url)` when they know nothing else uses a texture.
- **Evidence:** regression tests in `packages/renderer-pixi/test/pixi-renderer.test.ts` cover disposal with a shared cached texture (texture and source stay valid), consumers outside the stage, texture reuse across disposal and re-initialization, repeated disposal, and the partial-initialization path. A dedicated test pins the hazard: PixiJS destroy options with `texture: true, textureSource: true` do destroy stage textures, so reintroducing those flags fails the suite.
- **Trade-off:** textures the application never unloads explicitly live until page unload — accepted in exchange for never destroying a texture another consumer still holds.
- **Acceptance criteria:**
  1. [x] Documented, tested decision: the renderer stops destroying textures; docs state that framework disposal never ends texture lifetime.
  2. [x] Demo teardown order verified against the decision (scenes → game → assets; nothing in the chain destroys textures — see [examples/hello-world/src/main.ts](examples/hello-world/src/main.ts)).
  3. [x] No test asserts both policies simultaneously; the hazard test asserts only the PixiJS flag semantics the policy avoids.

### R2 — Game objects / display model

**Status:** Done · **Priority:** P1
- **Objective:** a minimal renderer-agnostic game-object layer so games stop hand-managing arrays.
- **Resolution (implemented and tested):** `@g2w/core` exports `GameObject` (a `Transform2D` plus optional `update(deltaTime)` and `destroy()` hooks) and `GameObjectCollection`. Deliberately minimal — no ECS, no scene graph, no parent/child transforms. A collection claims each object (one collection at a time, re-registrable after `remove`; destroyed objects are permanently unregistrable), duplicate or cross-collection registration throws `SceneError`, `update(deltaTime)` iterates a snapshot driven by the existing game loop (adds take effect next frame, removals immediately, even mid-iteration), and `destroy()` is terminal, idempotent, and best-effort: it destroys only still-registered objects exactly once in insertion order and reports hook failures as an `AggregateError` (or rethrows a single one). Objects share their sprite model's `Transform2D` by reference; display association stays with `Sprite2D`/`createSpriteView`, and object cleanup never touches shared textures (pinned by a renderer-adapter regression test).
- **Evidence:** 25 deterministic tests in `packages/core/test/game-object.test.ts` cover registration/claiming, update order and mid-update add/remove, error propagation, nested-update rejection, destroy idempotency and aggregation, `SceneManager` and `Sprite2D` integration; `packages/renderer-pixi/test/sprite-view.test.ts` pins that collection cleanup never destroys the shared texture; `scripts/verify-exports.mjs` exercises the object pipeline through the real package entry points.
- **Acceptance criteria:**
  1. [x] Public API documented and exported from `@g2w/core`.
  2. [x] Tests cover lifecycle, ownership, and update order.
  3. [x] Demo demonstrates it; no second loop introduced.

### DevTools MVP — read-only runtime overlay

**Status:** Done · **Priority:** P2
- **Objective:** let developers and AI agents inspect a running g2w game without instrumenting game code or mutating runtime state.
- **Resolution (implemented and tested):** new `@g2w/devtools` package (depends only on `@g2w/core`). `DevTools` takes plain references — `scenes`, optional `objects` (a collection or a getter), `input` with explicit `watchKeys`/`watchButtons` watch lists, optional `logLimit` and `refreshHz` — and polls read-only snapshots at a fixed rate into a fixed-position DOM panel: scene explorer, object list with positional `#N` labels, a transform inspector, FPS/frame time from a recent-samples ring buffer, a watched-input monitor, and a bounded drop-oldest log buffer that also records observed scene transitions. Strictly observational: it never mutates or disposes the runtime; its own `dispose()` is terminal and idempotent and removes only the panel and its refresh tick. The demo loads it dynamically behind `import.meta.env.DEV`, so production builds exclude it (verified by scanning the built bundle and by a live production smoke run). Supporting core additions, both exported and tested: `GameObjectCollection.objects()` (snapshot accessor, throws `SceneError` after destroy) and `SceneManager.keys` (fresh readonly array of registered scene keys). A disabled "3D — Coming Soon" placeholder marks the future 3D inspector.
- **Evidence:** 31 deterministic tests in `packages/devtools/test/` (fake DOM document + injected scheduler — no browser, no real timers) including 2 package-boundary tests; new core tests for the snapshot accessor and the `keys` getter; `pnpm verify:exports` exercises the DevTools pipeline through the real entry points; the full suite is 209 tests across 15 files. A real-browser smoke run (headed Chrome via CDP) exercised menu → gameplay → object selection → menu → re-entry with the overlay open, the close button, and captured the four `docs/screenshots/hello-world-*.png` images with zero console or page errors; a separate production-bundle smoke run verified the game runs with DevTools fully absent.
- **Screenshot validity:** the four `docs/screenshots/hello-world-*.png` captures come from a headed, on-screen Chrome session and show the fully rendered page — WebGL canvas included (menu blue background, gameplay square and sparks, page hints) plus the DevTools overlay. Headless/protocol captures of the same page return a black canvas (a canvas created without `preserveDrawingBuffer` cannot be read back through CDP screenshots), which is a capture-tooling limitation, not a rendering defect: an in-page `drawImage` readback of the live canvas returns real frame content, and a production-bundle smoke run confirmed the game renders and animates with DevTools excluded.
- **Intentionally out of scope:** editing or mutating runtime state, stable object IDs, an unwatched-input view, tapping the game's `deltaTime`, and any 3D inspection beyond the placeholder.
- **Acceptance criteria:**
  1. [x] Read-only overlay built on the public core API; core gains no rendering or DOM dependencies.
  2. [x] Deterministic tests cover snapshotting, logging, FPS, input watch lists, and disposal.
  3. [x] Demo wiring is dev-only and absent from production builds.

### R11 — Sprite anchors, pivots, and z-ordering

**Status:** Done · **Priority:** P2
- **Objective:** remove the top-left-pivot limitation and give scenes deterministic layering.
- **Dependencies:** R2.
- **Resolution (implemented and tested):** `Sprite2D` gains a normalized **`anchor`** (`Anchor2D`: `0` edge, `0.5` center, `1` opposite edge; default `(0, 0)` preserves the original top-left placement) and a **`zIndex`** (default `0`). The anchor is a sprite property, not a `Transform2D` property — transforms are shared between sprites and game objects, and a game object has no visual. `x`/`y` are read-only; `set(x, y)` is the only mutation path and rejects non-finite or out-of-range values with the new `SpriteError` instead of clamping (a rejected call is a no-op). `zIndex` is a plain mutable number: higher values render in front, equal values keep their current order (PixiJS's sort is stable), and the PixiJS adapter applies it through the same `view.sync()` call — mapping into PixiJS's identical normalized `Sprite.anchor` space with no offset math. The view attaches the display object before applying the model because PixiJS only marks a parent's sort dirty when a `zIndex` changes on an attached child. The demo now center-anchors the logo and sparks, so gameplay rotation visibly spins them around their own middles.
- **Evidence:** 16 new deterministic tests — `Anchor2D` defaults/init/`set`/rejection (negative, > 1, NaN, ±Infinity, constructor and setter paths, no-op on rejection, inclusive edges), `Sprite2D` anchor/zIndex defaults and init, per-sprite anchor ownership, anchor independence from a shared transform, plain `zIndex` mutability; adapter tests with real PixiJS sprites: default anchor leaves top-left placement, center/feet anchors applied at creation and through `set()`+`sync()`, real `Container` sorting reorders by `zIndex` and never reshuffles equal values, z-order changes don't disturb anchor/transform state, texture-safety regressions unchanged. `scripts/verify-exports.mjs` now asserts `Anchor2D`/`SpriteError` exports and that the sprite pipeline applies anchor and z-order. Full suite: 253 tests across 15 files.
- **Acceptance criteria:**
  1. [x] Anchor/pivot in the core model, applied by `sync()`.
  2. [x] Z-order defined and tested (higher `zIndex` in front; equal values stable).
  3. [x] Demo updated (center-anchored logo and sparks).

## Medium-term

### R3 — Renderer sizing, logical resolution, and viewport

**Status:** Done · **Priority:** P2
- **Objective:** make canvas dimensions predictable — the game's coordinate space, the drawing buffer, and the on-page display size must be three documented, independently sensible things instead of PixiJS defaults winning silently.
- **Root cause (verified):** `PixiRenderer.initialize()` never passed `width`/`height`, so PixiJS v8 applied its 800×600 default and overwrote the canvas's HTML attributes; the demo's 640×360 logical space only covered the top-left of the actual stage, and `DomInput` mapped pointers into backing pixels (`canvas.width`), which diverges from logical space whenever resolution ≠ 1.
- **Resolution (implemented and tested):** the core contract gains optional logical `width`/`height` on `RendererInitOptions`/`GameOptions` (both or neither, finite and > 0; `GameError`/`RendererError` otherwise; omitted keeps the renderer default) and an optional `Renderer.resize(width, height)` with the same rules that never touches textures. `PixiRenderer` forwards both to PixiJS (`Application.init` dimensions, `renderer.resize` for runtime changes) and keeps `autoDensity`, so CSS display size tracks the logical size by default; the display size itself stays application-owned CSS. `DomInput` gains an optional `logicalSize` mapping pointer coordinates into the game space under any CSS scaling or offset. Chosen policy: **fixed logical resolution with proportional display scaling** (plain CSS in the demo) — no ResizeObserver, no resize loops; container-driven resizing is available through `resize()`, and letterboxing/observer-driven policies remain future work.
- **Evidence:** 28 new deterministic tests — `PixiRenderer` sizing/resize suite (init pass-through with and without dimensions, mixed/zero/negative/non-finite rejection before the application is touched, resize forwarding, pre-init/post-dispose/invalid resize rejection, texture safety across resize and disposal), `Game` sizing validation and pass-through, `DomInput` logical-space mapping (backing-vs-logical divergence, CSS scaling, button positions, legacy default, zero-sized canvas). Full suite: 237 tests across 15 files. Browser-verified: the canvas backing store is 640×360×dpr, CSS display is 640×360 at desktop width and scales down proportionally with no page scrollbars at narrow widths, pointer coordinates read in logical space, zero console errors.
- **Acceptance criteria:**
  1. [x] Explicit logical dimensions honored by the renderer (init + runtime resize).
  2. [x] Logical vs drawing-buffer vs CSS relationship documented.
  3. [x] Resize behavior predictable and tested; pointer coordinates correct under scaling.
  4. [x] Demo renders at its intended dimensions without overflow; core stays renderer-agnostic; R1 texture ownership intact.

### R4 — Audio

**Status:** Done · **Priority:** P2
- **Objective:** a small, ownership-explicit audio API following the asset-manager pattern (browser adapter, core contract).
- **Dependencies:** R1 pattern decision.
- **Resolution (implemented and tested):** `@g2w/core` gains `AudioManager` plus `AudioBackend`/`Sound`/`SoundPlayback`/`SoundPlayOptions` and `AudioError` (`packages/core/src/audio.ts`, `packages/core/src/audio-error.ts`). The manager composes a non-owning core `AssetManager<Sound>`, so caching, concurrent-request deduplication, and retryable failures are inherited rather than reimplemented; `play(key, options?)` starts a tracked playback (`volume` validated as finite ≥ 0, `loop`), `stopAll()` stops every active playback, and `dispose()` is terminal and idempotent — it stops playbacks, clears the cache, and calls `backend.dispose()` once. Ownership: the manager owns _playback lifetimes_, never sounds — `Sound` values are never destroyed, so decoded audio can be shared between managers or subsystems. New package `@g2w/audio-web` (depends only on `@g2w/core`): `WebAudioBackend` downloads and decodes through an injectable `fetch` and `AudioContext`, starts `AudioBufferSourceNode` → `GainNode` playbacks, and `dispose()` closes the context at most once. Autoplay policy is explicit: `play()` on a suspended context throws `WebAudioError` (documented, not silent), and `resume()` must be called from a user-gesture handler. No second loop, no hidden timers. The demo plays a short generated beep on the menu→gameplay click (the resume happens inside the click handler), and teardown disposes audio between scenes and the game.
- **Evidence:** 28 new deterministic tests — 14 core (`AudioManager` load/cache/dedup, retry after failure, option forwarding and validation, `stopAll` exactly-once, finished-playback pruning, terminal idempotent disposal, non-owning sound policy, backend-refusal propagation, backend disposal errors) and 14 adapter (decode via fake context/fetch, non-OK fetch rejection with retry, source/gain wiring, volume/loop application, suspended-context `play()` rejection, `resume()` behavior, natural-completion flag, idempotent `stop()`/`dispose()`, core `AudioBackend` contract composition, core-only dependency boundary). `scripts/verify-exports.mjs` asserts the new exports and exercises the audio pipeline through the real entry points. Full suite: 282 tests across 18 files. Docs updated: `README.md`, `docs/architecture.md`, `ARCHITECTURE.md`, `examples/hello-world/README.md`, this file.
- **Acceptance criteria:**
  1. [x] Core contract with zero browser APIs (`AudioManager`/`AudioBackend`/`Sound`; core architecture tests still enforce no browser globals).
  2. [x] Adapter package with tested attach/dispose (`@g2w/audio-web`: injectable context, `resume()`, at-most-once idempotent `dispose()`).
  3. [x] Docs state autoplay-policy implications (suspended context, user-gesture resume, non-silent failure).

### R5 — Gamepad and touch input

**Status:** Done · **Priority:** P2
- **Objective:** extend the input contract (gamepad, touch gestures) without weakening the DOM-free core.
- **Resolution (implemented and tested):** two additions following the established state-machine-in-core / browser-API-in-adapter split. Core: `InputState` gains a multi-touch contract (`handleTouchStart/Move/End/Cancel` keyed by stable contact id, queries `touchCount`/`activeTouchIds`/`isTouchActive`/`getTouchPosition`, per-frame edges `wasTouchStarted`/`wasTouchEnded`/`wasTouchCancelled` with cancellation distinct from a normal end; focus loss cancels every active contact; non-finite coordinates are ignored), and a new DOM-free `GamepadState` keyed by controller index (buttons with per-frame edges, raw analog axes — no imposed dead zone, sampled-implied connection, disconnect releases held buttons with edges and clears stale state, reconnection starts clean). Adapters: `@g2w/input-dom` feeds touch contacts through the existing Pointer Events stream (`pointerType === "touch"`, keyed by `pointerId`) and handles `pointercancel` so a browser-claimed gesture releases stuck state; the new `@g2w/input-gamepad` package (depends only on `@g2w/core`) samples controllers through an injectable polling source with injectable connection `EventTarget`s — the host calls `poll()` explicitly once per frame, indices absent from a poll result are treated as disconnected, source errors propagate (state untouched, next poll retries), `attach()`/`dispose()` are idempotent with terminal disposal, and constructing the adapter requires no browser or hardware. No second loop, no hidden timers; keyboard and mouse behavior is unchanged and the single-pointer view ignores touch feeding.
- **Evidence:** 41 new deterministic tests — 8 core touch (`InputState` start/move/end, multiple simultaneous contacts, restart without duplicate edges, cancel vs end edges, unknown ids and non-finite coordinates, `endFrame` keeping held contacts, focus-loss cancellation, single-pointer isolation), 15 core gamepad (`GamepadState` initial/neutral state, sample-implied connection, press/hold/release and repeated samples, press-release inside one frame observable, `endFrame` boundaries, shrinking button arrays releasing unreported buttons, raw axes without dead zone, non-finite axis defense, disconnect edges and clean reconnection, unknown-index no-op, multi-controller independence), 10 adapter (`GamepadInput` idempotent attach/dispose with listener bookkeeping, hardware-free construction, sample feeding with vacant slots, vacancy-as-disconnect clearing stale state, per-frame edges across repeated polls, source-error propagation and recovery, connection events without sampling, malformed-event tolerance, no observation after disposal), 6 `input-dom` touch (pointer-event contact feeding, multiple contacts, `pointercancel` cancel vs button release, mouse isolation from the touch contract, logical-size touch mapping), plus 2 package-boundary tests. `scripts/verify-exports.mjs` asserts the new exports and exercises the gamepad pipeline through the real entry points. Full suite: 323 tests across 21 files. Typecheck verified in a CI-like fresh checkout (no `dist/` artifacts) with the new `tsconfig.check.json` path mapping. Docs updated: `README.md`, `docs/architecture.md`, `ARCHITECTURE.md`, `AGENTS.md`, `examples/hello-world/README.md`, this file.
- **Acceptance criteria:**
  1. [x] `InputState` extensions behind feature-scoped adapters (touch contacts in core `InputState`, gamepad state in core `GamepadState`, browser access only in `@g2w/input-dom`/`@g2w/input-gamepad`; core architecture tests still enforce no browser globals).
  2. [x] Deterministic tests via injected sources (fake polling sources, fake event targets, fake DOM events — no real gamepads, touchscreens, timers, or browsers).
  3. [x] No DOM types in core (`GamepadState` consumes plain `{ pressed, axes }` snapshots; the core browser-globals architecture test still passes).

### R6 — Dependency and supply-chain maintenance (ongoing)

**Status:** In Progress · **Priority:** P1
- **Objective:** keep the dependency surface minimal and audited.
- **Scope:** weekly Dependabot updates for GitHub Actions and the pnpm workspace; `pnpm audit` gates in release review; install-lifecycle-script review for every new dependency.
- **Acceptance criteria:** CI green on Dependabot PRs before merge; no new dependencies without a documented reason.

### R6-1 — Renderer backend selection and capability reporting

**Status:** Done · **Priority:** P1
- **Objective:** make the rendering backend selectable and observable without coupling core to any engine (from the R6 audit, `docs/renderer-audit-r6.md`).
- **Resolution (implemented and tested):** `@g2w/core` gains `RendererBackend` (`"webgl" | "webgpu" | "canvas"`) as an optional `backend` **preference** on `RendererInitOptions` (forwarded by `Game` and `G2WGame` like the other pass-through options) and an optional `backend` string on `RendererCapabilities` reporting the backend **actually** initialized. `PixiRenderer` forwards the preference to PixiJS's `preference` option (preferred backend first, PixiJS's own fallback order after it, so an unavailable backend degrades instead of failing) and reads the actual backend from PixiJS's public `renderer.name` after a successful `init()` — set by the concrete renderer class, so it never reports a requested-but-fallen-back preference. The report is cleared on rollback (`#resetAfterFailedInit`), on disposal (both the synchronous and the deferred path), and inside `#destroyApplication`; a detection failure after a successful init is treated as an initialization failure with the normal E3-B rollback (application destroyed, renderer retryable). Omitting `backend` keeps PixiJS auto-detection unchanged for existing callers.
- **Evidence:** 8 new deterministic tests in `packages/renderer-pixi/test/pixi-renderer.test.ts` (no preference passed when omitted, forwarding of all three preference values, actual-vs-requested reporting with a fallback, no report before init/after disposal, report cleared on failed-init rollback with successful retry, detection-failure rollback and retry, re-report after reinitialization). `scripts/verify-exports.mjs` asserts the backend contract through the built entry points. Core stays dependency-free; the PixiJS `renderer.name` API is public and documented.
- **Verification status:** superseded by R6-2 — auto, `webgl`, `canvas`, and `webgpu` are all browser-verified at the init/render/cleanup level (see R6-2 below).
- **Acceptance criteria:**
  1. [x] Additive backend preference and actual-backend reporting; existing callers unchanged (default = auto-detection).
  2. [x] The reported backend always reflects what runs (fallback test pins preference ≠ report).
  3. [x] Lifecycle, rollback, and disposal semantics preserved; no resource leaks on selection/detection failure.
  4. [x] Docs distinguish implemented / verified-by-g2w / available-upstream-unverified / not implemented.

### R6-2 — Shared renderer conformance suite and real-browser backend verification

**Status:** Done · **Priority:** P1
- **Objective:** (from the R6 audit's verification matrix) make the renderer contract's invariants executable and reusable by future adapters, and close the backend verification gap left by R6-1 with real-browser evidence.
- **Part A — conformance suite (implemented and tested):** `packages/core/test/renderer-conformance.ts` defines the shared suite against the `Renderer` interface only — no adapter, PixiJS, browser API, or Effect import, so `@g2w/core`'s dependency-free boundary is untouched and the suite never enters any package build (`tsc` builds `src/` only). It covers: initial state and identity capabilities, uninitialized disposal rejection, dimension-validation rejection before any backing attempt, successful initialization with truthful capabilities, optional `render()`/`resize()` support (including contract-defined `RendererError` on invalid resize dimensions) without turning optional capabilities into requirements, repeated-initialization rejection, concurrent-initialization coalescing (one backing attempt), uninitialized contract while initialization is pending, deferred disposal waiting for a pending init (including failure and concurrent-dispose sharing), failed-initialization recovery with an exactly-once release invariant for the retried session, and backend-report clearing after disposal. Adapters adopt it via `defineRendererConformanceSuite(factory)` with a deterministic gated fake; `PixiRenderer` is the reference adoption (`packages/renderer-pixi/test/renderer-conformance.test.ts`), while PixiJS-specific tests (R1 texture ownership, R3 sizing pass-through, R6-1 preference forwarding) stay in `pixi-renderer.test.ts`.
- **Part B — real-browser backend smoke (implemented and run):** `scripts/smoke-renderer-backends.mjs` boots the hello-world demo under the Vite dev server and drives one fresh headless-Chrome CDP page per case (`auto`, `webgl`, `canvas`, `webgpu`). Each case initializes its own `PixiRenderer` on its own canvas, records requested vs. actual backend from `capabilities.backend`, renders a frame, reads back the background pixel where the backend allows it (`readPixels` for WebGL, `getImageData` for Canvas 2D, 2D `drawImage` readback for WebGPU), disposes, and confirms repeated disposal still rejects. Fallback is recorded as fallback (never proof of the requested backend); an unavailable backend would be reported as skipped with the reason.
- **Browser environment:** HeadlessChrome 156.0.0.0 (`HeadlessChrome/156.0.0.0`, `--headless=new --enable-unsafe-webgpu`), Windows; command `node scripts/smoke-renderer-backends.mjs`.
- **Smoke results (all four cases verified):**

  | Case   | Requested | Initialized | Actual backend | Frame rendered | Pixel (center)    | Cleanup | Status   |
  | ------ | --------- | ----------- | -------------- | -------------- | ----------------- | ------- | -------- |
  | auto   | auto      | yes         | `webgl`        | yes            | 16, 153, 187, 255 | clean   | verified |
  | webgl  | webgl     | yes         | `webgl`        | yes            | 16, 153, 187, 255 | clean   | verified |
  | canvas | canvas    | yes         | `canvas`       | yes            | 16, 153, 187, 255 | clean   | verified |
  | webgpu | webgpu    | yes         | `webgpu`       | yes            | 16, 153, 187, 255 | clean   | verified |

  Pixel values match the `#1099bb` probe background (tolerance ±3). No console or page errors in any case.
- **Verification scope (deliberate):** the smoke verifies initialization, actual-backend reporting, one rendered background frame, and clean disposal per backend. **R6-3 extends this to the feature level:** `node scripts/smoke-renderer-features.mjs` verifies resize/logical resolution, texture assets with the non-destructive cleanup policy, sprite rendering, RGBA transparency, alpha blending, visibility, anchor+rotation, and sprite-view disposal on WebGL, Canvas, and WebGPU (12/12 features per backend, Chrome/156.0.8078.48, Windows). What remains outside browser verification: PixiJS `Graphics`/masks/filters have no g2w public API (they are demo-boundary objects, out of the renderer-agnostic contract by design), and mobile browsers remain out of scope.
- **Evidence:** 23 new conformance tests (full suite: 417 tests across 25 files); smoke summary 4/4 verified, zero console/page errors; all gates pass (`pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm verify:exports`, `pnpm test`, `pnpm build:example`).
- **Acceptance criteria:**
  1. [x] The conformance helper is reusable by future renderer adapters without importing PixiJS-specific details.
  2. [x] `PixiRenderer` runs through the shared conformance tests; existing PixiJS-specific regression tests remain intact.
  3. [x] No runtime dependency entered `@g2w/core`; optional capabilities stayed optional.
  4. [x] Each backend's requested vs. actual reporting verified in a real browser with a reproducible command and recorded environment.

### R7 — Starter template and CLI

**Status:** Done · **Priority:** P3
- **Objective:** `create-g2w` scaffolding for new projects.
- **Dependencies:** R2 and R11 (a usable minimum game framework).
- **Resolution (implemented and tested):** new `packages/create-g2w` — a zero-dependency Node CLI (Node >= 22, no prompts) that copies a bundled TypeScript + Vite template into the destination with `{{PROJECT_NAME}}` substitution. Its only subprocess is a local `git init` in the freshly generated directory (R7 follow-up): explicit argv array, never a shell string; skipped with a warning when Git is missing or the destination already has Git metadata (`.git` directory or worktree file); never a remote, an initial commit, or a push; a Git failure never fails the scaffold. The generated game boots through the public API the way the demo does: `G2WGame` owns the lifecycle, one play scene on a `SceneManager`, player movement as pure renderer-agnostic logic (`src/scenes/play-scene.ts`) driven by the core `InputState` through `@g2w/input-dom`, a PixiJS `Graphics` display object at the adapter boundary, logical 640×360 resolution, a `pagehide` disposal path (adapters first, then the game — idempotent), and deterministic unit tests (Vitest). The CLI accepts one target directory, optional `--name`, refuses non-empty destinations without `--force` (naming the collision, never deleting foreign files), fails with actionable nonzero-exit errors, and prints next steps. Template dependency versions are pinned (`pixi.js` 8.22.0, Vite 8, TypeScript 5.9, Vitest 4; `@g2w/*` at 0.1.0).
- **Distribution reality (honest boundary):** the `@g2w/*` packages are not published to npm (R10 is exploratory), so `pnpm create g2w` cannot resolve them yet. Validation is therefore **local-package validation**: `node scripts/smoke-create-g2w.mjs` packs `@g2w/core`, `@g2w/runtime`, `@g2w/renderer-pixi`, and `@g2w/input-dom` with `pnpm pack` (workspace protocols rewritten to real versions), generates a project into a temp directory **outside the workspace**, rewrites its `@g2w/*` deps to `file:` tarball URLs, then runs `pnpm install`, `typecheck`, `test`, `build`, and a real-browser dev-server smoke via CDP (canvas present, `__G2W_STARTED` set by the running loop, zero console/page errors; Chrome auto-detected or `CHROME_PATH`, skipped with a clear message when absent). Published-package validation is explicitly future work blocked on R10. The scaffold smoke is deliberately **not** in CI: fresh installs and browser runs are too slow and network-dependent for the fast validate job.
- **Evidence:** 26 deterministic CLI tests in `packages/create-g2w/test/cli.test.ts` (usage/help/exit codes, argument errors, name sanitization and `--name` suggestion, full template-copy inventory against the template directory on disk, pinned-version guard, placeholder-hygiene scan, non-empty-destination refusal with collision named, `--force` writing without deleting foreign files, file-as-destination rejection, empty-destination success, shell-free Git-only source check, `.gitignore` coverage, and the Git-init follow-up: explicit `git init` argv/cwd, Git-result verified before the success report, skip on existing `.git` directory or worktree file (metadata untouched, via `--force`), ENOENT and nonzero-exit warnings that never fail the scaffold, space-containing paths, and a real-Git integration test — skipped when Git is absent — asserting `git status` works with no HEAD commit and no remote). The template itself ships its own unit tests (`test/play-scene.test.ts`: movement, diagonal keys, clamping, large-frame bounds) that run inside the generated project. Local-package validation passes all steps including the browser smoke (headless Chrome 156, Windows). Repository gates: `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm verify:exports`, `pnpm test` (423 + 26 = 449 tests), `pnpm build:example`, `git diff --check`.
- **Acceptance criteria:**
  1. [x] Generated project builds, tests, and runs the demo with zero manual fixes (verified against packed tarballs; see limitation above for npm).
  2. [x] CLI is deterministic, non-destructive, and unit-tested.
  3. [x] Docs state the distribution strategy, supported Node/pnpm versions, and known limitations.

## Exploratory

### R8 — Three.js adapter for 3D

**Status:** Exploratory · **Priority:** P3
- **Objective:** a third renderer adapter proving the renderer contract generalizes beyond 2D.
- **Dependencies:** only after R1–R3 land and the core contracts are stable; the contract may need an extension point for 3D transforms.
- **Acceptance criteria (gate for starting):** core contracts frozen for one release cycle with no breaking change needed for 2D.

### R9 — Integrations (React, Vue)

**Status:** Exploratory · **Priority:** P3
- **Objective:** thin bindings embedding g2w in common stacks.
- **Acceptance criteria:** each integration is a separate package, depends only on public entry points, and never leaks framework internals.

### R10 — npm publishing and releases

**Status:** Exploratory · **Priority:** P3
- **Objective:** publish `@g2w/*` packages with a documented versioning policy.
- **Phase 1 (packability and consumer validation — implemented and passing, nothing published):** `node scripts/validate-packages.mjs` (`pnpm test:pack`) builds all packages, packs the eight intended publishable packages (`@g2w/core`, `@g2w/runtime`, `@g2w/renderer-pixi`, `@g2w/input-dom`, `@g2w/input-gamepad`, `@g2w/audio-web`, `@g2w/devtools`, `create-g2w`; the private `@g2w/example-hello-world` is the only documented exclusion) into a temp directory outside the workspace, audits each tarball (manifest version, no unresolved `workspace:*`, `main`/`types`/`exports`/`bin`/`files` point at archived files, no undeclared or dev-only files, no env/secret artifacts, `@g2w/*` dependency versions consistent across the packed set), then proves real external consumption: a throwaway TypeScript + Vite consumer outside the monorepo installs all eight tarballs (relative `file:` deps + `pnpm-workspace.yaml` overrides standing in for the not-yet-existing registry), typechecks, and builds against every public entry point, and the packed `create-g2w` CLI scaffolds a project from that consumer's `node_modules`. Phase 1 also fixed two packaging defects the harness caught: the CLI's entry-point guard was symlink-blind (a packed install ran as a silent no-op; entry detection now compares realpaths, unit-tested through a junction) and `pnpm pack` excludes `.gitignore` from archives (the template ships `gitignore` dotless and the CLI renames it, so published scaffolds keep their `.gitignore`). Deliberately not in CI (fresh installs are slow and network-dependent); browser runtime behavior stays covered by `scripts/smoke-create-g2w.mjs`.
- **Acceptance criteria:** provenance-enabled publishing, license/attribution review (including the demo logo asset), and a release checklist.
- **Phase 2 (release infrastructure and rehearsal — implemented and rehearsed, nothing published):** the release policy is a **fixed-version monorepo** (all eight packages share one version; internal deps stay `workspace:*` and become exact pins at pack time; template pins and the version-guard test move with every bump) — policy, per-release checklist, partial-failure recovery, and the OIDC/provenance/publishing distinction are documented in `docs/release.md`. `pnpm release:rehearsal` (`scripts/release-rehearsal.mjs`) runs `test:pack`, audits version consistency and release metadata, runs `npm pack --dry-run` for every package, and prints the deterministic dependency-order release plan — no token, no registry writes; npm name availability and Trusted Publisher setup are reported as external prerequisites. All eight manifests gained a `repository` field (the only metadata gap found). Publishing exists only in the manual `.github/workflows/release.yml` (`workflow_dispatch`-only, never on push/PR): a `validate` job runs every gate plus `test:pack` and the rehearsal, and a `publish` job runs only when `dry_run=false` AND `confirm` re-types the exact version AND the protected `npm-release` environment is approved — OIDC trusted publishing (no npm token), `--provenance`, SHA-pinned actions, least-privilege permissions, publish order core → adapters → create-g2w. **Nothing has been published; the npm-side Trusted Publisher configuration and the GitHub `npm-release` environment are documented, pending manual setup.**

## MVP 1F verification / release criteria

Checklist for the current milestone. Each box is checked only with evidence from the current codebase (tests, commands, or the headless browser smoke run).
- [x] Dependencies install with `pnpm install --frozen-lockfile` (exit 0, verified this milestone).
- [x] Type checking, formatting/linting, and tests pass (`pnpm typecheck`, `pnpm check`, `pnpm test` — 209/209).
- [x] The game runtime initializes, updates, renders, and shuts down (Game lifecycle tests + headless smoke).
- [x] Scene transitions and lifecycle behavior work correctly (29+ scene-manager tests: ordering, deferral, error recovery, disposal; demo menu ↔ gameplay verified in the smoke run).
- [x] Keyboard and pointer input behave as documented (input tests + demo smoke run).
- [x] Asset loading, caching, deduplication, retry, and ownership behavior are tested (asset-manager suite).
- [x] Resource cleanup follows an explicit, tested ownership policy (scene claim registry, sprite-view, asset-manager, and renderer-disposal texture-ownership tests).
- [x] The browser demo runs with documented steps (`pnpm dev`), verified by headless CDP smoke (11/11 checks).
- [x] Documentation matches the public API and actual behavior (this review).
- [ ] Dependabot security updates enabled in repository settings (API attempts left it `disabled`; manual step for the owner).

## Candidate work / not yet committed

The following areas have **no committed milestone or priority yet**. They are listed so their absence is explicit, not accidental. Any of them can be promoted to a roadmap item via the proposal process above once there is a concrete need:
- Physics and collision.
- Camera support.
- Tilemaps.
- A full animation system (tweening, keyframes, skeletal) — beyond mutating models in `update()`.
- Sprite batching helpers and texture atlases.
- Manifest-based bulk asset loading.
- Action mapping / input rebinding.
- Scene stacks and transition effects.
- Performance benchmarks (a reproducible benchmark harness should exist before any performance claim is made).

## Risks and open questions

- **PixiJS shared cache** — no supported way to prove exclusive texture ownership; the non-destructive policy (R1) trades memory (textures live until page unload unless explicitly unloaded) for safety.
- **Unpublished API** — public contracts may still change; nothing is semver-stable yet.
- **AI-agent skills content** — dependency-provided agent skills (see `pnpm-workspace.yaml` permissions) are reviewed on each PixiJS update.

## Proposing changes to this roadmap

Open an issue describing the proposed milestone with objective, scope, dependencies, and acceptance criteria. Roadmap changes are made by the maintainers after discussion; significant architecture changes should be discussed before implementation (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Recommended development sequence

A technically coherent order for the near-term work — a recommendation, not a change of status without evidence:
1. ~~**R1** — resolve resource ownership and renderer-disposal semantics while the codebase is small.~~ (Done.)
2. Strengthen the existing example and regression tests as each milestone lands.
3. **R2** — a minimal renderer-agnostic game-object/display model once it provides clear value.
4. **R11** — sprite ordering and transform-related features built on R2.
5. Establish a reproducible performance benchmark (see Candidate work) before making any performance claim.
6. **R8** — evaluate a Three.js adapter only after the core and renderer contracts have been stable for a release cycle.
