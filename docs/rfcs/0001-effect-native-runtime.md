# RFC 0001: Effect-native runtime and resource lifecycle

- **Status:** Proposed for review (E0 audit complete; no runtime implementation changed)
- **Target baseline:** `main` at R5 commit `85c72f281234b107c83110ffaccd0629ea1b55a0`
- **Scope:** Architecture and staged migration plan for making Effect a required dependency of the official G2W framework packages.
- **Non-goal:** This RFC does not implement Effect integration, change existing runtime behavior, or claim browser-hardware validation.

## 1. Context and repository audit

The current public architecture is small, modular, and synchronous at its frame boundary:

- `@g2w/core` owns `Game`, `Scene`, `SceneManager`, `InputState`, `GamepadState`, `AssetManager`, transforms/game objects, and audio contracts.
- `Game` owns one injectable frame scheduler and invokes the update callback before rendering. `SceneManager` is driven by that callback and does not own another loop.
- `AssetManager` deduplicates concurrent loads, retries failed loads, and has terminal/idempotent disposal with best-effort cleanup semantics.
- `@g2w/renderer-pixi`, `@g2w/input-dom`, `@g2w/input-gamepad`, and `@g2w/audio-web` implement technology-specific boundaries. Browser APIs are kept out of core state machines.
- `InputState` and `GamepadState` use explicit per-frame edge boundaries. Gamepad sampling is host-driven; it must not create a second loop.
- The example consumes package exports. The workspace uses pnpm, TypeScript project references, Biome, Vitest, and export verification.

Current repository facts that affect this migration:

1. `@g2w/core` currently has no runtime dependencies. Making Effect required in core intentionally changes this invariant; documentation and architecture tests must be updated deliberately rather than silently weakening the boundary.
2. Lifecycle and resource semantics are already specified and tested in handwritten classes. Migration must preserve those semantics or explicitly document a reviewed breaking change.
3. Current lifecycle APIs include synchronous hooks (`Scene.update`, game-object updates, input queries) and promise-based operations (game initialization, asset loading, disposal). These should not all be forced into one execution style.
4. The current docs mention Effect only as a possible future integration, so no Effect API should be described as already implemented.
5. R5 reports 323 passing tests and a green CI run, but real gamepad hardware and touchscreen behavior have not yet been verified. Effect migration must not imply that hardware gap is closed.

## 2. Decision

**Effect is a required runtime dependency for G2W's official framework runtime, not an optional integration.** The migration will be incremental and Effect-native for lifecycle, service composition, typed failure, and scoped resource management.

The framework remains:
- TypeScript-first and browser-game focused;
- renderer-agnostic at its core contracts;
- modular at renderer/input/audio integration boundaries;
- explicit about ownership, deterministic frame semantics, and cleanup;
- usable without requiring game authors to write `Effect.gen` for every ordinary operation.

### 2.1 Core boundary clarification

The old invariant “core has zero runtime dependencies” is no longer compatible with the mandatory-Effect decision if Effect is imported by core. Replace it with the more precise invariants:

- Core remains free of browser DOM, PixiJS, Web Audio, and framework/UI imports.
- Effect is the one deliberate runtime foundation dependency allowed in core.
- Core must not import concrete browser or renderer adapters.
- Runtime bundle impact must be measured and documented.
- If a truly dependency-free primitive package is still useful, consider extracting it only after the migration, based on measured use cases; do not create speculative package fragmentation during E1.

This is an intentional architecture change, not a claim that Effect has no cost.

## 3. Design principles

### 3.1 Use Effect where it earns its cost

Prefer Effect for:
- runtime/service construction and dependency injection with `Context` and `Layer`;
- async initialization, loading, and disposal workflows;
- typed recoverable failures and explicit error mapping;
- scoped ownership and finalizers for listeners, schedulers, audio contexts, renderer resources, and asset pipelines;
- composition of startup/shutdown and adapter dependencies;
- deterministic tests of failures, interruption, and cleanup.

Keep ordinary hot-path operations plain and synchronous unless profiling or correctness demonstrates a concrete benefit:
- input state queries and edge reads;
- transform math and simple game-object state changes;
- gamepad snapshot normalization;
- the per-frame update/render dispatch itself.

Do not run an Effect runtime per input event or per component operation by default. Do not add promises or scheduling boundaries to each frame just to make the API look uniform.

### 3.2 Separate frame loop from resource lifecycle

There remains exactly one frame scheduler owned by `Game`. Effect may coordinate starting, stopping, and releasing that scheduler, but it must not introduce a competing ticker, hidden polling loop, or timer. Gamepad sampling stays explicitly host-driven once per frame.

Frame callback policy must be documented and tested: how a synchronous update exception is reported, whether the loop stops, how the error reaches the host, and how disposal behaves during an in-flight frame.

### 3.3 Scope is an ownership boundary, not magic cleanup

Every acquired resource must have a clear owner and an idempotent finalizer. Scope closure should attempt all registered finalizers even if one fails, and cleanup failures must remain observable. External side effects already performed (for example, audio that has begun playing) cannot be rolled back merely because an Effect fails.

For resources whose API must remain manually disposable, the Effect integration may own them internally while preserving a public compatibility facade during migration.

### 3.4 Errors are typed at asynchronous boundaries

Define domain-specific errors for expected failures (renderer initialization, scene lifecycle, asset loading, input adapter setup, audio operations). Preserve causes and actionable messages. Do not catch and discard defects or convert every unknown programming error into a generic recoverable error. Keep synchronous developer mistakes obvious.

### 3.5 Public API migration must be deliberate

Avoid a flag-day rewrite. First define a canonical internal Effect API and decide which current APIs remain stable facades. Do not expose unstable internal services or require every game developer to understand Effect internals merely to create a game.

Before each public signature change, record:
- old and new usage;
- whether the change is source/binary breaking;
- migration notes;
- tests and docs to update.

## 4. Proposed target architecture

```text
Application / Example
  └─ G2W bootstrap (Effect runtime + Layers)
      ├─ Game lifecycle service
      ├─ Scene lifecycle service
      ├─ Asset service
      ├─ Renderer service ────────── @g2w/renderer-pixi
      ├─ DOM input service ───────── @g2w/input-dom
      ├─ Gamepad service ─────────── @g2w/input-gamepad
      └─ Audio service ───────────── @g2w/audio-web

Frame boundary: one scheduler → synchronous update/input consumption → renderer.render()
Resource boundary: scopes/finalizers own acquired resources and adapter teardown
Dependency direction: adapters depend on core contracts; core never imports adapters
```

This is a logical architecture, not a commitment to create a new `@g2w/runtime` package immediately. E0 should not add packages just to mirror diagram boxes. E1 must decide whether the runtime/bootstrap belongs in `@g2w/core` or a new `@g2w/runtime` package after checking public API ergonomics and dependency graph consequences.

## 5. Migration stages and acceptance criteria

### E0 — Architecture audit and RFC (this document)

- [x] Inspect current package map, key lifecycle/resource APIs, compiler configuration, and documented boundaries on R5 baseline.
- [x] Record the conflict between mandatory Effect and the existing zero-runtime-dependency core invariant.
- [x] Define frame-loop, resource ownership, error, and public API compatibility principles.
- [ ] Review this RFC and approve the package placement/API strategy before implementation.

### E1 — Effect foundation

Deliver:
- Pin a compatible Effect version through the workspace package manager and lockfile; avoid unbounded versions.
- Define shared conventions for `Effect`, `Context.Tag`, `Layer`, `Scope`, typed errors, runtime ownership, and interruption.
- Decide core vs. runtime package placement with a dependency graph and minimal runnable example.
- Provide a small tested bootstrap that composes services and guarantees shutdown.
- Update package exports, architecture docs, TypeScript project references, check paths, export verifier, and dependency-boundary tests.

Acceptance:
- No browser/renderer dependency leaks into core.
- Startup failure and shutdown/finalizer failure are tested.
- Scope cleanup is idempotent and best-effort, with failures observable.
- CI passes with generated `dist/` artifacts absent before typecheck.
- Bundle/dependency footprint has a baseline measurement.

### E2 — Game and scene lifecycle

Migrate `Game` initialization/disposal and `SceneManager` activation/transitions through Effect internally. Preserve the single scheduler and the existing deterministic transition policies. Define how the existing promise/synchronous public methods interoperate with Effect.

Acceptance:
- Concurrent init, stop-during-init, dispose-during-init, repeated dispose, failed scene enter, recovery after transition failure, and multiple cleanup failures have regression tests.
- No second frame loop and no per-frame Effect runtime allocation.
- API compatibility is documented and any breaking change is intentional.

### E3 — Renderer and input adapters

Integrate renderer, DOM input, and gamepad adapter lifecycle with scoped services/finalizers. Keep input state machines plain and synchronous. Preserve explicit gamepad polling and the existing touch cancellation policy.

Acceptance:
- Attach/attach twice/dispose/dispose twice and partial setup failure clean up all acquired listeners/resources.
- Input edge semantics remain frame-deterministic.
- Browser-only APIs remain in adapter packages.
- Tests use injected browser sources and event targets; physical hardware testing remains a separate manual validation item.

### E4 — Audio and asset pipeline

Migrate async asset loading, deduplication, retry, cancellation/interruption policy, and audio context lifecycle. Decide explicitly what happens if a load is interrupted after the underlying loader has started. Ensure a shared in-flight load is not accidentally cancelled for every waiter when only one waiter is interrupted.

Acceptance:
- Concurrent load deduplication and retry semantics are retained.
- Disposing during load has defined, tested behavior.
- All asset cleanup is attempted; cleanup failures are observable.
- Audio autoplay remains user-gesture controlled; Effect does not bypass browser policy.

### E5 — Public API, example, and agent workflow

Update the hello-world example and docs to demonstrate the recommended public API. Document Effect concepts only where developers need them. Provide examples for startup, scene transitions, adapter composition, asset loading, and orderly shutdown.

Acceptance:
- Example uses only public exports and builds from a clean checkout.
- README, architecture docs, API docs, and agent instructions agree.
- A new developer can run the example without having to understand internal layers first.

### E6 — Hardening and release decision

Run the full suite, clean-artifact typecheck, export verification, bundle comparison, and lifecycle/resource stress tests. Publish a migration guide and release notes. Decide whether this is a breaking minor/major pre-1.0 migration based on actual public API changes and current package versioning.

Acceptance:
- CI is green and all gates are recorded with actual outputs.
- Frame-loop overhead and bundle size are measured against the pre-migration baseline.
- No unsupported claim of hardware validation.
- No package is marked complete solely because its types compile.

## 6. Required test matrix

- Initialization succeeds, fails, is interrupted, and is requested concurrently.
- Disposal before initialization, during initialization, while running, and after failure.
- Scene init/enter/exit/dispose failures, deferred transition ordering, and recovery.
- Scope closure after partial adapter initialization; every finalizer attempted.
- Cleanup failure aggregation/observability.
- Asset concurrent deduplication, retry, shared waiters, interruption, and dispose races.
- Input DOM listener cleanup, touch cancel/focus loss, gamepad disconnect/reconnect, and frame edge reset.
- One scheduler only; deterministic injected scheduler; no timer/second-loop regression.
- Package boundary and public export checks.
- Browser demo boot smoke test plus separately documented manual touch/gamepad checks.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Mandatory Effect undermines the previous zero-dependency core property | Make the exception explicit; measure footprint; keep browser/rendering imports out |
| Too much Effect ceremony in simple game code | Provide stable ergonomic facades; keep hot-path state and math synchronous |
| Interruption accidentally cancels shared loads | Define ownership and waiter cancellation semantics before E4 |
| Scope hides cleanup failures | Test all-finalizer execution and observable failure reporting |
| Existing API breaks in a broad rewrite | Stage migrations and publish compatibility examples before changing signatures |
| Frame-loop latency/GC regressions | No per-frame runtime creation; benchmark before/after |
| Docs claim unsupported behavior | Update docs only after implementation and CI evidence exist |

## 8. Open questions to resolve before E1

1. Should Effect's public types be exposed directly in all public APIs, or should a smaller stable G2W facade wrap most Effect details?
2. Should the Effect runtime be constructed by the application, or should G2W provide a managed bootstrap with an escape hatch?
3. Does `@g2w/core` own the Effect runtime primitives, or should a new `@g2w/runtime` package own application composition while core exports contracts and synchronous models?
4. Which current public methods keep their sync/promise signatures for the 0.x line, and which are candidates for breaking changes?
5. What bundle-size and per-frame overhead budgets are acceptable? Establish baselines before selecting thresholds.
6. What cancellation semantics should apply to shared asset loads and audio operations?

## 9. Recommendation

Approve the direction, but resolve questions 1–4 in E1 before migrating `Game`, `SceneManager`, or adapters. The recommended default is: Effect-native internals for lifecycle and resource orchestration, a developer-friendly G2W public facade, and plain synchronous state/math on the frame hot path. Keep the work in small reviewable commits and do not migrate every package in one change.
