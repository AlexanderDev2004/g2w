import { InputState } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { DomInput, DomInputError } from "../src/index.js";

/** A minimal DOM event carrying only the fields the adapter reads. */
class FakeDomEvent extends Event {
  constructor(
    type: string,
    fields: { code?: string; button?: number; clientX?: number; clientY?: number } = {},
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
