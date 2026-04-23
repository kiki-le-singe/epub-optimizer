# syntax=docker/dockerfile:1.7

# ============================================================
# Stage 1: base — pinned Node LTS + pnpm via Corepack
# ============================================================
FROM node:24-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /app

# ============================================================
# Stage 2: deps — install full dependencies (with devDeps)
# ============================================================
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ============================================================
# Stage 3: build — compile TypeScript + minify
# ============================================================
FROM deps AS build
COPY . .
RUN pnpm build

# ============================================================
# Stage 4: prod-deps — production-only node_modules
# ============================================================
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ============================================================
# Stage 5: epubcheck — download EPUBCheck (cached separately)
# ============================================================
FROM debian:bookworm-slim AS epubcheck
ARG EPUBCHECK_VERSION=5.3.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN wget -q "https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip" \
 && unzip -q "epubcheck-${EPUBCHECK_VERSION}.zip" \
 && mv "epubcheck-${EPUBCHECK_VERSION}" epubcheck \
 && rm "epubcheck-${EPUBCHECK_VERSION}.zip"

# ============================================================
# Stage 6: runtime — slim final image (no build tooling)
# ============================================================
FROM node:24-slim AS runtime

LABEL org.opencontainers.image.title="epub-optimizer" \
      org.opencontainers.image.description="Optimize EPUB files by compressing HTML, CSS, images, fonts and recompressing the archive" \
      org.opencontainers.image.source="https://github.com/kiki-le-singe/epub-optimizer" \
      org.opencontainers.image.licenses="MIT"

# Install Java JRE only (required by EPUBCheck)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Copy built artifacts, prod-only deps, and EPUBCheck
COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/package.json ./package.json
COPY --from=epubcheck --chown=node:node /opt/epubcheck    ./epubcheck

# Entrypoint wrapper
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/epub-files"]
USER node

ENTRYPOINT ["docker-entrypoint.sh"]
