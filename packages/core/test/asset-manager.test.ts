import { AssetError, AssetManager, type AssetManagerOptions } from "@g2w/core";
import { describe, expect, it, vi } from "vitest";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeAsset {
  id: string;
  destroyed: number;
}

function fakeAsset(id: string): FakeAsset {
  return { id, destroyed: 0 };
}

function ownedManager(load: (key: string) => Promise<FakeAsset>): {
  manager: AssetManager<FakeAsset>;
  destroyed: FakeAsset[];
} {
  const destroyed: FakeAsset[] = [];
  const manager = new AssetManager<FakeAsset>({
    load,
    disposeAsset: (asset) => {
      asset.destroyed += 1;
      destroyed.push(asset);
    },
  });
  return { manager, destroyed };
}

describe("AssetManager caching and concurrency", () => {
  it("invokes the loader once for the first request and caches the value", async () => {
    const load = vi.fn(async (key: string) => fakeAsset(key));
    const manager = new AssetManager<FakeAsset>({ load });

    const asset = await manager.load("a");

    expect(asset.id).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);

    await expect(manager.load("a")).resolves.toBe(asset);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load between concurrent requests for the same key", async () => {
    const pending = deferred<FakeAsset>();
    const load = vi.fn(() => pending.promise);
    const manager = new AssetManager<FakeAsset>({ load });

    const first = manager.load("a");
    const second = manager.load("a");
    expect(load).toHaveBeenCalledTimes(1);
    // Concurrent requesters literally share the same promise.
    expect(second).toBe(first);

    const asset = fakeAsset("a");
    pending.resolve(asset);
    await expect(first).resolves.toBe(asset);
    await expect(second).resolves.toBe(asset);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads different keys independently", async () => {
    const load = vi.fn(async (key: string) => fakeAsset(key));
    const manager = new AssetManager<FakeAsset>({ load });

    const a = await manager.load("a");
    const b = await manager.load("b");

    expect(a.id).toBe("a");
    expect(b.id).toBe("b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache rejected loads, so a later request retries", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network down");
      }
      return fakeAsset("recovered");
    });
    const manager = new AssetManager<FakeAsset>({ load });

    const firstError = await manager.load("a").then(
      () => null,
      (error: unknown) => error,
    );
    // The error is the loader's own, never wrapped.
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe("network down");
    await expect(manager.load("a")).resolves.toHaveProperty("id", "recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("delivers the same rejection to every concurrent requester and still allows retry", async () => {
    const pending = deferred<FakeAsset>();
    const load = vi.fn(() => pending.promise);
    const manager = new AssetManager<FakeAsset>({ load });

    const first = manager.load("a");
    const second = manager.load("a");
    const failure = new Error("boom");
    pending.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    const loadRetry = vi.fn(async () => fakeAsset("ok"));
    const retrying = new AssetManager<FakeAsset>({ load: loadRetry });
    await expect(retrying.load("a")).resolves.toHaveProperty("id", "ok");
  });

  it("rejects an empty or non-string key with an AssetError", () => {
    const manager = new AssetManager<FakeAsset>({ load: async () => fakeAsset("x") });

    expect(() => manager.load("")).toThrow(AssetError);
    expect(() => manager.load(42 as unknown as string)).toThrow(AssetError);
  });

  it("rejects invalid constructor options with an AssetError", () => {
    expect(
      () => new AssetManager<FakeAsset>({ load: undefined as unknown as () => Promise<FakeAsset> }),
    ).toThrow(AssetError);
    expect(
      () =>
        new AssetManager<FakeAsset>({
          load: async () => fakeAsset("x"),
          disposeAsset: "nope" as unknown as (asset: FakeAsset) => void,
        }),
    ).toThrow(AssetError);
  });
});

describe("AssetManager disposal", () => {
  it("rejects new loads after disposal, even while disposal is in flight", async () => {
    const pending = deferred<FakeAsset>();
    const { manager } = ownedManager(() => pending.promise);
    const inFlight = manager.load("a");

    const disposal = manager.dispose();
    expect(manager.disposed).toBe(true);
    expect(() => manager.load("b")).toThrow(AssetError);

    pending.resolve(fakeAsset("a"));
    await inFlight;
    await disposal;
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it("disposes each owned cached value exactly once", async () => {
    const load = vi.fn(async (key: string) => fakeAsset(key));
    const { manager, destroyed } = ownedManager(load);
    const a = await manager.load("a");
    const b = await manager.load("b");

    await manager.dispose();

    expect(a.destroyed).toBe(1);
    expect(b.destroyed).toBe(1);
    expect(destroyed).toEqual([a, b]);
  });

  it("disposes a value shared by two keys at most once", async () => {
    const shared = fakeAsset("shared");
    const load = vi.fn(async () => shared);
    const { manager, destroyed } = ownedManager(load);
    await manager.load("a");
    await manager.load("b");

    await manager.dispose();

    expect(shared.destroyed).toBe(1);
    expect(destroyed).toEqual([shared]);
  });

  it("never disposes caller-owned values when no disposer is supplied", async () => {
    const asset = fakeAsset("caller-owned");
    const manager = new AssetManager<FakeAsset>({ load: async () => asset });
    await manager.load("a");

    await expect(manager.dispose()).resolves.toBeUndefined();

    expect(asset.destroyed).toBe(0);
  });

  it("cleans up in-flight loads during disposal and does not cache their values", async () => {
    const pending = deferred<FakeAsset>();
    const { manager, destroyed } = ownedManager(() => pending.promise);
    const inFlight = manager.load("a");

    const disposal = manager.dispose();
    const asset = fakeAsset("late");
    pending.resolve(asset);

    // The caller's promise still settles normally...
    await expect(inFlight).resolves.toBe(asset);
    // ...but the disposal only completes once the in-flight load settled and
    // its owned value was cleaned up.
    await disposal;

    expect(asset.destroyed).toBe(1);
    expect(destroyed).toEqual([asset]);
  });

  it("lets rejected in-flight loads pass through disposal without cleanup attempts", async () => {
    const pending = deferred<FakeAsset>();
    const { manager, destroyed } = ownedManager(() => pending.promise);
    const inFlight = manager.load("a");

    const disposal = manager.dispose();
    pending.reject(new Error("aborted"));

    await expect(inFlight).rejects.toThrow("aborted");
    await expect(disposal).resolves.toBeUndefined();
    expect(destroyed).toEqual([]);
  });

  it("rethrows the first disposer failure but still runs the remaining cleanups", async () => {
    const load = vi.fn(async (key: string) => fakeAsset(key));
    const destroyed: string[] = [];
    const manager = new AssetManager<FakeAsset>({
      load,
      disposeAsset: (asset) => {
        destroyed.push(asset.id);
        if (asset.id === "a") {
          throw new Error("cleanup failed");
        }
      },
    });
    await manager.load("a");
    await manager.load("b");

    await expect(manager.dispose()).rejects.toThrow("cleanup failed");
    expect(destroyed).toEqual(["a", "b"]);
  });

  it("surfaces multiple disposer failures as one AggregateError after all attempts", async () => {
    const failureA = new Error("cleanup A failed");
    const failureB = new Error("cleanup B failed");
    const manager = new AssetManager<FakeAsset>({
      load: async (key) => fakeAsset(key),
      disposeAsset: (asset) => {
        if (asset.id === "a") throw failureA;
        if (asset.id === "b") throw failureB;
      },
    });
    await manager.load("a");
    await manager.load("b");

    const disposal = manager.dispose();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(disposal).rejects.toMatchObject({ errors: [failureA, failureB] });
  });

  it("is idempotent: repeated disposal returns the first promise and re-runs nothing", async () => {
    const load = vi.fn(async (key: string) => fakeAsset(key));
    const { manager, destroyed } = ownedManager(load);
    const asset = await manager.load("a");

    const first = manager.dispose();
    const second = manager.dispose();
    expect(second).toBe(first);
    await first;
    await second;

    expect(asset.destroyed).toBe(1);
    expect(destroyed).toEqual([asset]);
  });
});

describe("AssetManager composition", () => {
  it("accepts a typed loader contract without constraining the value type", async () => {
    // A caller-owned manager of a plain value type: the API is generic and
    // never assumes resources.
    const strings = new AssetManager<string>({ load: async (key) => key.toUpperCase() });
    await expect(strings.load("abc")).resolves.toBe("ABC");
    await expect(strings.load("abc")).resolves.toBe("ABC");
    await expect(strings.dispose()).resolves.toBeUndefined();
  });

  it("keeps the options object readonly-friendly", async () => {
    const options: AssetManagerOptions<FakeAsset> = {
      load: async (key) => fakeAsset(key),
      disposeAsset: (asset) => {
        asset.destroyed += 1;
      },
    };
    const manager = new AssetManager<FakeAsset>(options);
    await expect(manager.load("k")).resolves.toHaveProperty("id", "k");
    await manager.dispose();
  });
});
