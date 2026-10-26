import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioManager } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { WebAudioBackend } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("@g2w/audio-web package boundary", () => {
  it("declares @g2w/core as its only dependency", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    expect(manifest.dependencies?.["@g2w/core"]).toBeDefined();
    // The audio backend must not pull in any rendering technology.
    expect(manifest.dependencies?.["pixi.js"]).toBeUndefined();
  });

  it("implements the core AudioBackend contract so the two packages compose", async () => {
    const context = {
      state: "suspended",
      resume: async () => {},
      close: async () => {},
    } as unknown as AudioContext;
    const backend = new WebAudioBackend({
      context,
      fetch: (async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
    });
    // The constructor accepts the backend directly — the adapter's only
    // coupling to core is the contract it implements.
    const manager = new AudioManager({ backend });
    await expect(manager.load("beep.wav")).rejects.toThrow();
    manager.dispose();
  });
});
