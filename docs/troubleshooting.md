# Troubleshooting

Start with `list_allowed_folders` (folders and their `state`) and the server's log (JSON lines on stderr, shown in
the client's MCP log). Every error carries a `code` and a `hint`.

## Version mismatch

**Symptom:** results carry an `mcp-api-version-mismatch` warning, or the startup log warns about the API version.

The MCP reads the API's `/healthz` at startup and compares major.minor with its own; use the MCP release whose
major.minor matches the API (patch versions may differ). There are no fallbacks for older APIs. It also checks
that `GET /v1/limits` exists and warns if it doesn't.

If you did update and still see an older MCP version in the warning, the client is running a different copy:

- Check which command the client starts (`claude mcp get subtitleedit` in Claude Code, the JSON config elsewhere).
- Built from source: rerun `npm ci && npm run build` after `git pull`.
- Client in a VM or container: it runs the copy **inside** that environment. If you copied `dist/` there, copy it
  again after every update ([clients.md](clients.md#clients-in-a-vm-or-container)).
- Restart the client completely afterwards.

## No allowed folders, or `path-not-allowed`

- `state: roots-empty` in Claude Desktop is expected: it doesn't pass approved folders. Set
  `SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS` ([folders-and-roots.md](folders-and-roots.md)).
- `state: waiting-for-roots`: the client hasn't sent its roots yet; the tool descriptions update once it does.
- `path-not-allowed`: the path is outside the allowed folders, relative, or inside a read-only folder for a write.
  The hint lists the folders in effect.

## Write errors

| Code | What to do |
|---|---|
| `output-exists` | Choose `ifExists: "error"` or explicit `ifExists: "replace"`, or a different `outputPath` ([writing-files.md](writing-files.md)) |
| `cross-device` | The destination is on another mount than its output root; configure that mount as its own output root |
| `staging-unavailable` | The `.subtitle-mcp-staging/` folder in the output root can't be created or used; check permissions |
| `path-not-found`, `path-too-long`, `disk-full`, `permission-denied`, `output-locked` | As named; the error carries `path` and `osError` |

## API unreachable

`api-unreachable`: check `SUBTITLE_API_URL` and that the API is running. On your machine that's the host port
(`http://localhost:4041` with the API's defaults); from a container on the same Docker network it's the container
port (`http://api:8080`). From a VM, `localhost` may not be your host. `401` from the API means
`SUBTITLE_API_KEY` is missing or wrong.

## Startup fails

- `SUBTITLE_API_URL` is required.
- Unknown `SUBTITLE_MCP_*` variables fail startup on purpose (typo protection); check the spelling against
  [configuration.md](configuration.md).
- `--http` needs an inbound token ([http-sidecar.md](http-sidecar.md)); `--hosted` isn't available yet.

## Jobs and storage URIs

- `storage-location-rejected`: configure the matching API allowlist; use a complete filename, not a trailing slash.
  MCP-local folder grants do not grant API filesystem access. API file storage currently requires Linux.
- `job-not-found`: the job record expired, was evicted, or its API process restarted. This does not mean the write failed.
- `job-output-not-stored`: an asynchronous job had no API output. Polling cannot download file bytes; use an API
  output URI next time. No empty local file was created.
- `job-not-ready` after acceptance: inspect the returned `jobId`; work can still be running. Do not blindly replay writes.
- `sidecar-write-failed`: retain the successful subtitle and inspect warnings; only the sidecar failed.
- `sidecar-skipped`: HTTPS PUT has no second signed URL for the sidecar, so none was attempted.
