# syntax=docker/dockerfile:1
# Production image for the delivery panel (@fermeribg/delivery-web), Next.js standalone.
# Build from the repo ROOT: `docker build -f delivery-web/Dockerfile -t fermeribg-delivery-web .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@fermeribg/delivery-web..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3003 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/delivery-web/.next/standalone ./
COPY --from=build /app/delivery-web/.next/static ./delivery-web/.next/static
COPY --from=build /app/delivery-web/public ./delivery-web/public
EXPOSE 3003
USER node
CMD ["node", "delivery-web/server.js"]
