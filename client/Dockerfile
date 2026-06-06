# syntax=docker/dockerfile:1
# Production image for the dashboard web app (@farmflow/web), Next.js standalone.
# Build from the repo ROOT: `docker build -f client/Dockerfile -t farmflow-web .`
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
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
