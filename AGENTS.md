# AGENTS.md

Fiona's Ice Cream websites. npm-workspaces monorepo: `apps/public` (marketing site), `apps/admin`
(staff tools, placeholder), and shared packages `@fionas/ui`, `@fionas/design-tokens`,
`@fionas/shared`. Stack mirrors `castab/madres-ui`: SvelteKit 2, Svelte 5 runes-only, Vite 8,
Tailwind v4, shadcn-svelte conventions, Vitest + Playwright.

## Where to look

| Need                                     | Read                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| Brand colors, type, spacing tokens       | `packages/design-tokens/src/tokens.css`                   |
| Tailwind utilities for those tokens      | `packages/design-tokens/src/theme.css`                    |
| Components (Button, Badge, Card, toast…) | `packages/ui/src/components/`                             |
| Site details, coming-soon copy           | `packages/shared/src/`                                    |
| Landing page                             | `apps/public/src/routes/+page.svelte`, `$lib/components/` |

## Commands (run from the repo root)

- Node **v26.9.0** (`.nvmrc`, `engine-strict`).
- `npm run check` must report 0 errors and 0 warnings; `npm run lint` must be clean.
- `npm run test:unit -- --run`; `npm run test:e2e` (builds each app, runs Playwright desktop + mobile).

## Rules

- **Svelte 5 runes only**: `$state` / `$derived` / `$props` / `$effect`, snippets not slots,
  `onclick` not `on:click`, `$app/state` not `$app/stores`. Type props explicitly.
- **Style with tokens**, not raw hex: `bg-olive-700`, `text-(--text-muted)`, `[font:var(--type-body)]`.
  The design system's `--text-*` font shorthands are named `--type-*` here (Tailwind owns `--text-*`).
  Don't combine a `[font:…]` shorthand with `text-[size]` on the same element — use discrete utilities.
- Components in `packages/ui` use relative imports (no `$lib`) because apps consume the raw source.
  New classes there are picked up via the `@source` line in each app's `layout.css`.
- Booking is not built. Book CTAs use `ComingSoonButton`: `aria-disabled`, raises the toast, never
  navigates or submits. Playwright needs `click({ force: true })` on them.
- Light mode only. Motion 120–220ms ease-out, no bounces. Radii: pill / 16 / 10 / 6.
