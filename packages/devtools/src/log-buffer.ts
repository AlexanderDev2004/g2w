/** Severity levels for the DevTools runtime log. */
export type LogLevel = "info" | "warn" | "error";

/** One bounded-buffer log entry. `seq` is the append counter — ordering only, not a clock. */
export interface LogEntry {
  readonly seq: number;
  readonly level: LogLevel;
  readonly message: string;
}

/**
 * A fixed-capacity log buffer: appending past the limit drops the oldest
 * entries, so a long-running game cannot grow it without bound. Filtering is
 * a read-time concern — entries are never removed by a filter change.
 */
export class LogBuffer {
  readonly #limit: number;
  readonly #entries: LogEntry[] = [];
  #nextSeq = 0;

  constructor(limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("LogBuffer limit must be a positive integer.");
    }
    this.#limit = limit;
  }

  /** How many entries are currently buffered. */
  get size(): number {
    return this.#entries.length;
  }

  /** The buffer capacity. */
  get limit(): number {
    return this.#limit;
  }

  /** Appends one entry, dropping the oldest entry when the buffer is full. */
  log(level: LogLevel, message: string): void {
    if (this.#entries.length >= this.#limit) {
      this.#entries.shift();
    }
    this.#entries.push({ seq: this.#nextSeq++, level, message });
  }

  /**
   * The buffered entries, oldest first, optionally restricted to the given
   * levels. The returned array is a fresh copy.
   */
  entries(levels?: ReadonlySet<LogLevel>): readonly LogEntry[] {
    if (levels === undefined) {
      return [...this.#entries];
    }
    return this.#entries.filter((entry) => levels.has(entry.level));
  }

  /** Removes every entry. The sequence counter keeps increasing. */
  clear(): void {
    this.#entries.length = 0;
  }
}
