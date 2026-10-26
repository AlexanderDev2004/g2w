import type {
  FrameRequestCallback,
  FrameScheduler,
  Renderer,
  RendererInitOptions,
  Scene,
} from "@g2w/core";
import { Game, InputState, SceneManager } from "@g2w/core";
import { describe, expect, it } from "vitest";

describe("InputState keyboard", () => {
  it("tracks held and pressed state on key down", () => {
    const input = new InputState();

    expect(input.isKeyDown("KeyW")).toBe(false);
    input.handleKeyDown("KeyW");

    expect(input.isKeyDown("KeyW")).toBe(true);
    expect(input.wasKeyPressed("KeyW")).toBe(true);
    expect(input.wasKeyReleased("KeyW")).toBe(false);
  });

  it("tracks held and released state on key up", () => {
    const input = new InputState();
    input.handleKeyDown("KeyW");
    input.endFrame();

    input.handleKeyUp("KeyW");

    expect(input.isKeyDown("KeyW")).toBe(false);
    expect(input.wasKeyReleased("KeyW")).toBe(true);
    expect(input.wasKeyPressed("KeyW")).toBe(false);
  });

  it("does not create repeated press transitions for OS key repeat", () => {
    const input = new InputState();
    input.handleKeyDown("Space");

    input.handleKeyDown("Space");
    input.handleKeyDown("Space");

    expect(input.isKeyDown("Space")).toBe(true);
    expect(input.wasKeyPressed("Space")).toBe(true);
  });

  it("ignores a release for a key that is not held", () => {
    const input = new InputState();

    input.handleKeyUp("KeyQ");

    expect(input.isKeyDown("KeyQ")).toBe(false);
    expect(input.wasKeyReleased("KeyQ")).toBe(false);
  });

  it("keeps a press-and-release between two frames fully observable", () => {
    const input = new InputState();
    input.endFrame();

    // A quick tap between two game frames: both edges must survive.
    input.handleKeyDown("Space");
    input.handleKeyUp("Space");

    expect(input.isKeyDown("Space")).toBe(false);
    expect(input.wasKeyPressed("Space")).toBe(true);
    expect(input.wasKeyReleased("Space")).toBe(true);
  });

  it("resets edge states exactly at endFrame and never touches held state", () => {
    const input = new InputState();
    input.handleKeyDown("KeyA");
    input.handleKeyUp("KeyA");
    input.handleKeyDown("KeyD");

    input.endFrame();

    expect(input.wasKeyPressed("KeyA")).toBe(false);
    expect(input.wasKeyReleased("KeyA")).toBe(false);
    expect(input.wasKeyPressed("KeyD")).toBe(false);
    // Held state survives the boundary.
    expect(input.isKeyDown("KeyD")).toBe(true);

    // Events after the boundary belong to the next frame's edges.
    input.handleKeyUp("KeyD");
    expect(input.wasKeyReleased("KeyD")).toBe(true);
  });

  it("tracks multiple keys independently", () => {
    const input = new InputState();
    input.handleKeyDown("KeyW");
    input.handleKeyDown("ArrowUp");

    input.handleKeyUp("KeyW");

    expect(input.isKeyDown("KeyW")).toBe(false);
    expect(input.isKeyDown("ArrowUp")).toBe(true);
    expect(input.wasKeyReleased("KeyW")).toBe(true);
    expect(input.wasKeyPressed("ArrowUp")).toBe(true);
    expect(input.wasKeyPressed("KeyW")).toBe(true);
  });
});

describe("InputState pointer", () => {
  it("updates the pointer position and marks it as seen", () => {
    const input = new InputState();

    expect(input.hasPointerPosition).toBe(false);
    input.handlePointerMove(120, 64);

    expect(input.hasPointerPosition).toBe(true);
    expect(input.pointerX).toBe(120);
    expect(input.pointerY).toBe(64);

    input.handlePointerMove(10, 20);
    expect(input.pointerX).toBe(10);
    expect(input.pointerY).toBe(20);
  });

  it("tracks button press and release edges like keys", () => {
    const input = new InputState();

    input.handleButtonDown(0);
    expect(input.isButtonDown(0)).toBe(true);
    expect(input.wasButtonPressed(0)).toBe(true);

    input.endFrame();
    input.handleButtonUp(0);
    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasButtonReleased(0)).toBe(true);
    expect(input.wasButtonPressed(0)).toBe(false);
  });

  it("ignores repeated presses of a held button and stray releases", () => {
    const input = new InputState();

    input.handleButtonDown(0);
    input.handleButtonDown(0);
    expect(input.isButtonDown(0)).toBe(true);
    expect(input.wasButtonPressed(0)).toBe(true);

    input.handleButtonUp(2);
    expect(input.wasButtonReleased(2)).toBe(false);
  });

  it("keeps the last pointer position across endFrame", () => {
    const input = new InputState();
    input.handlePointerMove(64, 32);

    input.endFrame();

    expect(input.hasPointerPosition).toBe(true);
    expect(input.pointerX).toBe(64);
    expect(input.pointerY).toBe(32);
  });
});

describe("InputState focus loss and pointer leave", () => {
  it("releases all held keys and buttons with edges on focus loss", () => {
    const input = new InputState();
    input.handleKeyDown("KeyW");
    input.handleKeyDown("ArrowLeft");
    input.handleButtonDown(0);
    input.endFrame();

    input.handleFocusLoss();

    expect(input.isKeyDown("KeyW")).toBe(false);
    expect(input.isKeyDown("ArrowLeft")).toBe(false);
    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasKeyReleased("KeyW")).toBe(true);
    expect(input.wasKeyReleased("ArrowLeft")).toBe(true);
    expect(input.wasButtonReleased(0)).toBe(true);
    // The pointer position is kept.
    input.handlePointerMove(5, 6);
    expect(input.pointerX).toBe(5);
  });

  it("does not report held keys as pressed after focus loss", () => {
    const input = new InputState();
    input.handleKeyDown("KeyW");
    input.endFrame();

    input.handleFocusLoss();

    expect(input.wasKeyPressed("KeyW")).toBe(false);
    expect(input.wasKeyReleased("KeyW")).toBe(true);
  });

  it("releases held buttons on pointer leave and keeps the position", () => {
    const input = new InputState();
    input.handlePointerMove(40, 50);
    input.handleButtonDown(0);
    input.endFrame();

    input.handlePointerLeave();

    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasButtonReleased(0)).toBe(true);
    expect(input.hasPointerPosition).toBe(true);
    expect(input.pointerX).toBe(40);
    expect(input.pointerY).toBe(50);
  });

  it("is safe to call focus loss with nothing held", () => {
    const input = new InputState();

    expect(() => input.handleFocusLoss()).not.toThrow();
    expect(() => input.handlePointerLeave()).not.toThrow();
  });
});

// --- Integration with Game and SceneManager ---------------------------------

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

describe("Input integration with Game and SceneManager", () => {
  it("lets the active scene read input edges and resets them once per frame", async () => {
    const input = new InputState();
    const seenPresses: string[] = [];
    const gameplay: Scene = {
      update() {
        if (input.wasKeyPressed("Space")) {
          seenPresses.push("space");
        }
      },
    };
    const scenes = new SceneManager({ scenes: { gameplay }, initial: "gameplay" });
    const scheduler = new ManualScheduler();
    const game = new Game({
      renderer: new StubRenderer(),
      canvas: { width: 640, height: 360 } as HTMLCanvasElement,
      scheduler,
      maxDeltaTime: 10,
      onUpdate: (deltaTime) => {
        scenes.update(deltaTime);
        // The frame boundary sits after every consumer of the input state.
        input.endFrame();
      },
    });

    await game.init();
    scenes.start();
    game.start();

    // Events between frames are visible to the next update.
    input.handleKeyDown("Space");
    scheduler.trigger(0);
    expect(seenPresses).toEqual(["space"]);

    // The edge was consumed at the frame boundary; holding is not a new press.
    scheduler.trigger(1000);
    expect(seenPresses).toEqual(["space"]);

    // A repeat keydown while held does not re-trigger.
    input.handleKeyDown("Space");
    scheduler.trigger(2000);
    expect(seenPresses).toEqual(["space"]);

    game.stop();
    await game.dispose();
  });

  it("keeps a tap between two frames observable through the game loop", async () => {
    const input = new InputState();
    const observed: { pressed: boolean; released: boolean; down: boolean }[] = [];
    const gameplay: Scene = {
      update() {
        observed.push({
          pressed: input.wasKeyPressed("KeyX"),
          released: input.wasKeyReleased("KeyX"),
          down: input.isKeyDown("KeyX"),
        });
      },
    };
    const scenes = new SceneManager({ scenes: { gameplay }, initial: "gameplay" });
    const scheduler = new ManualScheduler();
    const game = new Game({
      renderer: new StubRenderer(),
      canvas: { width: 640, height: 360 } as HTMLCanvasElement,
      scheduler,
      maxDeltaTime: 10,
      onUpdate: (deltaTime) => {
        scenes.update(deltaTime);
        input.endFrame();
      },
    });

    await game.init();
    scenes.start();
    game.start();

    // Tap arrives and completes between frames.
    input.handleKeyDown("KeyX");
    input.handleKeyUp("KeyX");
    scheduler.trigger(0);

    expect(observed).toEqual([{ pressed: true, released: true, down: false }]);

    game.stop();
    await game.dispose();
  });
});

describe("InputState touch contacts", () => {
  it("tracks a contact through start, move, and end", () => {
    const input = new InputState();

    input.handleTouchStart(11, 30, 40);
    expect(input.touchCount).toBe(1);
    expect(input.isTouchActive(11)).toBe(true);
    expect(input.wasTouchStarted(11)).toBe(true);
    expect(input.getTouchPosition(11)).toEqual({ x: 30, y: 40 });

    input.handleTouchMove(11, 50, 60);
    expect(input.getTouchPosition(11)).toEqual({ x: 50, y: 60 });

    input.handleTouchEnd(11);
    expect(input.isTouchActive(11)).toBe(false);
    expect(input.getTouchPosition(11)).toBeUndefined();
    expect(input.wasTouchEnded(11)).toBe(true);
  });

  it("supports multiple simultaneous contacts independently", () => {
    const input = new InputState();

    input.handleTouchStart(2, 10, 20);
    input.handleTouchStart(7, 30, 40);
    expect(input.touchCount).toBe(2);
    expect(input.activeTouchIds()).toEqual([2, 7]);

    input.handleTouchMove(7, 35, 45);
    input.handleTouchEnd(2);

    expect(input.activeTouchIds()).toEqual([7]);
    expect(input.getTouchPosition(7)).toEqual({ x: 35, y: 45 });
    expect(input.wasTouchEnded(2)).toBe(true);
    expect(input.wasTouchEnded(7)).toBe(false);
  });

  it("does not duplicate the start edge when an active contact restarts", () => {
    const input = new InputState();

    input.handleTouchStart(3, 1, 2);
    input.handleTouchStart(3, 5, 6);

    expect(input.touchCount).toBe(1);
    expect(input.getTouchPosition(3)).toEqual({ x: 5, y: 6 });
    expect(input.wasTouchStarted(3)).toBe(true);
  });

  it("cancels a contact with its own edge, distinct from a normal end", () => {
    const input = new InputState();

    input.handleTouchStart(4, 10, 10);
    input.handleTouchCancel(4);

    expect(input.isTouchActive(4)).toBe(false);
    expect(input.wasTouchCancelled(4)).toBe(true);
    expect(input.wasTouchEnded(4)).toBe(false);
  });

  it("ignores unknown ids and non-finite coordinates", () => {
    const input = new InputState();

    input.handleTouchMove(9, 5, 5);
    input.handleTouchEnd(9);
    input.handleTouchCancel(9);
    input.handleTouchStart(1, Number.NaN, 5);
    input.handleTouchStart(1, 5, Number.POSITIVE_INFINITY);
    input.handleTouchStart(1, 5, 5);
    input.handleTouchMove(1, Number.NaN, 5);

    expect(input.touchCount).toBe(1);
    expect(input.getTouchPosition(1)).toEqual({ x: 5, y: 5 });
    expect(input.wasTouchStarted(1)).toBe(true);
  });

  it("resets touch edges at endFrame while keeping active contacts", () => {
    const input = new InputState();

    input.handleTouchStart(1, 10, 10);
    input.handleTouchStart(2, 20, 20);
    input.handleTouchCancel(2);

    input.endFrame();

    expect(input.wasTouchStarted(1)).toBe(false);
    expect(input.wasTouchCancelled(2)).toBe(false);
    expect(input.isTouchActive(1)).toBe(true);
  });

  it("cancels every active contact on focus loss", () => {
    const input = new InputState();

    input.handleTouchStart(1, 10, 10);
    input.handleTouchStart(2, 20, 20);
    input.handleFocusLoss();

    expect(input.touchCount).toBe(0);
    expect(input.wasTouchCancelled(1)).toBe(true);
    expect(input.wasTouchCancelled(2)).toBe(true);
    expect(input.wasTouchEnded(1)).toBe(false);
  });

  it("leaves the single-pointer view untouched by touch contacts", () => {
    const input = new InputState();

    input.handleTouchStart(1, 10, 10);
    input.handleTouchEnd(1);

    expect(input.hasPointerPosition).toBe(false);
    expect(input.isButtonDown(0)).toBe(false);
  });
});
