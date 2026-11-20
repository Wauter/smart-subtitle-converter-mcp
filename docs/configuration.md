# Configuration

Settings come from environment variables (most also have a flag). Unknown `SUBTITLE_MCP_*` variables fail startup
(typo protection). `smart-subtitle-converter-mcp --help` lists the flags.

| Variable | Flag | Default | Description |
|---|---|---|---|
| `SUBTITLE_API_URL` | `--api-url` | **required** | API base URL: `http://localhost:8080` for the API's Compose on your machine (host port 8080), `http://api:8080` from a container on the same Docker network (container port) |
| `SUBTITLE_API_KEY` / `SUBTITLE_API_KEY_FILE` | – | unset | Bearer key sent to the API (the only upstream key; never taken from requests). The API needs one by default: point `SUBTITLE_API_KEY_FILE` at a file holding its key, such as a copy of the API's `api_keys.txt` (first non-comment line is used, re-read on change) |
| `SUBTITLE_MCP_HTTP_TOKEN` / `SUBTITLE_MCP_HTTP_TOKEN_FILE` | – | unset | HTTP mode: inbound token(s), ≥ 32 chars, comma list / one per line, file re-read on change. Required with `--http` |
| `SUBTITLE_MCP_HTTP` | `--http [host:]port` | stdio | Serve Streamable HTTP on `/mcp` ([http-sidecar.md](http-sidecar.md)) |
| `SUBTITLE_MCP_HOSTED` | `--hosted` | `false` | Hosted mode (not available yet: refuses to start) |
| `SUBTITLE_MCP_ALLOWED_DIRS` | `--allow-dir` | unset | Read-write folders (`:`-separated, `;` on Windows, or a JSON array) |
| `SUBTITLE_MCP_READONLY_DIRS` | `--allow-dir-ro` | unset | Read-only folders |
| `SUBTITLE_MCP_USE_CLIENT_ROOTS` | – | `true` | Local mode: if a client still sends older MCP roots, add them to the configured folders ([folders-and-roots.md](folders-and-roots.md)) |
| `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS` | – | `3600000` | Age after which staging files are swept |
| `SUBTITLE_MCP_MAX_BYTES` | – | unset | Local cap per input file (effective cap = min with the API limit) |
| `SUBTITLE_MCP_TIMEOUT_MS` | – | `45000` | Time limit for one whole tool call: request attempts, retry waits and job polling all fit inside it. Each metadata request attempt is also capped at 15000. See [Time limits](#time-limits) |
| `SUBTITLE_MCP_RETRY_MAX_ATTEMPTS` | – | `3` | Retries for safe metadata/read-only calls; conversion POST is never replayed |
| `SUBTITLE_MCP_RETRY_MAX_WAIT_MS` | – | `30000` | Longest single `Retry-After` wait accepted (always within the call's time limit) |
| `SUBTITLE_MCP_RETRY_BUDGET_MS` | – | `30000` | Total retry wait per call (always within the call's time limit, `SUBTITLE_MCP_TIMEOUT_MS`) |
| `SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES` | – | `32768` | `preview_text` page size, in UTF-8 bytes, when the call gives no `maxBytes`. The default keeps a page, once JSON-escaped, under the 50,000 characters above which Claude Code saves a result to a file instead of showing it ([Claude Code docs](https://code.claude.com/docs/en/mcp), checked on 2026-11-12). At least 4096 and at most `SUBTITLE_MCP_PREVIEW_MAX_BYTES` |
| `SUBTITLE_MCP_PREVIEW_MAX_BYTES` | – | `262144` | Largest `preview_text` page, in UTF-8 bytes; larger `maxBytes` requests are lowered to it, and a single cue over it can't be previewed (`preview-cue-too-large`). 4096 to 1048576 |
| `SUBTITLE_MCP_PREVIEW_CACHE_BYTES` | – | `67108864` | Memory for cached `preview_text` texts (64 MiB). Least recently used entries go first; a text bigger than the whole cache isn't cached. `0` turns the cache off |
| `SUBTITLE_MCP_PREVIEW_CACHE_TTL_MS` | – | `300000` | A cached preview unused for this long is dropped |
| `SUBTITLE_MCP_LIST_ENABLED` | – | `true` | Optional. Unset or `true`: register `list_files` and accept `location` in `preview_text`; local folders are browsable, and API locations follow the API's own `STORAGE_LIST_ENABLED` (on by default there). `false`: hide both ([tools.md](tools.md#browsing-and-reading-by-location)) |
| `SUBTITLE_MCP_RESULT_IN` | – | `both` | Where tool results go: `both` (`structuredContent` plus the same object as JSON in a text block), `structured` (`structuredContent` only; errors still include the JSON text block) or `content` (the JSON text block only; tools then declare no `outputSchema`). Any other value fails startup. Why: [tools.md](tools.md#why-results-are-sent-twice) |
| `SUBTITLE_MCP_JSON_MAX_DECODED_BYTES` | – | unset (10485760) | JSON decoded-content cap while `/v1/limits` is unreadable |
| `SUBTITLE_MCP_LIMITS_TTL_MS` | – | `300000` | `/v1/limits` cache TTL |
| `SUBTITLE_MCP_INCLUDE_DEBUG` | – | `false` | Pass the API's `debug` member into errors |
| `SUBTITLE_MCP_ALLOWED_ORIGINS` | – | unset | HTTP: allowed `Origin` values; with none set, only loopback origins are accepted |
| `SUBTITLE_MCP_ALLOWED_HOSTS` | – | `localhost,127.0.0.1,[::1]` + bind host | HTTP: `Host` allowlist (DNS rebinding) |
| `SUBTITLE_MCP_LOG_LEVEL` | `--log-level` | `info` | `error`, `warn`, `info`, `debug` (JSON lines on stderr) |
| `SUBTITLE_MCP_LOG_PATHS` | – | `false` | Log full paths instead of `sha256[:12]` + extension |

`SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` no longer exists: `convert_subtitle` returns whole files, and `preview_text`
pages its text. Setting it fails startup with a message pointing to the two preview settings above.

## Logging and privacy

Logs are JSON lines on stderr. Content, base64, profile values, API keys and tokens are never logged; paths are
hashed unless `SUBTITLE_MCP_LOG_PATHS=true`.

## API storage and asynchronous jobs

API `input`/`output` URIs are independent of MCP-local folders. Configure `STORAGE_FILE_ROOTS`,
`S3_ALLOWED_BUCKETS`/`S3_ALLOWED_PREFIXES` or `HTTP_ALLOWED_HOSTS` on the **API**, not this MCP.
Its `GET /v1/limits` describes enabled schemes, default wait, I/O and job retention settings; the limits
resource relays that response. Storage credentials belong to the API runtime, never tool arguments.

Cancelling or timing out the MCP does not cancel an admitted API job. If a conversion may take long or another system picks the file up from API storage, give an API `output`. Job
metadata cannot replay subtitle bytes.

## Time limits

`SUBTITLE_MCP_TIMEOUT_MS` (default 45000) is one time limit for each whole tool call, below the 60-second default
tool timeout of clients such as Codex. The rule for the model: If a conversion may take long or another system picks the file up from API storage, give an API `output`.

- **Quick conversion** (no API `output`: the file is attached, or written to `outputPath`/`outputDir`): the call
  asks the API to wait (`Prefer: wait`) as long as it can: at most the API's `requestMaxWaitSeconds` (60 when the
  API doesn't say) and the time left minus 2 seconds, about 41 seconds at the default. If the API still answers
  202, the MCP polls the job for the few seconds left, so a failure still comes back with its own error. When the
  time runs out the call returns `job-output-not-stored`: the result couldn't be kept (the API keeps job metadata,
  never the file); convert again with an API `output`, or raise `SUBTITLE_MCP_TIMEOUT_MS`.
- **Pipeline** (an API `output`): the call asks for at most 30 seconds, then polls `GET /v1/jobs/{id}`, honouring
  `Retry-After`, for the rest of the time. When the time runs out it returns `job-not-ready` with the `jobId`; the
  job keeps running and writes its output, and `get_job {jobId}` checks it. Don't resubmit.
- Retries of safe requests (`SUBTITLE_MCP_RETRY_*`) happen only when the wait and one more attempt fit before the
  limit; conversion POSTs are never retried.

Raise `SUBTITLE_MCP_TIMEOUT_MS` only together with your client's tool timeout. For example, to get the API's full
60-second wait back in Codex, set `SUBTITLE_MCP_TIMEOUT_MS=65000` in the server's `env` and `tool_timeout_sec = 90`.

Explicit `ifExists:replace` is sufficient for local and API outputs; there is no separate operator gate.
See [tools](tools.md#api-storage-and-job-ids) and [writing files](writing-files.md#api-destinations-are-separate).
