/**
 * Player movement — pure, renderer-agnostic logic.
 *
 * This module uses only `@g2w/core` types (in fact, only a structural input
 * interface), so the template's unit test can drive it deterministically
 * without a browser, PixiJS, or real timers. Display objects stay in
 * `src/main.ts` at the adapter boundary.
 */

/** Codes checked by the default keyboard controls (InputState key codes). */
export const PLAYER_SIZE = 48;
export const PLAYER_SPEED = 160; // logical pixels per second

export interface MoveInput {
  isKeyDown(code: string): boolean;
}

export interface Position {
  x: number;
  y: number;
}

export interface Bounds {
  width: number;
  height: number;
}

/**
 * Computes the player's next position from held keys, scaled by the frame's
 * clamped `deltaTime` in seconds, and clamped to the logical bounds.
 */
export function nextPlayerPosition(
  input: MoveInput,
  position: Position,
  deltaTime: number,
  bounds: Bounds,
): Position {
  let moveX = 0;
  let moveY = 0;
  if (input.isKeyDown("KeyA") || input.isKeyDown("ArrowLeft")) {
    moveX -= 1;
  }
  if (input.isKeyDown("KeyD") || input.isKeyDown("ArrowRight")) {
    moveX += 1;
  }
  if (input.isKeyDown("KeyW") || input.isKeyDown("ArrowUp")) {
    moveY -= 1;
  }
  if (input.isKeyDown("KeyS") || input.isKeyDown("ArrowDown")) {
    moveY += 1;
  }
  const x = clamp(position.x + moveX * PLAYER_SPEED * deltaTime, 0, bounds.width - PLAYER_SIZE);
  const y = clamp(position.y + moveY * PLAYER_SPEED * deltaTime, 0, bounds.height - PLAYER_SIZE);
  return { x, y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
