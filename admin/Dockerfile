# syntax=docker/dockerfile:1
# Production image for the admin app (@farmflow/admin), Next.js standalone.
# Build from the repo ROOT: `docker build -f admin/Dockerfile -t farmflow-admin .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
# Sentry DSN is NOT baked — it is read at runtime from the container env
# (SENTRY_DSN, set in Dokploy). See sentry.*.config.ts + src/app/layout.tsx.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@farmflow/admin..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3002 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/admin/.next/standalone ./
COPY --from=build /app/admin/.next/static ./admin/.next/static
COPY --from=build /app/admin/public ./admin/public
EXPOSE 3002
USER node
CMD ["node", "admin/server.js"]
