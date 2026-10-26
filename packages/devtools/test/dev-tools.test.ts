import { GameObjectCollection, InputState, type Scene, SceneManager, Transform2D } from "@g2w/core";
import { describe, expect, it } from "vitest";
import {
  createDevTools,
  DevTools,
  DevToolsError,
  type DevToolsScheduler,
  FrameStats,
  LogBuffer,
} from "../src/index.js";
import {
  summarizeInput,
  summarizeObjects,
  summarizeScenes,
  summarizeTransform,
} from "../src/snapshot.js";

/* ------------------------------------------------------------------ */
/* Deterministic fakes: a minimal DOM and a manual frame scheduler.    */
/* No real timers and no browser are used anywhere in this file.       */
/* ------------------------------------------------------------------ */

class FakeEvent {
  target: FakeElement;
  stopPropagation = (): void => {};
  preventDefault = (): void => {};
  constructor(target: FakeElement) {
    this.target = target;
  }
}

class FakeElement {
  readonly tag: string;
  readonly style: { cssText: string; display: string } = { cssText: "", display: "" };
  readonly dataset: Record<string, string> = {};
  textContent = "";
  disabled = false;
  title = "";
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly #listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(tag: string) {
    this.tag = tag;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index !== -1) {
        this.parent.children.splice(index, 1);
      }
      this.parent = null;
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children.length = 0;
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  dispatch(type: string, bubbles = true): void {
    const event = new FakeEvent(this);
    let element: FakeElement | null = this;
    // Minimal bubbling: listeners on ancestors also run, like real DOM events.
    while (element !== null) {
      for (const listener of element.#listeners.get(type) ?? []) {
        listener(event);
      }
      element = bubbles ? element.parent : null;
    }
  }

  /** Depth-first search for the first element whose text contains the given fragment. */
  find(text: string): FakeElement | null {
    if (this.textContent.includes(text)) {
      return this;
    }
    for (const child of this.children) {
      const found = child.find(text);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

/** Manual frame scheduler: tests fire frames at explicit times. */
class FakeScheduler implements DevToolsScheduler {
  #callback: ((timeMs: number) => void) | null = null;
  #handle = 0;
  canceled = 0;

  requestFrame(callback: (timeMs: number) => void): unknown {
    this.#callback = callback;
    this.#handle += 1;
    return this.#handle;
  }

  cancelFrame(): void {
    this.canceled += 1;
    this.#callback = null;
  }

  /** Fires the pending frame at the given time, if one is scheduled. */
  fire(timeMs: number): void {
    const callback = this.#callback;
    this.#callback = null;
    callback?.(timeMs);
  }
}

/* ------------------------------- helpers ------------------------------- */

const emptyScene = (name: string): Scene & { name: string } => ({
  name,
  init(): void {},
  enter(): void {},
  update(): void {},
  exit(): void {},
  dispose(): void {},
});

function createScenes(): SceneManager {
  return new SceneManager({
    scenes: { menu: emptyScene("menu"), gameplay: emptyScene("gameplay") },
    initial: "menu",
  });
}

/* ------------------------------- snapshot ------------------------------ */

describe("devtools snapshots (public APIs only)", () => {
  it("summarizes scenes from the SceneManager public surface", () => {
    const scenes = createScenes();
    const summary = summarizeScenes(scenes);

    expect(summary.names).toEqual(["menu", "gameplay"]);
    expect(summary.active).toBe(null);
    scenes.start();
    expect(summarizeScenes(scenes).active).toBe("menu");
  });

  it("copies the five public transform properties", () => {
    const transform = new Transform2D({ x: 10, y: -4, rotation: 0.5, scaleX: 2, scaleY: 3 });
    expect(summarizeTransform(transform)).toEqual({
      x: 10,
      y: -4,
      rotation: 0.5,
      scaleX: 2,
      scaleY: 3,
    });
  });

  it("summarizes objects with positional labels and hook flags", () => {
    const a = { transform: new Transform2D({ x: 1 }) };
    const b = { transform: new Transform2D({ x: 2 }), update() {}, destroy() {} };
    const summaries = summarizeObjects([a, b]);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.label).toBe("#0");
    expect(summaries[0]?.hasUpdate).toBe(false);
    expect(summaries[1]?.label).toBe("#1");
    expect(summaries[1]?.hasUpdate).toBe(true);
    expect(summaries[1]?.hasDestroy).toBe(true);
  });

  it("reports pointer position only when the input state has one", () => {
    const input = new InputState();
    const watch = { keys: ["KeyW"], buttons: [0] };

    const withoutPointer = summarizeInput(input, watch);
    expect(withoutPointer.hasPointerPosition).toBe(false);
    expect(withoutPointer.pointerX).toBe(null);

    input.handlePointerMove(12, 34);
    input.handleKeyDown("KeyW");
    input.handleButtonDown(0);
    const withPointer = summarizeInput(input, watch);
    expect(withPointer.pointerX).toBe(12);
    expect(withPointer.pointerY).toBe(34);
    expect(withPointer.keys).toEqual({ KeyW: true });
    expect(withPointer.buttons).toEqual({ 0: true });
  });
});

/* ------------------------------ log buffer ----------------------------- */

describe("LogBuffer", () => {
  it("appends entries with increasing sequence numbers", () => {
    const buffer = new LogBuffer(10);
    buffer.log("info", "one");
    buffer.log("error", "two");

    const entries = buffer.entries();
    expect(entries.map((entry) => entry.message)).toEqual(["one", "two"]);
    expect(entries[0]?.seq).toBeLessThan(entries[1]?.seq ?? 0);
    expect(buffer.size).toBe(2);
  });

  it("drops the oldest entries when the limit is reached", () => {
    const buffer = new LogBuffer(3);
    for (const message of ["a", "b", "c", "d", "e"]) {
      buffer.log("info", message);
    }
    expect(buffer.size).toBe(3);
    expect(buffer.entries().map((entry) => entry.message)).toEqual(["c", "d", "e"]);
  });

  it("filters by severity at read time without deleting entries", () => {
    const buffer = new LogBuffer(10);
    buffer.log("info", "i");
    buffer.log("warn", "w");
    buffer.log("error", "e");

    const filtered = buffer.entries(new Set(["warn", "error"]));
    expect(filtered.map((entry) => entry.message)).toEqual(["w", "e"]);
    expect(buffer.size).toBe(3);
  });

  it("clears but keeps the sequence counter increasing", () => {
    const buffer = new LogBuffer(10);
    buffer.log("info", "first");
    const firstSeq = buffer.entries()[0]?.seq;
    buffer.clear();
    expect(buffer.size).toBe(0);
    buffer.log("info", "second");
    expect(buffer.entries()[0]?.seq).toBeGreaterThan(firstSeq ?? 0);
  });

  it("rejects a non-positive limit", () => {
    expect(() => new LogBuffer(0)).toThrow(RangeError);
  });
});

/* ------------------------------ frame stats ---------------------------- */

describe("FrameStats", () => {
  it("returns null fps until two samples exist and averages a steady window", () => {
    const stats = new FrameStats();
    expect(stats.fps).toBe(null);

    stats.push(1 / 60);
    expect(stats.fps).toBe(null);
    stats.push(1 / 60);
    expect(stats.fps).toBeCloseTo(60, 5);
  });

  it("reports the average frame time in milliseconds", () => {
    const stats = new FrameStats();
    stats.push(1 / 60);
    stats.push(3 / 60);
    expect(stats.frameMs).toBeCloseTo(((1 / 60 + 3 / 60) / 2) * 1000, 5);
  });

  it("keeps a bounded window regardless of session length", () => {
    const stats = new FrameStats(4);
    for (let i = 0; i < 100; i++) {
      stats.push(1 / 60);
    }
    expect(stats.samples).toBe(4);
  });

  it("rejects a non-positive capacity and supports clear", () => {
    expect(() => new FrameStats(0)).toThrow(RangeError);
    const stats = new FrameStats();
    stats.push(1 / 60);
    stats.clear();
    expect(stats.samples).toBe(0);
  });
});

/* ------------------------------- DevTools ------------------------------ */

describe("DevTools lifecycle", () => {
  it("is optional: constructing with no sources is valid and panels say so", () => {
    const doc = new FakeDocument();
    const devtools = createDevTools({
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();

    expect(devtools.isOpen).toBe(true);
    expect(doc.body.find("scenes: not connected") !== null).toBe(true);
    expect(doc.body.find("input: not connected") !== null).toBe(true);
  });

  it("open builds the overlay into the document body; close removes it", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const devtools = new DevTools({ document: doc as unknown as Document, scheduler });
    devtools.open();

    expect(doc.body.children).toHaveLength(1);
    expect(scheduler.canceled).toBe(0);

    devtools.close();
    expect(devtools.isOpen).toBe(false);
    expect(doc.body.children).toHaveLength(0);
    expect(scheduler.canceled).toBe(1);
  });

  it("toggle switches between open and closed", () => {
    const devtools = new DevTools({
      document: new FakeDocument() as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    expect(devtools.isOpen).toBe(false);
    devtools.toggle();
    expect(devtools.isOpen).toBe(true);
    devtools.toggle();
    expect(devtools.isOpen).toBe(false);
  });

  it("dispose removes the overlay, cancels the frame loop, clears logs, and is idempotent", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const devtools = new DevTools({ document: doc as unknown as Document, scheduler });
    devtools.open();
    devtools.log("info", "note");
    devtools.dispose();

    expect(devtools.disposed).toBe(true);
    expect(doc.body.children).toHaveLength(0);
    expect(scheduler.canceled).toBe(1);
    expect(devtools.logs).toHaveLength(0);

    devtools.dispose();
    expect(devtools.disposed).toBe(true);
  });

  it("rejects operations after disposal", () => {
    const devtools = new DevTools({
      document: new FakeDocument() as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.dispose();

    expect(() => devtools.open()).toThrow(DevToolsError);
    expect(() => devtools.log("info", "late")).toThrow(DevToolsError);
    expect(() => devtools.toggle()).toThrow(DevToolsError);
  });

  it("disposal never disposes the connected runtime sources", () => {
    const scenes = createScenes();
    scenes.start();
    const devtools = new DevTools({
      scenes,
      document: new FakeDocument() as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    devtools.dispose();

    // The SceneManager still works: transitions and disposal remain the app's.
    scenes.goTo("gameplay");
    expect(scenes.active).toBe("gameplay");
    scenes.dispose();
    expect(scenes.active).toBe(null);
  });
});

describe("DevTools panels", () => {
  it("logs scene transitions detected while polling the SceneManager", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const scenes = createScenes();
    scenes.start();
    const devtools = new DevTools({ scenes, document: doc as unknown as Document, scheduler });
    devtools.open();
    expect(devtools.logs.some((entry) => entry.message.includes("→ menu"))).toBe(true);

    scenes.goTo("gameplay");
    devtools.refreshPanels();

    const transition = devtools.logs.find((entry) => entry.message.includes("menu → gameplay"));
    expect(transition?.level).toBe("info");
    expect(doc.body.find("active: gameplay") !== null).toBe(true);
  });

  it("lists game objects from the collection snapshot and selects rows read-only", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const objectA = { transform: new Transform2D({ x: 11, y: 22 }) };
    const objectB = { transform: new Transform2D({ x: 33, y: 44 }), update() {} };
    const collection = new GameObjectCollection();
    collection.add(objectA);
    collection.add(objectB);

    const devtools = new DevTools({
      objects: collection,
      document: doc as unknown as Document,
      scheduler,
    });
    devtools.open();

    expect(doc.body.find("#0 pos(11.0, 22.0)") !== null).toBe(true);
    expect(doc.body.find("#1 pos(33.0, 44.0)") !== null).toBe(true);

    // Selecting an object shows its live transform and never mutates it.
    const row = doc.body.find("#1 pos(33.0, 44.0)");
    row?.dispatch("click");
    expect(doc.body.find("transform 1 — x: 33.0 y: 44.0") !== null).toBe(true);
    expect(objectB.transform.x).toBe(33);
  });

  it("clears the selection when the selected object is removed", () => {
    const doc = new FakeDocument();
    const collection = new GameObjectCollection();
    const objectA = { transform: new Transform2D() };
    const objectB = { transform: new Transform2D() };
    collection.add(objectA);
    collection.add(objectB);
    const devtools = new DevTools({
      objects: collection,
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    devtools.select(1);
    expect(doc.body.find("transform 1") !== null).toBe(true);

    collection.remove(objectB);
    devtools.refreshPanels();

    expect(doc.body.find("no object selected") !== null).toBe(true);
  });

  it("treats a non-integer or negative selection index as no selection", () => {
    const doc = new FakeDocument();
    const collection = new GameObjectCollection();
    collection.add({ transform: new Transform2D() });
    const devtools = new DevTools({
      objects: collection,
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    devtools.select(Number.NaN);
    expect(doc.body.find("transform: no object selected") !== null).toBe(true);
    devtools.select(-1);
    expect(doc.body.find("transform: no object selected") !== null).toBe(true);
    devtools.select(1.5);
    expect(doc.body.find("transform: no object selected") !== null).toBe(true);

    devtools.select(0);
    expect(doc.body.find("transform 0") !== null).toBe(true);
  });

  it("shows the watched input state, including held keys", () => {
    const doc = new FakeDocument();
    const input = new InputState();
    const devtools = new DevTools({
      input,
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    expect(doc.body.find("keys held: (none)") !== null).toBe(true);

    input.handleKeyDown("KeyW");
    input.handlePointerMove(100, 50);
    devtools.refreshPanels();

    expect(doc.body.find("keys held: KeyW") !== null).toBe(true);
    expect(doc.body.find("pointer: 100, 50") !== null).toBe(true);
  });

  it("computes fps from the overlay's own frame loop and reports game deltaTime as unsupported", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const devtools = new DevTools({
      document: doc as unknown as Document,
      scheduler,
      refreshHz: 1000,
    });
    devtools.open();

    // First frame only records the timestamp; later frames accumulate deltas.
    scheduler.fire(0);
    for (let i = 1; i <= 60; i++) {
      scheduler.fire(i * 16);
    }

    // The window is 60 frames of ~16 ms; assert the stable frame time and a
    // plausible fps (floating-point drift makes the exact digit unstable).
    expect(doc.body.find("frame: 16.0 ms") !== null).toBe(true);
    expect(/fps: 6[23]/.test(doc.body.find("fps:")?.textContent ?? "")).toBe(true);
    expect(doc.body.find("game deltaTime: unsupported") !== null).toBe(true);
  });

  it("filters runtime logs by severity through the toggle buttons", () => {
    const doc = new FakeDocument();
    const devtools = new DevTools({
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    devtools.log("info", "the info");
    devtools.log("warn", "the warn");
    devtools.log("error", "the error");

    expect(doc.body.find("[0] info: the info") !== null).toBe(true);
    expect(doc.body.find("[2] error: the error") !== null).toBe(true);

    const warnToggle = doc.body.find("warn");
    warnToggle?.dispatch("click");
    expect(doc.body.find("[1] warn: the warn")).toBe(null);
    expect(doc.body.find("[0] info: the info") !== null).toBe(true);

    warnToggle?.dispatch("click");
    expect(doc.body.find("[1] warn: the warn") !== null).toBe(true);
  });

  it("drops the oldest log entries when the bounded buffer is full", () => {
    const doc = new FakeDocument();
    const devtools = new DevTools({
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
      logLimit: 3,
    });
    devtools.open();
    for (const message of ["a", "b", "c", "d"]) {
      devtools.log("info", message);
    }
    expect(devtools.logs.map((entry) => entry.message)).toEqual(["b", "c", "d"]);
  });

  it("renders the disabled 3D Coming Soon control", () => {
    const doc = new FakeDocument();
    const devtools = new DevTools({
      document: doc as unknown as Document,
      scheduler: new FakeScheduler(),
    });
    devtools.open();
    const button = doc.body.find("3D — Coming Soon");
    expect(button !== null).toBe(true);
    expect(button?.disabled).toBe(true);
  });

  it("stops the overlay frame loop when closed and ignores late frames", () => {
    const doc = new FakeDocument();
    const scheduler = new FakeScheduler();
    const devtools = new DevTools({ document: doc as unknown as Document, scheduler });
    devtools.open();
    devtools.close();
    // A late frame after close must not reschedule or crash.
    scheduler.fire(100);
    expect(devtools.isOpen).toBe(false);
    expect(scheduler.canceled).toBe(1);
  });
});
