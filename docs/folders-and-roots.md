# Allowed folders

The MCP only reads and writes files inside folders you name. Every tool that takes a path lists them in its
description, each marked read-write or read-only, e.g. `Allowed folders: /Users/me/Subtitles (read-write),
/Volumes/Masters (read-only).` With none available, the descriptions say so and name the settings below.

## Name the folders

Set these (or the matching flags; see [configuration.md](configuration.md)):

- `SUBTITLE_MCP_ALLOWED_DIRS` — read-write
- `SUBTITLE_MCP_READONLY_DIRS` — read-only

That is the setup path for every client. Claude Desktop never passes chat-approved folders here, so you must
configure them there too. Setup per client: [clients.md](clients.md).

Some clients can still offer extra folders through the older MCP "roots" feature. The protocol is dropping that
(SEP-2577, `2026-07-28`); don't rely on it — name your folders in the settings. When a client does send them and
`SUBTITLE_MCP_USE_CLIENT_ROOTS` isn't `false`, they are added as read-write on top of what you configured. A
configured read-only folder stays read-only. An empty or failing client list never removes your configured
folders. In HTTP sidecar mode, only the configured folders apply.

When the set changes, the tool descriptions are rebuilt and `notifications/tools/list_changed` is sent.

## Checking the folders in effect

The `list_allowed_folders` tool returns the folders in effect right now, each with `mode` (read-write/read-only)
and `source` (`config` / `client-roots`), plus a `state`:

| `state` | Meaning |
|---|---|
| `ready` | Folders are available |
| `waiting-for-roots` | A client still offering roots hasn't sent them yet |
| `roots-unsupported` | The client doesn't offer roots |
| `roots-empty` | The client sent an empty list (Claude Desktop) |
| `roots-failed` | The client's roots request failed |
| `none` | No folders from config or client |

When there are none, it adds a hint naming the settings. Path errors (`path-not-allowed`) include the current list
in their hint. This tool reports MCP-local folders only — not API `STORAGE_FILE_ROOTS`, S3 buckets or HTTPS hosts.

## Logging

Every client roots answer is logged at `info` (count, folders hashed unless `SUBTITLE_MCP_LOG_PATHS=true`, and
skipped entries with the reason), so the client's MCP log shows what it actually sent.
