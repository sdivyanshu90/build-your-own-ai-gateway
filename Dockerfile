# syntax=docker/dockerfile:1.7
# =============================================================================
# Multi-stage build for the AI gateway.
#
#   deps      — install ALL dependencies once (cached layer)
#   builder   — compile TypeScript → dist; also serves as the MIGRATOR image
#               (it retains tsx + src + the .sql migrations) for `npm run db:migrate`
#   prod-deps — a clean, production-only node_modules
#   runtime   — distroless, non-root; ships only dist + production deps
#
# The runtime image contains no shell, package manager, or compilers, which
# dramatically shrinks the attack surface. Migrations run from the `builder`
# target as a separate Job/step (see docker-compose.yml and k8s/cronjob.yaml).
# =============================================================================

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production dependencies and compiled output only.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
# Run as the built-in non-root user.
USER nonroot
EXPOSE 8080
# The distroless nodejs image's entrypoint is `node`; pass args via CMD.
CMD ["--enable-source-maps", "dist/index.js"]
