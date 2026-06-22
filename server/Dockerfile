# syntax=docker/dockerfile:1
# Production image for the NestJS API (@fermeribg/api).
# Build from the repo ROOT: `docker build -f server/Dockerfile -t fermeribg-api .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ── Install + build the api and its workspace deps (@fermeribg/db, @fermeribg/types) ──
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# `@fermeribg/api...` builds the api plus its workspace dependencies in topo order.
RUN pnpm --filter "@fermeribg/api..." run build
# Produce an isolated, prod-only deployment (bundles built workspace deps).
RUN pnpm --filter @fermeribg/api deploy --prod /app/deploy

# ── Slim runtime image ──
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/deploy/node_modules ./node_modules
COPY --from=build /app/deploy/package.json ./package.json
COPY --from=build /app/server/dist ./dist
# Drizzle SQL migrations run on boot (main.ts → runMigrations, using the
# drizzle-orm migrator). Copy the migration folder next to the @fermeribg/db
# package so it resolves at runtime (the prod deploy bundle may omit non-dist
# files). Must include drizzle/meta/_journal.json + the *.sql files.
COPY --from=build /app/packages/db/drizzle ./node_modules/@fermeribg/db/drizzle
# The API listens on PORT (default 3000) and exposes GET /health for healthchecks.
ENV PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
