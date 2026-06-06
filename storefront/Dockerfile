# syntax=docker/dockerfile:1
# Production image for the public storefront (@farmflow/storefront), Next.js standalone.
# Build from the repo ROOT: `docker build -f storefront/Dockerfile -t farmflow-storefront .`
FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@farmflow/storefront..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3003 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/storefront/.next/standalone ./
COPY --from=build /app/storefront/.next/static ./storefront/.next/static
COPY --from=build /app/storefront/public ./storefront/public
EXPOSE 3003
USER node
CMD ["node", "storefront/server.js"]
