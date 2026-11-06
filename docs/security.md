# Security

The safeguards that exist today, and how to change them. This server does no conversion itself: it talks to the
[Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api) and only reads or writes files
inside folders you allow.

How to report a vulnerability: [SECURITY.md](../SECURITY.md). API-side storage, keys and network checks:
the API's [security notes](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/security.md).

## Defaults

- The usual setup is stdio: the server talks to one local client, not the network.
- It reads and writes only inside folders you name (`SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS`).
- File contents go by `path`, so they do not pass through the model's context.
- Logs never include subtitle content, profile values, API keys or tokens. Paths are hashed unless
  `SUBTITLE_MCP_LOG_PATHS=true`.
- `--hosted` is not available and refuses to start.
- A conversion POST is never automatically replayed after a connection loss.

## Allowed folders

- Name them with `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and `SUBTITLE_MCP_READONLY_DIRS` (read-only), or the
  `--allow-dir` / `--allow-dir-ro` flags. That is the setup path for every client.
- Some clients can still add extra folders via the older MCP roots feature when
  `SUBTITLE_MCP_USE_CLIENT_ROOTS` is not `false`; a configured read-only folder stays read-only. Don't rely on
  that feature — name your folders in the settings. Details: [folders-and-roots.md](folders-and-roots.md).
- `list_allowed_folders` shows what is in effect. Path errors use `path-not-allowed` and include the current list.

## Writing files

Single-file outputs are staged next to the destination and committed with a rename, so a failed write does not
leave a half-written file. Existing files are not replaced unless the request sends `ifExists: "replace"`.
There is no separate operator gate. Details: [writing-files.md](writing-files.md).

## Talking to the API

- `SUBTITLE_API_URL` is required. `SUBTITLE_API_KEY` / `SUBTITLE_API_KEY_FILE` is the only upstream key; it is
  never taken from tool arguments.
- API `input` / `output` URIs (filesystem, S3-compatible, HTTPS) are checked by the API with its own allowlists,
  separately from this server's local folders. Storage credentials belong to the API runtime, never to a tool call.
- Job metadata cannot replay subtitle bytes; prefer an API output location for work that may outlast the wait.
  `get_job_file` re-reads a stored input or output only for a known job id.

## HTTP mode

With `--http`, the server speaks Streamable HTTP on `/mcp` instead of stdio.

- Inbound tokens (`SUBTITLE_MCP_HTTP_TOKEN` / `SUBTITLE_MCP_HTTP_TOKEN_FILE`) are required and must be at least
  32 characters.
- With no `SUBTITLE_MCP_ALLOWED_ORIGINS`, only loopback origins are accepted. Set the allow-list for any other
  browser or remote client.
- `SUBTITLE_MCP_ALLOWED_HOSTS` defaults to loopback plus the bind host, to block DNS rebinding.

Details: [http-sidecar.md](http-sidecar.md) and [configuration.md](configuration.md).
