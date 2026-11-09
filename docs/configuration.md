# Configuration

Settings come from environment variables (most also have a flag). Unknown `SUBTITLE_MCP_*` variables fail startup
(typo protection). `smart-subtitle-converter-mcp --help` lists the flags.

| Variable | Flag | Default | Description |
|---|---|---|---|
| `SUBTITLE_API_URL` | `--api-url` | **required** | API base URL: `http://localhost:8080` for the API's Compose on your machine (host port 8080), `http://api:8080` from a container on the same Docker network (container port) |
| `SUBTITLE_API_KEY` / `SUBTITLE_API_KEY_FILE` | – | unset | Bearer key sent to the API (the only upstream key; never taken from requests) |
| `SUBTITLE_MCP_HTTP_TOKEN` / `SUBTITLE_MCP_HTTP_TOKEN_FILE` | – | unset | HTTP mode: inbound token(s), ≥ 32 chars, comma list / one per line, file re-read on change. Required with `--http` |
| `SUBTITLE_MCP_HTTP` | `--http [host:]port` | stdio | Serve Streamable HTTP on `/mcp` ([http-sidecar.md](http-sidecar.md)) |
| `SUBTITLE_MCP_HOSTED` | `--hosted` | `false` | Hosted mode (not available yet: refuses to start) |
| `SUBTITLE_MCP_ALLOWED_DIRS` | `--allow-dir` | unset | Read-write folders (`:`-separated, `;` on Windows, or a JSON array) |
| `SUBTITLE_MCP_READONLY_DIRS` | `--allow-dir-ro` | unset | Read-only folders |
| `SUBTITLE_MCP_USE_CLIENT_ROOTS` | – | `true` | Local mode: if a client still sends older MCP roots, add them to the configured folders ([folders-and-roots.md](folders-and-roots.md)) |
| `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS` | – | `3600000` | Age after which staging files are swept |
| `SUBTITLE_MCP_MAX_BYTES` | – | unset | Local cap per input file (effective cap = min with the API limit) |
| `SUBTITLE_MCP_TIMEOUT_MS` | – | `120000` | Per-attempt timeout for conversions (metadata: min(this, 15000)) |
| `SUBTITLE_MCP_RETRY_MAX_ATTEMPTS` | – | `3` | Retries for safe metadata/read-only calls; conversion POST is never replayed |
| `SUBTITLE_MCP_RETRY_MAX_WAIT_MS` | – | `60000` | Longest single `Retry-After` wait accepted |
| `SUBTITLE_MCP_RETRY_BUDGET_MS` | – | `90000` | Total retry wait per call |
| `SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` | – | `65536` | Size limit, in UTF-8 bytes, of subtitle text returned to the model (`get_job_file`, inline `convert_subtitle`); longer text is cut at a cue or line boundary and marked `truncated` |
| `SUBTITLE_MCP_JSON_MAX_DECODED_BYTES` | – | unset (10485760) | JSON decoded-content cap while `/v1/limits` is unreadable |
| `SUBTITLE_MCP_LIMITS_TTL_MS` | – | `300000` | `/v1/limits` cache TTL |
| `SUBTITLE_MCP_INCLUDE_DEBUG` | – | `false` | Pass the API's `debug` member into errors |
| `SUBTITLE_MCP_ALLOWED_ORIGINS` | – | unset | HTTP: allowed `Origin` values; with none set, only loopback origins are accepted |
| `SUBTITLE_MCP_ALLOWED_HOSTS` | – | `localhost,127.0.0.1,[::1]` + bind host | HTTP: `Host` allowlist (DNS rebinding) |
| `SUBTITLE_MCP_LOG_LEVEL` | `--log-level` | `info` | `error`, `warn`, `info`, `debug` (JSON lines on stderr) |
| `SUBTITLE_MCP_LOG_PATHS` | – | `false` | Log full paths instead of `sha256[:12]` + extension |

## Logging and privacy

Logs are JSON lines on stderr. Content, base64, profile values, API keys and tokens are never logged; paths are
hashed unless `SUBTITLE_MCP_LOG_PATHS=true`.

## API storage and asynchronous jobs

API `input`/`output` URIs are independent of MCP-local folders. Configure `STORAGE_FILE_ROOTS`,
`S3_ALLOWED_BUCKETS`/`S3_ALLOWED_PREFIXES` or `HTTP_ALLOWED_HOSTS` on the **API**, not this MCP.
Its `GET /v1/limits` describes enabled schemes, default wait, I/O and job retention settings; the limits
resource relays that response. Storage credentials belong to the API runtime, never tool arguments.

The MCP requests a wait equal to the smaller of its timeout (whole seconds) and the API's `requestMaxWaitSeconds` (fallback 60 if absent; requestWaitSeconds is informational only), and polls the
returned job on 202 within the remaining tool budget. Increase `SUBTITLE_MCP_TIMEOUT_MS` for slower work,
but prefer an API output URI: job metadata cannot replay subtitle bytes. Cancelling or timing out the MCP
does not cancel an admitted API job. Poll timeout reports `job-not-ready`; capture `jobId` and inspect it before resubmitting writes.

Explicit `ifExists:replace` is sufficient for local and API outputs; there is no separate operator gate.
See [tools](tools.md#api-storage-and-job-ids) and [writing files](writing-files.md#api-destinations-are-separate).
