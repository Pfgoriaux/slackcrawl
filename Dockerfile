FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p /data

ENV DATA_DIR=/data

VOLUME ["/data"]

EXPOSE 8080

CMD ["bun", "run", "src/index.ts", "serve"]
