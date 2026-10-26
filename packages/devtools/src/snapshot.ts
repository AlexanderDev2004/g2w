import type { InputState, SceneManager, Transform2D } from "@g2w/core";

/**
 * Read-only summaries built from the public g2w APIs. These are the DevTools'
 * only view of the running game: nothing here reads private fields, and
 * information the model does not expose is reported as `null`/`"unsupported"`
 * rather than invented.
 */

/** Scene names and the active scene key, from `SceneManager`'s public surface. */
export interface SceneSummary {
  readonly names: readonly string[];
  readonly active: string | null;
}

export function summarizeScenes(scenes: SceneManager): SceneSummary {
  return {
    names: scenes.keys,
    active: scenes.active,
  };
}

/**
 * A plain copy of a `Transform2D`'s public properties. This is the DevTools
 * transform inspector's entire surface: the five public fields, read-only.
 */
export interface TransformSummary {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function summarizeTransform(transform: Transform2D): TransformSummary {
  return {
    x: transform.x,
    y: transform.y,
    rotation: transform.rotation,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
  };
}

/**
 * One inspectable game object. `label` is a **positional label** (`#0`, `#1`,
 * …) derived from the collection's current insertion order — it is not a
 * stable identity, and it shifts when objects are added or removed. The
 * framework has no object IDs, so DevTools does not invent them.
 */
export interface ObjectSummary {
  readonly label: string;
  readonly transform: TransformSummary;
  readonly hasUpdate: boolean;
  readonly hasDestroy: boolean;
}

/** The object shape DevTools inspects — the core `GameObject` contract. */
export interface InspectableObject {
  readonly transform: Transform2D;
  update?(deltaTime: number): void;
  destroy?(): void;
}

/**
 * Summarize a snapshot of game objects. The caller supplies the snapshot
 * (typically `GameObjectCollection.objects()`) so this stays a pure function.
 */
export function summarizeObjects(objects: readonly InspectableObject[]): ObjectSummary[] {
  return objects.map((object, index) => ({
    label: `#${index}`,
    transform: summarizeTransform(object.transform),
    hasUpdate: typeof object.update === "function",
    hasDestroy: typeof object.destroy === "function",
  }));
}

/** Keys and buttons DevTools watches on the input state. */
export interface InputWatch {
  readonly keys: readonly string[];
  readonly buttons: readonly number[];
}

/** The state of the watched keys and buttons plus the pointer, read-only. */
export interface InputSummary {
  readonly hasPointerPosition: boolean;
  readonly pointerX: number | null;
  readonly pointerY: number | null;
  /** Watched key code → held state. Keys the model cannot enumerate are simply not listed. */
  readonly keys: Readonly<Record<string, boolean>>;
  /** Watched button index → held state. */
  readonly buttons: Readonly<Record<string, boolean>>;
}

/**
 * Summarize the watched subset of an `InputState`. `InputState` exposes only
 * per-code queries (no enumeration of held keys), so DevTools polls an
 * explicit watch list; unwatched keys are invisible by design.
 */
export function summarizeInput(input: InputState, watch: InputWatch): InputSummary {
  const keys: Record<string, boolean> = {};
  for (const code of watch.keys) {
    keys[code] = input.isKeyDown(code);
  }
  const buttons: Record<string, boolean> = {};
  for (const button of watch.buttons) {
    buttons[String(button)] = input.isButtonDown(button);
  }
  return {
    hasPointerPosition: input.hasPointerPosition,
    pointerX: input.hasPointerPosition ? input.pointerX : null,
    pointerY: input.hasPointerPosition ? input.pointerY : null,
    keys,
    buttons,
  };
}
