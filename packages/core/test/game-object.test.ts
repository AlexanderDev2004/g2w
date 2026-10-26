import {
  type GameObject,
  GameObjectCollection,
  SceneError,
  SceneManager,
  Sprite2D,
  Transform2D,
} from "@g2w/core";
import { describe, expect, it, vi } from "vitest";

/** A fake texture handle — core never inspects it. */
const fakeTexture = { id: "tex-1" };

interface Log {
  entries: string[];
  log(name: string): void;
}

function createLog(): Log {
  return {
    entries: [],
    log(name: string) {
      this.entries.push(name);
    },
  };
}

function namedObject(
  name: string,
  transform = new Transform2D(),
): {
  object: GameObject;
  calls: Log;
} {
  const calls = createLog();
  const object: GameObject = {
    transform,
    update(deltaTime) {
      calls.log(`${name}:update:${deltaTime}`);
    },
    destroy() {
      calls.log(`${name}:destroy`);
    },
  };
  return { object, calls };
}

describe("GameObjectCollection registration", () => {
  it("registers an object and reports its membership count", () => {
    const collection = new GameObjectCollection();
    const { object } = namedObject("a");

    expect(collection.size).toBe(0);
    collection.add(object);

    expect(collection.size).toBe(1);
  });

  it("rejects duplicate registration of the same object in the same collection", () => {
    const collection = new GameObjectCollection();
    const { object } = namedObject("a");
    collection.add(object);

    expect(() => collection.add(object)).toThrow(SceneError);
    expect(collection.size).toBe(1);
  });

  it("rejects registration of an object already registered in another collection", () => {
    const first = new GameObjectCollection();
    const second = new GameObjectCollection();
    const { object } = namedObject("a");
    first.add(object);

    expect(() => second.add(object)).toThrow(SceneError);
    expect(second.size).toBe(0);
    expect(first.size).toBe(1);
  });

  it("allows re-registration after removal: removal releases the claim", () => {
    const first = new GameObjectCollection();
    const second = new GameObjectCollection();
    const { object } = namedObject("a");
    first.add(object);
    first.remove(object);

    expect(() => second.add(object)).not.toThrow();
    expect(second.size).toBe(1);
  });

  it("rejects non-object values and objects without a Transform2D transform", () => {
    const collection = new GameObjectCollection();

    expect(() => collection.add(null as unknown as GameObject)).toThrow(SceneError);
    expect(() => collection.add(42 as unknown as GameObject)).toThrow(SceneError);
    expect(() => collection.add({ transform: { x: 0 } } as unknown as GameObject)).toThrow(
      SceneError,
    );
    expect(collection.size).toBe(0);
  });
});

describe("GameObjectCollection updates", () => {
  it("updates registered objects in insertion order with the forwarded deltaTime", () => {
    const collection = new GameObjectCollection();
    const a = namedObject("a");
    const b = namedObject("b");
    collection.add(a.object);
    collection.add(b.object);

    collection.update(0.5);

    expect(a.calls.entries).toEqual(["a:update:0.5"]);
    expect(b.calls.entries).toEqual(["b:update:0.5"]);
  });

  it("supports objects without an update hook and non-rendered objects", () => {
    const collection = new GameObjectCollection();
    // No sprite, no view, no visual at all — a pure logic object.
    const logicOnly: GameObject = {
      transform: new Transform2D(),
      update(deltaTime) {
        logicOnly.transform.x += deltaTime;
      },
    };
    const silent: GameObject = { transform: new Transform2D() };
    collection.add(logicOnly);
    collection.add(silent);

    expect(() => collection.update(1)).not.toThrow();
    expect(logicOnly.transform.x).toBe(1);
  });

  it("calls hooks with the object as `this`, matching the scene convention", () => {
    const collection = new GameObjectCollection();
    let seenThis: unknown = null;
    const object: GameObject = {
      transform: new Transform2D({ x: 7 }),
      update() {
        seenThis = this;
      },
    };
    collection.add(object);

    collection.update(0.1);

    expect(seenThis).toBe(object);
  });

  it("propagates hook errors unwrapped and keeps the collection consistent", () => {
    const collection = new GameObjectCollection();
    const failure = new Error("boom");
    const failing: GameObject = {
      transform: new Transform2D(),
      update() {
        throw failure;
      },
    };
    collection.add(failing);

    expect(() => collection.update(0.1)).toThrow(failure);
    // The collection still works afterwards for a repaired object set.
    failing.update = undefined;
    expect(() => collection.update(0.1)).not.toThrow();
  });

  it("rejects nested updates from inside an object hook", () => {
    const collection = new GameObjectCollection();
    const object: GameObject = {
      transform: new Transform2D(),
      update() {
        expect(() => collection.update(0.1)).toThrow(SceneError);
      },
    };
    collection.add(object);

    expect(() => collection.update(0.1)).not.toThrow();
  });
});

describe("GameObjectCollection mid-update mutations", () => {
  it("applies objects added during an update from the next update onward", () => {
    const collection = new GameObjectCollection();
    const late = namedObject("late");
    let spawned = false;
    const spawner: GameObject = {
      transform: new Transform2D(),
      update() {
        if (!spawned) {
          spawned = true;
          collection.add(late.object);
        }
      },
    };
    collection.add(spawner);

    collection.update(1);
    // Not updated in the frame that added it.
    expect(late.calls.entries).toEqual([]);

    collection.update(2);
    expect(late.calls.entries).toEqual(["late:update:2"]);
  });

  it("skips objects removed during an update for the rest of that update", () => {
    const collection = new GameObjectCollection();
    const a = namedObject("a");
    const b = namedObject("b");
    collection.add(a.object);
    collection.add(b.object);
    const remover: GameObject = {
      transform: new Transform2D(),
      update() {
        if (collection.size === 3) {
          collection.remove(b.object);
        }
      },
    };
    collection.add(remover);
    // Order: a, b, remover — b is removed after it already ran this frame.

    collection.update(1);

    expect(a.calls.entries).toEqual(["a:update:1"]);
    expect(b.calls.entries).toEqual(["b:update:1"]);
    expect(collection.size).toBe(2);

    // From the next update, b no longer updates.
    a.calls.entries.length = 0;
    b.calls.entries.length = 0;
    collection.update(2);
    expect(a.calls.entries).toEqual(["a:update:2"]);
    expect(b.calls.entries).toEqual([]);
  });

  it("skips an object removed before its turn in the same update", () => {
    const collection = new GameObjectCollection();
    const a = namedObject("a");
    const b = namedObject("b");
    // Order: a first, and a removes b before b's turn.
    const remover: GameObject = {
      transform: new Transform2D(),
      update() {
        collection.remove(b.object);
      },
    };
    collection.add(a.object);
    collection.add(b.object);
    collection.add(remover);
    // Rebuild the order as a, remover, b by re-registering.
    collection.remove(a.object);
    collection.remove(b.object);
    collection.remove(remover);
    collection.add(a.object);
    collection.add(remover);
    collection.add(b.object);

    collection.update(1);

    expect(a.calls.entries).toEqual(["a:update:1"]);
    expect(b.calls.entries).toEqual([]);
  });

  it("supports an object removing itself during its own update", () => {
    const collection = new GameObjectCollection();
    let updates = 0;
    const selfRemoving: GameObject = {
      transform: new Transform2D(),
      update() {
        updates += 1;
        collection.remove(selfRemoving);
      },
    };
    collection.add(selfRemoving);

    collection.update(1);
    collection.update(2);

    expect(updates).toBe(1);
    expect(collection.size).toBe(0);
  });
});

describe("GameObjectCollection removal", () => {
  it("removes without calling the destroy hook: the caller owns the object again", () => {
    const collection = new GameObjectCollection();
    const { object, calls } = namedObject("a");
    collection.add(object);

    collection.remove(object);

    expect(collection.size).toBe(0);
    expect(calls.entries).toEqual([]);
    expect(() => collection.update(1)).not.toThrow();
  });

  it("rejects removing an object that is not registered", () => {
    const collection = new GameObjectCollection();
    const { object } = namedObject("a");
    const other = namedObject("b");
    collection.add(other.object);

    expect(() => collection.remove(object)).toThrow(SceneError);
    expect(() => collection.remove(object)).toThrow(/not registered/);
  });
});

describe("GameObjectCollection destruction", () => {
  it("destroys every registered object exactly once in insertion order", () => {
    const collection = new GameObjectCollection();
    const a = namedObject("a");
    const b = namedObject("b");
    collection.add(a.object);
    collection.add(b.object);

    collection.destroy();

    expect(a.calls.entries).toEqual(["a:destroy"]);
    expect(b.calls.entries).toEqual(["b:destroy"]);
  });

  it("is idempotent and terminal: later operations throw SceneError", () => {
    const collection = new GameObjectCollection();
    const { object, calls } = namedObject("a");
    collection.add(object);

    collection.destroy();
    expect(() => collection.destroy()).not.toThrow();
    expect(calls.entries).toEqual(["a:destroy"]);

    expect(() => collection.add(object)).toThrow(/destroyed collection/);
    expect(() => collection.remove(object)).toThrow(/destroyed collection/);
    expect(() => collection.update(1)).toThrow(/destroyed collection/);
  });

  it("does not destroy objects removed before destruction", () => {
    const collection = new GameObjectCollection();
    const removed = namedObject("removed");
    const kept = namedObject("kept");
    collection.add(removed.object);
    collection.add(kept.object);
    collection.remove(removed.object);

    collection.destroy();

    expect(removed.calls.entries).toEqual([]);
    expect(kept.calls.entries).toEqual(["kept:destroy"]);
  });

  it("never registers a destroyed object again, in any collection", () => {
    const first = new GameObjectCollection();
    const second = new GameObjectCollection();
    const { object } = namedObject("a");
    first.add(object);
    first.destroy();

    expect(() => second.add(object)).toThrow(/destroyed game object/);
    expect(() => first.add(object)).toThrow(/destroyed collection|destroyed game object/);
    expect(second.size).toBe(0);
  });

  it("rethrows a single destroy-hook failure after all cleanups complete", () => {
    const collection = new GameObjectCollection();
    const failure = new Error("cleanup failed");
    const a = namedObject("a");
    const b = namedObject("b");
    (b.object.destroy as () => void) = () => {
      b.calls.log("b:destroy");
      throw failure;
    };
    collection.add(a.object);
    collection.add(b.object);

    expect(() => collection.destroy()).toThrow(failure);
    // Best-effort: a's cleanup still ran, and b's hook was attempted.
    expect(a.calls.entries).toEqual(["a:destroy"]);
    expect(b.calls.entries).toEqual(["b:destroy"]);
  });

  it("aggregates several destroy-hook failures as an AggregateError", () => {
    const collection = new GameObjectCollection();
    const first = new Error("first");
    const second = new Error("second");
    const a: GameObject = {
      transform: new Transform2D(),
      destroy() {
        throw first;
      },
    };
    const b: GameObject = {
      transform: new Transform2D(),
      destroy() {
        throw second;
      },
    };
    collection.add(a);
    collection.add(b);

    try {
      collection.destroy();
      expect.unreachable("destroy should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toEqual([first, second]);
    }
  });
});

describe("game object integration with scenes and sprites", () => {
  it("drives a collection from a scene: active scene updates, scene dispose destroys", () => {
    const collection = new GameObjectCollection();
    const a = namedObject("a");
    collection.add(a.object);

    const scenes = new SceneManager({
      scenes: {
        gameplay: {
          update(deltaTime) {
            collection.update(deltaTime);
          },
          dispose() {
            collection.destroy();
          },
        },
        other: {},
      },
      initial: "gameplay",
    });
    scenes.start();
    scenes.update(0.25);
    expect(a.calls.entries).toEqual(["a:update:0.25"]);

    // Only the active scene updates: switching away stops object updates.
    scenes.goTo("other");
    scenes.update(1);
    expect(a.calls.entries).toEqual(["a:update:0.25"]);

    // Disposal of the manager destroys the scene's owned objects.
    scenes.dispose();
    expect(a.calls.entries).toEqual(["a:update:0.25", "a:destroy"]);
  });

  it("drives a Sprite2D through a shared transform without touching the texture", () => {
    const collection = new GameObjectCollection();
    const sprite = new Sprite2D({ texture: fakeTexture });
    const object: GameObject = {
      transform: sprite.transform,
      update(deltaTime) {
        object.transform.x += 100 * deltaTime;
      },
      destroy() {
        sprite.visible = false;
      },
    };
    collection.add(object);

    collection.update(0.5);
    collection.update(0.5);

    expect(sprite.transform.x).toBe(100);
    // Core cleanup never touches the texture handle — the R1 policy.
    expect(fakeTexture).toEqual({ id: "tex-1" });
  });
});

describe("GameObjectCollection determinism helpers", () => {
  it("update calls objects exactly once per frame with vitest spies", () => {
    const collection = new GameObjectCollection();
    const update = vi.fn();
    collection.add({ transform: new Transform2D(), update });

    collection.update(1 / 60);
    collection.update(1 / 60);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 1 / 60);
    expect(update).toHaveBeenNthCalledWith(2, 1 / 60);
  });
});

describe("GameObjectCollection.objects() snapshot accessor", () => {
  it("returns a snapshot of registered objects in insertion order", () => {
    const collection = new GameObjectCollection();
    const a = { transform: new Transform2D() };
    const b = { transform: new Transform2D(), destroy() {} };
    collection.add(a);
    collection.add(b);

    const snapshot = collection.objects();

    expect(snapshot).toEqual([a, b]);
  });

  it("returns a fresh copy that does not track later collection changes", () => {
    const collection = new GameObjectCollection();
    const a = { transform: new Transform2D() };
    collection.add(a);
    const before = collection.objects();

    collection.remove(a);

    expect(before).toHaveLength(1); // earlier snapshot unchanged
    expect(collection.objects()).toHaveLength(0);
  });

  it("throws SceneError on a destroyed collection", () => {
    const collection = new GameObjectCollection();
    collection.destroy();

    expect(() => collection.objects()).toThrow(SceneError);
  });
});
