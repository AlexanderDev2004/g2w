import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  site: "https://g2w.alexanderar.com",
  base: "/",
  integrations: [react()],
});
