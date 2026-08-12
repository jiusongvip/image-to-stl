import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  integrations: [tailwind(), react(), sitemap()],
  output: "static",
  site: "https://image-to-stl.com",
  trailingSlash: "never",
});
