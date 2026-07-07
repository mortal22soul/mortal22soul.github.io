# mortal22soul.github.io

Personal portfolio site, built with Astro 5, Tailwind CSS, and MDX.

> Live at [https://mortal22soul.github.io](https://mortal22soul.github.io)

---

## Commands

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `pnpm install`         | Install dependencies                               |
| `pnpm dev`             | Start dev server locally                           |
| `pnpm dev:network`     | Start dev server with `--host` (accessible on LAN) |
| `pnpm build`           | Run `astro check` then build the static site       |
| `pnpm preview`         | Preview the production build locally               |
| `pnpm preview:network` | Preview with `--host`                              |
| `pnpm lint`            | Run ESLint over the project                        |
| `pnpm lint:fix`        | Run ESLint and auto-fix issues                     |

> **pnpm** is the required package manager. `npm install` or `yarn` will not work as expected.

---

## Architecture

This is an **Astro 5** static site (`astro-nano`), outputting a pre-rendered static build to `dist/`.

### Stack

- **Astro 5** with **MDX** for blog posts
- **Tailwind CSS 3** + `@tailwindcss/typography` for styling
- **TypeScript** with path aliases (`@/*` → `./src/*`)
- **@astrojs/sitemap** for sitemap generation
- **@astrojs/rss** for RSS feeds
- **ESLint** with `eslint-plugin-astro`, `@typescript-eslint`, and `eslint-plugin-jsx-a11y`
- Fonts: **Inter** (sans) and **Lora** (serif) via `@fontsource/*`

### Source layout

| Path                           | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `src/pages/`                   | File-based routing — index, blog, projects, work pages, RSS, robots.txt |
| `src/layouts/PageLayout.astro` | Shared page layout                                                      |
| `src/components/`              | Reusable Astro components                                               |
| `src/content/blog/`            | Blog posts (MDX)                                                        |
| `src/content/projects/`        | Project entries                                                         |
| `src/content/work/`            | Work experience entries                                                 |
| `src/styles/global.css`        | Global CSS (imports Tailwind)                                           |
| `src/consts.ts`                | Site metadata (name, email, social links)                               |
| `src/lib/utils.ts`             | Utility helpers                                                         |
| `src/types.ts`                 | TypeScript type definitions                                             |

### Content Collections

Blog, work, and projects use typed Zod schemas defined in `src/content/config.ts`. Entries live in `src/content/<collection>/` as MDX/Markdown files with frontmatter.

### Styling

- Dark mode is class-based (`darkMode: ["class"]`)
- ESLint rules: semicolons required, double quotes, strict null checks

> Based on [astro-nano](https://github.com/markhorn-dev/astro-nano) by Mark Horn.
