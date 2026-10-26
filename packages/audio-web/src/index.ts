import type { AudioBackend, Sound, SoundPlayback, SoundPlayOptions } from "@g2w/core";

/** Error thrown for invalid `WebAudioBackend` lifecycle or usage errors. */
export class WebAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAudioError";
  }
}

/** Options for constructing a {@link WebAudioBackend}. */
export interface WebAudioBackendOptions {
  /**
   * The browser `AudioContext` this backend plays through. Injectable so
   * tests (and embedders) can supply their own context; create it in the
   * browser with `new AudioContext()`. A fresh context starts `suspended`
   * under autoplay policies — call `resume()` from a user-gesture handler
   * before playing.
   */
  readonly context: AudioContext;
  /**
   * The fetch implementation used to download sound files. Defaults to
   * `globalThis.fetch`; inject a fake in tests or a scoped implementation
   * for custom origins.
   */
  readonly fetch?: typeof fetch;
}

/** One active playback of a decoded Web Audio buffer. */
class WebAudioPlayback implements SoundPlayback {
  #stopped = false;

  constructor(
    private readonly source: AudioBufferSourceNode,
    private readonly gain: GainNode,
  ) {}

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    // Web Audio's stop() is idempotent for started sources, but the guard
    // keeps the contract exact even for edge cases; disconnect releases the
    // nodes immediately instead of waiting for garbage collection.
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // A source that never reached startable state cannot be stopped;
      // there is nothing to release beyond the disconnect below.
    }
    this.source.disconnect();
    this.gain.disconnect();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Internal: flip to stopped when the source finishes on its own. */
  #notifyEnded(): void {
    this.#stopped = true;
  }

  /** Internal: start the underlying source and wire the completion flag. */
  start(): void {
    this.source.onended = () => {
      this.#notifyEnded();
    };
    this.source.start();
  }
}

/** A decoded sound played through the backend's AudioContext. */
class WebAudioSound implements Sound {
  constructor(
    private readonly context: AudioContext,
    private readonly buffer: AudioBuffer,
    private readonly destination: AudioNode,
  ) {}

  play(options?: SoundPlayOptions): SoundPlayback {
    if (this.context.state === "closed") {
      throw new WebAudioError("Cannot play a sound on a closed AudioContext.");
    }
    if (this.context.state === "suspended") {
      // Autoplay policy: never start silently inaudible playback. The caller
      // must resume the context from a user-gesture handler first.
      throw new WebAudioError(
        "The AudioContext is suspended (browser autoplay policy). Call WebAudioBackend.resume() from a user-gesture handler before playing.",
      );
    }
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.loop = options?.loop ?? false;
    const gain = this.context.createGain();
    gain.gain.value = options?.volume ?? 1;
    source.connect(gain);
    gain.connect(this.destination);

    const playback = new WebAudioPlayback(source, gain);
    playback.start();
    return playback;
  }
}

/**
 * Web Audio (browser) backend for the core `AudioManager` contract:
 * downloads and decodes sound files through an `AudioContext` and plays them
 * as fire-and-forget playbacks with volume and looping.
 *
 * Caching policy: caching and deduplication live in the core `AudioManager`,
 * which wraps this backend; `load()` itself always decodes, so a failed load
 * is naturally retryable.
 *
 * Ownership policy: the backend owns only the `AudioContext` and the playback
 * nodes it creates. Decoded buffers are owned by the context; `dispose()`
 * closes the context (which reclaims the buffers) and is at-most-once and
 * idempotent. A disposed backend cannot load or play again.
 *
 * Autoplay policy: a fresh browser `AudioContext` starts `suspended`.
 * `play()` on a suspended context throws {@link WebAudioError} instead of
 * starting silently inaudible playback; call `resume()` from a real
 * user-gesture handler (click, keypress) first. `resume()` is safe to call
 * any time the context is not closed.
 */
export class WebAudioBackend implements AudioBackend {
  readonly #context: AudioContext;
  readonly #fetch: typeof fetch;
  #disposed = false;

  constructor(options: WebAudioBackendOptions) {
    if (typeof options.context !== "object" || options.context === null) {
      throw new WebAudioError("WebAudioBackend requires an AudioContext.");
    }
    this.#context = options.context;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Load and decode one sound for a key. Fetch failures (non-OK status)
   * reject with {@link WebAudioError}; decode failures reject with the
   * browser's error unchanged. Callers (typically the core `AudioManager`)
   * cache results, so a failed load is simply retried on the next request.
   */
  async load(key: string): Promise<Sound> {
    if (this.#disposed) {
      throw new WebAudioError("Cannot load with a disposed WebAudioBackend.");
    }
    return this.#decode(key);
  }

  /**
   * Resume the context after autoplay suspension. Call from a user-gesture
   * handler; idempotent and safe when already running (the browser resolves
   * the call as a no-op). Throws {@link WebAudioError} after disposal;
   * a resume on a closed context rejects with the browser's error unchanged.
   */
  async resume(): Promise<void> {
    if (this.#disposed) {
      throw new WebAudioError("Cannot resume a disposed WebAudioBackend.");
    }
    await this.#context.resume();
  }

  /** The context's current state (`suspended`, `running`, or `closed`). */
  get state(): AudioContextState {
    return this.#context.state;
  }

  /**
   * Close the context, releasing every decoded buffer and stopping all sound.
   * At-most-once and idempotent. The returned promise settles when the
   * context has closed; playback node cleanup is handled by the context.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    void this.#context.close();
  }

  async #decode(key: string): Promise<Sound> {
    const response = await this.#fetch(key);
    if (!response.ok) {
      throw new WebAudioError(`Failed to fetch sound ${key}: HTTP ${response.status}.`);
    }
    const data = await response.arrayBuffer();
    // decodeAudioData rejects on undecodable data; that rejection propagates
    // unchanged so callers can distinguish decode errors from HTTP errors.
    const buffer = await this.#context.decodeAudioData(data);
    return new WebAudioSound(this.#context, buffer, this.#context.destination);
  }
}
