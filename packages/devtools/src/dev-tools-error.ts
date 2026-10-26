/**
 * Error thrown when `@g2w/devtools` is used against its documented contract —
 * for example opening or logging after `dispose()`.
 */
export class DevToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevToolsError";
  }
}
