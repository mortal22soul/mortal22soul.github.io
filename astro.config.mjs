import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  output: "static",
  site: "https://mortal22soul.github.io",
  // Preserve v6 whitespace behavior between inline elements (v7 default changed to 'jsx')
  compressHTML: true,
  integrations: [mdx(), sitemap(), tailwind()],
});
