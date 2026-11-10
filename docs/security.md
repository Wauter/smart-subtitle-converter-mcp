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
- A path outside the allowed folders is `path-not-allowed`, always checked first.
- Hidden files and folders (any path component starting with `.`, including everything in a hidden allowed folder)
  are never read, listed or written, by any tool, with browsing on or off: `hidden-path`. The check runs on the
  requested path before any filesystem call, and hidden allowed folders are not named in descriptions, hints or
  `list_allowed_folders`. Details: [tools.md](tools.md#hidden-files-and-folders).
- Symbolic links are never followed, not even ones that stay inside an allowed folder: a link anywhere below an
  allowed folder is refused (`path-not-allowed`), `list_files` leaves links out, and `ifExists: "replace"` never
  replaces a link. Files are opened without following links and checked again after opening, so swapping a folder
  for a link mid-call doesn't help. An allowed folder that is itself reached through a link (for example
  `/var` → `/private/var` on macOS) still works.
- Only subtitle files are read, listed or written: the file name must end in a subtitle extension that the engine can
  read (`.srt`, `.vtt`, `.stl`, …; always the API's list from `GET /v1/limits`; there is no built-in copy). With an older API that doesn't report it,
  the check is skipped and results carry the `mcp-extension-check-skipped` warning; the allowed-folder, hidden and
  symbolic-link rules still apply. Anything else,
  including names without an extension, is `extension-not-allowed`. A chosen `outputPath` must also end in the
  extension of the format it produces.
- A local folder with more than 5000 subtitle files and sub-folders isn't listed (`folder-too-large`); narrow it with
  `prefix`. FIFOs and other special files are never opened.

## Writing files

Single-file outputs are staged next to the destination and committed with a rename, so a failed write does not
leave a half-written file. Existing files are not replaced unless the request sends `ifExists: "replace"`.
There is no separate operator gate. Details: [writing-files.md](writing-files.md).

## Talking to the API

- `SUBTITLE_API_URL` is required. `SUBTITLE_API_KEY` / `SUBTITLE_API_KEY_FILE` is the only upstream key; it is
  never taken from tool arguments. The API asks for a key by default: give the MCP a file holding the key (a copy of the API's
  `api_keys.txt`, readable by the MCP's user) with `SUBTITLE_API_KEY_FILE` (the API's [Securing the API](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/security.md#securing-the-api)).
- When the API is busy (`queue-full`, `browse-busy`, `conversion-engine-stuck` with `Retry-After`), safe reads and
  listings are retried within `SUBTITLE_MCP_RETRY_*`; a conversion POST is never replayed.
- API `input` / `output` URIs (filesystem, S3-compatible, HTTPS) are checked by the API with its own allowlists,
  separately from this server's local folders. Storage credentials belong to the API runtime, never to a tool call.
- Job metadata cannot replay subtitle bytes; prefer an API output location for work that may outlast the wait.
  `preview_text` reads a stored input or output for a known job id. Reading by location and `list_files` are on unless
  `SUBTITLE_MCP_LIST_ENABLED=false`, and cover only the allowed folders; API locations follow the API's own
  `STORAGE_LIST_ENABLED`, which the API
  checks it on every request and applies the same allowlists, traversal, symbolic-link and decoding guards as for
  conversion inputs. The API's allowlists are never shown while its switch is off, and locations never carry
  credentials or query strings. HTTPS can't be listed or read by location.

## HTTP mode

With `--http`, the server speaks Streamable HTTP on `/mcp` instead of stdio.

- Inbound tokens (`SUBTITLE_MCP_HTTP_TOKEN` / `SUBTITLE_MCP_HTTP_TOKEN_FILE`) are required and must be at least
  32 characters.
- With no `SUBTITLE_MCP_ALLOWED_ORIGINS`, only loopback origins are accepted. Set the allow-list for any other
  browser or remote client.
- `SUBTITLE_MCP_ALLOWED_HOSTS` defaults to loopback plus the bind host, to block DNS rebinding.

Details: [http-sidecar.md](http-sidecar.md) and [configuration.md](configuration.md).
