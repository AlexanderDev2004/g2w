import { InputState } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { DomInput, DomInputError } from "../src/index.js";

/** A minimal DOM event carrying only the fields the adapter reads. */
class FakeDomEvent extends Event {
  constructor(
    type: string,
    fields: {
      code?: string;
      button?: number;
      clientX?: number;
      clientY?: number;
      pointerType?: string;
      pointerId?: number;
    } = {},
  ) {
    super(type);
    if (fields.code !== undefined) {
      Object.defineProperty(this, "code", { value: fields.code });
    }
    if (fields.button !== undefined) {
      Object.defineProperty(this, "button", { value: fields.button });
    }
    Object.defineProperty(this, "clientX", { value: fields.clientX ?? 0 });
    Object.defineProperty(this, "clientY", { value: fields.clientY ?? 0 });
    Object.defineProperty(this, "pointerType", { value: fields.pointerType ?? "mouse" });
    Object.defineProperty(this, "pointerId", { value: fields.pointerId ?? 1 });
  }
}

/** Records registrations so tests can assert on listener bookkeeping. */
class FakeTarget extends EventTarget {
  readonly registrationCounts = new Map<string, number>();
  readonly removalCounts = new Map<string, number>();

  override addEventListener(type: string, listener: EventListener): void {
    super.addEventListener(type, listener);
    this.registrationCounts.set(type, (this.registrationCounts.get(type) ?? 0) + 1);
  }

  override removeEventListener(type: string, listener: EventListener): void {
    super.removeEventListener(type, listener);
    this.removalCounts.set(type, (this.removalCounts.get(type) ?? 0) + 1);
  }
}

/** A canvas double: a counting EventTarget with a bounding rect and logical size. */
class FakeCanvasElement extends FakeTarget {
  readonly width: number;
  readonly height: number;
  #rect: { left: number; top: number; width: number; height: number };

  constructor(width = 640, height = 360) {
    super();
    this.width = width;
    this.height = height;
    this.#rect = { left: 100, top: 50, width, height };
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.#rect;
  }

  setRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.#rect = rect;
  }
}

function createFakeCanvas(width = 640, height = 360): FakeCanvasElement {
  return new FakeCanvasElement(width, height);
}

function createAttached(): {
  input: InputState;
  keyTarget: FakeTarget;
  blurTarget: FakeTarget;
  pointerUpTarget: FakeTarget;
  canvas: FakeCanvasElement;
  domInput: DomInput;
} {
  const input = new InputState();
  const keyTarget = new FakeTarget();
  const blurTarget = new FakeTarget();
  const pointerUpTarget = new FakeTarget();
  const canvas = createFakeCanvas();
  const domInput = new DomInput(input, {
    canvas: canvas as unknown as HTMLCanvasElement,
    keyTarget,
    blurTarget,
    pointerUpTarget,
  });
  domInput.attach();
  return { input, keyTarget, blurTarget, pointerUpTarget, canvas, domInput };
}

describe("DomInput keyboard normalization", () => {
  it("maps keydown and keyup events to InputState by KeyboardEvent.code", () => {
    const { input, keyTarget } = createAttached();

    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyW" }));
    expect(input.isKeyDown("KeyW")).toBe(true);
    expect(input.wasKeyPressed("KeyW")).toBe(true);

    keyTarget.dispatchEvent(new FakeDomEvent("keyup", { code: "KeyW" }));
    expect(input.isKeyDown("KeyW")).toBe(false);
    expect(input.wasKeyReleased("KeyW")).toBe(true);
  });

  it("does not create duplicate press edges for OS key repeat", () => {
    const { input, keyTarget } = createAttached();

    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "Space" }));
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "Space" }));

    expect(input.isKeyDown("Space")).toBe(true);
    expect(input.wasKeyPressed("Space")).toBe(true);
  });
});

describe("DomInput pointer normalization", () => {
  it("converts client coordinates to canvas-relative canvas pixels", () => {
    const { input, canvas } = createAttached();

    // The fake canvas's bounding rect sits at (100, 50) with its full
    // 640x360 size, so the event at client (164, 86) is canvas-relative
    // (64, 36) in canvas pixels.
    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 164, clientY: 86 }));

    expect(input.hasPointerPosition).toBe(true);
    expect(input.pointerX).toBe(64);
    expect(input.pointerY).toBe(36);
  });

  it("scales coordinates when CSS scales the canvas", () => {
    const input = new InputState();
    // Canvas is 640 internal pixels but rendered at 320 CSS pixels.
    const canvas = createFakeCanvas();
    canvas.setRect({ left: 0, top: 0, width: 320, height: 180 });
    const domInput = new DomInput(input, {
      canvas: canvas as unknown as HTMLCanvasElement,
      keyTarget: new FakeTarget(),
      blurTarget: new FakeTarget(),
      pointerUpTarget: new FakeTarget(),
    });
    domInput.attach();

    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 160, clientY: 90 }));

    // Half the CSS size maps to the full internal size.
    expect(input.pointerX).toBe(320);
    expect(input.pointerY).toBe(180);
  });

  it("records button presses with the press position and releases via pointerUpTarget", () => {
    const { input, canvas, pointerUpTarget } = createAttached();

    // Client (130, 90) with the rect at (100, 50) is canvas-relative (30, 40).
    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0, clientX: 130, clientY: 90 }));
    expect(input.isButtonDown(0)).toBe(true);
    expect(input.wasButtonPressed(0)).toBe(true);
    expect(input.pointerX).toBe(30);
    expect(input.pointerY).toBe(40);

    // A release that happens off-canvas is caught by the pointerUpTarget.
    pointerUpTarget.dispatchEvent(new FakeDomEvent("pointerup", { button: 0 }));
    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasButtonReleased(0)).toBe(true);
  });

  it("releases held buttons on pointer leave and keeps the position", () => {
    const { input, canvas } = createAttached();

    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0, clientX: 130, clientY: 90 }));
    canvas.dispatchEvent(new FakeDomEvent("pointerleave"));

    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasButtonReleased(0)).toBe(true);
    expect(input.pointerX).toBe(30);
  });
});

describe("DomInput logical coordinate space (R3)", () => {
  function createWithLogicalSize(canvas: FakeCanvasElement): {
    input: InputState;
    domInput: DomInput;
  } {
    const input = new InputState();
    const domInput = new DomInput(input, {
      canvas: canvas as unknown as HTMLCanvasElement,
      keyTarget: new FakeTarget(),
      blurTarget: new FakeTarget(),
      pointerUpTarget: new FakeTarget(),
      // The game's stage space: 640×360 logical pixels.
      logicalSize: { width: 640, height: 360 },
    });
    domInput.attach();
    return { input, domInput };
  }

  it("maps pointer coordinates into the logical space instead of backing pixels", () => {
    // Backing resolution 800×750 (640×360 at resolution 1.25), CSS size
    // 640×360 — what autoDensity produces. The legacy mapping would scale
    // by 800/640; the logical mapping must not.
    const canvas = new FakeCanvasElement(800, 750);
    canvas.setRect({ left: 100, top: 50, width: 640, height: 360 });
    const { input } = createWithLogicalSize(canvas);

    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 420, clientY: 230 }));

    expect(input.pointerX).toBe(320);
    expect(input.pointerY).toBe(180);
  });

  it("maps into the logical space under proportional CSS display scaling", () => {
    // Narrow viewport: the 640×360 logical canvas is displayed at 320×180.
    const canvas = new FakeCanvasElement(640, 360);
    canvas.setRect({ left: 0, top: 0, width: 320, height: 180 });
    const { input } = createWithLogicalSize(canvas);

    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 160, clientY: 90 }));

    expect(input.pointerX).toBe(320);
    expect(input.pointerY).toBe(180);
  });

  it("keeps button press positions in the logical space", () => {
    const canvas = new FakeCanvasElement(800, 750);
    canvas.setRect({ left: 100, top: 50, width: 640, height: 360 });
    const { input } = createWithLogicalSize(canvas);

    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", { button: 0, clientX: 180, clientY: 140 }),
    );

    expect(input.isButtonDown(0)).toBe(true);
    expect(input.pointerX).toBe(80);
    expect(input.pointerY).toBe(90);
  });

  it("preserves the legacy backing-pixel mapping when logicalSize is omitted", () => {
    const { input, canvas } = createAttached(); // canvas.width 640, rect 640 at (100, 50)

    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 164, clientY: 86 }));

    expect(input.pointerX).toBe(64);
    expect(input.pointerY).toBe(36);
  });

  it("handles a zero-sized canvas without dividing by zero", () => {
    const canvas = new FakeCanvasElement(640, 360);
    canvas.setRect({ left: 100, top: 50, width: 0, height: 0 });
    const { input } = createWithLogicalSize(canvas);

    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 130, clientY: 80 }));

    expect(input.hasPointerPosition).toBe(true);
    expect(input.pointerX).toBe(30);
    expect(input.pointerY).toBe(30);
  });
});

describe("DomInput focus loss", () => {
  it("releases all held keys and buttons when the blur target fires", () => {
    const { input, keyTarget, blurTarget, canvas } = createAttached();

    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyA" }));
    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0 }));
    input.endFrame();

    blurTarget.dispatchEvent(new FakeDomEvent("blur"));

    expect(input.isKeyDown("KeyA")).toBe(false);
    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasKeyReleased("KeyA")).toBe(true);
    expect(input.wasButtonReleased(0)).toBe(true);
  });
});

describe("DomInput lifecycle", () => {
  it("registers exactly one listener per event type", () => {
    const { domInput, keyTarget, canvas } = createAttached();

    expect(keyTarget.registrationCounts.get("keydown")).toBe(1);
    expect(keyTarget.registrationCounts.get("keyup")).toBe(1);
    expect(canvas.registrationCounts.get("pointermove")).toBe(1);
    expect(canvas.registrationCounts.get("pointerdown")).toBe(1);
    expect(canvas.registrationCounts.get("pointerleave")).toBe(1);

    domInput.attach();
    domInput.attach();

    // Repeated attach does not duplicate listeners.
    expect(keyTarget.registrationCounts.get("keydown")).toBe(1);
  });

  it("removes every listener on disposal and stops feeding events", () => {
    const { input, keyTarget, blurTarget, pointerUpTarget, canvas, domInput } = createAttached();

    domInput.dispose();

    const expected = new Set([
      "keydown",
      "keyup",
      "blur",
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointercancel",
      "pointerleave",
    ]);
    for (const target of [keyTarget, blurTarget, pointerUpTarget, canvas]) {
      for (const [type, removals] of target.removalCounts) {
        expect(expected.has(type)).toBe(true);
        expect(removals).toBe(1);
      }
    }

    // No further events reach the state.
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyZ" }));
    expect(input.isKeyDown("KeyZ")).toBe(false);
  });

  it("is idempotent to repeated disposal and rejects re-attachment", () => {
    const { domInput } = createAttached();

    domInput.dispose();
    expect(() => domInput.dispose()).not.toThrow();
    expect(() => domInput.attach()).toThrow(DomInputError);
    expect(domInput.attached).toBe(false);
  });

  it("reports attachment state", () => {
    const input = new InputState();
    const canvas = createFakeCanvas();
    const domInput = new DomInput(input, {
      canvas: canvas as unknown as HTMLCanvasElement,
      keyTarget: new FakeTarget(),
      blurTarget: new FakeTarget(),
      pointerUpTarget: new FakeTarget(),
    });

    expect(domInput.attached).toBe(false);
    domInput.attach();
    expect(domInput.attached).toBe(true);
    domInput.dispose();
    expect(domInput.attached).toBe(false);
  });
});

describe("DomInput touch normalization (R5)", () => {
  it("feeds touch pointer events into the multi-touch contract by pointerId", () => {
    const { input, canvas, pointerUpTarget } = createAttached();

    // Client (164, 86) with the rect at (100, 50) is canvas-relative (64, 36).
    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        button: 0,
        clientX: 164,
        clientY: 86,
        pointerType: "touch",
        pointerId: 5,
      }),
    );
    expect(input.touchCount).toBe(1);
    expect(input.isTouchActive(5)).toBe(true);
    expect(input.wasTouchStarted(5)).toBe(true);
    expect(input.getTouchPosition(5)).toEqual({ x: 64, y: 36 });

    canvas.dispatchEvent(
      new FakeDomEvent("pointermove", {
        clientX: 200,
        clientY: 120,
        pointerType: "touch",
        pointerId: 5,
      }),
    );
    expect(input.getTouchPosition(5)).toEqual({ x: 100, y: 70 });

    pointerUpTarget.dispatchEvent(
      new FakeDomEvent("pointerup", { button: 0, pointerType: "touch", pointerId: 5 }),
    );
    expect(input.isTouchActive(5)).toBe(false);
    expect(input.wasTouchEnded(5)).toBe(true);
    expect(input.wasTouchCancelled(5)).toBe(false);
  });

  it("tracks multiple simultaneous touch contacts independently", () => {
    const { input, canvas } = createAttached();

    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        clientX: 130,
        clientY: 90,
        pointerType: "touch",
        pointerId: 1,
      }),
    );
    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        clientX: 230,
        clientY: 190,
        pointerType: "touch",
        pointerId: 2,
      }),
    );

    expect(input.touchCount).toBe(2);
    expect(input.activeTouchIds()).toEqual([1, 2]);
    expect(input.getTouchPosition(1)).toEqual({ x: 30, y: 40 });
    expect(input.getTouchPosition(2)).toEqual({ x: 130, y: 140 });
  });

  it("cancels the touch contact on pointercancel for touch pointers", () => {
    const { input, canvas, pointerUpTarget } = createAttached();

    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        clientX: 130,
        clientY: 90,
        pointerType: "touch",
        pointerId: 3,
      }),
    );
    pointerUpTarget.dispatchEvent(
      new FakeDomEvent("pointercancel", { pointerType: "touch", pointerId: 3 }),
    );

    expect(input.isTouchActive(3)).toBe(false);
    expect(input.wasTouchCancelled(3)).toBe(true);
    expect(input.wasTouchEnded(3)).toBe(false);
  });

  it("releases held buttons on pointercancel for non-touch pointers", () => {
    const { input, canvas, pointerUpTarget } = createAttached();

    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0, clientX: 130, clientY: 90 }));
    pointerUpTarget.dispatchEvent(new FakeDomEvent("pointercancel", { button: 0 }));

    expect(input.isButtonDown(0)).toBe(false);
    expect(input.wasButtonReleased(0)).toBe(true);
  });

  it("keeps mouse pointer events out of the touch contract", () => {
    const { input, canvas } = createAttached();

    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0, clientX: 130, clientY: 90 }));
    canvas.dispatchEvent(new FakeDomEvent("pointermove", { clientX: 140, clientY: 100 }));

    expect(input.touchCount).toBe(0);
    expect(input.isButtonDown(0)).toBe(true);
  });

  it("maps touch coordinates through the logical size like pointer coordinates", () => {
    const input = new InputState();
    const canvas = createFakeCanvas();
    // 640x360 canvas rendered at 320x180 CSS pixels: half-size mapping.
    canvas.setRect({ left: 0, top: 0, width: 320, height: 180 });
    const domInput = new DomInput(input, {
      canvas: canvas as unknown as HTMLCanvasElement,
      keyTarget: new FakeTarget(),
      blurTarget: new FakeTarget(),
      pointerUpTarget: new FakeTarget(),
      logicalSize: { width: 1280, height: 720 },
    });
    domInput.attach();

    canvas.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        clientX: 160,
        clientY: 90,
        pointerType: "touch",
        pointerId: 7,
      }),
    );

    // (160, 90) CSS is exactly half the canvas, so (640, 360) in logical space.
    expect(input.getTouchPosition(7)).toEqual({ x: 640, y: 360 });
  });
});

/**
 * E3-C attachment failure safety: a listener registration that fails
 * part-way through must leave no listeners behind, a consistent detached
 * state, and a retryable adapter — with the original error preserved
 * alongside any rollback cleanup failure.
 */
describe("DomInput attachment failure safety (E3-C)", () => {
  /** A FakeTarget whose `addEventListener` throws when a given type arrives. */
  class FailingTarget extends FakeTarget {
    #failOnType: string | null = null;
    #failOnRemove: string | null = null;

    failRegistrationOn(type: string): void {
      this.#failOnType = type;
    }

    failRemovalOn(type: string): void {
      this.#failOnRemove = type;
    }

    override addEventListener(type: string, listener: EventListener): void {
      if (this.#failOnType === type) {
        throw new Error(`addEventListener failed for ${type}`);
      }
      super.addEventListener(type, listener);
    }

    override removeEventListener(type: string, listener: EventListener): void {
      if (this.#failOnRemove === type) {
        throw new Error(`removeEventListener failed for ${type}`);
      }
      super.removeEventListener(type, listener);
    }
  }

  function createAdapters(): {
    input: InputState;
    keyTarget: FailingTarget;
    blurTarget: FailingTarget;
    pointerUpTarget: FailingTarget;
    canvas: FakeCanvasElement;
  } {
    const input = new InputState();
    const keyTarget = new FailingTarget();
    const blurTarget = new FailingTarget();
    const pointerUpTarget = new FailingTarget();
    const canvas = createFakeCanvas();
    return { input, keyTarget, blurTarget, pointerUpTarget, canvas };
  }

  function createInput(input: InputState, targets: ReturnType<typeof createAdapters>): DomInput {
    return new DomInput(input, {
      canvas: targets.canvas as unknown as HTMLCanvasElement,
      keyTarget: targets.keyTarget,
      blurTarget: targets.blurTarget,
      pointerUpTarget: targets.pointerUpTarget,
    });
  }

  it("rolls back every listener when registration fails part-way and stays retryable", () => {
    const targets = createAdapters();
    const { input, keyTarget, canvas } = targets;
    // keydown registers fine; keyup (the second registration) throws.
    keyTarget.failRegistrationOn("keyup");
    const domInput = createInput(input, targets);

    expect(() => domInput.attach()).toThrow("addEventListener failed for keyup");

    // Consistent detached state, not a half-attached adapter.
    expect(domInput.attached).toBe(false);
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyW" }));
    expect(input.isKeyDown("KeyW")).toBe(false);

    // Retry fully succeeds once the failure is gone.
    keyTarget.failRegistrationOn("");
    domInput.attach();
    expect(domInput.attached).toBe(true);
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyW" }));
    expect(input.isKeyDown("KeyW")).toBe(true);
    keyTarget.dispatchEvent(new FakeDomEvent("keyup", { code: "KeyW" }));
    expect(input.isKeyDown("KeyW")).toBe(false);
    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0 }));
    expect(input.isButtonDown(0)).toBe(true);

    domInput.dispose();
  });

  it("preserves the registration error alongside rollback cleanup failures", () => {
    const targets = createAdapters();
    const { input, keyTarget } = targets;
    keyTarget.failRegistrationOn("keyup");
    // keydown's listener (registered before keyup) fails to roll back.
    keyTarget.failRemovalOn("keydown");
    const domInput = createInput(input, targets);

    let caught: unknown;
    try {
      domInput.attach();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe("addEventListener failed for keyup");
    expect((aggregate.errors[1] as Error).message).toBe("removeEventListener failed for keydown");
    expect(domInput.attached).toBe(false);
  });

  it("reports cleanup failures from dispose while staying terminal", () => {
    const targets = createAdapters();
    const { input, keyTarget } = targets;
    const domInput = createInput(input, targets);
    domInput.attach();

    keyTarget.failRemovalOn("keydown");
    expect(() => domInput.dispose()).toThrow(AggregateError);
    // Terminal regardless: repeated dispose is a no-op and attach is rejected.
    expect(() => domInput.dispose()).not.toThrow();
    expect(() => domInput.attach()).toThrow(DomInputError);
    expect(domInput.attached).toBe(false);
  });

  it("leaves the caller-owned state fully usable after adapter disposal", () => {
    const targets = createAdapters();
    const { input, keyTarget, canvas } = targets;
    const domInput = createInput(input, targets);
    domInput.attach();
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyA" }));
    domInput.dispose();

    // The adapter owned only its listeners; the state stays usable.
    input.handleKeyDown("KeyB");
    expect(input.isKeyDown("KeyB")).toBe(true);
    expect(input.wasKeyPressed("KeyB")).toBe(true);
    input.endFrame();
    expect(input.wasKeyPressed("KeyB")).toBe(false);
    // And the disposed adapter's targets feed nothing.
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyC" }));
    canvas.dispatchEvent(new FakeDomEvent("pointerdown", { button: 0 }));
    expect(input.isKeyDown("KeyC")).toBe(false);
    expect(input.isButtonDown(0)).toBe(false);
  });

  it("retains listeners whose rollback failed so dispose can retry the removal", () => {
    const targets = createAdapters();
    const { input, keyTarget } = targets;
    keyTarget.failRegistrationOn("keyup");
    // keydown registered fine, then keyup threw; the keydown rollback
    // removal also throws, so the listener would be stranded without
    // retention.
    keyTarget.failRemovalOn("keydown");
    const domInput = createInput(input, targets);

    expect(() => domInput.attach()).toThrow(AggregateError);
    expect(domInput.attached).toBe(false);

    // Documented window: the stranded listener is still live until the
    // retry in dispose() succeeds.
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyQ" }));
    expect(input.isKeyDown("KeyQ")).toBe(true);

    // dispose() retries the failed removal and wins, leaving no live
    // listener behind (KeyQ above was pressed while it was still live).
    keyTarget.failRemovalOn("");
    expect(() => domInput.dispose()).not.toThrow();
    expect(keyTarget.removalCounts.get("keydown")).toBe(1);
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyR" }));
    expect(input.isKeyDown("KeyR")).toBe(false);
  });

  it("leaves no stale tracking when the first registration fails", () => {
    const targets = createAdapters();
    const { input, keyTarget } = targets;
    keyTarget.failRegistrationOn("keydown");
    const domInput = createInput(input, targets);

    let caught: unknown;
    try {
      domInput.attach();
    } catch (error) {
      caught = error;
    }
    // Nothing was registered, so this is the plain registration error —
    // not an aggregate — and there is nothing tracked or to roll back.
    expect(caught).not.toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toBe("addEventListener failed for keydown");
    expect(keyTarget.registrationCounts.size).toBe(0);
    expect(keyTarget.removalCounts.size).toBe(0);

    // Retry registers every listener exactly once.
    keyTarget.failRegistrationOn("");
    domInput.attach();
    expect(domInput.attached).toBe(true);
    expect(keyTarget.registrationCounts.get("keydown")).toBe(1);
    keyTarget.dispatchEvent(new FakeDomEvent("keydown", { code: "KeyD" }));
    expect(input.isKeyDown("KeyD")).toBe(true);
    domInput.dispose();
    expect(keyTarget.removalCounts.get("keydown")).toBe(1);
  });

  it("collects multiple removal failures from dispose into one aggregate", () => {
    const targets = createAdapters();
    const { input, keyTarget, blurTarget } = targets;
    const domInput = createInput(input, targets);
    domInput.attach();

    keyTarget.failRemovalOn("keydown");
    blurTarget.failRemovalOn("blur");
    let caught: unknown;
    try {
      domInput.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe("removeEventListener failed for keydown");
    expect((aggregate.errors[1] as Error).message).toBe("removeEventListener failed for blur");
    // Terminal regardless, and every remaining removal was still attempted.
    expect(() => domInput.dispose()).not.toThrow();
    expect(() => domInput.attach()).toThrow(DomInputError);
  });
});
