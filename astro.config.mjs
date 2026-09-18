import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  integrations: [tailwind(), react(), sitemap()],
  output: "static",
  site: "https://www.image-2-stl.com",
  trailingSlash: "always",
  build: {
    // The whole site shares one small stylesheet (~7 KiB). Inlining it removes the
    // render-blocking request entirely instead of trading it for a FOUC.
    inlineStylesheets: "always",
  },
});
