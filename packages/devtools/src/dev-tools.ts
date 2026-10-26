import type { GameObject, GameObjectCollection, InputState, SceneManager } from "@g2w/core";
import { DevToolsError } from "./dev-tools-error.js";
import { FrameStats } from "./frame-stats.js";
import { LogBuffer, type LogEntry, type LogLevel } from "./log-buffer.js";
import {
  type InputWatch,
  type ObjectSummary,
  type SceneSummary,
  summarizeInput,
  summarizeObjects,
  summarizeScenes,
  summarizeTransform,
  type TransformSummary,
} from "./snapshot.js";

/**
 * Frame source for the overlay loop, injectable for deterministic tests. The
 * default implementation wraps `requestAnimationFrame`/`cancelAnimationFrame`.
 * The scheduler drives **only** the DevTools overlay — it never drives game
 * logic, so it is not a second game loop.
 */
export interface DevToolsScheduler {
  requestFrame(callback: (timeMs: number) => void): unknown;
  cancelFrame(handle: unknown): void;
}

/** The default browser frame source. */
export function rafScheduler(): DevToolsScheduler {
  return {
    requestFrame(callback) {
      return requestAnimationFrame(callback);
    },
    cancelFrame(handle) {
      cancelAnimationFrame(handle as number);
    },
  };
}

/** Where DevTools reads its information from. Everything is optional and read-only. */
export interface DevToolsOptions {
  /** Scene explorer source: scene names and the active scene key. */
  readonly scenes?: SceneManager;
  /**
   * Object list source: a `GameObjectCollection` (read through its snapshot
   * `objects()` accessor) or a function returning the current snapshot.
   */
  readonly objects?: GameObjectCollection | (() => readonly GameObject[]);
  /** Input monitor source, polled on the watched keys and buttons. */
  readonly input?: InputState;
  /** Key codes the input monitor polls. `InputState` has no key enumeration, so polling is explicit. */
  readonly watchKeys?: readonly string[];
  /** Pointer button indexes the input monitor polls. */
  readonly watchButtons?: readonly number[];
  /** Header title. Defaults to `"g2w DevTools"`. */
  readonly title?: string;
  /** Runtime-log capacity. Defaults to 200 entries; oldest entries are dropped first. */
  readonly logLimit?: number;
  /** Panel refresh rate in hertz. Defaults to 10. The frame loop itself runs every frame. */
  readonly refreshHz?: number;
  /** Document to build the overlay in. Defaults to the global `document`. */
  readonly document?: Document;
  /** Frame source. Defaults to `rafScheduler()`. */
  readonly scheduler?: DevToolsScheduler;
}

const DEFAULT_WATCH_KEYS = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Escape",
] as const;
const DEFAULT_WATCH_BUTTONS = [0, 1, 2] as const;
const RENDERED_LOGS = 50;

function el(doc: Document, tag: string, cssText: string, text?: string): HTMLElement {
  const element = doc.createElement(tag);
  element.style.cssText = cssText;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

// Shorthand so the class body can build elements in the injected document.
type El = (tag: string, cssText: string, text?: string) => HTMLElement;

const numberOr = (value: number | null | undefined, fallback: string): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : fallback;

/**
 * The development-only runtime inspector: a read-only DOM overlay that polls
 * the public g2w APIs it was given at construction time and displays scenes,
 * game objects, transforms, frame statistics, watched input, and a bounded
 * runtime log. Nothing mutates the game: DevTools holds references and reads
 * them, and its frame loop only refreshes the overlay.
 *
 * Lifecycle: construct → `open()` ⇄ `close()` → `dispose()`. Disposal is
 * terminal and idempotent: it removes the overlay, cancels the overlay frame
 * loop, and clears the log buffer. It never disposes the game, the renderer,
 * scenes, input, or any shared resource — the runtime outlives DevTools.
 */
export class DevTools {
  readonly #options: DevToolsOptions;
  readonly #document: Document;
  readonly #scheduler: DevToolsScheduler;
  readonly #el: El;
  readonly #logs: LogBuffer;
  readonly #frameStats = new FrameStats();
  readonly #enabledLogLevels = new Set<LogLevel>(["info", "warn", "error"]);
  #watch: InputWatch;
  #disposed = false;
  #open = false;
  #frameHandle: unknown = null;
  #lastFrameTime: number | null = null;
  #refreshAccumulator = 0;
  #lastActiveScene: string | null = null;
  #selectedIndex: number | null = null;
  #root: HTMLElement | null = null;
  #sceneText: HTMLElement | null = null;
  #objectList: HTMLElement | null = null;
  #transformText: HTMLElement | null = null;
  #perfText: HTMLElement | null = null;
  #inputText: HTMLElement | null = null;
  #logList: HTMLElement | null = null;

  constructor(options: DevToolsOptions = {}) {
    this.#options = options;
    this.#document = options.document ?? globalThis.document;
    this.#scheduler = options.scheduler ?? rafScheduler();
    this.#el = (tag, cssText, text) => el(this.#document, tag, cssText, text);
    this.#logs = new LogBuffer(options.logLimit ?? 200);
    this.#watch = {
      keys: options.watchKeys ?? DEFAULT_WATCH_KEYS,
      buttons: options.watchButtons ?? DEFAULT_WATCH_BUTTONS,
    };
    if (
      options.refreshHz !== undefined &&
      (!Number.isFinite(options.refreshHz) || options.refreshHz <= 0)
    ) {
      throw new RangeError("DevTools refreshHz must be a positive number.");
    }
  }

  /** Whether the overlay is currently visible. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** Whether `dispose()` has run. Disposal is terminal. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** The bounded runtime log. DevTools itself logs scene transitions here. */
  get logs(): readonly LogEntry[] {
    return this.#logs.entries();
  }

  /** Writes one entry into the bounded runtime log. */
  log(level: LogLevel, message: string): void {
    this.#assertUsable("log");
    this.#logs.log(level, message);
    this.renderLogs();
  }

  /** Shows the overlay and starts the overlay frame loop. */
  open(): void {
    this.#assertUsable("open");
    if (this.#open) {
      return;
    }
    this.#open = true;
    this.#buildOverlay();
    this.#lastFrameTime = null;
    this.#refreshAccumulator = 0;
    this.#frameStats.clear();
    this.#scheduleFrame();
  }

  /** Hides the overlay and stops the overlay frame loop. The instance stays usable. */
  close(): void {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    this.#cancelFrame();
    this.#root?.remove();
    this.#root = null;
  }

  /** `open()` when closed, `close()` when open. */
  toggle(): void {
    if (this.#open) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Selects an object by its current positional index, or clears selection with `null`.
   * A non-integer or negative index is treated as "no selection" — the object list
   * uses positional labels, so only a valid position can name an object. Read-only.
   */
  select(index: number | null): void {
    this.#selectedIndex = index === null || (Number.isInteger(index) && index >= 0) ? index : null;
    if (this.#open) {
      this.refreshPanels();
    }
  }

  /**
   * Terminal and idempotent cleanup: closes the overlay, cancels the frame
   * loop, and clears the log buffer. It does **not** dispose the game, the
   * renderer, scenes, input, or any shared resource. Afterwards every method
   * that needs a live instance throws `DevToolsError`.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.close();
    this.#logs.clear();
  }

  #scheduleFrame(): void {
    this.#frameHandle = this.#scheduler.requestFrame((timeMs) => this.#frame(timeMs));
  }

  #cancelFrame(): void {
    if (this.#frameHandle !== null) {
      this.#scheduler.cancelFrame(this.#frameHandle);
      this.#frameHandle = null;
    }
  }

  #frame(timeMs: number): void {
    if (!this.#open) {
      this.#frameHandle = null;
      return;
    }
    if (this.#lastFrameTime !== null) {
      const deltaSeconds = Math.max(0, (timeMs - this.#lastFrameTime) / 1000);
      this.#frameStats.push(deltaSeconds);
      this.#refreshAccumulator += deltaSeconds;
      const refreshInterval = 1 / (this.#options.refreshHz ?? 10);
      if (this.#refreshAccumulator >= refreshInterval) {
        this.#refreshAccumulator = 0;
        this.refreshPanels();
      }
    }
    this.#lastFrameTime = timeMs;
    this.#scheduleFrame();
  }

  /** Rebuilds every panel from the current public state. Called on the overlay's refresh tick. */
  refreshPanels(): void {
    if (!this.#open || this.#disposed) {
      return;
    }
    this.refreshScene();
    this.refreshObjects();
    this.refreshTransform();
    this.refreshPerf();
    this.refreshInput();
    this.renderLogs();
  }

  #objectSnapshot(): readonly GameObject[] | null {
    const source = this.#options.objects;
    if (source === undefined) {
      return null;
    }
    try {
      return typeof source === "function" ? source() : source.objects();
    } catch {
      // A destroyed collection (or a failing provider) is a diagnostics
      // condition, not a crash: the overlay reports it and moves on.
      return null;
    }
  }

  refreshScene(): void {
    if (this.#sceneText === null) {
      return;
    }
    const scenes = this.#options.scenes;
    if (scenes === undefined) {
      this.#sceneText.textContent = "scenes: not connected";
      return;
    }
    const summary = summarizeScenes(scenes);
    this.#sceneText.textContent =
      `scenes: ${summary.names.length > 0 ? summary.names.join(", ") : "(none)"} — ` +
      `active: ${summary.active ?? "(none)"}`;
    if (summary.active !== this.#lastActiveScene) {
      this.#logs.log(
        "info",
        `scene: ${this.#lastActiveScene ?? "(none)"} → ${summary.active ?? "(none)"}`,
      );
      this.#lastActiveScene = summary.active;
    }
  }

  refreshObjects(): void {
    const list = this.#objectList;
    if (list === null) {
      return;
    }
    const snapshot = this.#objectSnapshot();
    if (snapshot === null) {
      list.replaceChildren(
        this.#el(
          "div",
          "",
          this.#options.objects === undefined
            ? "objects: not connected"
            : "objects: source unavailable",
        ),
      );
      return;
    }
    const summaries = summarizeObjects(snapshot);
    if (this.#selectedIndex !== null && this.#selectedIndex >= summaries.length) {
      this.#selectedIndex = null;
    }
    if (summaries.length === 0) {
      list.replaceChildren(this.#el("div", "", "objects: none registered"));
      return;
    }
    list.replaceChildren(
      ...summaries.map((summary, index) => {
        const row = this.#el(
          "div",
          "cursor: pointer;",
          `${summary.label} pos(${numberOr(summary.transform.x, "?")}, ${numberOr(summary.transform.y, "?")})` +
            `${summary.hasUpdate ? " [update]" : ""}${summary.hasDestroy ? " [destroy]" : ""}`,
        );
        row.dataset.index = String(index);
        if (index === this.#selectedIndex) {
          row.style.cssText += "outline: 1px solid #6cf;";
        }
        return row;
      }),
    );
  }

  refreshTransform(): void {
    const text = this.#transformText;
    if (text === null) {
      return;
    }
    const snapshot = this.#objectSnapshot();
    if (snapshot === null || this.#selectedIndex === null) {
      text.textContent = "transform: no object selected (click a row above)";
      return;
    }
    const object = snapshot[this.#selectedIndex];
    if (object === undefined) {
      text.textContent = "transform: selected object is gone";
      return;
    }
    const summary: TransformSummary = summarizeTransform(object.transform);
    text.textContent =
      `transform ${this.#selectedIndex} — x: ${summary.x.toFixed(1)} y: ${summary.y.toFixed(1)} ` +
      `rot: ${summary.rotation.toFixed(3)} scale: ${summary.scaleX.toFixed(2)}/${summary.scaleY.toFixed(2)}`;
  }

  refreshPerf(): void {
    const text = this.#perfText;
    if (text === null) {
      return;
    }
    const fps = this.#frameStats.fps;
    const frameMs = this.#frameStats.frameMs;
    // The overlay measures its own frame loop; the game's internal deltaTime
    // is not exposed by the framework, so it is reported as unsupported.
    text.textContent =
      `fps: ${fps === null ? "measuring…" : fps.toFixed(0)} — ` +
      `frame: ${frameMs === null ? "measuring…" : `${frameMs.toFixed(1)} ms`} — ` +
      `game deltaTime: unsupported (not exposed by @g2w/core)`;
  }

  refreshInput(): void {
    const text = this.#inputText;
    if (text === null) {
      return;
    }
    const input = this.#options.input;
    if (input === undefined) {
      text.textContent = "input: not connected";
      return;
    }
    const summary = summarizeInput(input, this.#watch);
    const pointer = summary.hasPointerPosition
      ? `pointer: ${summary.pointerX?.toFixed(0)}, ${summary.pointerY?.toFixed(0)}`
      : "pointer: —";
    const keys = Object.entries(summary.keys)
      .filter(([, held]) => held)
      .map(([code]) => code);
    const buttons = Object.entries(summary.buttons)
      .filter(([, held]) => held)
      .map(([button]) => `b${button}`);
    text.textContent =
      `${pointer} — keys held: ${keys.length > 0 ? keys.join("+") : "(none)"} — ` +
      `buttons held: ${buttons.length > 0 ? buttons.join("+") : "(none)"}`;
  }

  renderLogs(): void {
    const list = this.#logList;
    if (list === null) {
      return;
    }
    const entries = this.#logs.entries(this.#enabledLogLevels).slice(-RENDERED_LOGS);
    list.replaceChildren(
      ...entries.map((entry) =>
        this.#el("div", "", `[${entry.seq}] ${entry.level}: ${entry.message}`),
      ),
    );
    if (entries.length === 0) {
      list.replaceChildren(this.#el("div", "", "logs: (empty for the selected severities)"));
    }
  }

  #buildOverlay(): void {
    const body = this.#document.body;
    if (body === null || body === undefined) {
      throw new DevToolsError("DevTools.open requires a document with a body.");
    }
    const root = this.#el(
      "div",
      "position: fixed; right: 8px; bottom: 8px; width: 340px; max-height: 70vh; overflow: auto;" +
        "background: #11151c; color: #d6e2f0; font: 12px/1.5 monospace; padding: 8px;" +
        "border: 1px solid #2a3547; border-radius: 6px; z-index: 2147483647; user-select: none;",
    );
    const stop = (event: Event): void => {
      event.stopPropagation();
    };
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup", "pointermove"]) {
      root.addEventListener(type, stop);
    }

    const header = this.#el(
      "div",
      "display: flex; gap: 6px; align-items: center; margin-bottom: 6px;",
    );
    header.appendChild(this.#el("strong", "flex: 1;", this.#options.title ?? "g2w DevTools"));
    const threeD = this.#el(
      "button",
      "background: #1a2230; color: #5a6a80; border: 1px solid #2a3547; border-radius: 4px; padding: 2px 6px;",
      "3D — Coming Soon",
    ) as HTMLButtonElement;
    threeD.disabled = true;
    threeD.title = "3D inspection is not implemented.";
    header.appendChild(threeD);
    const minimize = this.#el(
      "button",
      "background: #1a2230; color: #d6e2f0; border: 1px solid #2a3547; border-radius: 4px; padding: 2px 6px;",
      "_",
    );
    minimize.addEventListener("click", () => {
      bodySection.style.display = bodySection.style.display === "none" ? "block" : "none";
    });
    header.appendChild(minimize);
    const closeButton = this.#el(
      "button",
      "background: #1a2230; color: #d6e2f0; border: 1px solid #2a3547; border-radius: 4px; padding: 2px 6px;",
      "×",
    );
    closeButton.addEventListener("click", () => this.close());
    header.appendChild(closeButton);
    root.appendChild(header);

    const bodySection = this.#el("div", "display: flex; flex-direction: column; gap: 6px;");
    const section = (heading: string): HTMLElement => {
      const box = this.#el("div", "border: 1px solid #2a3547; border-radius: 4px; padding: 4px;");
      box.appendChild(this.#el("div", "color: #8fa8c7;", heading));
      return box;
    };

    const sceneBox = section("Scene Explorer");
    this.#sceneText = this.#el("div", "", "");
    sceneBox.appendChild(this.#sceneText);
    bodySection.appendChild(sceneBox);

    const objectBox = section("Objects (game objects)");
    this.#objectList = this.#el("div", "display: flex; flex-direction: column;");
    this.#objectList.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const index = target?.dataset?.index;
      this.select(index === undefined ? null : Number(index));
    });
    objectBox.appendChild(this.#objectList);
    bodySection.appendChild(objectBox);

    const transformBox = section("Transform Inspector (read-only)");
    this.#transformText = this.#el("div", "", "");
    transformBox.appendChild(this.#transformText);
    bodySection.appendChild(transformBox);

    const perfBox = section("Performance");
    this.#perfText = this.#el("div", "", "");
    perfBox.appendChild(this.#perfText);
    bodySection.appendChild(perfBox);

    const inputBox = section("Input (watched keys/buttons)");
    this.#inputText = this.#el("div", "", "");
    inputBox.appendChild(this.#inputText);
    bodySection.appendChild(inputBox);

    const logBox = section("Runtime Logs");
    const filterRow = this.#el("div", "display: flex; gap: 4px; margin-bottom: 4px;");
    for (const level of ["info", "warn", "error"] as const) {
      const toggle = this.#el(
        "button",
        "background: #1a2230; color: #d6e2f0; border: 1px solid #2a3547; border-radius: 4px; padding: 1px 5px;",
        level,
      );
      toggle.addEventListener("click", () => {
        if (this.#enabledLogLevels.has(level)) {
          this.#enabledLogLevels.delete(level);
        } else {
          this.#enabledLogLevels.add(level);
        }
        this.renderLogs();
      });
      filterRow.appendChild(toggle);
    }
    logBox.appendChild(filterRow);
    this.#logList = this.#el("div", "max-height: 120px; overflow: auto;");
    logBox.appendChild(this.#logList);
    bodySection.appendChild(logBox);

    root.appendChild(bodySection);
    body.appendChild(root);
    this.#root = root;
    this.refreshPanels();
  }

  #assertUsable(operation: string): void {
    if (this.#disposed) {
      throw new DevToolsError(`DevTools.${operation}: the instance has been disposed.`);
    }
  }
}

/**
 * Creates a DevTools instance. Construction has no side effects; call
 * `open()` to show the overlay. See {@link DevToolsOptions} for the sources.
 */
export function createDevTools(options: DevToolsOptions = {}): DevTools {
  return new DevTools(options);
}

/** Re-exported for consumers that want the exact log shape. */
export type { InputWatch, LogEntry, LogLevel, ObjectSummary, SceneSummary, TransformSummary };
