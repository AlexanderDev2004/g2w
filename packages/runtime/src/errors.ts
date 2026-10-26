import { Schema } from "effect";

/**
 * Error raised when the G2W runtime bootstrap fails while building its
 * layers. The original layer-build failure is preserved in `cause`, so the
 * reason a bootstrap failed is never hidden.
 */
export class RuntimeBootstrapError extends Schema.TaggedError<RuntimeBootstrapError>()(
  "RuntimeBootstrapError",
  {
    /** Human-readable description of what failed during bootstrap. */
    message: Schema.String,
    /** The original layer-build failure raised by Effect. */
    cause: Schema.Defect(),
  },
) {}

/**
 * One failed cleanup step recorded during runtime shutdown. Collected into
 * {@link RuntimeShutdownError.failures} so a failing finalizer can never
 * hide the fate of the remaining cleanup steps.
 */
export class RuntimeCleanupFailure extends Schema.TaggedError<RuntimeCleanupFailure>()(
  "RuntimeCleanupFailure",
  {
    /** Message of the error the finalizer (or layer disposal) threw. */
    message: Schema.String,
    /** The original error thrown by the cleanup step. */
    cause: Schema.Defect(),
  },
) {}

/**
 * Error raised by `shutdown()` when at least one cleanup step failed. All
 * registered finalizers are still attempted; every failure is collected in
 * `failures`. Repeated `shutdown()` calls report the same recorded failures
 * without executing cleanup again.
 */
export class RuntimeShutdownError extends Schema.TaggedError<RuntimeShutdownError>()(
  "RuntimeShutdownError",
  {
    /** Human-readable summary of how many cleanup steps failed. */
    message: Schema.String,
    /** Every observed cleanup failure, in the order the steps ran. */
    failures: Schema.Array(RuntimeCleanupFailure),
  },
) {}
