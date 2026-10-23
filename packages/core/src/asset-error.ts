/**
 * Error thrown when an `AssetManager` method is called in a state that does
 * not allow it, e.g. loading after disposal or constructing with invalid
 * options. Errors thrown by loaders themselves are not wrapped; they
 * propagate unchanged to the caller of `load`.
 */
export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}
