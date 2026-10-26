import { describe, expect, it, vi } from "vitest";
import {
  AudioManager,
  type Sound,
  type SoundPlayback,
  type SoundPlayOptions,
} from "../src/audio.js";
import { AudioError } from "../src/audio-error.js";

/** A deterministic playback handle whose lifetime is driven by the test. */
class FakePlayback implements SoundPlayback {
  #stopped = false;
  readonly stop = vi.fn((): void => {
    this.#stopped = true;
  });

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Test hook: simulate natural completion without an explicit stop(). */
  finish(): void {
    this.#stopped = true;
  }
}

/** A deterministic sound that records play() calls and hands out fakes. */
class FakeSound implements Sound {
  readonly playbacks: FakePlayback[] = [];
  readonly playCalls: SoundPlayOptions[] = [];

  constructor(readonly options?: { failOnPlay?: boolean }) {}

  play(options?: SoundPlayOptions): SoundPlayback {
    this.playCalls.push(options ?? {});
    if (this.options?.failOnPlay) {
      throw new Error("backend refuses to start playback (suspended)");
    }
    const playback = new FakePlayback();
    this.playbacks.push(playback);
    return playback;
  }
}

function setup() {
  const sounds = new Map<string, FakeSound>();
  const loadCalls: string[] = [];
  let loadError: unknown = null;
  const backendDispose = vi.fn();
  const manager = new AudioManager({
    backend: {
      load: async (key: string) => {
        loadCalls.push(key);
        if (loadError !== null) {
          throw loadError;
        }
        const existing = sounds.get(key);
        if (existing) {
          return existing;
        }
        const sound = new FakeSound();
        sounds.set(key, sound);
        return sound;
      },
      dispose: backendDispose,
    },
  });
  return {
    manager,
    sounds,
    loadCalls,
    backendDispose,
    setLoadError: (e: unknown) => (loadError = e),
  };
}

describe("AudioManager", () => {
  it("loads a sound through the backend and caches it by key", async () => {
    const { manager, sounds, loadCalls } = setup();

    const first = await manager.load("laser.wav");
    const second = await manager.load("laser.wav");

    expect(loadCalls).toEqual(["laser.wav"]);
    expect(second).toBe(first);
    expect(sounds.get("laser.wav")).toBe(first);
  });

  it("deduplicates concurrent loads of the same key", async () => {
    const { manager, loadCalls } = setup();

    const [a, b] = await Promise.all([manager.load("laser.wav"), manager.load("laser.wav")]);

    expect(loadCalls).toEqual(["laser.wav"]);
    expect(b).toBe(a);
  });

  it("propagates backend failures unchanged and retries a later load", async () => {
    const { manager, setLoadError, loadCalls } = setup();
    setLoadError(new Error("decode failed"));

    await expect(manager.load("laser.wav")).rejects.toThrow("decode failed");
    await expect(manager.load("laser.wav")).rejects.toThrow("decode failed");

    setLoadError(null);
    const sound = await manager.load("laser.wav");
    expect(sound).toBeInstanceOf(FakeSound);
    expect(loadCalls).toEqual(["laser.wav", "laser.wav", "laser.wav"]);
  });

  it("play() starts a tracked playback and forwards options to the sound", async () => {
    const { manager, sounds } = setup();

    const playback = await manager.play("laser.wav", { volume: 0.5, loop: true });

    expect(playback.stopped).toBe(false);
    expect(sounds.get("laser.wav")?.playCalls).toEqual([{ volume: 0.5, loop: true }]);
  });

  it("play() reuses the cached sound instead of reloading", async () => {
    const { manager, loadCalls } = setup();

    await manager.play("laser.wav");
    await manager.play("laser.wav", { volume: 1 });

    expect(loadCalls).toEqual(["laser.wav"]);
  });

  it("stopAll() stops every active playback exactly once", async () => {
    const { manager, sounds } = setup();

    const a = await manager.play("laser.wav");
    const b = await manager.play("laser.wav");
    manager.stopAll();

    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    // A later play starts fresh playback even after stopAll.
    const c = await manager.play("laser.wav");
    expect(c.stopped).toBe(false);
    expect(sounds.get("laser.wav")?.playbacks).toHaveLength(3);
  });

  it("prunes finished playbacks so the active set stays bounded", async () => {
    const { manager, sounds } = setup();

    const finished = await manager.play("laser.wav");
    (finished as FakePlayback).finish();
    // The next play() prunes the finished playback from tracking.
    const active = await manager.play("laser.wav");

    manager.stopAll();
    // The finished playback must not be stopped again by stopAll.
    expect((finished as FakePlayback).stop).not.toHaveBeenCalled();
    expect(active.stop).toHaveBeenCalledTimes(1);
    expect(sounds.get("laser.wav")?.playbacks).toHaveLength(2);
  });

  it("dispose() stops active playbacks, releases the backend once, and is terminal", async () => {
    const { manager, backendDispose } = setup();

    const playback = await manager.play("laser.wav");
    manager.dispose();
    manager.dispose();

    expect(playback.stop).toHaveBeenCalledTimes(1);
    expect(backendDispose).toHaveBeenCalledTimes(1);
    expect(() => manager.load("laser.wav")).toThrow(AudioError);
    await expect(manager.play("laser.wav")).rejects.toThrow(AudioError);
  });

  it("dispose() never destroys cached sounds (non-owning policy)", async () => {
    const { manager, sounds } = setup();
    await manager.load("laser.wav");

    manager.dispose();

    // The sound value survives disposal untouched: it is caller/backend-owned
    // and may still be used elsewhere.
    expect(sounds.get("laser.wav")).toBeInstanceOf(FakeSound);
  });

  it("propagates backend playback refusal instead of swallowing it", async () => {
    const refusing = new FakeSound({ failOnPlay: true });
    const failing = new AudioManager({
      backend: { load: async () => refusing },
    });

    await expect(failing.play("laser.wav")).rejects.toThrow("backend refuses to start playback");
    failing.dispose();
  });

  it("rejects invalid play options before touching the backend", async () => {
    const { manager, loadCalls, sounds } = setup();

    await expect(manager.play("laser.wav", { volume: Number.NaN })).rejects.toThrow(AudioError);
    await expect(manager.play("laser.wav", { volume: -1 })).rejects.toThrow(AudioError);
    await expect(manager.play("laser.wav", { volume: Number.POSITIVE_INFINITY })).rejects.toThrow(
      AudioError,
    );

    expect(loadCalls).toEqual([]);
    expect(sounds.size).toBe(0);
  });

  it("accepts zero volume and default options", async () => {
    const { manager, sounds } = setup();

    const muted = await manager.play("laser.wav", { volume: 0 });
    await manager.play("laser.wav");

    expect(muted.stopped).toBe(false);
    expect(sounds.get("laser.wav")?.playCalls[0]).toEqual({ volume: 0 });
    expect(sounds.get("laser.wav")?.playCalls[1]).toEqual({});
  });

  it("requires a usable backend at construction", () => {
    expect(() => new AudioManager({ backend: null as never })).toThrow(AudioError);
    expect(() => new AudioManager({ backend: {} as never })).toThrow(AudioError);
  });

  it("backend disposal errors propagate to the disposer", () => {
    const failing = new AudioManager({
      backend: {
        load: async () => new FakeSound(),
        dispose: () => {
          throw new Error("close failed");
        },
      },
    });

    expect(() => failing.dispose()).toThrow("close failed");
  });
});
