# syntax=docker/dockerfile:1
# Production image for the public storefront (@fermeribg/storefront), Next.js standalone.
# Build from the repo ROOT: `docker build -f storefront/Dockerfile -t fermeribg-storefront .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
# NEXT_PUBLIC_* are inlined into the bundle at build time (Vite), so they arrive
# as build args from CI, not runtime env.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=""
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_STOREFRONT_NAME=""
ARG NEXT_PUBLIC_STOREFRONT_EMAIL=""
ARG NEXT_PUBLIC_STOREFRONT_PHONE=""
ARG NEXT_PUBLIC_STOREFRONT_SLUG=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_STOREFRONT_NAME=$NEXT_PUBLIC_STOREFRONT_NAME \
    NEXT_PUBLIC_STOREFRONT_EMAIL=$NEXT_PUBLIC_STOREFRONT_EMAIL \
    NEXT_PUBLIC_STOREFRONT_PHONE=$NEXT_PUBLIC_STOREFRONT_PHONE \
    NEXT_PUBLIC_STOREFRONT_SLUG=$NEXT_PUBLIC_STOREFRONT_SLUG
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@fermeribg/storefront..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3003 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/storefront/.next/standalone ./
COPY --from=build /app/storefront/.next/static ./storefront/.next/static
COPY --from=build /app/storefront/public ./storefront/public
EXPOSE 3003
USER node
CMD ["node", "storefront/server.js"]
