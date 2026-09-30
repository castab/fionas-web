# fionas-web

Websites for **Fiona's Ice Cream**, a towable ice cream trailer serving Fresno & the Madera Ranchos
([@fionasicecream](https://www.instagram.com/fionasicecream/)).

npm-workspaces monorepo:

```
fionas-web/
├── apps/
│   ├── public/          # marketing site (SvelteKit) — the landing page today
│   └── admin/           # staff tools (SvelteKit) — placeholder shell for now
├── packages/
│   ├── ui/              # @fionas/ui — Svelte 5 components (Button, Badge, Card, Wordmark, toast…)
│   ├── design-tokens/   # @fionas/design-tokens — brand CSS tokens + Tailwind v4 theme
│   └── shared/          # @fionas/shared — framework-agnostic constants (site details, copy)
└── package.json
```

## Stack

- Svelte 5 (runes only) + SvelteKit 2 on Vite 8, `adapter-node`
- Tailwind CSS v4 (CSS-first config) + shadcn-svelte conventions (`tailwind-variants`)
- Vitest (browser mode for components) + Playwright (e2e)

## Getting started

Node **v26.9.0** is required (`.nvmrc`; `engine-strict` enforces it).

```bash
nvm use
npm install
npm run dev          # public site on http://localhost:5173
npm run dev:admin    # admin on http://localhost:5174
```

## Scripts (run from the repo root)

| Script                       | What it does                                      |
| ---------------------------- | ------------------------------------------------- |
| `npm run check`              | `tsc` / `svelte-check` in every workspace         |
| `npm run lint`               | Prettier check + ESLint                           |
| `npm run format`             | Prettier write                                    |
| `npm run test:unit -- --run` | Vitest once (bare `test:unit` starts watch mode)  |
| `npm run test:e2e`           | Playwright against a production build of each app |
| `npm run build`              | Build every app                                   |
