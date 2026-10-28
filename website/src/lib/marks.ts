/**
 * G2W pixel marks — single source of truth.
 *
 * Characters: "#" = ink, "o" = signal orange, "." = empty.
 * Rendered as inline SVG (crispEdges) so no JavaScript is needed on the page.
 *
 * - MARK_ICON   (19×7)  Konsep C — d-pad lives inside the G bowl, orange
 *                        buttons sit in the W valley. App icon / favicon scale.
 * - LOCKUP_NAVBAR (37×7) Konsep A — gamepad | G 2 W | browser window, all
 *                        baseline-aligned. Navbar / wordmark lockup.
 */

export type PixelChar = "#" | "o" | ".";
export type PixelGrid = readonly PixelChar[][];

const LETTER_G: readonly string[] = [
  ".###.",
  "#...#",
  "#....",
  "#.###",
  "#...#",
  "#...#",
  ".###.",
];

const LETTER_2: readonly string[] = [
  ".###.",
  "#...#",
  "....#",
  "..##.",
  ".#...",
  "#....",
  "#####",
].map((row) => row.replaceAll("#", "o"));

const LETTER_W: readonly string[] = [
  "#...#",
  "#...#",
  "#...#",
  "#.#.#",
  "#.#.#",
  "##.##",
  "#...#",
];

/** Konsep C — G with a d-pad carved into its bowl. */
const G_FUSED: readonly string[] = [
  ".###.",
  "#.#.#",
  "#.#.#",
  "#.###",
  "#...#",
  "#...#",
  ".###.",
];

/** Konsep C — W with two orange action buttons in its valleys. */
const W_FUSED: readonly string[] = [
  "#...#",
  "#o.o#",
  "#...#",
  "#.#.#",
  "#.#.#",
  "##.##",
  "#...#",
];

/** Gamepad companion icon, 8×6 (Konsep A left flank). */
export const ICON_GAMEPAD: readonly string[] = [
  "........",
  "########",
  "#o....o#",
  "########",
  ".##..##.",
  "........",
];

/** Browser window companion icon, 8×6 (Konsep A right flank). */
export const ICON_WINDOW: readonly string[] = [
  "########",
  "#o.o.o.#",
  "########",
  "#......#",
  "#.####.#",
  "########",
];

function compose(width: number, height: number): PixelChar[][] {
  return Array.from({ length: height }, () => ".".repeat(width).split("")) as PixelChar[][];
}

function stamp(
  grid: PixelChar[][],
  art: readonly string[],
  ox: number,
  oy: number,
): PixelChar[][] {
  art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c !== "." && grid[oy + y] !== undefined) {
        grid[oy + y]![ox + x] = c as PixelChar;
      }
    }
  });
  return grid;
}

/** MARK_ICON — G (0,0) · 2 (6,0, orange) · W (12,0) = 19 wide × 7 tall. */
export const MARK_ICON: PixelGrid = (() => {
  const g = compose(19, 7);
  stamp(g, G_FUSED, 0, 0);
  stamp(g, LETTER_2, 6, 0);
  stamp(g, W_FUSED, 12, 0);
  return g.map((row) => [...row]) as PixelGrid;
})();

/** LOCKUP_NAVBAR — pad (0,1) · G (10) · 2 (16) · W (22) · win (29,1) = 37×7. */
export const LOCKUP_NAVBAR: PixelGrid = (() => {
  const g = compose(37, 7);
  stamp(g, ICON_GAMEPAD, 0, 1);
  stamp(g, LETTER_G, 10, 0);
  stamp(g, LETTER_2, 16, 0);
  stamp(g, LETTER_W, 22, 0);
  stamp(g, ICON_WINDOW, 29, 1);
  return g.map((row) => [...row]) as PixelGrid;
})();

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly char: PixelChar;
}

/** Flatten a grid into pixel rects; "." is skipped. */
export function toRects(grid: PixelGrid): readonly PixelRect[] {
  const rects: PixelRect[] = [];
  grid.forEach((row, y) => {
    row.forEach((char, x) => {
      if (char !== ".") rects.push({ x, y, char });
    });
  });
  return rects;
}

export function gridSize(grid: PixelGrid): { width: number; height: number } {
  return { width: grid[0]!.length, height: grid.length };
}
