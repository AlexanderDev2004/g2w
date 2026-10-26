import type { GamepadSnapshot } from "@g2w/core";
import { GamepadState } from "@g2w/core";
import { describe, expect, it } from "vitest";

function snapshot(pressed: boolean[], axes: number[] = []): GamepadSnapshot {
  return { pressed, axes };
}

describe("GamepadState initial state", () => {
  it("starts with no controllers connected and neutral queries", () => {
    const state = new GamepadState();

    expect(state.connectedIndices()).toEqual([]);
    expect(state.isConnected(0)).toBe(false);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.wasButtonPressed(0, 0)).toBe(false);
    expect(state.wasButtonReleased(0, 0)).toBe(false);
    expect(state.getAxis(0, 0)).toBe(0);
    expect(state.getAxes(0)).toEqual([]);
  });

  it("implies connection from the first sample", () => {
    const state = new GamepadState();

    state.handleSample(0, snapshot([true], [0.5]));

    expect(state.isConnected(0)).toBe(true);
    expect(state.connectedIndices()).toEqual([0]);
  });
});

describe("GamepadState buttons and edges", () => {
  it("tracks press, hold, and release edges", () => {
    const state = new GamepadState();

    state.handleSample(0, snapshot([true, false]));
    expect(state.isButtonDown(0, 0)).toBe(true);
    expect(state.wasButtonPressed(0, 0)).toBe(true);
    expect(state.wasButtonReleased(0, 0)).toBe(false);

    // Repeated identical samples do not create extra edges.
    state.handleSample(0, snapshot([true, false]));
    expect(state.wasButtonPressed(0, 0)).toBe(true);

    state.handleSample(0, snapshot([false, false]));
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.wasButtonReleased(0, 0)).toBe(true);
  });

  it("keeps a press-and-release between two frames fully observable", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([false]));

    // Sampled many times between two endFrame calls, edges stay per frame.
    state.handleSample(0, snapshot([true]));
    state.handleSample(0, snapshot([false]));

    expect(state.wasButtonPressed(0, 0)).toBe(true);
    expect(state.wasButtonReleased(0, 0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(false);
  });

  it("resets all edges at endFrame and never touches held state or axes", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true, true], [0.25, -0.75]));

    state.endFrame();
    expect(state.wasButtonPressed(0, 0)).toBe(false);
    expect(state.wasButtonPressed(0, 1)).toBe(false);
    expect(state.isButtonDown(0, 1)).toBe(true);
    expect(state.getAxis(0, 1)).toBe(-0.75);
  });

  it("treats missing entries in a later sample as released buttons", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true, true]));

    state.handleSample(0, snapshot([true]));

    expect(state.isButtonDown(0, 0)).toBe(true);
    expect(state.isButtonDown(0, 1)).toBe(false);
    expect(state.wasButtonReleased(0, 1)).toBe(true);
  });
});

describe("GamepadState axes", () => {
  it("stores raw analog values without a dead zone", () => {
    const state = new GamepadState();

    state.handleSample(0, snapshot([], [0.03, -0.97]));
    expect(state.getAxis(0, 0)).toBeCloseTo(0.03);
    expect(state.getAxis(0, 1)).toBeCloseTo(-0.97);
    // Uns sampled axis reads neutral, not an error.
    expect(state.getAxis(0, 5)).toBe(0);

    state.handleSample(0, snapshot([], [0.5]));
    expect(state.getAxis(0, 0)).toBeCloseTo(0.5);
    expect(state.getAxis(0, 1)).toBe(0);
  });

  it("ignores non-finite axis values from a broken sample", () => {
    const state = new GamepadState();

    state.handleSample(0, snapshot([], [Number.NaN, Number.POSITIVE_INFINITY, 0.4]));

    expect(state.getAxis(0, 0)).toBe(0);
    expect(state.getAxis(0, 1)).toBe(0);
    expect(state.getAxis(0, 2)).toBeCloseTo(0.4);
  });
});

describe("GamepadState connection and disconnection", () => {
  it("clears held buttons with released edges on disconnect", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true, true], [0.9]));

    state.handleDisconnected(0);

    expect(state.isConnected(0)).toBe(false);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.wasButtonReleased(0, 0)).toBe(true);
    expect(state.wasButtonReleased(0, 1)).toBe(true);
    expect(state.getAxes(0)).toEqual([]);
  });

  it("keeps released edges observable after disconnect until endFrame", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true]));

    state.handleDisconnected(0);
    state.endFrame();

    expect(state.wasButtonReleased(0, 0)).toBe(false);
  });

  it("starts a reconnected controller from a clean slate", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true], [0.9]));
    state.endFrame();
    state.handleDisconnected(0);

    state.handleSample(0, snapshot([false, false]));

    expect(state.isConnected(0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.getAxes(0)).toEqual([]);
  });

  it("treats a vacant index in a poll cycle as disconnected without stale state", () => {
    const state = new GamepadState();
    state.handleSample(1, snapshot([true]));

    // Slot 1's controller vanishes: nothing arrives for it this cycle.
    state.handleSample(0, snapshot([false]));

    // Only an explicit disconnect (or an adapter noticing the vacancy)
    // clears it; the sample for another index never does.
    expect(state.isConnected(1)).toBe(true);
    state.handleDisconnected(1);
    expect(state.isConnected(1)).toBe(false);
    expect(state.isButtonDown(1, 0)).toBe(false);
  });

  it("is a no-op to disconnect an unknown index", () => {
    const state = new GamepadState();

    expect(() => state.handleDisconnected(3)).not.toThrow();
    expect(state.connectedIndices()).toEqual([]);
  });
});

describe("GamepadState multiple controllers", () => {
  it("tracks controllers independently and sorts connected indices", () => {
    const state = new GamepadState();
    state.handleSample(2, snapshot([true]));
    state.handleSample(0, snapshot([false], [0.1]));

    expect(state.connectedIndices()).toEqual([0, 2]);
    expect(state.isButtonDown(2, 0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.getAxis(0, 0)).toBeCloseTo(0.1);
    expect(state.getAxis(2, 0)).toBe(0);

    // After the frame boundary, controller 0's press edge is observable and
    // controller 2's earlier edge is gone — states never bleed across slots.
    state.endFrame();
    state.handleSample(0, snapshot([true]));
    expect(state.wasButtonPressed(0, 0)).toBe(true);
    expect(state.wasButtonPressed(2, 0)).toBe(false);
  });

  it("resets edges for every controller at endFrame", () => {
    const state = new GamepadState();
    state.handleSample(0, snapshot([true]));
    state.handleSample(1, snapshot([true]));

    state.endFrame();

    expect(state.wasButtonPressed(0, 0)).toBe(false);
    expect(state.wasButtonPressed(1, 0)).toBe(false);
    expect(state.isButtonDown(0, 0)).toBe(true);
    expect(state.isButtonDown(1, 0)).toBe(true);
  });
});
