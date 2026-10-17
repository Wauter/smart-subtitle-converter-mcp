# syntax=docker/dockerfile:1.7
# subtitleedit-converter-mcp: MCP server for the Subtitle Edit Converter API (spec §15.1).
# Build: node:22-slim (npm ci, build). Runtime: distroless nodejs22, nonroot, no shell, read-only rootfs friendly.

FROM node:22-slim AS build
WORKDIR /src
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build \
 && node dist/index.js --version

FROM gcr.io/distroless/nodejs22-debian12:nonroot
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="subtitleedit-converter-mcp" \
      org.opencontainers.image.description="MCP server for the Subtitle Edit Converter API (community wrapper around Subtitle Edit libse; not an official Subtitle Edit project)" \
      org.opencontainers.image.source="https://github.com/Wauter/subtitleedit-converter-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
# The bundle is self-contained (no node_modules). No temp files are written: zips are built in memory and
# staging files go to <output-root>/.subtitle-mcp-staging/ on the mounted output volume (D-38).
COPY --from=build /src/dist ./dist
COPY LICENSE README.md ./
ENV NODE_ENV=production
EXPOSE 3000
# Sidecar mode: an inbound token is required (SUBTITLE_MCP_HTTP_TOKEN or _FILE), see README.
CMD ["dist/index.js", "--http", "0.0.0.0:3000"]
