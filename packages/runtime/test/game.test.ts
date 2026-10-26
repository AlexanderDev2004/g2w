import type { FrameRequestCallback, FrameScheduler, Renderer } from "@g2w/core";
import { GameError, SceneManager } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { G2WGame, RuntimeShutdownError } from "../src/index.js";

/** Deterministic fake frame scheduler: records requests, drives on demand. */
class FakeScheduler implements FrameScheduler {
  readonly requests: FrameRequestCallback[] = [];
  cancelled = 0;

  requestFrame(callback: FrameRequestCallback): void {
    this.requests.push(callback);
  }

  cancelFrame(): void {
    this.cancelled++;
    this.requests.length = 0;
  }

  /** Drive one frame; returns whether a callback was outstanding. */
  tick(timestampMs: number): boolean {
    const callback = this.requests.shift();
    if (callback === undefined) {
      return false;
    }
    callback(timestampMs);
    return true;
  }

  get outstanding(): number {
    return this.requests.length;
  }
}

interface FakeRenderer extends Omit<Renderer, "initialized"> {
  initialized: boolean;
  initCount: number;
  disposeCount: number;
  renderCount: number;
  initError: Error | null;
  disposeError: Error | null;
}

function fakeRenderer(): FakeRenderer {
  const renderer: FakeRenderer = {
    capabilities: { id: "fake", displayName: "Fake" },
    initialized: false,
    initCount: 0,
    disposeCount: 0,
    renderCount: 0,
    initError: null,
    disposeError: null,
    initialize: async () => {
      renderer.initCount++;
      if (renderer.initError !== null) {
        throw renderer.initError;
      }
      renderer.initialized = true;
    },
    dispose: async () => {
      renderer.disposeCount++;
      if (renderer.disposeError !== null) {
        throw renderer.disposeError;
      }
      renderer.initialized = false;
    },
    render: () => {
      renderer.renderCount++;
    },
  };
  return renderer;
}

const canvas = { tag: "fake-canvas" } as unknown as HTMLCanvasElement;

/**
 * Patch the renderer with an initialization that blocks until released.
 * `release()` is safe to call before `initialize()` even starts: the game's
 * lifecycle hop through the managed runtime defers the renderer call to a
 * later microtask, so release-then-start and start-then-release both work.
 * Pass `releaseError` to make the released initialization reject.
 */
function gateInitialize(renderer: FakeRenderer, releaseError: Error | null = null): () => void {
  let released = false;
  let resolvePending: (() => void) | null = null;
  renderer.initialize = async () => {
    renderer.initCount++;
    if (!released) {
      await new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
    }
    if (releaseError !== null) {
      throw releaseError;
    }
    renderer.initialized = true;
  };
  return () => {
    released = true;
    resolvePending?.();
  };
}

const settle = async <T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
};

describe("G2WGame init lifecycle", () => {
  it("initializes the renderer through the managed runtime", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    expect(game.state).toBe("new");

    await game.init();

    expect(game.state).toBe("initialized");
    expect(renderer.initCount).toBe(1);
    expect(renderer.initialized).toBe(true);
  });

  it("shares one in-flight promise across concurrent init() calls", async () => {
    const renderer = fakeRenderer();
    // Defer the renderer's own initialization so both calls see "initializing".
    const releaseInit = gateInitialize(renderer);
    const game = new G2WGame({ renderer, canvas });

    const first = game.init();
    const second = game.init();
    expect(second).toBe(first);

    releaseInit();
    await Promise.all([first, second]);
    expect(renderer.initCount).toBe(1);
    expect(game.state).toBe("initialized");
  });

  it("returns to the new state on init failure, preserving the original error", async () => {
    const renderer = fakeRenderer();
    const boom = new Error("renderer init boom");
    renderer.initError = boom;
    const game = new G2WGame({ renderer, canvas });

    const settled = await settle(game.init());

    expect(settled.ok).toBe(false);
    expect(settled.ok === false ? settled.error : undefined).toBe(boom);
    expect(game.state).toBe("new");
    expect(renderer.initCount).toBe(1);

    // Retry after a failed init works, and nothing was disposed meanwhile.
    renderer.initError = null;
    await game.init();
    expect(game.state).toBe("initialized");
    expect(renderer.disposeCount).toBe(0);
  });

  it("cleans up partial resources when a caller finalizer precedes a failed init", async () => {
    const renderer = fakeRenderer();
    renderer.initError = new Error("init boom");
    const game = new G2WGame({ renderer, canvas });
    const released: string[] = [];
    game.addFinalizer(() => {
      released.push("user");
    });

    await settle(game.init());
    await game.dispose();

    // The failed init acquired nothing; the buffered caller finalizer still
    // runs on disposal and the renderer is never released.
    expect(released).toEqual(["user"]);
    expect(renderer.disposeCount).toBe(0);
    expect(renderer.initialized).toBe(false);
    expect(game.state).toBe("disposed");
  });
});

describe("G2WGame start/stop lifecycle", () => {
  it("rejects start before initialization and while initializing", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    expect(() => game.start()).toThrow(GameError);

    const pending = game.init();
    expect(() => game.start()).toThrow(GameError);
    await pending;
    expect(game.state).toBe("initialized");
  });

  it("runs the synchronous frame loop with one scheduler and no Effect in the hot path", async () => {
    const renderer = fakeRenderer();
    const scheduler = new FakeScheduler();
    const frames: number[] = [];
    const game = new G2WGame({
      renderer,
      canvas,
      scheduler,
      onUpdate: (dt) => {
        frames.push(dt);
      },
    });
    await game.init();
    game.start();
    expect(game.state).toBe("running");
    expect(scheduler.outstanding).toBe(1);

    // Drive three frames synchronously: each dispatches update + render
    // inline (observable in the same tick, so no microtask hop), re-arming
    // exactly one frame callback per frame.
    scheduler.tick(0);
    expect(frames).toEqual([0]);
    scheduler.tick(16);
    scheduler.tick(32);
    expect(frames).toEqual([0, 0.016, 0.016]);
    expect(renderer.renderCount).toBe(3);
    expect(scheduler.outstanding).toBe(1);

    // Delta clamping to maxDeltaTime.
    scheduler.tick(10_000);
    expect(frames.at(-1)).toBe(0.25);

    game.stop();
    expect(game.state).toBe("stopped");
    expect(scheduler.cancelled).toBe(1);
    expect(scheduler.outstanding).toBe(0);
  });

  it("stops the loop when the update callback throws", async () => {
    const renderer = fakeRenderer();
    const scheduler = new FakeScheduler();
    const boom = new Error("update boom");
    const game = new G2WGame({
      renderer,
      canvas,
      scheduler,
      onUpdate: () => {
        throw boom;
      },
    });
    await game.init();
    game.start();

    let thrown: unknown;
    try {
      scheduler.tick(0);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(game.state).toBe("stopped");
    expect(scheduler.outstanding).toBe(0);
  });
});

describe("G2WGame stop/dispose races", () => {
  it("marks the game stopped when stop() is requested during initialization", async () => {
    const renderer = fakeRenderer();
    const releaseInit = gateInitialize(renderer);
    const scheduler = new FakeScheduler();
    const game = new G2WGame({ renderer, canvas, scheduler });

    const pending = game.init();
    game.stop();
    releaseInit();
    await pending;

    expect(game.state).toBe("stopped");
    // Starting from "stopped" is legal and the loop runs on the injected
    // scheduler (deterministic; the rAF default is not available in Node).
    game.start();
    expect(game.state).toBe("running");
    expect(scheduler.outstanding).toBe(1);
    await game.dispose();
    expect(scheduler.outstanding).toBe(0);
  });

  it("waits for in-flight initialization when disposed during it", async () => {
    const renderer = fakeRenderer();
    const releaseInit = gateInitialize(renderer);
    const game = new G2WGame({ renderer, canvas });

    const pending = game.init();
    game.dispose();
    releaseInit();
    await pending;
    await game.dispose();

    expect(game.state).toBe("disposed");
    // The renderer was initialized (init won the race) and released once.
    expect(renderer.initCount).toBe(1);
    expect(renderer.disposeCount).toBe(1);
  });

  it("rejects init() retry once disposal has started, even after a failed init", async () => {
    const renderer = fakeRenderer();
    const boom = new Error("init boom during dispose");
    const releaseInit = gateInitialize(renderer, boom);
    const game = new G2WGame({ renderer, canvas });

    const pending = game.init();
    const disposing = game.dispose();
    releaseInit();
    // Retry from inside a rejection handler of the failed init: at that
    // moment the failure has reset the state to "new" while disposal is
    // still completing, so this is exactly the gap a retry could exploit.
    // Without the disposal guard the retry proceeds, completes after the
    // runtime shut down, initializes a renderer no finalizer would ever
    // release, and resurrects the disposed game's state.
    let retry: Promise<{ ok: boolean; error?: unknown }> | undefined;
    const settled = await settle(
      pending.catch((error) => {
        retry = settle(game.init());
        throw error;
      }),
    );
    expect(settled.ok).toBe(false);
    if (retry === undefined) {
      throw new Error("the rejection handler never attempted a retry");
    }

    const retrySettled = await retry;
    expect(retrySettled.ok).toBe(false);
    expect(retrySettled.ok === false ? retrySettled.error : undefined).toBeInstanceOf(GameError);

    await disposing;
    expect(game.state).toBe("disposed");
    // The retry never reached the renderer, and nothing owned was released.
    expect(renderer.initCount).toBe(1);
    expect(renderer.disposeCount).toBe(0);
  });

  it("is a safe no-op to dispose before initialization", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });

    await game.dispose();

    expect(game.state).toBe("disposed");
    expect(renderer.initCount).toBe(0);
    expect(renderer.disposeCount).toBe(0);
    await expect(game.init()).rejects.toThrow(GameError);
    expect(() => game.start()).toThrow(GameError);
  });

  it("shares one promise across repeated and concurrent disposal and cleans up once", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    await game.init();
    let finalizerCount = 0;
    game.addFinalizer(() => {
      finalizerCount++;
    });

    const first = game.dispose();
    expect(game.dispose()).toBe(first);
    await Promise.all([first, game.dispose(), game.dispose()]);

    expect(finalizerCount).toBe(1);
    expect(renderer.disposeCount).toBe(1);
    expect(game.state).toBe("disposed");
  });
});

describe("G2WGame finalizers", () => {
  it("runs multiple finalizers in LIFO order and keeps failures observable", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    await game.init();
    const calls: string[] = [];
    const boom = new Error("finalizer boom");
    game.addFinalizer(() => {
      calls.push("first");
    });
    game.addFinalizer(() => {
      throw boom;
    });
    game.addFinalizer(() => {
      calls.push("last");
    });

    const settled = await settle(game.dispose());

    // All finalizers attempted despite the failure; state still disposed.
    expect(calls).toEqual(["last", "first"]);
    expect(game.state).toBe("disposed");
    expect(settled.ok).toBe(false);
    const error = settled.ok === false ? settled.error : undefined;
    expect(error).toBeInstanceOf(RuntimeShutdownError);
    const shutdownError = error as RuntimeShutdownError;
    expect(shutdownError.failures).toHaveLength(1);
    expect(shutdownError.failures[0]?.cause).toBe(boom);
    // The renderer release still ran after the failing finalizer.
    expect(renderer.disposeCount).toBe(1);
  });

  it("keeps the original renderer disposal error observable", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    await game.init();
    const boom = new Error("renderer dispose boom");
    renderer.disposeError = boom;

    const settled = await settle(game.dispose());

    expect(game.state).toBe("disposed");
    expect(settled.ok).toBe(false);
    const error = settled.ok === false ? settled.error : undefined;
    expect(error).toBeInstanceOf(RuntimeShutdownError);
    const shutdownError = error as RuntimeShutdownError;
    expect(shutdownError.failures[0]?.cause).toBe(boom);
  });

  it("rejects finalizer registration after disposal", async () => {
    const renderer = fakeRenderer();
    const game = new G2WGame({ renderer, canvas });
    await game.dispose();
    expect(() => game.addFinalizer(() => {})).toThrow(GameError);
  });
});

interface FakeSceneManager {
  active: string | null;
  keys: readonly string[];
  start(): void;
  goTo(name: string): void;
  update(deltaTime: number): void;
  dispose(): void;
  disposeCalls: number;
}

function fakeSceneManager(active: string | null = "menu"): FakeSceneManager & SceneManager {
  const manager: FakeSceneManager = {
    active,
    keys: [],
    start: () => {},
    goTo: () => {},
    update: () => {},
    dispose: () => {
      manager.disposeCalls++;
    },
    disposeCalls: 0,
  };
  // `SceneManager` is a class with private state; the game only touches the
  // public contract above, so the fake is safe to cast. The intersection
  // keeps `disposeCalls` readable in tests while satisfying the option type.
  return manager as unknown as FakeSceneManager & SceneManager;
}

describe("G2WGame scene ownership", () => {
  it("disposes the owned scene manager before releasing the renderer", async () => {
    const renderer = fakeRenderer();
    const scenes = fakeSceneManager();
    const releaseOrder: string[] = [];
    renderer.dispose = async () => {
      releaseOrder.push("renderer");
      renderer.disposeCount++;
      renderer.initialized = false;
    };
    scenes.dispose = () => {
      releaseOrder.push("scenes");
      scenes.disposeCalls++;
    };
    const game = new G2WGame({ renderer, canvas, scenes });
    await game.init();
    scenes.start();

    await game.dispose();

    expect(scenes.disposeCalls).toBe(1);
    expect(renderer.disposeCount).toBe(1);
    expect(releaseOrder).toEqual(["scenes", "renderer"]);
    expect(game.state).toBe("disposed");
  });

  it("does not dispose scenes when ownership is declined", async () => {
    const renderer = fakeRenderer();
    const scenes = fakeSceneManager();
    const game = new G2WGame({ renderer, canvas, scenes, ownScenes: false });
    await game.init();

    await game.dispose();

    expect(scenes.disposeCalls).toBe(0);
    expect(renderer.disposeCount).toBe(1);
  });

  it("defers reentrant transition requests to the next update through the game loop", async () => {
    const renderer = fakeRenderer();
    const scheduler = new FakeScheduler();
    const calls: string[] = [];
    let managerRef: SceneManager | undefined;
    const menu = {
      enter: () => {
        calls.push("menu:enter");
      },
      update: () => {
        // Reentrant request from inside a running scene hook: deferred.
        managerRef?.goTo("gameplay");
        calls.push("menu:update");
      },
    };
    const gameplay = {
      enter: () => {
        calls.push("gameplay:enter");
      },
      update: () => {
        calls.push("gameplay:update");
      },
    };
    const scenes = new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });
    managerRef = scenes;
    const game = new G2WGame({
      renderer,
      canvas,
      scheduler,
      scenes,
      onUpdate: (dt) => {
        scenes.update(dt);
      },
    });
    await game.init();
    scenes.start();
    game.start();

    // Frame 1 issues the reentrant request; frame 2 applies it before the
    // update, exactly matching the core deferred-transition contract.
    scheduler.tick(0);
    scheduler.tick(16);

    expect(calls).toEqual(["menu:enter", "menu:update", "gameplay:enter", "gameplay:update"]);
    expect(scenes.active).toBe("gameplay");

    await game.dispose();
  });

  it("preserves recovery after a failed transition", async () => {
    const renderer = fakeRenderer();
    const scheduler = new FakeScheduler();
    const boom = new Error("enter boom");
    const broken = {
      enter: () => {
        throw boom;
      },
    };
    const menu = {
      enter: () => {},
      update: () => {},
    };
    const scenes = new SceneManager({ scenes: { menu, broken }, initial: "menu" });
    const game = new G2WGame({
      renderer,
      canvas,
      scheduler,
      scenes,
      onUpdate: (dt) => {
        scenes.update(dt);
      },
    });
    await game.init();
    scenes.start();

    // The failed transition throws from goTo, leaves no active scene, and
    // never reaches the frame loop.
    expect(() => scenes.goTo("broken")).toThrow(boom);
    expect(scenes.active).toBeNull();

    // A later valid transition recovers normally.
    scenes.goTo("menu");
    expect(scenes.active).toBe("menu");

    await game.dispose();
  });
});
