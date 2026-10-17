# Subtitle Edit Converter MCP

`subtitleedit-converter-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents
convert subtitles. It is a thin TypeScript client over
[subtitleedit-converter-api](https://github.com/Wauter/subtitleedit-converter-api) and does no conversion itself.

It is part of a community wrapper around Subtitle Edit's `libse`, **not an official Subtitle Edit project**.

> **Private, unreleased.** No npm package or public image exists yet; every publish step is gated behind the repo
> variable `PUBLISH_ENABLED` (default `false`).

## Versions

- **The MCP shares the API's version number.** MCP `1.1.0` pairs with API `1.1.0` and they are released together.
- **`package.json` `version` is bumped on every change that ships** (any merged change to `src/`, the Dockerfile or the
  bundled output). A patch may differ within a pair; major.minor must match.
- **Minimum API:** 1.1.0. At startup the MCP reads `/healthz` and logs the API version. If major.minor differs from its
  own it logs a warning (and adds an `mcp-api-version-mismatch` warning to conversion results). It also
  feature-detects `GET /v1/limits` (200/401 = present) and warns if it is missing. There are no fallbacks for older APIs;
  run matching pairs.

## Tools

| Tool | API endpoint | Purpose |
|---|---|---|
| `list_formats` | `GET /v1/formats` | Formats (id, name, extensions, read/write, text/binary); `includeBinary`, `writableOnly`, `limit` |
| `list_presets` | `GET /v1/profiles` | Built-in and mounted presets, with validity and load errors |
| `get_profile` | `GET /v1/profiles/{name}` | Raw and resolved preset JSON |
| `validate_profile` | `POST /v1/profiles/validate` | Validate a profile (inline or `profilePath`); pointer-level errors with hints |
| `detect_format` | `POST /v1/detect` | Format, encoding and language of inline content or a `path` |
| `convert_subtitle` | `POST /v1/convert/json` | Convert one file: inline content or `path`, result inline or to `outputPath`/`outputDir` |
| `convert_batch` | `POST /v1/convert/json` (base64 zip, chunked) | Convert a folder or list of files into a **new** folder, all or nothing |

Resources: `subtitleedit://schemas/profile.json`, `subtitleedit://formats`, `subtitleedit://limits`.

Errors come back as `isError: true` with a structured `error` (`source`, `code`, `detail`, `hint`, `requestId`, and
for local write failures `path` + `osError`). Report every warning the tools return (e.g. `frame-rate-changed`: an EBU
STL frame-rate code mismatch, timings move by less than one frame with no cumulative drift).

### Writing files

- **`convert_subtitle`** writes through a staging file in `<output-root>/.subtitle-mcp-staging/` and commits it with an
  atomic link/rename. `ifExists`: `error` (default), `archive` (renames the old file to `<name>.<UTC timestamp>.bak`),
  and, only with `SUBTITLE_MCP_ALLOW_DESTRUCTIVE=true`, `replace` and `delete`. Nothing is ever suffixed (`_2`).
- **`convert_batch`** requires an `outputDir` that does **not exist yet**. Outputs are staged in
  `<output-root>/.subtitle-mcp-staging/<dirname>.<6hex>.partial/`; only when every file has converted and been written
  is that folder renamed to `outputDir` (missing parent folders are created just before). On any failure the staging
  folder is deleted and nothing is written; the result lists the failing file(s) with a hint.
- The staging folder must be on the same filesystem as the destination. A mount inside an output root fails with
  `cross-device` (configure that mount as its own output root); there is never a non-atomic copy.
- Stale staging files and folders (older than `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS`) are swept at startup and periodically,
  only inside `.subtitle-mcp-staging/`. No state is stored.
- **Race windows** (documented, small):
  - On filesystems without hard links (many SMB shares, FAT/exFAT) a single-file commit is a plain `rename` right after
    an `lstat`, so a file created at the same instant by another program could be overwritten.
  - A batch commit is `lstat` + `rename(staging, outputDir)`. POSIX `rename` replaces an **empty** directory created in
    between; that loses no data.

## Transports

- **stdio** (local mode): `npx subtitleedit-converter-mcp`, started by the MCP client.
- **Streamable HTTP** (sidecar mode): `subtitleedit-converter-mcp --http 0.0.0.0:3000`, endpoint `/mcp`, stateless.
  Requires an inbound token: clients send `Authorization: Bearer <token>`. `GET /healthz` is the only unauthenticated
  path. Generate a token with:

  ```sh
  openssl rand -hex 32 > secrets/mcp_token.txt
  ```

  The inbound token is separate from the API key and is never sent upstream. `--hosted` refuses to start in v1.

## Configuration

Unknown `SUBTITLE_MCP_*` variables fail startup (typo protection).

| Variable | Flag | Default | Description |
|---|---|---|---|
| `SUBTITLE_API_URL` | `--api-url` | **required** | API base URL: `http://localhost:4041` for the API's Compose on your machine (host port 4041), `http://api:8080` from a container on the same Docker network (container port) |
| `SUBTITLE_API_KEY` / `SUBTITLE_API_KEY_FILE` | – | unset | Bearer key sent to the API (the only upstream key; never taken from requests) |
| `SUBTITLE_MCP_HTTP_TOKEN` / `SUBTITLE_MCP_HTTP_TOKEN_FILE` | – | unset | HTTP mode: inbound token(s), ≥ 32 chars, comma list / one per line, file re-read on change. Required with `--http` |
| `SUBTITLE_MCP_HTTP` | `--http [host:]port` | stdio | Serve Streamable HTTP on `/mcp` |
| `SUBTITLE_MCP_HOSTED` | `--hosted` | `false` | Hosted hardening (not available in v1) |
| `SUBTITLE_MCP_ALLOWED_DIRS` | `--allow-dir` | unset | Read-write roots (`:`-separated, `;` on Windows, or a JSON array) |
| `SUBTITLE_MCP_READONLY_DIRS` | `--allow-dir-ro` | unset | Read-only roots |
| `SUBTITLE_MCP_USE_CLIENT_ROOTS` | – | `true` | Local mode: use the client's `roots/list` when no folders are configured |
| `SUBTITLE_MCP_ALLOW_DESTRUCTIVE` | – | `false` | Allow `ifExists: replace/delete` in convert_subtitle |
| `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS` | – | `3600000` | Age after which staging files/folders are swept |
| `SUBTITLE_MCP_MAX_BYTES` | – | unset | Local cap per input file (effective cap = min with the API limit) |
| `SUBTITLE_MCP_TIMEOUT_MS` | – | `120000` | Per-attempt timeout for conversions (metadata: min(this, 15000)) |
| `SUBTITLE_MCP_RETRY_MAX_ATTEMPTS` | – | `3` | Retries for 429/503/connection errors |
| `SUBTITLE_MCP_RETRY_MAX_WAIT_MS` | – | `60000` | Longest single `Retry-After` wait accepted |
| `SUBTITLE_MCP_RETRY_BUDGET_MS` | – | `90000` | Total retry wait per call (per chunk for batches) |
| `SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` | – | `65536` | Larger inline text outputs come back as an embedded resource |
| `SUBTITLE_MCP_BATCH_MAX_FILES` | – | `1000` | Max files per convert_batch call |
| `SUBTITLE_MCP_BATCH_MAX_ENTRIES` / `_BATCH_MAX_BYTES` | – | unset | Chunking fallback when `/v1/limits` is unreadable |
| `SUBTITLE_MCP_BATCH_MAX_RESPONSE_BYTES` | – | `67108864` | Cap on the estimated JSON response per batch chunk |
| `SUBTITLE_MCP_JSON_MAX_DECODED_BYTES` | – | unset (10485760) | JSON decoded-content cap while `/v1/limits` is unreadable |
| `SUBTITLE_MCP_LIMITS_TTL_MS` | – | `300000` | `/v1/limits` cache TTL |
| `SUBTITLE_MCP_INCLUDE_DEBUG` | – | `false` | Pass the API's `debug` member into errors |
| `SUBTITLE_MCP_ALLOWED_ORIGINS` | – | unset | HTTP: allowed `Origin` values; with none set, only loopback origins are accepted |
| `SUBTITLE_MCP_ALLOWED_HOSTS` | – | `localhost,127.0.0.1,[::1]` + bind host | HTTP: `Host` allowlist (DNS rebinding) |
| `SUBTITLE_MCP_LOG_LEVEL` | `--log-level` | `info` | `error`, `warn`, `info`, `debug` (JSON lines on stderr) |
| `SUBTITLE_MCP_LOG_PATHS` | – | `false` | Log full paths instead of `sha256[:12]` + extension |

Content, base64, profile values, API keys and tokens are never logged.

## Client configuration

```jsonc
// Claude Desktop / Cursor (stdio)
{ "mcpServers": { "subtitleedit": {
    "command": "npx", "args": ["-y", "subtitleedit-converter-mcp"],
    "env": { "SUBTITLE_API_URL": "http://localhost:4041",
             "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/Subtitles" } } } }
```

Claude Code (stdio):

```bash
claude mcp add --transport stdio \
  --env SUBTITLE_API_URL=http://localhost:4041 \
  --env SUBTITLE_MCP_ALLOWED_DIRS=/Users/me/Subtitles \
  subtitleedit -- node /path/to/subtitleedit-converter-mcp/dist/index.js
```

`http://localhost:4041` is the host port the API's `docker-compose.yml` publishes (bound to `127.0.0.1`; the
container itself listens on 8080). If you changed that mapping, use your host port here.

On Windows some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "subtitleedit-converter-mcp"]`, and
`SUBTITLE_MCP_ALLOWED_DIRS` uses `;` as the separator. Until the package is published, point `command` at
`node /path/to/subtitleedit-converter-mcp/dist/index.js` after `npm ci && npm run build`.

### Allowed folders

The MCP only reads and writes files inside its allowed folders. Every tool that takes a path lists them in its
description, each marked read-write or read-only, e.g. `Allowed folders: /Users/me/Subtitles (read-write),
/Volumes/Masters (read-only).` With none available, the descriptions say so and name the settings below.

- **Claude Desktop doesn't pass its own approved folders to MCP servers.** It advertises the MCP roots capability
  but answers `roots/list` with an empty list, so folders you approve in a Claude chat never reach this server.
  Set `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and/or `SUBTITLE_MCP_READONLY_DIRS` (read-only) in its config.
- **Claude Code and other roots-capable clients** can supply folders automatically: when no folders are
  configured (and `SUBTITLE_MCP_USE_CLIENT_ROOTS` isn't `false`), the client's workspace roots are used as
  read-write folders. When they change, the tool descriptions are rebuilt and `notifications/tools/list_changed` is sent.
- **Configured folders always win** (D-13): when `SUBTITLE_MCP_ALLOWED_DIRS` or `SUBTITLE_MCP_READONLY_DIRS` is set,
  client roots are never requested, so an empty or failing `roots/list` can't remove or replace them.
- Roots are deprecated as of MCP protocol `2026-07-28` (SEP-2577), so configuration stays the primary mechanism;
  client roots are a convenience while clients still send them.
- Every `roots/list` answer is logged at `info` level (count, folders hashed unless `SUBTITLE_MCP_LOG_PATHS=true`,
  and skipped entries with the reason), so the client's MCP log shows what it actually sent.

## Sidecar (reference Compose)

A copy of the reference Compose from the API repo:

```yaml
services:
  api:
    image: ghcr.io/wauter/subtitleedit-converter-api:1.1.1      # pinned, never latest
    read_only: true
    tmpfs: [/tmp]
    networks: [internal]
    # API_KEYS / API_KEYS_FILE optional
  mcp:
    image: ghcr.io/wauter/subtitleedit-converter-mcp:1.1.2      # pinned, never latest
    read_only: true
    environment:
      SUBTITLE_API_URL: http://api:8080              # container port on the internal network (host port 4041 is not involved)
      SUBTITLE_MCP_READONLY_DIRS: /data/in
      SUBTITLE_MCP_ALLOWED_DIRS: /data/out
      SUBTITLE_MCP_ALLOWED_HOSTS: mcp,localhost,127.0.0.1
      SUBTITLE_MCP_HTTP_TOKEN_FILE: /run/secrets/mcp_token   # required
      # SUBTITLE_API_KEY_FILE: /run/secrets/api_key          # the only upstream key
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

The image is distroless (`nodejs22-debian12:nonroot`), works on a read-only rootfs and writes nothing outside the
mounted output roots.

## Development

```sh
npm ci
npm run lint && npm run typecheck
npm test                     # unit + MCP-level
npm run build && npm run test:e2e
scripts/contract.sh ghcr.io/wauter/subtitleedit-converter-api:edge   # contract suite against a real API image
```

The contract suite can also target a running API: `CONTRACT_API_URL=http://127.0.0.1:4041 npm run test:contract` (the API's Compose)
(add `CONTRACT_API_KEY` and `CONTRACT_SMALL_LIMITS=1` for an API started with `API_KEYS`, `MAX_UPLOAD_BYTES=1048576`
and `ZIP_MAX_ENTRIES=3`). In CI the contract job pulls the pinned private API image; it is skipped (with a notice)
when the image can't be pulled, unless the repo variable `CONTRACT_REQUIRED=true`.

### Smoke checklist (Claude Desktop / Cursor, MCP Inspector)

1. `tools/list` shows the seven tools; `convert_batch` only when a writable root is configured.
2. `list_formats` returns `subrip`, `webvtt`, `ebustl`.
3. `convert_subtitle` with inline SRT → WebVTT returns the text inline.
4. `convert_subtitle` with `path` + `outputDir`: the file appears atomically; a second run fails with `output-exists`.
5. `convert_batch` into a new folder: the folder appears complete; a run with one broken file writes nothing and names it.
6. HTTP mode: a request without the token gets 401; `/healthz` answers without one.

## License

MIT, see [LICENSE](LICENSE).

Formerly `subtitleedit-mcp` (renamed 2026-10-17 with the API, formerly `subtitleedit-api`).
