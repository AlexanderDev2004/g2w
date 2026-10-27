import { Container } from "pixi.js";
import { defineRendererConformanceSuite } from "../../core/test/renderer-conformance.js";
import { type PixiApplicationLike, PixiRenderer } from "../src/index.js";

/**
 * R6-2 Part A: `PixiRenderer` adopted into the shared renderer conformance
 * suite. The suite (owned by `@g2w/core`, see
 * `packages/core/test/renderer-conformance.ts`) verifies the public
 * renderer-agnostic contract through the `Renderer` interface only; this
 * file only wires it to a deterministic gated fake of the PixiJS
 * `Application`, the same pattern as the E3-B lifecycle tests.
 *
 * PixiJS-specific behavior — texture ownership (R1), destroy-option flags,
 * `preference` option forwarding and `renderer.name` reporting (R6-1),
 * dimension option pass-through (R3) — is pinned separately in
 * `pixi-renderer.test.ts` and deliberately not duplicated here.
 */

/** Minimal canvas fake: the injected application never touches it. */
function fakeCanvas(): HTMLCanvasElement {
  return { width: 640, height: 360 } as HTMLCanvasElement;
}

interface GatedFakeApplication extends PixiApplicationLike {
  initCalls: number;
  destroyCalls: number;
}

/**
 * An application whose `init()` parks until released, or — if the release
 * arrived first — settles immediately from the queued signal. The queueing
 * keeps the conformance suite's contract (settle calls may precede the
 * park) satisfiable for any adapter, including one whose initialization
 * does not park synchronously.
 */
function gatedApplication(): {
  application: GatedFakeApplication;
  release: (error?: Error) => void;
} {
  let releaser: ((error?: Error) => void) | null = null;
  let queued: { error?: Error } | null = null;
  const application: GatedFakeApplication = {
    initCalls: 0,
    destroyCalls: 0,
    init: async () => {
      application.initCalls += 1;
      if (queued !== null) {
        const signal = queued;
        queued = null;
        if (signal.error !== undefined) {
          throw signal.error;
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        releaser = (error?: Error) => (error === undefined ? resolve() : reject(error));
      });
    },
    render: () => {},
    destroy: () => {
      application.destroyCalls += 1;
    },
    stage: new Container(),
    renderer: { name: "webgl", resize: () => {} },
  };
  return {
    application,
    release: (error?: Error) => {
      const current = releaser;
      releaser = null;
      if (current !== null) {
        current(error);
      } else {
        queued = { error };
      }
    },
  };
}

/**
 * The reference adoption of the shared conformance suite: a factory that
 * builds a fresh `PixiRenderer` over a fresh gated fake per test, with
 * controllers that expose only attempt/dispose counts — the suite sees the
 * adapter purely through the `Renderer` contract.
 */
const pixiConformanceFactory = {
  adapterName: "PixiRenderer",
  reportsBackend: true,
  create() {
    const { application, release } = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    return {
      renderer,
      controller: {
        resolveInit: () => release(),
        rejectInit: (error: Error) => release(error),
        initAttempts: () => application.initCalls,
        disposeCount: () => application.destroyCalls,
      },
    };
  },
  successOptions() {
    return { canvas: fakeCanvas() };
  },
};

defineRendererConformanceSuite(pixiConformanceFactory);
