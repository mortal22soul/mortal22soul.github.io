import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";

function rehypeMermaidCodeBlocks() {
  return (tree) => {
    function textContent(node) {
      if (node.type === "text") return node.value;
      if (!Array.isArray(node.children)) return "";
      return node.children.map(textContent).join("");
    }

    function visit(node) {
      if (!Array.isArray(node.children)) return;

      for (const child of node.children) {
        const code = child.children?.[0];
        const classes = code?.properties?.className;
        const isMermaid =
          child.properties?.dataLanguage === "mermaid" ||
          (Array.isArray(classes) && classes.includes("language-mermaid"));

        if (
          child.type === "element" &&
          child.tagName === "pre" &&
          code?.type === "element" &&
          code.tagName === "code" &&
          isMermaid
        ) {
          child.properties = { className: ["mermaid"] };
          child.children = [{ type: "text", value: textContent(code) }];
          continue;
        }

        visit(child);
      }
    }

    visit(tree);
  };
}

export default defineConfig({
  output: "static",
  site: "https://mortal22soul.github.io",
  // Preserve v6 whitespace behavior between inline elements (v7 default changed to 'jsx')
  compressHTML: true,
  integrations: [mdx(), sitemap(), tailwind()],
  markdown: {
    processor: unified({ rehypePlugins: [rehypeMermaidCodeBlocks] }),
  },
});
