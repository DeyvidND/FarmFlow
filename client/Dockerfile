# syntax=docker/dockerfile:1
# Production image for the dashboard web app (@farmflow/web), Next.js standalone.
# Build from the repo ROOT: `docker build -f client/Dockerfile -t farmflow-web .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
# NEXT_PUBLIC_* are inlined into the bundle at build time (Vite), so they arrive
# as build args from CI, not runtime env.
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=""
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# Builds @farmflow/web plus its workspace deps in topo order.
RUN pnpm --filter "@farmflow/web..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output (outputFileTracingRoot = repo root) preserves the monorepo
# layout, so the server entrypoint is at client/server.js.
COPY --from=build /app/client/.next/standalone ./
COPY --from=build /app/client/.next/static ./client/.next/static
COPY --from=build /app/client/public ./client/public
EXPOSE 3000
USER node
CMD ["node", "client/server.js"]
