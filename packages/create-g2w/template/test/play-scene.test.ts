import { describe, expect, it } from "vitest";
import { type MoveInput, nextPlayerPosition, PLAYER_SIZE } from "../src/scenes/play-scene.js";

/** Fake keyboard: only the codes explicitly listed are held down. */
function keys(codes: string[]): MoveInput {
  return { isKeyDown: (code) => codes.includes(code) };
}

const bounds = { width: 640, height: 360 };
const start = { x: 300, y: 150 };

describe("player movement", () => {
  it("does not move without held keys", () => {
    const next = nextPlayerPosition(keys([]), start, 1 / 60, bounds);
    expect(next).toEqual(start);
  });

  it("moves right by speed * deltaTime while the key is held", () => {
    const next = nextPlayerPosition(keys(["KeyD"]), start, 0.5, bounds);
    expect(next.x).toBeCloseTo(start.x + 160 * 0.5);
    expect(next.y).toBe(start.y);
  });

  it("moves diagonally with two held keys", () => {
    const next = nextPlayerPosition(keys(["KeyW", "KeyA"]), start, 0.25, bounds);
    expect(next.x).toBeCloseTo(start.x - 160 * 0.25);
    expect(next.y).toBeCloseTo(start.y - 160 * 0.25);
  });

  it("accepts arrow keys as an alternative control scheme", () => {
    const next = nextPlayerPosition(keys(["ArrowLeft", "ArrowDown"]), start, 0.25, bounds);
    expect(next.x).toBeCloseTo(start.x - 160 * 0.25);
    expect(next.y).toBeCloseTo(start.y + 160 * 0.25);
  });

  it("clamps movement to the logical bounds", () => {
    const corner = { x: PLAYER_SIZE / 2, y: bounds.height - PLAYER_SIZE / 2 };
    const next = nextPlayerPosition(keys(["KeyA", "KeyS"]), corner, 10, bounds);
    expect(next.x).toBe(0);
    expect(next.y).toBe(bounds.height - PLAYER_SIZE);
  });

  it("stays inside the bounds for arbitrarily large frames", () => {
    const next = nextPlayerPosition(keys(["KeyD"]), start, 100, bounds);
    expect(next.x).toBe(bounds.width - PLAYER_SIZE);
  });
});
