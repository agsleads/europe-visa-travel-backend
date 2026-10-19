# syntax=docker/dockerfile:1
#
# Multi-stage build for the Europe Visa Centre enquiry API.
#
# The runtime stage carries production dependencies and compiled JS only: no
# TypeScript, no test fixtures, no build toolchain. It runs as the unprivileged
# `node` user because a lead-intake API has no reason to be root in its own
# container.

# ---------------------------------------------------------------------------
# Dependencies (full, including dev — needed to compile)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Build: tsc -> tsc-alias -> copy .sql migrations into dist/
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Fail the build here rather than at runtime if the migrations did not make it
# into the artifact. `migrate:prod` against an empty directory reports "no
# pending migrations" and leaves you with a schema-less database.
RUN test -n "$(ls -A dist/db/migrations/*.sql 2>/dev/null)" \
    || (echo 'FATAL: no .sql migrations in dist/db/migrations' && exit 1)

# ---------------------------------------------------------------------------
# Production dependencies only
# ---------------------------------------------------------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards SIGTERM to node, so the graceful shutdown in
# src/server.ts actually runs on `docker stop` instead of being SIGKILLed.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
