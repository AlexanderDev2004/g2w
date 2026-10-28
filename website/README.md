# g2w website

Documentation website for **g2w (Game to Website)**, built with Astro + React
islands and a standalone design system ("Cartridge Manual": paper + ink, 2px
borders, offset shadows, signal orange).

This folder is deliberately **not** a member of the pnpm workspace and is
excluded from the root Biome config — it has its own toolchain.

## Commands

Run from this directory:

- `pnpm install` — install dependencies.
- `pnpm dev` — dev server.
- `pnpm build` — static build into `dist/`.
- `pnpm preview` — preview the production build.

## Layout

- `src/lib/marks.ts` — pixel logo marks (single source of truth for the brand
  marks: Konsep C icon + Konsep A navbar lockup, rendered as inline SVG).
- `src/components/PixelMark.astro` — renders a pixel grid as crisp SVG rects.
- `src/components/DocsSidebar.astro` — shared docs sidebar (single nav list).
- `src/components/react/Installer.tsx` — package-manager tabs island.
- `src/layouts/Base.astro` — html shell, navbar, footer.
- `src/styles/global.css` — the whole design system.
- `src/pages/` — landing page plus `docs/*` content pages.

Docs content is handwritten to match the implemented framework (packages under
`packages/`, template under `packages/create-g2w/template/`). Update it when
the public API or package list changes.
