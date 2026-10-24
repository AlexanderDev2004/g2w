import type {
  FrameRequestCallback,
  FrameScheduler,
  Renderer,
  RendererInitOptions,
  Scene,
} from "@g2w/core";
import { Game, SceneError, SceneManager } from "@g2w/core";
import { describe, expect, it } from "vitest";

class FakeScene implements Scene {
  readonly calls: string[] = [];
  readonly deltas: number[] = [];
  failOnInit = false;
  failOnEnter = false;
  failOnExit = false;
  failOnDispose = false;
  failOnUpdate = false;
  /** Side hook invoked inside `update`, e.g. to request a transition. */
  onUpdate?: () => void;

  readonly #label: string;

  constructor(label: string) {
    this.#label = label;
  }

  init(): void {
    this.calls.push(`${this.#label}:init`);
    if (this.failOnInit) {
      throw new Error(`${this.#label} init failed`);
    }
  }

  enter(): void {
    this.calls.push(`${this.#label}:enter`);
    if (this.failOnEnter) {
      throw new Error(`${this.#label} enter failed`);
    }
  }

  update(deltaTime: number): void {
    this.calls.push(`${this.#label}:update`);
    this.deltas.push(deltaTime);
    if (this.failOnUpdate) {
      throw new Error(`${this.#label} update failed`);
    }
    this.onUpdate?.();
  }

  exit(): void {
    this.calls.push(`${this.#label}:exit`);
    if (this.failOnExit) {
      throw new Error(`${this.#label} exit failed`);
    }
  }

  dispose(): void {
    this.calls.push(`${this.#label}:dispose`);
    if (this.failOnDispose) {
      throw new Error(`${this.#label} dispose failed`);
    }
  }
}

interface Harness {
  manager: SceneManager;
  menu: FakeScene;
  gameplay: FakeScene;
}

function createHarness(initial = "menu"): Harness {
  const menu = new FakeScene("menu");
  const gameplay = new FakeScene("gameplay");
  const manager = new SceneManager({ scenes: { menu, gameplay }, initial });
  return { manager, menu, gameplay };
}

describe("SceneManager lifecycle", () => {
  it("activates the initial scene with init before enter on start", () => {
    const { manager, menu } = createHarness();

    expect(manager.active).toBeNull();
    manager.start();

    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual(["menu:init", "menu:enter"]);
  });

  it("runs init once per scene across repeated activations", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    manager.goTo("gameplay");
    manager.goTo("menu");

    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit", "menu:enter"]);
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter", "gameplay:exit"]);
  });

  it("updates only the active scene and forwards delta time in seconds", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    manager.update(0.1);
    manager.update(0.25);

    expect(menu.deltas).toEqual([0.1, 0.25]);
    expect(gameplay.deltas).toEqual([]);

    manager.goTo("gameplay");
    manager.update(0.5);

    expect(menu.deltas).toEqual([0.1, 0.25]);
    expect(gameplay.deltas).toEqual([0.5]);
  });

  it("throws when started twice", () => {
    const { manager } = createHarness();
    manager.start();

    expect(() => manager.start()).toThrow(SceneError);
  });

  it("throws for update and goTo before start", () => {
    const { manager } = createHarness();

    expect(() => manager.update(0.1)).toThrow(SceneError);
    expect(() => manager.goTo("gameplay")).toThrow(SceneError);
  });
});

describe("SceneManager construction", () => {
  it("rejects an unknown initial scene", () => {
    const menu = new FakeScene("menu");

    expect(() => new SceneManager({ scenes: { menu }, initial: "missing" })).toThrow(SceneError);
  });

  it("rejects the same scene instance registered under two names", () => {
    const scene = new FakeScene("shared");

    expect(() => new SceneManager({ scenes: { a: scene, b: scene }, initial: "a" })).toThrow(
      SceneError,
    );
  });

  it("rejects a scene instance already owned by another manager", () => {
    const menu = new FakeScene("menu");
    const gameplay = new FakeScene("gameplay");
    new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });

    expect(() => new SceneManager({ scenes: { gameplay }, initial: "gameplay" })).toThrow(
      SceneError,
    );
  });

  it("keeps the claim after the owning manager is disposed", () => {
    const menu = new FakeScene("menu");
    const manager = new SceneManager({ scenes: { menu }, initial: "menu" });
    manager.dispose();

    expect(() => new SceneManager({ scenes: { menu }, initial: "menu" })).toThrow(SceneError);
  });

  it("rejects an empty scenes record", () => {
    expect(() => new SceneManager({ scenes: {}, initial: "menu" })).toThrow(SceneError);
  });
});

describe("SceneManager transitions", () => {
  it("exits the previous scene before entering the next one", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    manager.goTo("gameplay");

    expect(manager.active).toBe("gameplay");
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter"]);
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit"]);
  });

  it("defers transitions requested during an update to the next update", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    // The gameplay scene requests a transition back to the menu mid-update.
    gameplay.onUpdate = () => manager.goTo("menu");
    manager.goTo("gameplay");
    manager.update(0.1);

    // The requesting update finishes on the active scene; nothing moved yet.
    expect(manager.active).toBe("gameplay");
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit"]);

    manager.update(0.2);

    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual([
      "menu:init",
      "menu:enter",
      "menu:exit",
      "menu:enter",
      "menu:update",
    ]);
    // The new scene updates in the same frame its transition was applied.
    expect(menu.deltas).toEqual([0.2]);
    expect(gameplay.deltas).toEqual([0.1]);
  });

  it("lets the last deferred request win", () => {
    const credits = new FakeScene("credits");
    const menu = new FakeScene("menu");
    const gameplay = new FakeScene("gameplay");
    const manager = new SceneManager({
      scenes: { menu, gameplay, credits },
      initial: "menu",
    });
    manager.start();

    // Deferred requests replace each other; the intermediate scene never runs.
    gameplay.onUpdate = () => {
      manager.goTo("menu");
      manager.goTo("credits");
    };
    manager.goTo("gameplay");
    manager.update(0.1);
    manager.update(0.2);

    expect(manager.active).toBe("credits");
    expect(credits.deltas).toEqual([0.2]);
    expect(gameplay.calls).toEqual([
      "gameplay:init",
      "gameplay:enter",
      "gameplay:update",
      "gameplay:exit",
    ]);
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit"]);
  });

  it("cancels a pending deferred transition when the active scene is requested again", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    // A deferred request exists after this update...
    menu.onUpdate = () => manager.goTo("gameplay");
    manager.update(0.1);
    expect(manager.active).toBe("menu");

    // ...and the most recent request (a no-op for the active scene) cancels it.
    menu.onUpdate = undefined;
    manager.goTo("menu");
    manager.update(0.2);

    expect(manager.active).toBe("menu");
    expect(menu.deltas).toEqual([0.1, 0.2]);
    expect(gameplay.calls).toEqual([]);
  });

  it("lets a later immediate request supersede a pending deferred transition", () => {
    const credits = new FakeScene("credits");
    const menu = new FakeScene("menu");
    const gameplay = new FakeScene("gameplay");
    const manager = new SceneManager({
      scenes: { menu, gameplay, credits },
      initial: "menu",
    });
    manager.start();

    menu.onUpdate = () => manager.goTo("gameplay");
    manager.update(0.1);
    expect(manager.active).toBe("menu");

    // The explicit request after the update replaces the stale pending one.
    manager.goTo("credits");
    manager.update(0.2);

    expect(manager.active).toBe("credits");
    expect(gameplay.calls).toEqual([]);
    expect(credits.calls).toEqual(["credits:init", "credits:enter", "credits:update"]);
  });

  it("keeps a pending transition when an unknown scene is requested", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();

    menu.onUpdate = () => manager.goTo("gameplay");
    manager.update(0.1);
    expect(() => manager.goTo("missing")).toThrow(SceneError);

    manager.update(0.2);

    // The invalid request changed nothing; the pending one still applies.
    expect(manager.active).toBe("gameplay");
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter", "gameplay:update"]);
  });

  it("propagates an init failure during a transition and allows recovery", () => {
    const { manager, gameplay } = createHarness();
    manager.start();
    gameplay.failOnInit = true;

    expect(() => manager.goTo("gameplay")).toThrow("gameplay init failed");
    expect(manager.active).toBeNull();
    // The previous scene exited; the destination never entered and its init
    // can be retried.
    expect(gameplay.calls).toEqual(["gameplay:init"]);

    gameplay.failOnInit = false;
    manager.goTo("gameplay");

    // Recovery retries the failed init and completes activation.
    expect(manager.active).toBe("gameplay");
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:init", "gameplay:enter"]);
  });

  it("ignores a request for the already-active scene", () => {
    const { manager, menu } = createHarness();
    manager.start();

    manager.goTo("menu");

    expect(menu.calls).toEqual(["menu:init", "menu:enter"]);
    expect(manager.active).toBe("menu");
  });

  it("throws for unknown scene names and keeps the active scene", () => {
    const { manager, menu } = createHarness();
    manager.start();

    expect(() => manager.goTo("missing")).toThrow(SceneError);
    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual(["menu:init", "menu:enter"]);
  });
});

describe("SceneManager hook errors", () => {
  it("propagates an init failure, stays unstarted, and allows a retry", () => {
    const { manager, menu } = createHarness();
    menu.failOnInit = true;

    expect(() => manager.start()).toThrow("menu init failed");
    expect(manager.active).toBeNull();

    menu.failOnInit = false;
    manager.start();

    // Init is retried after a failure; enter only runs on success.
    expect(menu.calls).toEqual(["menu:init", "menu:init", "menu:enter"]);
    expect(manager.active).toBe("menu");
  });

  it("leaves no active scene after a failed enter and recovers via goTo", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    gameplay.failOnEnter = true;

    expect(() => manager.goTo("gameplay")).toThrow("gameplay enter failed");
    expect(manager.active).toBeNull();
    // The old scene was exited; the new scene ran init, and its enter threw
    // after recording the call.
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit"]);
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter"]);

    gameplay.failOnEnter = false;
    manager.goTo("menu");

    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit", "menu:enter"]);
  });

  it("propagates an exit failure and does not enter the next scene", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    menu.failOnExit = true;

    expect(() => manager.goTo("gameplay")).toThrow("menu exit failed");
    expect(manager.active).toBeNull();
    expect(gameplay.calls).toEqual([]);

    menu.failOnExit = false;
    manager.goTo("gameplay");

    expect(manager.active).toBe("gameplay");
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter"]);
    // The failed scene never completed a transition, so it gets no exit.
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit"]);
  });

  it("propagates an update failure to the caller", () => {
    const { manager, menu } = createHarness();
    manager.start();
    menu.failOnUpdate = true;

    expect(() => manager.update(0.1)).toThrow("menu update failed");
  });
});

describe("SceneManager disposal", () => {
  it("exits the active scene, disposes initialized scenes, and is idempotent", () => {
    const menu = new FakeScene("menu");
    const gameplay = new FakeScene("gameplay");
    const credits = new FakeScene("credits");
    const manager = new SceneManager({
      scenes: { menu, gameplay, credits },
      initial: "menu",
    });
    manager.start();
    manager.goTo("gameplay");
    manager.goTo("menu");

    manager.dispose();

    // Registration order: menu first, then gameplay; credits was never
    // initialized, so it has nothing to release.
    expect(menu.calls).toEqual([
      "menu:init",
      "menu:enter",
      "menu:exit",
      "menu:enter",
      "menu:exit",
      "menu:dispose",
    ]);
    expect(gameplay.calls).toEqual([
      "gameplay:init",
      "gameplay:enter",
      "gameplay:exit",
      "gameplay:dispose",
    ]);
    expect(credits.calls).toEqual([]);

    manager.dispose();

    expect(menu.calls.length).toBe(6);
    expect(gameplay.calls.length).toBe(4);
  });

  it("disposes before start without touching any scene", () => {
    const { manager, menu } = createHarness();

    manager.dispose();

    expect(menu.calls).toEqual([]);
    expect(() => manager.start()).toThrow(SceneError);
  });

  it("disposes after a failed transition without a stray exit", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    gameplay.failOnEnter = true;
    expect(() => manager.goTo("gameplay")).toThrow("gameplay enter failed");

    manager.dispose();

    // No active scene remained, so there is nothing to exit; both initialized
    // scenes (menu, then gameplay in registration order) are disposed once.
    expect(menu.calls).toEqual(["menu:init", "menu:enter", "menu:exit", "menu:dispose"]);
    expect(gameplay.calls).toEqual(["gameplay:init", "gameplay:enter", "gameplay:dispose"]);
  });

  it("keeps disposing all scenes when the active scene's exit throws, then rethrows", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    manager.goTo("gameplay");
    manager.goTo("menu");
    menu.failOnExit = true;

    expect(() => manager.dispose()).toThrow("menu exit failed");

    // The failure did not prevent the remaining cleanup.
    expect(menu.calls).toEqual([
      "menu:init",
      "menu:enter",
      "menu:exit",
      "menu:enter",
      "menu:exit",
      "menu:dispose",
    ]);
    expect(gameplay.calls).toEqual([
      "gameplay:init",
      "gameplay:enter",
      "gameplay:exit",
      "gameplay:dispose",
    ]);

    // Disposal is terminal even when it reports an error.
    manager.dispose();
    expect(menu.calls.length).toBe(6);
    expect(() => manager.update(0.1)).toThrow(SceneError);
  });

  it("rethrows a single dispose error as-is after completing cleanup", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    manager.goTo("gameplay");
    manager.goTo("menu");
    gameplay.failOnDispose = true;

    let thrown: unknown;
    try {
      manager.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("gameplay dispose failed");
    // Menu, registered first, was still disposed after gameplay failed.
    expect(menu.calls).toEqual([
      "menu:init",
      "menu:enter",
      "menu:exit",
      "menu:enter",
      "menu:exit",
      "menu:dispose",
    ]);
  });

  it("aggregates multiple dispose errors and stays terminal", () => {
    const { manager, menu, gameplay } = createHarness();
    manager.start();
    manager.goTo("gameplay");
    manager.goTo("menu");
    menu.failOnDispose = true;
    gameplay.failOnDispose = true;

    let thrown: unknown;
    try {
      manager.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    // Every eligible hook was still attempted exactly once.
    expect(menu.calls.filter((call) => call === "menu:dispose")).toHaveLength(1);
    expect(gameplay.calls.filter((call) => call === "gameplay:dispose")).toHaveLength(1);

    manager.dispose();
    expect(menu.calls.filter((call) => call === "menu:dispose")).toHaveLength(1);
  });

  it("throws for start, goTo, and update after disposal", () => {
    const { manager } = createHarness();
    manager.start();
    manager.dispose();

    expect(() => manager.start()).toThrow(SceneError);
    expect(() => manager.goTo("gameplay")).toThrow(SceneError);
    expect(() => manager.update(0.1)).toThrow(SceneError);
  });
});

class StubRenderer implements Renderer {
  readonly capabilities = { id: "stub", displayName: "Stub" } as const;

  #initialized = false;

  get initialized(): boolean {
    return this.#initialized;
  }

  async initialize(_options: RendererInitOptions): Promise<void> {
    this.#initialized = true;
  }

  async dispose(): Promise<void> {
    this.#initialized = false;
  }

  render(): void {}
}

class ManualScheduler implements FrameScheduler {
  #callback: FrameRequestCallback | null = null;

  requestFrame(callback: FrameRequestCallback): void {
    this.#callback = callback;
  }

  cancelFrame(): void {
    this.#callback = null;
  }

  trigger(timestampMs: number): void {
    const callback = this.#callback;
    this.#callback = null;
    callback?.(timestampMs);
  }
}

describe("Game integration", () => {
  it("drives the active scene through Game.onUpdate without a second loop", async () => {
    const menu = new FakeScene("menu");
    const gameplay = new FakeScene("gameplay");
    const manager = new SceneManager({
      scenes: { menu, gameplay },
      initial: "menu",
    });
    const scheduler = new ManualScheduler();
    const game = new Game({
      renderer: new StubRenderer(),
      canvas: { width: 640, height: 360 } as HTMLCanvasElement,
      scheduler,
      // Keep deltas readable; the clamping behavior is covered in game.test.ts.
      maxDeltaTime: 10,
      onUpdate: (deltaTime) => manager.update(deltaTime),
    });

    await game.init();
    manager.start();
    game.start();

    // Frame 1: the first delta after start is zero (Game resets its timestamp).
    scheduler.trigger(0);
    expect(menu.deltas).toEqual([0]);
    expect(gameplay.deltas).toEqual([]);

    // Frame 2: the gameplay scene requests a return to the menu mid-update.
    manager.goTo("gameplay");
    gameplay.onUpdate = () => manager.goTo("menu");
    scheduler.trigger(1000);
    expect(gameplay.deltas).toEqual([1]);
    expect(manager.active).toBe("gameplay");

    // Frame 3: the deferred transition applies before the new scene updates.
    scheduler.trigger(2000);
    expect(manager.active).toBe("menu");
    expect(menu.calls).toEqual([
      "menu:init",
      "menu:enter",
      "menu:update",
      "menu:exit",
      "menu:enter",
      "menu:update",
    ]);
    expect(menu.deltas).toEqual([0, 1]);
    expect(game.state).toBe("running");

    game.stop();
    await game.dispose();
  });
});
