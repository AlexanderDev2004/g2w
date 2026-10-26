import type {
  FrameRequestCallback,
  FrameScheduler,
  Renderer,
  RendererInitOptions,
} from "@g2w/core";
import { Game, GameError, RendererError } from "@g2w/core";
import { describe, expect, it } from "vitest";

class FakeRenderer implements Renderer {
  readonly capabilities = { id: "fake", displayName: "Fake" } as const;

  #initialized = false;
  #initCount = 0;
  #disposeCount = 0;
  #renderCount = 0;
  failNextInitialize = false;
  failNextDispose = false;
  lastInitOptions: RendererInitOptions | null = null;

  get initialized(): boolean {
    return this.#initialized;
  }

  get initCount(): number {
    return this.#initCount;
  }

  get disposeCount(): number {
    return this.#disposeCount;
  }

  get renderCount(): number {
    return this.#renderCount;
  }

  async initialize(options: RendererInitOptions): Promise<void> {
    this.#initCount++;
    this.lastInitOptions = options;
    if (this.failNextInitialize) {
      throw new RendererError("FakeRenderer failed to initialize.");
    }
    if (this.#initialized) {
      throw new RendererError("FakeRenderer is already initialized.");
    }
    this.#initialized = true;
  }

  async dispose(): Promise<void> {
    if (!this.#initialized) {
      throw new RendererError("FakeRenderer is not initialized.");
    }
    if (this.failNextDispose) {
      this.failNextDispose = false;
      throw new RendererError("FakeRenderer failed to dispose.");
    }
    this.#initialized = false;
    this.#disposeCount++;
  }

  render(): void {
    if (!this.#initialized) {
      throw new RendererError("FakeRenderer is not initialized.");
    }
    this.#renderCount++;
  }
}

class FakeScheduler implements FrameScheduler {
  #pending: FrameRequestCallback[] = [];
  #cancelCount = 0;

  get pendingFrameCount(): number {
    return this.#pending.length;
  }

  get cancelCount(): number {
    return this.#cancelCount;
  }

  requestFrame(callback: FrameRequestCallback): void {
    this.#pending.push(callback);
  }

  cancelFrame(): void {
    this.#cancelCount++;
    this.#pending = [];
  }

  /** Fire all pending frame callbacks with the given timestamp. */
  trigger(timestampMs: number): void {
    const pending = [...this.#pending];
    this.#pending = [];
    for (const callback of pending) {
      callback(timestampMs);
    }
  }
}

const canvas = { width: 640, height: 360 } as HTMLCanvasElement;

interface Harness {
  game: Game;
  renderer: FakeRenderer;
  scheduler: FakeScheduler;
  deltas: number[];
}

function createGame(overrides: Partial<ConstructorParameters<typeof Game>[0]> = {}): Harness {
  const renderer = new FakeRenderer();
  const scheduler = new FakeScheduler();
  const deltas: number[] = [];
  const game = new Game({
    renderer,
    canvas,
    scheduler,
    onUpdate: (deltaTime) => deltas.push(deltaTime),
    ...overrides,
  });
  return { game, renderer, scheduler, deltas };
}

describe("Game sizing options (R3)", () => {
  it("passes logical dimensions through to the renderer's init options", async () => {
    const { game, renderer } = createGame({ width: 640, height: 360, resolution: 2 });
    await game.init();

    expect(renderer.lastInitOptions?.width).toBe(640);
    expect(renderer.lastInitOptions?.height).toBe(360);
    expect(renderer.lastInitOptions?.resolution).toBe(2);
  });

  it("omits the dimension keys entirely when no size is configured", async () => {
    const { game, renderer } = createGame();
    await game.init();

    const initOptions = renderer.lastInitOptions ?? {};
    expect("width" in initOptions).toBe(false);
    expect("height" in initOptions).toBe(false);
  });

  it("rejects width without height and height without width", () => {
    expect(() => createGame({ width: 640 })).toThrow(GameError);
    expect(() => createGame({ height: 360 })).toThrow(GameError);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-positive or non-finite dimensions (%s)",
    (invalid) => {
      expect(() => createGame({ width: invalid, height: 360 })).toThrow(GameError);
      expect(() => createGame({ width: 640, height: invalid })).toThrow(GameError);
    },
  );
});

describe("Game lifecycle", () => {
  it("initializes successfully", async () => {
    const { game, renderer } = createGame();

    expect(game.state).toBe("new");
    await game.init();

    expect(game.state).toBe("initialized");
    expect(renderer.initCount).toBe(1);
  });

  it("deduplicates concurrent init calls so the renderer initializes once", async () => {
    const { game, renderer } = createGame();

    const first = game.init();
    const second = game.init();
    await Promise.all([first, second]);

    expect(renderer.initCount).toBe(1);
    expect(game.state).toBe("initialized");
  });

  it("leaves the game in the new state and rethrows on initialization failure", async () => {
    const { game, renderer } = createGame();
    renderer.failNextInitialize = true;

    await expect(game.init()).rejects.toThrow(RendererError);
    expect(game.state).toBe("new");
    expect(renderer.initCount).toBe(1);

    // Retry is allowed after a failure.
    renderer.failNextInitialize = false;
    await game.init();
    expect(game.state).toBe("initialized");
    expect(renderer.initCount).toBe(2);
  });

  it("throws when started before initialization", () => {
    const { game } = createGame();

    expect(() => game.start()).toThrow(GameError);
    expect(game.state).toBe("new");
  });

  it("throws when started while initialization is pending", async () => {
    const { game } = createGame();
    const initPromise = game.init();

    expect(() => game.start()).toThrow(GameError);

    await initPromise;
    expect(game.state).toBe("initialized");
  });

  it("does not schedule duplicate loops when started repeatedly", async () => {
    const { game, scheduler } = createGame();
    await game.init();

    game.start();
    game.start();
    game.start();

    expect(game.state).toBe("running");
    expect(scheduler.pendingFrameCount).toBe(1);
  });

  it("cancels pending frames when stopped", async () => {
    const { game, scheduler } = createGame();
    await game.init();
    game.start();

    game.stop();

    expect(game.state).toBe("stopped");
    expect(scheduler.pendingFrameCount).toBe(0);
    expect(scheduler.cancelCount).toBeGreaterThanOrEqual(1);
  });

  it("does not update after stopping", async () => {
    const { game, renderer, scheduler, deltas } = createGame();
    await game.init();
    game.start();
    scheduler.trigger(0);
    game.stop();
    const cancelsAfterStop = scheduler.cancelCount;

    scheduler.trigger(16);

    expect(deltas.length).toBe(1);
    expect(renderer.renderCount).toBe(1);
    expect(scheduler.pendingFrameCount).toBe(0);
    expect(scheduler.cancelCount).toBe(cancelsAfterStop);
  });

  it("can resume from the stopped state", async () => {
    const { game, scheduler, deltas } = createGame();
    await game.init();
    game.start();
    scheduler.trigger(0);
    game.stop();

    game.start();
    expect(game.state).toBe("running");
    // A restart resets the timestamp: the first frame after (re)start has
    // delta 0, not the clamped gap since the previous frame.
    scheduler.trigger(10_000);
    expect(deltas).toEqual([0, 0]);
  });

  it("stops the loop and disposes the renderer exactly once", async () => {
    const { game, renderer, scheduler } = createGame();
    await game.init();
    game.start();

    await game.dispose();

    expect(game.state).toBe("disposed");
    expect(renderer.disposeCount).toBe(1);
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("is safe to dispose repeatedly", async () => {
    const { game, renderer } = createGame();
    await game.init();

    await game.dispose();
    await game.dispose();

    expect(renderer.disposeCount).toBe(1);
    expect(game.state).toBe("disposed");
  });

  it("marks the game stopped when stop is requested during initialization", async () => {
    const { game, renderer, scheduler } = createGame();
    const initPromise = game.init();

    game.stop();
    await initPromise;

    expect(game.state).toBe("stopped");
    expect(renderer.initCount).toBe(1);
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("stops and disposes the renderer when dispose is requested during initialization", async () => {
    const { game, renderer, scheduler } = createGame();
    const initPromise = game.init();

    const disposePromise = game.dispose();
    await Promise.all([initPromise, disposePromise]);

    expect(game.state).toBe("disposed");
    expect(renderer.disposeCount).toBe(1);
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("completes disposal even when initialization fails during dispose", async () => {
    const { game, renderer } = createGame();
    renderer.failNextInitialize = true;
    const initPromise = game.init();

    const disposePromise = game.dispose();
    await expect(initPromise).rejects.toThrow(RendererError);
    await disposePromise;

    expect(game.state).toBe("disposed");
    expect(renderer.disposeCount).toBe(0);
  });

  it("rethrows renderer disposal errors after marking the game disposed", async () => {
    const { game, renderer, scheduler } = createGame();
    await game.init();
    renderer.failNextDispose = true;

    await expect(game.dispose()).rejects.toThrow(RendererError);
    expect(game.state).toBe("disposed");
    // Disposal stays terminal and idempotent: repeated calls return the first
    // disposal's promise, so they surface the same renderer failure again.
    await expect(game.dispose()).rejects.toThrow(RendererError);
    expect(renderer.disposeCount).toBe(0);
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("throws GameError for init and start after disposal, and no-ops for stop and dispose", async () => {
    const { game, scheduler } = createGame();
    await game.dispose();

    expect(game.state).toBe("disposed");
    await expect(game.init()).rejects.toThrow(GameError);
    expect(() => game.start()).toThrow(GameError);
    expect(() => game.stop()).not.toThrow();
    await expect(game.dispose()).resolves.toBeUndefined();
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("stops when stop is called from inside the update callback", async () => {
    const inner = createGame();
    await inner.game.init();
    inner.game.start();

    const outer = createGame({
      onUpdate: () => {
        inner.game.stop();
      },
    });
    await outer.game.init();
    outer.game.start();

    outer.scheduler.trigger(0);

    expect(inner.game.state).toBe("stopped");
    // The outer loop keeps running because only the inner game stopped.
    expect(outer.game.state).toBe("running");
  });
});

describe("Game timing and scheduling", () => {
  it("gives the first frame a delta of zero and later frames seconds-based deltas", async () => {
    const { game, scheduler, deltas } = createGame();
    await game.init();
    game.start();

    // 240 ms gaps stay below the default 0.25 s clamp so the raw seconds
    // conversion is observable.
    scheduler.trigger(1000);
    scheduler.trigger(1240);
    scheduler.trigger(1480);

    expect(deltas).toEqual([0, 0.24, 0.24]);
  });

  it("clamps oversized deltas to maxDeltaTime (default 0.25s)", async () => {
    const { game, scheduler, deltas } = createGame();
    await game.init();
    game.start();

    scheduler.trigger(0);
    scheduler.trigger(10_000);

    expect(deltas).toEqual([0, 0.25]);
  });

  it("respects a custom maxDeltaTime", async () => {
    const { game, scheduler, deltas } = createGame({ maxDeltaTime: 0.1 });
    await game.init();
    game.start();

    scheduler.trigger(0);
    scheduler.trigger(5000);

    expect(deltas).toEqual([0, 0.1]);
  });

  it("rejects an invalid maxDeltaTime at construction", () => {
    expect(() => createGame({ maxDeltaTime: 0 })).toThrow(GameError);
    expect(() => createGame({ maxDeltaTime: -1 })).toThrow(GameError);
    expect(() => createGame({ maxDeltaTime: Number.NaN })).toThrow(GameError);
  });

  it("schedules the next frame after each tick and never more than one", async () => {
    const { game, scheduler } = createGame();
    await game.init();
    game.start();

    scheduler.trigger(16);

    expect(scheduler.pendingFrameCount).toBe(1);
  });

  it("stops scheduling frames after a fatal update error and marks the game stopped", async () => {
    const { game, scheduler } = createGame({
      onUpdate: () => {
        throw new Error("update exploded");
      },
    });
    await game.init();
    game.start();

    expect(() => scheduler.trigger(16)).toThrow("update exploded");
    expect(game.state).toBe("stopped");
    expect(scheduler.pendingFrameCount).toBe(0);

    // No further frames are scheduled or updates run after the fatal error.
    scheduler.trigger(32);
    expect(scheduler.pendingFrameCount).toBe(0);
  });

  it("runs the update callback before rendering each frame", async () => {
    const events: string[] = [];
    const harness = createGame({
      onUpdate: () => events.push("update"),
    });
    const originalRender = harness.renderer.render.bind(harness.renderer);
    harness.renderer.render = () => {
      events.push("render");
      originalRender();
    };
    await harness.game.init();
    harness.game.start();

    harness.scheduler.trigger(0);

    expect(events).toEqual(["update", "render"]);
  });
});
