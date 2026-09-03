# ---- build stage: compile a standalone binary ----
FROM oven/bun:1-alpine AS build

WORKDIR /app

COPY package.json bun.lock* ./
# Frozen install: a lockfile drift must fail the build, not silently install
# different dependency versions.
RUN bun install --frozen-lockfile

COPY src/ ./src/
COPY tsconfig.json ./

# Compile to a single self-contained executable (faster cold start, smaller runtime image).
RUN bun build --compile --minify --outfile=slackcrawl src/index.ts

# ---- runtime stage ----
FROM oven/bun:1-alpine

# wget (busybox) is used by the healthcheck.
WORKDIR /app
COPY --from=build /app/slackcrawl /usr/local/bin/slackcrawl

RUN mkdir -p /data && chown -R bun:bun /data

ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

# Run as the unprivileged user shipped with the base image.
USER bun

# Respect a custom PORT (the $${...} escaping defers expansion to the runtime shell).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$${PORT:-8080}/health" >/dev/null 2>&1 || exit 1

CMD ["slackcrawl", "serve"]
