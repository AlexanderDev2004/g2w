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

## Near-term (current focus)

### R1 — Reconcile renderer-disposal texture semantics

**Status:** Planned · **Priority:** P0
- **Objective:** make texture lifetime unambiguous across the whole stack.
- **Scope:** `PixiRenderer.dispose()` currently destroys stage-attached textures (`texture: true, textureSource: true`), while the asset policy says textures from PixiJS's shared `Assets` cache are never destroyed by framework disposal and live until page unload. Both statements are true of their own API, but the composition misleads and can destroy textures still referenced outside the stage.
- **Dependencies:** none.
- **Acceptance criteria:**
  1. Documented, tested decision: either the renderer stops destroying textures (`texture: false`) or the docs state that renderer disposal ends texture lifetime for everything on the stage.
  2. Demo teardown order verified against the decision.
  3. No test asserts both policies simultaneously.

### R2 — Game objects / display model

**Status:** Planned · **Priority:** P1
- **Objective:** a minimal renderer-agnostic game-object layer above sprites (positioning helpers, z-order, simple parenting) so games stop hand-managing arrays.
- **Scope:** deliberately minimal; no full ECS. Extends `Sprite2D`/`Transform2D`; keeps ownership rules explicit.
- **Dependencies:** R1 (texture semantics settled).
- **Acceptance criteria:**
  1. Public API documented and exported from `@g2w/core`.
  2. Tests cover lifecycle, ownership, and update order.
  3. Demo demonstrates it; no second loop introduced.

### R3 — Sprite anchors, pivots, and z-ordering

**Status:** Planned · **Priority:** P2
- **Objective:** remove the top-left-pivot limitation and give scenes deterministic layering.
- **Dependencies:** R2.
- **Acceptance criteria:** anchor/pivot in the core model, applied by `sync()`; z-order defined and tested; demo updated.

## Medium-term

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
- **Dependencies:** R2–R3 (a usable minimum game framework).
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

## Risks and open questions

- **Renderer-disposal texture lifetime** — see R1; the only known contradiction between two documented policies.
- **PixiJS shared cache** — no supported way to prove exclusive texture ownership; the non-destructive policy trades memory for safety until R1 resolves the renderer side.
- **Unpublished API** — public contracts may still change; nothing is semver-stable yet.
- **AI-agent skills content** — dependency-provided agent skills (see `pnpm-workspace.yaml` permissions) are reviewed on each PixiJS update.

## Proposing changes to this roadmap

Open an issue describing the proposed milestone with objective, scope, dependencies, and acceptance criteria. Roadmap changes are made by the maintainers after discussion; significant architecture changes should be discussed before implementation (see [CONTRIBUTING.md](CONTRIBUTING.md)).
