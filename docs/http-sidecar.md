# Transports and the HTTP sidecar

## Transports

- **stdio** (local mode): `npx smart-subtitle-converter-mcp`, started by the MCP client ([clients.md](clients.md)).
- **Streamable HTTP** (sidecar mode): `smart-subtitle-converter-mcp --http 0.0.0.0:3000`, endpoint `/mcp`,
  stateless. Requires an inbound token: clients send `Authorization: Bearer <token>`. `GET /healthz` is the only
  unauthenticated path. Generate a token with:

  ```sh
  openssl rand -hex 32 > secrets/mcp_token.txt
  ```

  The inbound token is separate from the API key and is never sent upstream. `--hosted` (hosted mode) refuses
  to start; it isn't available yet.

In HTTP mode, `SUBTITLE_MCP_ALLOWED_HOSTS` and `SUBTITLE_MCP_ALLOWED_ORIGINS` guard against DNS rebinding and
cross-origin calls ([configuration.md](configuration.md)). Name the allowed folders with
`SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS`; client-offered extras do not apply here.

## Reference Compose

The API and the MCP side by side on an internal network, with the MCP reachable on `127.0.0.1:3000`. Replace
`X.Y.Z` with release tags whose major.minor match (see the [CHANGELOG](../CHANGELOG.md)); pin them, never `latest`.

```yaml
services:
  api:
    image: ghcr.io/wauter/smart-subtitle-converter-api:X.Y.Z      # pinned, never latest
    read_only: true
    tmpfs: [/tmp]
    networks: [internal]
    # API_KEYS / API_KEYS_FILE optional
    # environment: { STORAGE_LIST_ENABLED: "true" }     # optional: let the MCP browse the API's storage
  mcp:
    image: ghcr.io/wauter/smart-subtitle-converter-mcp:X.Y.Z      # same major.minor as the API
    read_only: true
    environment:
      SUBTITLE_API_URL: http://api:8080              # container port on the internal network (host port 8080 is not involved)
      SUBTITLE_MCP_READONLY_DIRS: /data/in
      SUBTITLE_MCP_ALLOWED_DIRS: /data/out
      SUBTITLE_MCP_ALLOWED_HOSTS: mcp,localhost,127.0.0.1
      SUBTITLE_MCP_HTTP_TOKEN_FILE: /run/secrets/mcp_token   # required
      # SUBTITLE_API_KEY_FILE: /run/secrets/api_key          # the only upstream key
      # SUBTITLE_MCP_LIST_ENABLED: "true"                    # optional: list_files and preview_text by location
    volumes:
      - /mnt/share/subtitles-in:/data/in:ro
      - /mnt/share/subtitles-out:/data/out:rw   # .subtitle-mcp-staging/ is created here; must be writable by uid 65532
    ports: ["127.0.0.1:3000:3000"]
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "dist/healthcheck.js"]
    networks: [internal]
    secrets: [mcp_token]
    depends_on: [api]
networks:
  internal: {}
secrets:
  mcp_token:
    file: ./secrets/mcp_token.txt               # openssl rand -hex 32 > secrets/mcp_token.txt
```

The image is distroless (Node.js, `nonroot`), works on a read-only rootfs and writes nothing outside the mounted
output folders.
