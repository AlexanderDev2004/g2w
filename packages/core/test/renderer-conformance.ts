import { type Renderer, RendererError, type RendererInitOptions } from "@g2w/core";
import { describe, expect, it } from "vitest";

/**
 * Shared renderer conformance suite (R6-2).
 *
 * This file is the contract owner's executable definition of the
 * renderer-agnostic `Renderer` contract from `@g2w/core`. It contains only
 * what the public contract states — lifecycle state, capability truthfulness,
 * error semantics, optional `render`/`resize` support, disposal, and recovery
 * after failed initialization — expressed through the `Renderer` interface
 * alone. It never imports a concrete adapter, PixiJS, browser APIs, or Effect.
 *
 * A renderer adapter adopts the suite by calling
 * {@linkcode defineRendererConformanceSuite} from its own `*.test.ts` file
 * with a {@linkcode RendererConformanceFactory} that wires the suite to a
 * deterministic fake of the adapter's backing technology (see
 * `packages/renderer-pixi/test/renderer-conformance.test.ts` for the
 * reference adoption). Adapter-specific behavior — texture ownership,
 * technology-specific option forwarding, destroy arguments, fallback order —
 * stays in the adapter's own test files.
 *
 * The suite deliberately avoids two traps:
 *
 * 1. It never turns optional capabilities into requirements. `render`,
 *    `resize`, and `RendererCapabilities.backend` are optional in the
 *    contract, so tests that touch them are guarded on their presence or on
 *    the factory's `reportsBackend` flag.
 * 2. It never asserts implementation details. Error identity on failure is
 *    the adapter's choice (the contract only requires rejection), so
 *    failure tests assert observable state and retryability, while each
 *    adapter's own tests pin the exact error values.
 */

/**
 * Deterministic control over the backing implementation's initialization
 * outcome. The factory wires this to its fake so the suite can park, settle,
 * and fail initializations without timers or real technology.
 *
 * Implementations must tolerate `resolveInit`/`rejectInit` being called
 * before the backing initialization parks: queue the signal and apply it to
 * the next (or current) attempt, so the suite stays valid for adapters whose
 * initialization does not park synchronously.
 */
export interface RendererInitController {
  /** Settle the current or next initialization attempt successfully. */
  resolveInit(): void;
  /** Settle the current or next initialization attempt with the given error. */
  rejectInit(error: Error): void;
  /** Number of initialization attempts the backing implementation started. */
  initAttempts(): number;
  /** Number of disposals the backing implementation performed. */
  disposeCount(): number;
}

/** Factory wiring the conformance suite to one adapter under test. */
export interface RendererConformanceFactory {
  /** Adapter name used in the suite's describe title. */
  readonly adapterName: string;
  /**
   * Whether the adapter reports `RendererCapabilities.backend`. Renderers
   * without a backend concept may leave it `undefined` at all times (see the
   * contract); set this to `false` to skip backend-truthfulness assertions.
   */
  readonly reportsBackend: boolean;
  /**
   * Create a fresh, uninitialized renderer plus the controller for its
   * backing fake. Called once per test; instances never share state.
   */
  create(): { renderer: Renderer; controller: RendererInitController };
  /**
   * Options that make a fresh renderer initialize successfully on the
   * fake backing implementation (a canvas the fake accepts, etc.).
   */
  successOptions(): RendererInitOptions;
}

/** Renderer errors the contract names explicitly. */
const dimensionViolations: Array<[name: string, options: Partial<RendererInitOptions>]> = [
  ["width without height", { width: 640 }],
  ["height without width", { height: 360 }],
  ["zero width", { width: 0, height: 360 }],
  ["negative width", { width: -1, height: 360 }],
  ["non-finite width", { width: Number.NaN, height: 360 }],
  ["infinite width", { width: Number.POSITIVE_INFINITY, height: 360 }],
  ["zero height", { width: 640, height: 0 }],
  ["negative height", { width: 640, height: -1 }],
  ["non-finite height", { width: 640, height: Number.NaN }],
  ["infinite height", { width: 640, height: Number.POSITIVE_INFINITY }],
];

/**
 * Define the shared renderer conformance suite for one adapter. Call from a
 * `packages/<adapter>/test/*.test.ts` file; the suite contributes one
 * describe block to that file's test run.
 */
export function defineRendererConformanceSuite(factory: RendererConformanceFactory): void {
  describe(`${factory.adapterName} — renderer contract conformance (R6-2)`, () => {
    it("starts uninitialized with identity capabilities and no backend report", () => {
      const { renderer } = factory.create();

      expect(renderer.initialized).toBe(false);
      expect(typeof renderer.capabilities.id).toBe("string");
      expect(renderer.capabilities.id.length).toBeGreaterThan(0);
      expect(typeof renderer.capabilities.displayName).toBe("string");
      expect(renderer.capabilities.displayName.length).toBeGreaterThan(0);
      expect(renderer.capabilities.backend).toBeUndefined();
    });

    it("rejects disposal while uninitialized with a RendererError", async () => {
      const { renderer } = factory.create();

      await expect(renderer.dispose()).rejects.toThrow(RendererError);
      expect(renderer.initialized).toBe(false);
    });

    it.each(dimensionViolations)(
      "rejects %s with a RendererError and stays uninitialized",
      async (_name, invalid) => {
        const { renderer, controller } = factory.create();

        await expect(
          renderer.initialize({ ...factory.successOptions(), ...invalid }),
        ).rejects.toThrow(RendererError);
        expect(renderer.initialized).toBe(false);
        expect(controller.initAttempts()).toBe(0);
      },
    );

    it("initializes successfully and reports truthful capabilities", async () => {
      const { renderer, controller } = factory.create();

      const pending = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await pending;

      expect(renderer.initialized).toBe(true);
      if (factory.reportsBackend) {
        expect(typeof renderer.capabilities.backend).toBe("string");
        expect(renderer.capabilities.backend?.length ?? 0).toBeGreaterThan(0);
      }
    });

    it("supports optional render() and resize() when the contract exposes them", async () => {
      const { renderer, controller } = factory.create();
      const pending = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await pending;

      // Bind the optional hooks to the instance so narrowing survives the
      // assertion closures below (TS drops method narrowing inside arrows)
      // and so prototype methods keep their `this`.
      const render = renderer.render?.bind(renderer);
      const resize = renderer.resize?.bind(renderer);
      if (render !== undefined) {
        expect(() => render()).not.toThrow();
      }
      if (resize !== undefined) {
        expect(() => resize(800, 600)).not.toThrow();
        for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(() => resize(invalid, 600)).toThrow(RendererError);
          expect(() => resize(800, invalid)).toThrow(RendererError);
        }
      }
      await renderer.dispose();
    });

    it("rejects a second initialization while initialized with a RendererError", async () => {
      const { renderer, controller } = factory.create();
      const pending = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await pending;

      await expect(renderer.initialize(factory.successOptions())).rejects.toThrow(RendererError);
      // The renderer keeps working: the failed second call changed nothing.
      expect(renderer.initialized).toBe(true);
      await renderer.dispose();
    });

    it("coalesces concurrent initializations into one attempt", async () => {
      const { renderer, controller } = factory.create();

      const first = renderer.initialize(factory.successOptions());
      const second = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await Promise.all([first, second]);

      expect(renderer.initialized).toBe(true);
      expect(controller.initAttempts()).toBe(1);
      await renderer.dispose();
      expect(controller.disposeCount()).toBe(1);
    });

    it("keeps the uninitialized contract while initialization is pending", async () => {
      const { renderer, controller } = factory.create();

      const pending = renderer.initialize(factory.successOptions());
      expect(renderer.initialized).toBe(false);
      if (factory.reportsBackend) {
        expect(renderer.capabilities.backend).toBeUndefined();
      }

      controller.resolveInit();
      await pending;
      await renderer.dispose();
    });

    it("waits for a pending initialization before disposing, then releases once", async () => {
      const { renderer, controller } = factory.create();

      const pending = renderer.initialize(factory.successOptions());
      const disposal = renderer.dispose();
      controller.resolveInit();
      await pending;
      await disposal;

      expect(renderer.initialized).toBe(false);
      expect(controller.disposeCount()).toBe(1);
      await expect(renderer.dispose()).rejects.toThrow(RendererError);
    });

    it("settles a deferred disposal when the pending initialization fails", async () => {
      const { renderer, controller } = factory.create();

      const pending = renderer.initialize(factory.successOptions());
      const disposal = renderer.dispose();
      controller.rejectInit(new Error("conformance: injected initialization failure"));

      await expect(pending).rejects.toThrow();
      // The failed initialization's own rollback released the partial
      // resources, so the disposal completes instead of failing twice.
      await expect(disposal).resolves.toBeUndefined();
      expect(renderer.initialized).toBe(false);
    });

    it("shares one deferred disposal across concurrent dispose calls", async () => {
      const { renderer, controller } = factory.create();

      const pending = renderer.initialize(factory.successOptions());
      const first = renderer.dispose();
      const second = renderer.dispose();
      controller.resolveInit();
      await Promise.all([pending, first, second]);

      expect(controller.disposeCount()).toBe(1);
      expect(renderer.initialized).toBe(false);
    });

    it("recovers to a retryable state after a failed initialization", async () => {
      const { renderer, controller } = factory.create();

      const failing = renderer.initialize(factory.successOptions());
      controller.rejectInit(new Error("conformance: injected initialization failure"));
      // The contract requires rejection; the adapter decides the error shape.
      await expect(failing).rejects.toThrow();

      expect(renderer.initialized).toBe(false);
      if (factory.reportsBackend) {
        expect(renderer.capabilities.backend).toBeUndefined();
      }
      await expect(renderer.dispose()).rejects.toThrow(RendererError);

      // The failed attempt's own rollback released its partial resources;
      // the retried session must release exactly its own, no more.
      const destroysBeforeRetry = controller.disposeCount();
      const retry = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await retry;
      expect(renderer.initialized).toBe(true);
      await renderer.dispose();
      expect(controller.disposeCount()).toBe(destroysBeforeRetry + 1);
    });

    it("rejects repeated disposal after completion with a RendererError", async () => {
      const { renderer, controller } = factory.create();
      const pending = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await pending;

      await expect(renderer.dispose()).resolves.toBeUndefined();
      await expect(renderer.dispose()).rejects.toThrow(RendererError);
      expect(renderer.initialized).toBe(false);
    });

    it("clears the backend report after disposal", async () => {
      const { renderer, controller } = factory.create();
      const pending = renderer.initialize(factory.successOptions());
      controller.resolveInit();
      await pending;
      await renderer.dispose();

      expect(renderer.initialized).toBe(false);
      if (factory.reportsBackend) {
        expect(renderer.capabilities.backend).toBeUndefined();
      }
    });
  });
}
