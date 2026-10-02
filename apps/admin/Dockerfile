# syntax=docker/dockerfile:1

# Fiona's admin app: SvelteKit + adapter-node.
# The build context is the REPO ROOT (the app depends on the shared workspace packages):
#
#   docker build -f apps/admin/Dockerfile -t fionas-admin .
#   docker run --rm -p 3000:3000 --env-file .env fionas-admin
#
# Keep NODE_VERSION in sync with .nvmrc / package.json "engines".
ARG NODE_VERSION=26.9.0

# ---- build: install everything, build the app --------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo

# Manifests first so the install layer is cached until a dependency changes.
COPY package.json package-lock.json .npmrc ./
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/public/package.json apps/public/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY packages packages
COPY apps/admin apps/admin
RUN npm run build --workspace=@fionas/admin

# ---- prod-deps: runtime dependencies only ------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages packages
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,target=/root/.npm     npm ci --omit=dev --ignore-scripts --workspace=@fionas/admin --include-workspace-root=false

# ---- runtime ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production     HOST=0.0.0.0     PORT=3000
WORKDIR /repo/apps/admin

COPY --from=prod-deps --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/apps/admin/build ./build
COPY --from=build --chown=node:node /repo/apps/admin/package.json ./package.json

USER node
EXPOSE 3000

# No curl in the slim image, so probe with node. /login answers 200 without a session or backend.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3     CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',{redirect:'manual'}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"

CMD ["node", "build/index.js"]
