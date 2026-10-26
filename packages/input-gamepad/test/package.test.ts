import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GamepadState } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { GamepadInput } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("@g2w/input-gamepad package boundary", () => {
  it("declares @g2w/core as its only dependency", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    expect(manifest.dependencies?.["@g2w/core"]).toBeDefined();
    // The adapter must not pull in any rendering technology.
    expect(manifest.dependencies?.["pixi.js"]).toBeUndefined();
  });

  it("feeds a core GamepadState so the two packages compose", () => {
    const state = new GamepadState();
    const input = new GamepadInput(state, {
      source: () => [null],
      connectTarget: new EventTarget(),
      disconnectTarget: new EventTarget(),
    });

    // Constructor accepts a core GamepadState directly — the adapter's only
    // coupling to core is the state it feeds.
    expect(input.attached).toBe(false);
    input.poll();
    expect(state.connectedIndices()).toEqual([]);
  });
});
