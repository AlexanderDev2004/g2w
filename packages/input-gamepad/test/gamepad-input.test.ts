import { GamepadState } from "@g2w/core";
import { describe, expect, it } from "vitest";
import type { PolledGamepad } from "../src/index.js";
import { GamepadInput, GamepadInputError } from "../src/index.js";

function fakeGamepad(index: number, pressed: boolean[], axes: number[] = []): PolledGamepad {
  return { index, pressed, axes };
}

/** Minimal EventTarget double that records added/removed listeners. */
function fakeTarget() {
  const target = new EventTarget() as EventTarget & {
    added: { type: string; listener: EventListener }[];
    removed: { type: string; listener: EventListener }[];
  };
  const added: { type: string; listener: EventListener }[] = [];
  const removed: { type: string; listener: EventListener }[] = [];
  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);
  target.addEventListener = ((type: string, listener: EventListener) => {
    originalAdd(type, listener);
    added.push({ type, listener });
  }) as typeof target.addEventListener;
  target.removeEventListener = ((type: string, listener: EventListener) => {
    originalRemove(type, listener);
    removed.push({ type, listener });
  }) as typeof target.removeEventListener;
  target.added = added;
  target.removed = removed;
  return target;
}

/** Read the `gamepad.index` the way the real DOM event exposes it. */
function emitGamepadEvent(
  target: ReturnType<typeof fakeTarget>,
  type: string,
  index: number,
): void {
  const event = new Event(type) as Event & { gamepad?: { index: number } };
  event.gamepad = { index };
  target.dispatchEvent(event);
}

describe("GamepadInput lifecycle", () => {
  it("starts detached and attaches idempotently without duplicating listeners", () => {
    const state = new GamepadState();
    const connectTarget = fakeTarget();
    const disconnectTarget = fakeTarget();
    const input = new GamepadInput(state, { connectTarget, disconnectTarget });

    expect(input.attached).toBe(false);
    input.attach();
    input.attach();

    expect(input.attached).toBe(true);
    expect(connectTarget.added.filter((r) => r.type === "gamepadconnected")).toHaveLength(1);
    expect(disconnectTarget.added.filter((r) => r.type === "gamepaddisconnected")).toHaveLength(1);
  });

  it("removes every listener on dispose and is idempotent and terminal", () => {
    const state = new GamepadState();
    const connectTarget = fakeTarget();
    const disconnectTarget = fakeTarget();
    const input = new GamepadInput(state, { connectTarget, disconnectTarget });
    input.attach();

    input.dispose();
    input.dispose();

    expect(input.attached).toBe(false);
    expect(connectTarget.removed).toEqual(connectTarget.added);
    expect(disconnectTarget.removed).toEqual(disconnectTarget.added);
    expect(() => input.attach()).toThrow(GamepadInputError);
  });

  it("requires no gamepad hardware to construct or attach", () => {
    const state = new GamepadState();
    const input = new GamepadInput(state, {
      source: () => [null, null, null, null],
      connectTarget: new EventTarget(),
      disconnectTarget: new EventTarget(),
    });

    expect(() => input.attach()).not.toThrow();
    input.poll();
    expect(state.connectedIndices()).toEqual([]);
    input.dispose();
  });
});

describe("GamepadInput sampling", () => {
  it("feeds samples into the state and leaves vacant slots alone", () => {
    const state = new GamepadState();
    let slots: readonly (PolledGamepad | null)[] = [
      fakeGamepad(0, [true], [0.5]),
      null,
      fakeGamepad(2, [false]),
    ];
    const input = new GamepadInput(state, { source: () => slots });

    input.poll();

    expect(state.isConnected(0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(true);
    expect(state.wasButtonPressed(0, 0)).toBe(true);
    expect(state.getAxis(0, 0)).toBeCloseTo(0.5);
    expect(state.isConnected(1)).toBe(false);
    expect(state.isConnected(2)).toBe(true);
    expect(state.isButtonDown(2, 0)).toBe(false);

    // A later cycle without slot 0's controller: the adapter treats the
    // vacancy as a disconnect and clears the stale state.
    slots = [null, null, fakeGamepad(2, [false])];
    expect(() => input.poll()).not.toThrow();
    expect(state.isConnected(0)).toBe(false);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.wasButtonReleased(0, 0)).toBe(true);

    input.dispose();
  });

  it("disconnects indices that vanish from the source between polls", () => {
    const state = new GamepadState();
    const input = new GamepadInput(state, {
      source: () => [fakeGamepad(0, [true])],
    });
    input.poll();
    expect(state.isButtonDown(0, 0)).toBe(true);

    // Slot 0's controller vanished; the adapter now reports the vacancy.
    const absent = new GamepadInput(state, { source: () => [null] });
    absent.poll();

    expect(state.isConnected(0)).toBe(false);
    expect(state.isButtonDown(0, 0)).toBe(false);
    expect(state.wasButtonReleased(0, 0)).toBe(true);
    absent.dispose();
    input.dispose();
  });

  it("treats every poll between two endFrame calls as one frame of edges", () => {
    const state = new GamepadState();
    let pressed: boolean[] = [false];
    const input = new GamepadInput(state, {
      source: () => [fakeGamepad(0, pressed)],
    });

    input.poll();
    pressed = [true];
    input.poll();
    pressed = [false];
    input.poll();

    expect(state.wasButtonPressed(0, 0)).toBe(true);
    expect(state.wasButtonReleased(0, 0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(false);

    state.endFrame();
    expect(state.wasButtonPressed(0, 0)).toBe(false);
    input.dispose();
  });

  it("propagates source errors and recovers on the next poll", () => {
    const state = new GamepadState();
    let healthy = false;
    const input = new GamepadInput(state, {
      source: () => {
        if (!healthy) {
          throw new Error("getGamepads unavailable");
        }
        return [fakeGamepad(0, [true])];
      },
    });

    expect(() => input.poll()).toThrow("getGamepads unavailable");
    expect(state.connectedIndices()).toEqual([]);

    healthy = true;
    input.poll();
    expect(state.isConnected(0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(true);
    input.dispose();
  });
});

describe("GamepadInput connection events", () => {
  it("marks connectivity on connect/disconnect events without sampling", () => {
    const state = new GamepadState();
    const connectTarget = fakeTarget();
    const disconnectTarget = fakeTarget();
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget,
      disconnectTarget,
    });
    input.attach();

    emitGamepadEvent(connectTarget, "gamepadconnected", 1);
    expect(state.isConnected(1)).toBe(true);
    expect(state.isButtonDown(1, 0)).toBe(false);
    expect(state.getAxes(1)).toEqual([]);

    emitGamepadEvent(disconnectTarget, "gamepaddisconnected", 1);
    expect(state.isConnected(1)).toBe(false);
    input.dispose();
  });

  it("ignores malformed connection events", () => {
    const state = new GamepadState();
    const connectTarget = fakeTarget();
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget,
      disconnectTarget: new EventTarget(),
    });
    input.attach();

    connectTarget.dispatchEvent(new Event("gamepadconnected"));
    expect(state.connectedIndices()).toEqual([]);
    input.dispose();
  });

  it("stops observing connection events after dispose", () => {
    const state = new GamepadState();
    const connectTarget = fakeTarget();
    const disconnectTarget = fakeTarget();
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget,
      disconnectTarget,
    });
    input.attach();
    input.dispose();

    emitGamepadEvent(connectTarget, "gamepadconnected", 0);
    emitGamepadEvent(disconnectTarget, "gamepaddisconnected", 0);

    expect(state.isConnected(0)).toBe(false);
  });
});

/**
 * E3-C attachment failure safety: partial listener registration failure
 * rolls back completely, cleanup failures never mask the registration
 * error, and sampling cannot mutate the state after disposal.
 */
describe("GamepadInput attachment failure safety (E3-C)", () => {
  /** A fake target that throws on demand for registration or removal. */
  function failingTarget() {
    const target = fakeTarget();
    let failAddType: string | null = null;
    let failRemoveType: string | null = null;
    const originalAdd = target.addEventListener.bind(target);
    const originalRemove = target.removeEventListener.bind(target);
    target.addEventListener = ((type: string, listener: EventListener) => {
      if (failAddType === type) {
        throw new Error(`addEventListener failed for ${type}`);
      }
      originalAdd(type, listener);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, listener: EventListener) => {
      if (failRemoveType === type) {
        throw new Error(`removeEventListener failed for ${type}`);
      }
      originalRemove(type, listener);
    }) as typeof target.removeEventListener;
    return {
      target,
      failRegistrationOn: (type: string | null) => {
        failAddType = type;
      },
      failRemovalOn: (type: string | null) => {
        failRemoveType = type;
      },
    };
  }

  it("rolls back every listener when registration fails part-way and stays retryable", () => {
    const state = new GamepadState();
    const connect = failingTarget();
    const disconnect = failingTarget();
    // gamepadconnected registers fine on the connect target;
    // gamepaddisconnected (second registration) throws on the disconnect target.
    disconnect.failRegistrationOn("gamepaddisconnected");
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget: connect.target,
      disconnectTarget: disconnect.target,
    });

    expect(() => input.attach()).toThrow("addEventListener failed for gamepaddisconnected");
    expect(input.attached).toBe(false);

    // The rolled-back connect listener feeds nothing.
    emitGamepadEvent(connect.target, "gamepadconnected", 3);
    expect(state.isConnected(3)).toBe(false);

    // Retry fully succeeds once the failure is gone.
    disconnect.failRegistrationOn(null);
    input.attach();
    expect(input.attached).toBe(true);
    emitGamepadEvent(connect.target, "gamepadconnected", 3);
    expect(state.isConnected(3)).toBe(true);
    emitGamepadEvent(disconnect.target, "gamepaddisconnected", 3);
    expect(state.isConnected(3)).toBe(false);

    input.dispose();
  });

  it("preserves the registration error alongside rollback cleanup failures", () => {
    const state = new GamepadState();
    const connect = failingTarget();
    const disconnect = failingTarget();
    // gamepadconnected registers fine on the connect target;
    // gamepaddisconnected throws on the disconnect target, and the already
    // registered connect listener fails to roll back.
    disconnect.failRegistrationOn("gamepaddisconnected");
    connect.failRemovalOn("gamepadconnected");
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget: connect.target,
      disconnectTarget: disconnect.target,
    });

    let caught: unknown;
    try {
      input.attach();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe(
      "addEventListener failed for gamepaddisconnected",
    );
    expect((aggregate.errors[1] as Error).message).toBe(
      "removeEventListener failed for gamepadconnected",
    );
    expect(input.attached).toBe(false);
  });

  it("reports cleanup failures from dispose while staying terminal", () => {
    const state = new GamepadState();
    const connect = failingTarget();
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget: connect.target,
      disconnectTarget: new EventTarget(),
    });
    input.attach();

    connect.failRemovalOn("gamepadconnected");
    expect(() => input.dispose()).toThrow(AggregateError);
    expect(() => input.dispose()).not.toThrow();
    expect(() => input.attach()).toThrow(GamepadInputError);
    expect(input.attached).toBe(false);
  });

  it("rejects poll after disposal and leaves the state untouched", () => {
    const state = new GamepadState();
    const input = new GamepadInput(state, {
      source: () => [fakeGamepad(0, [true])],
      connectTarget: new EventTarget(),
      disconnectTarget: new EventTarget(),
    });
    input.attach();
    input.dispose();

    // Sampling stays caller-driven; after disposal it cannot mutate the
    // caller-owned state at all.
    expect(() => input.poll()).toThrow(GamepadInputError);
    expect(state.isConnected(0)).toBe(false);
    expect(state.connectedIndices()).toEqual([]);

    // The caller-owned state remains directly usable.
    state.handleSample(0, { pressed: [true], axes: [] });
    expect(state.isConnected(0)).toBe(true);
    expect(state.isButtonDown(0, 0)).toBe(true);
  });

  it("retains listeners whose rollback failed so dispose can retry the removal", () => {
    const state = new GamepadState();
    const connect = failingTarget();
    const disconnect = failingTarget();
    disconnect.failRegistrationOn("gamepaddisconnected");
    // gamepadconnected registered fine, then the disconnect registration
    // threw; the connect rollback removal also throws, so the listener
    // would be stranded without retention.
    connect.failRemovalOn("gamepadconnected");
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget: connect.target,
      disconnectTarget: disconnect.target,
    });

    expect(() => input.attach()).toThrow(AggregateError);
    expect(input.attached).toBe(false);

    // Documented window: the stranded listener is still live until the
    // retry in dispose() succeeds.
    emitGamepadEvent(connect.target, "gamepadconnected", 4);
    expect(state.isConnected(4)).toBe(true);

    // dispose() retries the failed removal and wins, leaving no live
    // listener behind.
    connect.failRemovalOn(null);
    expect(() => input.dispose()).not.toThrow();
    expect(connect.target.removed.filter((r) => r.type === "gamepadconnected")).toHaveLength(1);
    emitGamepadEvent(connect.target, "gamepadconnected", 5);
    expect(state.isConnected(5)).toBe(false);
  });

  it("leaves no stale tracking when the first registration fails", () => {
    const state = new GamepadState();
    const connect = failingTarget();
    const disconnect = failingTarget();
    connect.failRegistrationOn("gamepadconnected");
    const input = new GamepadInput(state, {
      source: () => [],
      connectTarget: connect.target,
      disconnectTarget: disconnect.target,
    });

    let caught: unknown;
    try {
      input.attach();
    } catch (error) {
      caught = error;
    }
    // Nothing was registered, so this is the plain registration error —
    // not an aggregate — with no listener tracked on either target.
    expect(caught).not.toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toBe("addEventListener failed for gamepadconnected");
    expect(connect.target.added).toHaveLength(0);
    expect(connect.target.removed).toHaveLength(0);
    expect(disconnect.target.added).toHaveLength(0);

    // Retry registers every listener exactly once.
    connect.failRegistrationOn(null);
    input.attach();
    expect(input.attached).toBe(true);
    expect(connect.target.added.filter((r) => r.type === "gamepadconnected")).toHaveLength(1);
    emitGamepadEvent(connect.target, "gamepadconnected", 6);
    expect(state.isConnected(6)).toBe(true);
    input.dispose();
  });
});
