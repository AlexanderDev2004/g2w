import { AssetError } from "./asset-error.js";

/**
 * Loads one asset for a cache key. Supplied by the caller (or a renderer
 * adapter); the manager never interprets keys itself. Loaders may reject —
 * the error is propagated to the caller unchanged and the failed key becomes
 * retryable.
 */
export type AssetLoader<T> = (key: string) => Promise<T>;

/** Options for constructing an {@link AssetManager}. */
export interface AssetManagerOptions<T> {
  /** The loader used for every cache miss. */
  readonly load: AssetLoader<T>;
  /**
   * Disposes one loaded value. Optional:
   * - **Provided** — the manager *owns* its resources: `dispose()` destroys
   *   every cached value exactly once (values shared between keys, or between
   *   managers, are only destroyed on their first cleanup).
   * - **Omitted** — the manager merely *caches caller-owned values*:
   *   `dispose()` clears the cache and never touches the values.
   */
  readonly disposeAsset?: (asset: T) => void;
}

/**
 * A minimal, renderer-agnostic asset cache. Keys are opaque strings; values
 * are whatever the injected loader returns.
 *
 * ```ts
 * const textures = new AssetManager<Texture>({
 *   load: (url) => pixiAssetsLoad(url),
 *   disposeAsset: (texture) => texture.destroy(true),
 * });
 * const logo = await textures.load("logo.png");
 * ```
 *
 * Semantics (all covered by tests in `packages/core/test/asset-manager.test.ts`):
 * - **Caching:** the first `load(key)` invokes the loader; every later request
 *   for the same key returns the same promise — and therefore the same value —
 *   without invoking the loader again. Different keys load independently.
 * - **Concurrent requests deduplicate:** requests made while a load is in
 *   flight share that one load.
 * - **Failure is retryable:** a rejected load removes its cache entry without
 *   poisoning it, so a later `load(key)` invokes the loader again. Loader
 *   errors are never wrapped; concurrent requesters of the failing key all
 *   observe the same rejection.
 * - **Disposal is terminal and idempotent:** repeated `dispose()` calls return
 *   the first disposal's promise. `load` on a disposed manager throws
 *   {@link AssetError} immediately, even while a disposal is still in flight.
 * - **In-flight loads during disposal** still settle for their callers (the
 *   caller's promise is not altered), but after `dispose()` resolves every
 *   owned value has been cleaned up: values that fulfilled after disposal was
 *   requested are disposed and never enter the cache. Callers of such loads
 *   receive a disposed value and must not use it.
 * - **Cleanup is best-effort:** one disposer failure does not prevent the
 *   remaining cleanups; the first error is rethrown as-is, or as an
 *   `AggregateError` when several fail, after all attempts complete. The
 *   disposer runs at most once per distinct value (identity for objects), so
 *   shared resources are never destroyed twice.
 *
 * Intentionally unsupported: automatic unloading on scene transitions,
 * reference counting, and resource dependency graphs. The caller owns the
 * manager, decides when it lives and dies, and passes it to scenes explicitly.
 */
export class AssetManager<T> {
  readonly #load: AssetLoader<T>;
  readonly #disposeAsset: ((asset: T) => void) | null;
  /** Settled and in-flight loads by key; cleared on failure and disposal. */
  readonly #entries = new Map<string, Promise<T>>();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: AssetManagerOptions<T>) {
    if (typeof options.load !== "function") {
      throw new AssetError("AssetManager requires a load function.");
    }
    if (options.disposeAsset !== undefined && typeof options.disposeAsset !== "function") {
      throw new AssetError("AssetManager disposeAsset must be a function when provided.");
    }
    this.#load = options.load;
    this.#disposeAsset = options.disposeAsset ?? null;
  }

  /** Whether the manager has been disposed (terminal). */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Load the asset for `key`, from the cache when possible. Throws
   * {@link AssetError} synchronously for a disposed manager or an empty or
   * non-string key; loader errors propagate through the returned promise
   * unchanged.
   */
  load(key: string): Promise<T> {
    if (this.#disposed) {
      throw new AssetError("Cannot load assets from a disposed asset manager.");
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new AssetError("Asset keys must be non-empty strings.");
    }
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let entry: Promise<T>;
    entry = this.#load(key).then(undefined, (error: unknown) => {
      // A failed load must not poison the cache: drop the entry so a later
      // request retries. Only this entry's own failure may remove it.
      if (this.#entries.get(key) === entry) {
        this.#entries.delete(key);
      }
      throw error;
    });
    this.#entries.set(key, entry);
    return entry;
  }

  /**
   * Dispose the manager. Terminal and idempotent: repeated calls return the
   * first disposal's promise. New loads are rejected immediately; in-flight
   * loads still settle for their callers, and once this promise resolves
   * every owned value has been disposed exactly once. Best-effort: the first
   * disposer error is rethrown as-is, or as an `AggregateError` when several
   * fail, after all cleanup attempts complete.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    this.#disposed = true;
    this.#disposePromise = this.#runDispose();
    return this.#disposePromise;
  }

  async #runDispose(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    const disposeAsset = this.#disposeAsset;
    if (disposeAsset === null) {
      // Caller-owned values: the manager only held references.
      return;
    }
    // In-flight loads settle inside the disposal, so nothing is destroyed
    // before its loader finished and nothing outlives the disposal.
    const settled = await Promise.allSettled(entries);
    // One disposer run per distinct value: two keys resolving to the same
    // object (a shared resource) must not destroy it twice.
    const disposed = new Set<unknown>();
    const errors: unknown[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") {
        continue; // A rejected load has no resource to release.
      }
      const asset = result.value;
      if (disposed.has(asset)) {
        continue;
      }
      disposed.add(asset);
      try {
        disposeAsset(asset);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more assets failed to clean up during disposal.");
    }
  }
}
