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
Tunable settings go in a `.env` next to the file, passed in with `env_file` (Docker Compose 2.24 or later for
`required: false`); for example `S3_ALLOWED_BUCKETS=subs`, `SUBTITLE_MCP_LOG_LEVEL=debug`, or
`SUBTITLE_MCP_LIST_ENABLED=false` to hide browsing (on by default, and API locations only when the API allows it).
`environment:` keeps only wiring that must match the mounts, secrets and network, plus defaults written as
`${VAR:-default}`: values under `environment:` override `env_file`, so a setting placed there would silently win over
`.env`. Both services read the same `.env`; each ignores the other's variables.

```yaml
services:
  api:
    image: ghcr.io/wauter/smart-subtitle-converter-api:X.Y.Z      # pinned, never latest
    read_only: true
    tmpfs: [/tmp]
    networks: [internal]
    env_file: [{ path: .env, required: false }]
    environment:
      API_KEYS_FILE: /api_keys.txt                  # matches the mount; the API generates a key here on first start
      ALLOWED_HOSTS: "${ALLOWED_HOSTS:-api}"        # default: the host name the MCP uses in SUBTITLE_API_URL
    volumes:
      - ./api_keys.txt:/api_keys.txt:rw             # touch api_keys.txt && chmod 600 api_keys.txt && sudo chown 1654 api_keys.txt
  mcp:
    image: ghcr.io/wauter/smart-subtitle-converter-mcp:X.Y.Z      # same major.minor as the API
    read_only: true
    env_file: [{ path: .env, required: false }]
    environment:
      SUBTITLE_API_URL: http://api:8080              # the api service on the internal network (host port 8080 is not involved)
      SUBTITLE_MCP_READONLY_DIRS: /data/in           # match the volumes below
      SUBTITLE_MCP_ALLOWED_DIRS: /data/out
      SUBTITLE_MCP_ALLOWED_HOSTS: "${SUBTITLE_MCP_ALLOWED_HOSTS:-mcp,localhost,127.0.0.1}"
      SUBTITLE_MCP_HTTP_TOKEN_FILE: /run/secrets/mcp_token   # required; matches secrets below
      SUBTITLE_API_KEY_FILE: /run/secrets/api_key            # the only upstream key (a copy of the API's key, see below)
    volumes:
      - /mnt/share/subtitles-in:/data/in:ro
      - /mnt/share/subtitles-out:/data/out:rw   # .subtitle-mcp-staging/ is created here; must be writable by uid 65532
    ports: ["127.0.0.1:3000:3000"]
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "dist/healthcheck.js"]
    networks: [internal]
    secrets: [mcp_token, api_key]
    depends_on: [api]
networks:
  internal: {}
secrets:
  mcp_token:
    file: ./secrets/mcp_token.txt               # openssl rand -hex 32 > secrets/mcp_token.txt
  api_key:
    file: ./secrets/api_key.txt                 # a copy of the API's key, readable by uid 65532 (see below)
```

The API asks for a key by default. On its first start it writes one to `api_keys.txt` (owned by the API's user, 1654,
mode `600`), so the MCP (user 65532) can't read that file directly. Copy the key for the MCP once the API has started:

```bash
docker compose up -d api
sudo grep -v -e '^#' -e '^$' api_keys.txt | head -n 1 > secrets/api_key.txt
sudo chown 65532 secrets/api_key.txt && sudo chmod 600 secrets/api_key.txt
docker compose up -d
```

The MCP re-reads `SUBTITLE_API_KEY_FILE` when it changes, so a rotated key only needs a new copy. Details on keys,
`ALLOWED_HOSTS` and the other defaults: the API's
[Securing the API](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/security.md#securing-the-api).

The image is distroless (Node.js, `nonroot`), works on a read-only rootfs and writes nothing outside the mounted
output folders.
