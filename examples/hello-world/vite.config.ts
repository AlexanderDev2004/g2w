import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      // Develop against workspace package sources so `pnpm dev` works without
      // a prior `pnpm build`.
      "@g2w/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@g2w/input-dom": fileURLToPath(
        new URL("../../packages/input-dom/src/index.ts", import.meta.url),
      ),
      "@g2w/renderer-pixi": fileURLToPath(
        new URL("../../packages/renderer-pixi/src/index.ts", import.meta.url),
      ),
    },
  },
});
