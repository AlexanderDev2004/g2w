import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  createG2WRuntime,
  RuntimeBootstrapError,
  type RuntimeCleanupFailure,
  RuntimeShutdownError,
} from "../src/index.js";

class Clock extends Context.Service<Clock, { now(): number }>()("test/runtime/Clock") {
  static readonly layer = Layer.effect(Clock, Effect.succeed(Clock.of({ now: () => 42 })));
}

const settle = async <T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
};

describe("@g2w/runtime bootstrap", () => {
  it("bootstraps a layer and runs programs against its services", async () => {
    const runtime = await createG2WRuntime({ layer: Clock.layer });
    try {
      const time = await runtime.run(
        Effect.gen(function* () {
          const clock = yield* Clock;
          return clock.now();
        }),
      );
      expect(time).toBe(42);
    } finally {
      await runtime.shutdown();
    }
    expect(runtime.disposed).toBe(true);
  });

  it("reports bootstrap failure without hiding its cause", async () => {
    const failure = new Error("layer build failed");
    const settled = await settle(
      createG2WRuntime({ layer: Layer.effectDiscard(Effect.fail(failure)) }),
    );

    expect(settled.ok).toBe(false);
    const error = settled.ok === false ? settled.error : undefined;
    expect(error).toBeInstanceOf(RuntimeBootstrapError);
    const bootstrapError = error as RuntimeBootstrapError;
    expect(bootstrapError.message).toContain("bootstrap failed");
    // The original layer-build failure stays observable through `cause`.
    expect(String(bootstrapError.cause)).toContain("layer build failed");
  });

  it("cleans up resources acquired by a partially failing bootstrap", async () => {
    const flags = { acquired: false, released: false };
    const partiallyFailingLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          flags.acquired = true;
        }),
        () =>
          Effect.sync(() => {
            flags.released = true;
          }),
      ).pipe(Effect.andThen(Effect.fail(new Error("late layer failure")))),
    );

    const settled = await settle(createG2WRuntime({ layer: partiallyFailingLayer }));

    expect(settled.ok).toBe(false);
    expect(settled.ok === false ? settled.error : undefined).toBeInstanceOf(RuntimeBootstrapError);
    expect(flags.acquired).toBe(true);
    expect(flags.released).toBe(true);
  });
});

describe("@g2w/runtime shutdown", () => {
  it("runs registered finalizers on shutdown", async () => {
    const runtime = await createG2WRuntime();
    const calls: string[] = [];
    runtime.addFinalizer(() => {
      calls.push("first");
    });
    runtime.addFinalizer(() => {
      calls.push("second");
    });

    await runtime.shutdown();

    // Reverse registration order: the last acquired resource releases first.
    expect(calls).toEqual(["second", "first"]);
    expect(runtime.disposed).toBe(true);
  });

  it("does not execute cleanup twice across repeated and concurrent shutdowns", async () => {
    const runtime = await createG2WRuntime();
    let count = 0;
    runtime.addFinalizer(() => {
      count++;
    });

    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    await runtime.shutdown();
    await runtime.shutdown();

    expect(count).toBe(1);
  });

  it("attempts every finalizer and keeps cleanup failures observable", async () => {
    const runtime = await createG2WRuntime();
    const calls: string[] = [];
    const boom = new Error("finalizer boom");
    runtime.addFinalizer(() => {
      calls.push("ok-first");
    });
    runtime.addFinalizer(() => {
      throw boom;
    });
    runtime.addFinalizer(() => {
      calls.push("ok-last");
    });

    const settled = await settle(runtime.shutdown());

    expect(settled.ok).toBe(false);
    const error = settled.ok === false ? settled.error : undefined;
    expect(error).toBeInstanceOf(RuntimeShutdownError);
    const shutdownError = error as RuntimeShutdownError;
    expect(shutdownError.failures).toHaveLength(1);
    const failure = shutdownError.failures[0] as RuntimeCleanupFailure;
    expect(failure.message).toBe("finalizer boom");
    expect(failure.cause).toBe(boom);
    // The failing finalizer did not stop the remaining cleanup steps.
    expect(calls).toEqual(["ok-last", "ok-first"]);
  });

  it("keeps layer-disposal defects observable through shutdown", async () => {
    const failingDisposalLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("layer disposal boom")));
      }),
    );
    const runtime = await createG2WRuntime({ layer: failingDisposalLayer });
    let hostFinalizerRan = false;
    runtime.addFinalizer(() => {
      hostFinalizerRan = true;
    });

    const settled = await settle(runtime.shutdown());

    // The layer's internal defect surfaces as one observable cleanup failure
    // without hiding the host finalizer result.
    expect(settled.ok).toBe(false);
    const error = settled.ok === false ? settled.error : undefined;
    expect(error).toBeInstanceOf(RuntimeShutdownError);
    const shutdownError = error as RuntimeShutdownError;
    expect(shutdownError.failures).toHaveLength(1);
    expect(String(shutdownError.failures[0]?.cause)).toContain("layer disposal boom");
    expect(hostFinalizerRan).toBe(true);
  });

  it("rejects programs and finalizer registration after shutdown", async () => {
    const runtime = await createG2WRuntime();
    await runtime.shutdown();

    expect(() => runtime.run(Effect.succeed(1))).toThrow(RuntimeShutdownError);
    expect(() => runtime.addFinalizer(() => {})).toThrow(RuntimeShutdownError);
  });
});

describe("@g2w/runtime surface", () => {
  it("exposes no scheduler, timer, or per-frame runtime API", async () => {
    const runtime = await createG2WRuntime();
    try {
      expect(Object.keys(runtime).sort()).toEqual(["addFinalizer", "disposed", "run", "shutdown"]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("is idempotent to dispose through the facade across many programs", async () => {
    const runtime = await createG2WRuntime({ layer: Clock.layer });
    let finalizerCount = 0;
    runtime.addFinalizer(() => {
      finalizerCount++;
    });

    await runtime.run(
      Effect.gen(function* () {
        const clock = yield* Clock;
        return clock.now();
      }),
    );
    await runtime.shutdown();
    await runtime.shutdown();

    expect(finalizerCount).toBe(1);
    expect(runtime.disposed).toBe(true);
  });
});
