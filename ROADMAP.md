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

**Status:** Planned · **Priority:** P2
- **Objective:** a small, ownership-explicit audio API following the asset-manager pattern (browser adapter, core contract).
- **Dependencies:** R1 pattern decision.
- **Acceptance criteria:** core contract with zero browser APIs; adapter package with tested attach/dispose; docs state autoplay-policy implications.

### R5 — Gamepad and touch input

**Status:** Planned · **Priority:** P2
- **Objective:** extend the input contract (gamepad, touch gestures) without weakening the DOM-free core.
- **Acceptance criteria:** `InputState` extensions behind feature-scoped adapters; deterministic tests via injected sources; no DOM types in core.

### R6 — Dependency and supply-chain maintenance (ongoing)

**Status:** In Progress · **Priority:** P1
- **Objective:** keep the dependency surface minimal and audited.
- **Scope:** weekly Dependabot updates for GitHub Actions and the pnpm workspace; `pnpm audit` gates in release review; install-lifecycle-script review for every new dependency.
- **Acceptance criteria:** CI green on Dependabot PRs before merge; no new dependencies without a documented reason.

### R7 — Starter template and CLI

**Status:** Planned · **Priority:** P3
- **Objective:** `create-g2w` scaffolding for new projects.
- **Dependencies:** R2 and R11 (a usable minimum game framework).
- **Acceptance criteria:** generated project builds, tests, and runs the demo with zero manual fixes.

## Exploratory

### R8 — Three.js adapter for 3D

**Status:** Exploratory · **Priority:** P3
- **Objective:** a third renderer adapter proving the renderer contract generalizes beyond 2D.
- **Dependencies:** only after R1–R3 land and the core contracts are stable; the contract may need an extension point for 3D transforms.
- **Acceptance criteria (gate for starting):** core contracts frozen for one release cycle with no breaking change needed for 2D.

### R9 — Integrations (React, Vue, Effect)

**Status:** Exploratory · **Priority:** P3
- **Objective:** thin bindings embedding g2w in common stacks.
- **Acceptance criteria:** each integration is a separate package, depends only on public entry points, and never leaks framework internals.

### R10 — npm publishing and releases

**Status:** Exploratory · **Priority:** P3
- **Objective:** publish `@g2w/*` packages with a documented versioning policy.
- **Acceptance criteria:** provenance-enabled publishing, license/attribution review (including the demo logo asset), and a release checklist.

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
