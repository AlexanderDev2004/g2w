import type { AudioBackend, SoundPlayback, SoundPlayOptions } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { WebAudioBackend, WebAudioError } from "../src/index.js";

/**
 * A deterministic AudioBufferSourceNode fake: start/stop are recorded, the
 * completion event fires only when the test says so, and stop() after stop()
 * is recorded (the real node tolerates it; we must never rely on that twice).
 */
class FakeSource {
  started = 0;
  stopped = 0;
  loop = false;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connectedTo: FakeDestination | null = null;

  start(): void {
    this.started++;
  }

  stop(): void {
    this.stopped++;
  }

  connect(node: FakeDestination): FakeDestination {
    this.connectedTo = node;
    return node;
  }

  disconnect(): void {
    this.connectedTo = null;
  }

  /** Test hook: the buffer finished playing on its own. */
  end(): void {
    this.onended?.();
  }
}

class FakeDestination {
  readonly sources: FakeSource[] = [];
  /** Mirrors the real GainNode's `gain` AudioParam. */
  readonly gain = { value: 1 };
  connectedTo: FakeDestination | null = null;

  connect(node: FakeDestination): FakeDestination {
    this.connectedTo = node;
    return node;
  }

  disconnect(): void {
    this.connectedTo = null;
  }
}

class FakeContext {
  state: AudioContextState = "running";
  readonly destination = new FakeDestination();
  readonly createdSources: FakeSource[] = [];
  readonly createdGains: FakeDestination[] = [];
  readonly decoded: ArrayBuffer[] = [];
  resumed = 0;
  closed = 0;

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.createdSources.push(source);
    return source;
  }

  createGain(): FakeDestination {
    const gain = new FakeDestination();
    this.createdGains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    if (this.state === "suspended") {
      this.state = "running";
    }
    this.resumed++;
  }

  async close(): Promise<void> {
    this.closed++;
    this.state = "closed";
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(data);
    return { fake: true, bytes: data.byteLength } as unknown as AudioBuffer;
  }
}

/** Minimal fetch fake returning canned responses per key. */
function fakeFetch(
  responses: Record<string, { ok: boolean; status?: number; body?: ArrayBuffer }>,
) {
  const calls: string[] = [];
  const fn = (async (key: string) => {
    calls.push(key);
    const response = responses[key] ?? { ok: false, status: 404 };
    return {
      ok: response.ok,
      status: response.status ?? 200,
      arrayBuffer: async () => response.body ?? new ArrayBuffer(8),
    };
  }) as typeof fetch & { calls: string[] };
  return Object.assign(fn, { calls });
}

const WAV = new ArrayBuffer(16);

/** Indexed access with noUncheckedIndexedAccess on: assert the entry exists. */
function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected at least one item");
  }
  return item;
}

function setup(options?: {
  state?: AudioContextState;
  responses?: Record<string, { ok: boolean; status?: number }>;
}) {
  const context = new FakeContext();
  if (options?.state) {
    context.state = options.state;
  }
  const responses: Record<string, { ok: boolean; status?: number }> = options?.responses ?? {
    "beep.wav": { ok: true },
  };
  const fetcher = fakeFetch(
    Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, { ...v, body: WAV }])),
  );
  const backend = new WebAudioBackend({
    context: context as unknown as AudioContext,
    fetch: fetcher,
  });
  return { backend, context, fetcher };
}

describe("WebAudioBackend", () => {
  it("requires a context at construction", () => {
    expect(() => new WebAudioBackend({ context: null as never })).toThrow(WebAudioError);
  });

  it("fetches and decodes a sound into a playable Sound", async () => {
    const { backend, context, fetcher } = setup();

    const sound = await backend.load("beep.wav");

    expect(fetcher.calls).toEqual(["beep.wav"]);
    expect(context.decoded).toHaveLength(1);
    expect(typeof sound.play).toBe("function");
  });

  it("rejects non-OK fetches with WebAudioError and is retryable", async () => {
    const { backend } = setup({ responses: { "beep.wav": { ok: false, status: 404 } } });

    await expect(backend.load("beep.wav")).rejects.toThrow(WebAudioError);
    // Retry path: the caller may request the same key again.
    await expect(backend.load("beep.wav")).rejects.toThrow(WebAudioError);
  });

  it("rejects load after disposal", async () => {
    const { backend } = setup();

    backend.dispose();

    await expect(backend.load("beep.wav")).rejects.toThrow(WebAudioError);
  });

  it("play() creates source and gain, applies options, and starts", async () => {
    const { backend, context } = setup();
    const sound = await backend.load("beep.wav");

    const playback = sound.play({ volume: 0.25, loop: true });

    const source = first(context.createdSources);
    const gain = first(context.createdGains);
    expect(source.started).toBe(1);
    expect(source.loop).toBe(true);
    expect(gain.gain.value).toBe(0.25);
    expect(source.connectedTo).toBe(gain);
    expect(gain.connectedTo).toBe(context.destination);
    expect(playback.stopped).toBe(false);
  });

  it("play() throws a documented error while the context is suspended (autoplay policy)", async () => {
    const { backend, context } = setup({ state: "suspended" });
    const sound = await backend.load("beep.wav");

    expect(() => sound.play()).toThrow(WebAudioError);
    expect(() => sound.play()).toThrow(/suspended/);
    // Nothing was started and no nodes were created for the failed plays.
    expect(context.createdSources).toHaveLength(0);
  });

  it("resume() flips a suspended context to running and is idempotent", async () => {
    const { backend, context } = setup({ state: "suspended" });

    await backend.resume();
    await backend.resume();

    expect(context.state).toBe("running");
    expect(context.resumed).toBe(2);
    // After resume, playback works.
    const sound = await backend.load("beep.wav");
    expect(sound.play().stopped).toBe(false);
  });

  it("play() throws after the context is closed", async () => {
    const { backend, context } = setup();
    const sound = await backend.load("beep.wav");
    context.state = "closed";

    expect(() => sound.play()).toThrow(/closed/);
  });

  it("stop() stops the source once, disconnects nodes, and is idempotent", async () => {
    const { backend, context } = setup();
    const sound = await backend.load("beep.wav");
    const playback = sound.play();
    const source = first(context.createdSources);

    playback.stop();
    playback.stop();

    expect(source.stopped).toBe(1);
    expect(source.connectedTo).toBeNull();
    expect(playback.stopped).toBe(true);
  });

  it("a naturally ended playback reports stopped without an explicit stop()", async () => {
    const { backend, context } = setup();
    const sound = await backend.load("beep.wav");
    const playback = sound.play();
    const source = first(context.createdSources);

    source.end();

    expect(playback.stopped).toBe(true);
    // stop() after natural end is still a safe no-op.
    expect(() => playback.stop()).not.toThrow();
  });

  it("dispose() closes the context once and is idempotent", async () => {
    const { backend, context } = setup();

    backend.dispose();
    backend.dispose();

    expect(context.closed).toBe(1);
    expect(backend.state).toBe("closed");
    await expect(backend.resume()).rejects.toThrow(WebAudioError);
  });

  it("satisfies the core AudioBackend contract structurally", async () => {
    const { backend } = setup();
    const asContract: AudioBackend = backend;

    const sound = await asContract.load("beep.wav");
    const options: SoundPlayOptions = { volume: 1 };
    const playback: SoundPlayback = sound.play(options);
    expect(playback.stopped).toBe(false);
  });
});
