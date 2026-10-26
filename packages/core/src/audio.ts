import { AssetManager } from "./asset-manager.js";
import { AudioError } from "./audio-error.js";

/** Options for one playback of a {@link Sound}. All fields are optional. */
export interface SoundPlayOptions {
  /**
   * Output volume as a multiplier. Must be a finite number >= 0; the default
   * is `1` (natural volume). Values above `1` are allowed where the backend
   * supports them, but `AudioManager` rejects non-finite or negative values
   * with {@link AudioError} before any backend call.
   */
  readonly volume?: number;
  /** Whether the playback repeats from the start when it ends. Default `false`. */
  readonly loop?: boolean;
}

/**
 * One active playback of a {@link Sound}. A playback is a handle the caller
 * may keep and stop early; it says nothing about *ownership* of the underlying
 * resource — the manager owns playback lifetimes (see `AudioManager`).
 */
export interface SoundPlayback {
  /**
   * Stop the playback now. Idempotent: stopping an already-finished or
   * already-stopped playback is a no-op, never an error.
   */
  stop(): void;
  /** Whether the playback has finished or been stopped and is no longer audible. */
  readonly stopped: boolean;
}

/**
 * A loaded, playable sound. Rendered by a backend; core never interprets the
 * underlying audio data. Values are *caller/backend-owned*: the manager caches
 * them but never destroys them (see `AudioManager` ownership policy).
 */
export interface Sound {
  /** Start one playback with the given options and return its handle. */
  play(options?: SoundPlayOptions): SoundPlayback;
}

/**
 * The backend contract a host supplies to `AudioManager`. It loads sounds for
 * opaque string keys; everything browser-specific lives behind it. This is the
 * audio analog of the asset system's injected loader.
 */
export interface AudioBackend {
  /** Load (or decode) one playable sound for a key. May reject; errors are propagated unchanged. */
  load(key: string): Promise<Sound>;
  /**
   * Release backend-owned resources (for example, close a browser
   * `AudioContext`). Optional; called at most once by `AudioManager.dispose()`
   * after all playbacks are stopped. Errors propagate to the disposer.
   */
  dispose?(): void;
}

/** Options for constructing an {@link AudioManager}. */
export interface AudioManagerOptions {
  /** The backend used for every sound load. */
  readonly backend: AudioBackend;
}

/**
 * A minimal, renderer-agnostic audio manager following the asset-manager
 * pattern: an injected backend loads sounds, requests are cached and
 * deduplicated, and failed loads are retryable.
 *
 * ```ts
 * const audio = new AudioManager({ backend: createWebAudioBackend() });
 * const laser = await audio.load("laser.wav");
 * const shot = await audio.play("laser.wav", { volume: 0.5 });
 * // later: shot.stop(); or audio.stopAll(); or await-free audio.dispose();
 * ```
 *
 * Semantics (all covered by tests in `packages/core/test/audio-manager.test.ts`):
 * - **Caching and deduplication are inherited from `AssetManager`:** the first
 *   `load(key)` invokes the backend; repeated and concurrent requests share one
 *   load and one `Sound` value. A rejected load leaves the key retryable, and
 *   backend errors are never wrapped.
 * - **`play(key, options?)`** loads the sound (usually a cache hit), starts one
 *   playback, and tracks the returned `SoundPlayback`. Invalid options
 *   (non-finite or negative `volume`) throw {@link AudioError} before any
 *   backend call. If the backend cannot start playback — for example a browser
 *   autoplay policy holds the context suspended — the backend's rejection or
 *   throw propagates unchanged; it is never silently swallowed.
 * - **`stopAll()`** stops every playback this manager started, exactly once
 *   each (`SoundPlayback.stop()` is idempotent).
 * - **Ownership:** the manager owns *playback lifetimes*, never the sounds
 *   themselves. `dispose()` stops all active playbacks, clears the cache, and
 *   calls `backend.dispose()` once if provided. It never destroys `Sound`
 *   values: decoded audio data is caller/backend-owned and may be shared
 *   freely. Backend disposal errors propagate to the disposer.
 * - **Disposal is terminal and idempotent:** `load` and `play` after disposal
 *   throw {@link AudioError} immediately; repeated `dispose()` calls are
 *   no-ops.
 *
 * Intentionally unsupported: mixers, spatial/3D audio, adaptive music,
 * streaming, and autoplay queues. There is no second frame loop and no hidden
 * timer — audio is fire-and-forget from the caller's perspective, driven by
 * the backend, not by the game loop.
 */
export class AudioManager {
  readonly #backend: AudioBackend;
  /** Non-owning cache: dedup, retry, and disposal-clearing come from AssetManager. */
  readonly #sounds: AssetManager<Sound>;
  readonly #active = new Set<SoundPlayback>();
  #disposed = false;

  constructor(options: AudioManagerOptions) {
    if (typeof options.backend !== "object" || options.backend === null) {
      throw new AudioError("AudioManager requires a backend object.");
    }
    if (typeof options.backend.load !== "function") {
      throw new AudioError("AudioManager backend must provide a load function.");
    }
    this.#backend = options.backend;
    // Deliberately non-owning: the manager caches sounds but never destroys
    // them. Decoded audio may be shared (same file, several managers), so
    // destruction stays with whoever owns the backend resources.
    this.#sounds = new AssetManager<Sound>({ load: (key) => this.#backend.load(key) });
  }

  /**
   * Load one sound for a key. Cached and deduplicated; a failed load is
   * retryable. Throws {@link AudioError} after disposal.
   */
  load(key: string): Promise<Sound> {
    this.#assertUsable();
    return this.#sounds.load(key);
  }

  /**
   * Load (usually from cache) and start one playback of the sound at `key`,
   * returning its handle. The returned promise rejects if the load fails or
   * the backend refuses to start playback (for example, browser autoplay
   * policy); it never resolves to a silently dead playback started against a
   * suspended backend unless the backend itself allowed it.
   */
  async play(key: string, options?: SoundPlayOptions): Promise<SoundPlayback> {
    this.#assertUsable();
    this.#assertOptions(options);
    const sound = await this.load(key);
    const playback = sound.play(options);
    this.#prune();
    this.#active.add(playback);
    return playback;
  }

  /** Stop every playback this manager started. Idempotent. */
  stopAll(): void {
    for (const playback of this.#active) {
      playback.stop();
    }
    this.#active.clear();
  }

  /**
   * Stop all playbacks, drop the cache, and release backend resources
   * (`backend.dispose()`, at most once). Terminal and idempotent: later
   * `load`/`play` calls throw {@link AudioError}, and later `dispose()` calls
   * are no-ops. `Sound` values are never destroyed — see the ownership policy
   * above.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.stopAll();
    this.#sounds.dispose();
    this.#backend.dispose?.();
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AudioError("Cannot use a disposed AudioManager.");
    }
  }

  #assertOptions(options: SoundPlayOptions | undefined): void {
    if (options?.volume !== undefined && (!Number.isFinite(options.volume) || options.volume < 0)) {
      throw new AudioError(`Sound volume must be a finite number >= 0, got ${options.volume}.`);
    }
  }

  /** Drop playbacks that already finished, so the active set stays bounded. */
  #prune(): void {
    for (const playback of this.#active) {
      if (playback.stopped) {
        this.#active.delete(playback);
      }
    }
  }
}
