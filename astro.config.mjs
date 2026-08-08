import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";

export default defineConfig({
  integrations: [tailwind(), react(), sitemap()],
  output: "static",
  site: "https://image-to-stl.com",
  trailingSlash: "never",
});
import sitemap from "@astrojs/sitemap";
