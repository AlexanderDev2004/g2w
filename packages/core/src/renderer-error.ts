/**
 * Error thrown for invalid renderer lifecycle usage, such as initializing a
 * renderer twice or disposing a renderer that was never initialized.
 */
export class RendererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererError";
  }
}
