import { type Effect, Layer, ManagedRuntime } from "effect";
import { RuntimeBootstrapError, RuntimeCleanupFailure, RuntimeShutdownError } from "./errors.js";

/**
 * A cleanup callback registered on a G2W runtime. It runs once during
 * `shutdown()`, after all other registered finalizers that were registered
 * before it. May be synchronous or return a promise.
 */
export type G2WFinalizer = () => void | Promise<void>;

/** Options for {@link createG2WRuntime}. */
export interface G2WRuntimeOptions<R = never, E = never> {
  /**
   * Application layers whose services the bootstrap owns for the lifetime of
   * the runtime. The bootstrap builds the layer eagerly, so a layer that
   * fails to build reports through {@link createG2WRuntime} itself, and
   * resources already acquired by a partially failing layer are released
   * before the failure is reported. Omit to bootstrap with no services.
   */
  readonly layer?: Layer.Layer<R, E, never> | undefined;
}

/**
 * The official G2W runtime handle: a managed Effect runtime the facade owns,
 * plus a managed lifecycle scope with explicit, idempotent shutdown.
 *
 * Ordinary game developers only need `createG2WRuntime`, `run`, and
 * `shutdown`. Advanced users compose Effect programs and layers through the
 * same surface instead of touching the underlying Effect runtime directly.
 */
export interface G2WRuntime<R> {
  /**
   * Run an Effect program against the services owned by this runtime.
   * Throws {@link RuntimeShutdownError} if the runtime has already shut
   * down. No Effect runtime is ever allocated per call: every `run` reuses
   * the single managed runtime created at bootstrap.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>;

  /**
   * Register a cleanup callback executed exactly once during `shutdown()`.
   * Finalizers run in reverse registration order (last registered runs
   * first). Throws {@link RuntimeShutdownError} after shutdown. Every
   * registered finalizer is attempted even if an earlier one fails, and
   * each failure stays observable through {@link RuntimeShutdownError}.
   */
  readonly addFinalizer: (finalizer: G2WFinalizer) => void;

  /**
   * Shut the runtime down: run every registered finalizer, then release the
   * layer resources the bootstrap owns. Idempotent — repeated and concurrent
   * calls share the same shutdown and never execute cleanup twice. If any
   * cleanup step fails, the remaining steps still run and the promise
   * rejects with {@link RuntimeShutdownError} carrying every failure.
   */
  readonly shutdown: () => Promise<void>;

  /** Whether shutdown has started (or completed) for this runtime. */
  readonly disposed: boolean;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const bootstrapFromLayer = async <R, E>(
  layer: Layer.Layer<R, E, never>,
): Promise<G2WRuntime<R>> => {
  const managed = ManagedRuntime.make(layer);

  try {
    // Build the layer eagerly so bootstrap failures surface here, at
    // bootstrap time, instead of silently on the first `run` call.
    await managed.context();
  } catch (error) {
    // Best-effort rollback: release resources the partially built layer
    // already acquired. A secondary disposal failure cannot hide the
    // bootstrap error, which is the meaningful failure here.
    try {
      await managed.dispose();
    } catch {
      // The original bootstrap failure is reported below.
    }
    throw new RuntimeBootstrapError({
      message: "The G2W runtime bootstrap failed while building its layers.",
      cause: error,
    });
  }

  const finalizers: G2WFinalizer[] = [];
  let shutdownPromise: Promise<void> | undefined;
  let shutdownStarted = false;

  return {
    run: <A, E>(effect: Effect.Effect<A, E, R>) => {
      if (shutdownStarted) {
        throw new RuntimeShutdownError({
          message: "Cannot run a program after the G2W runtime has shut down.",
          failures: [],
        });
      }
      return managed.runPromise(effect);
    },
    addFinalizer: (finalizer) => {
      if (shutdownStarted) {
        throw new RuntimeShutdownError({
          message: "Cannot register a finalizer after the G2W runtime has shut down.",
          failures: [],
        });
      }
      finalizers.push(finalizer);
    },
    get disposed(): boolean {
      return shutdownStarted;
    },
    shutdown: () => {
      if (shutdownPromise === undefined) {
        // Mark shutdown as started and publish the promise synchronously
        // before any cleanup runs, so a finalizer that reenters shutdown()
        // shares this shutdown instead of starting a second cleanup pass,
        // and reentrant run()/addFinalizer() calls are rejected. Cleanup
        // itself starts on the next microtask.
        shutdownStarted = true;
        shutdownPromise = Promise.resolve().then(() => runShutdown(managed, finalizers));
      }
      return shutdownPromise;
    },
  };
};

const runShutdown = async <R, E>(
  managed: ManagedRuntime.ManagedRuntime<R, E>,
  finalizers: G2WFinalizer[],
): Promise<void> => {
  const failures: RuntimeCleanupFailure[] = [];

  // Finalizers run in reverse registration order (LIFO), mirroring
  // acquire/release: the last resource acquired is released first. Every
  // finalizer is attempted even after a failure, so cleanup never stops
  // early and every failure stays observable.
  for (let index = finalizers.length - 1; index >= 0; index--) {
    const finalizer = finalizers[index];
    if (finalizer === undefined) {
      continue;
    }
    try {
      await finalizer();
    } catch (error) {
      failures.push(
        new RuntimeCleanupFailure({
          message: describeError(error),
          cause: error,
        }),
      );
    }
  }
  finalizers.length = 0;

  try {
    // Layer-internal finalizer defects surface here: Effect's Scope.close
    // typed as never-failing still rejects ManagedRuntime disposal with any
    // defect a layer finalizer raises. Capture it as an observable cleanup
    // failure instead of letting it hide the rest of the shutdown result.
    await managed.dispose();
  } catch (error) {
    failures.push(
      new RuntimeCleanupFailure({
        message: describeError(error),
        cause: error,
      }),
    );
  }

  if (failures.length > 0) {
    throw new RuntimeShutdownError({
      message: `The G2W runtime shutdown finished with ${failures.length} cleanup failure${
        failures.length === 1 ? "" : "s"
      }.`,
      failures,
    });
  }
};

/**
 * Bootstrap the official G2W runtime: one managed Effect runtime built from
 * the given layer (or none), owning its lifecycle scope, with explicit
 * idempotent shutdown and best-effort finalizer cleanup.
 *
 * The layer is built eagerly before the promise resolves, so a layer that
 * fails to build rejects with {@link RuntimeBootstrapError} — carrying the
 * original cause — after releasing what the partial build already acquired.
 */
export async function createG2WRuntime<R = never, E = never>(
  options: G2WRuntimeOptions<R, E> = {},
): Promise<G2WRuntime<R>> {
  const layer = options.layer ?? Layer.empty;
  // Layer.empty provides no services and never fails, so it satisfies every
  // Layer<R, E, never>; Effect's contravariant ROut annotation cannot express
  // that, hence the single narrow cast at the zero-config fallback.
  return bootstrapFromLayer(layer as Layer.Layer<R, E, never>);
}
