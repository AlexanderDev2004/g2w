import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputState } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { DomInput } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("@g2w/input-dom package boundary", () => {
  it("declares @g2w/core as a dependency", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    expect(manifest.dependencies?.["@g2w/core"]).toBeDefined();
    // The adapter must not pull in any rendering technology.
    expect(manifest.dependencies?.["pixi.js"]).toBeUndefined();
  });

  it("feeds a core InputState so the two packages compose", () => {
    const input = new InputState();
    const canvas = Object.assign(new EventTarget(), {
      width: 640,
      height: 360,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    });
    const domInput = new DomInput(input, {
      canvas: canvas as unknown as HTMLCanvasElement,
    });

    // Constructor accepts a core InputState directly — the adapter's only
    // coupling to core is the state it feeds.
    expect(domInput.attached).toBe(false);
  });
});
