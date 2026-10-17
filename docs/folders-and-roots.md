# Allowed folders and roots

The MCP only reads and writes files inside its allowed folders. Every tool that takes a path lists them in its
description, each marked read-write or read-only, e.g. `Allowed folders: /Users/me/Subtitles (read-write),
/Volumes/Masters (read-only).` With none available, the descriptions say so and name the settings below.

## Two sources, combined

- **Configuration:** `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and `SUBTITLE_MCP_READONLY_DIRS` (read-only), or the
  flags `--allow-dir` / `--allow-dir-ro` ([configuration.md](configuration.md)).
- **Client roots:** when the client supports MCP roots and `SUBTITLE_MCP_USE_CLIENT_ROOTS` isn't `false`, its
  workspace folders are added as read-write folders, even when folders are configured.

The effective set is the union.

- A configured read-only folder stays read-only even inside a client root (the most restrictive setting wins).
- An empty or failing `roots/list` never removes configured folders; a failing one also keeps the client folders
  received before.
- When the set changes, the tool descriptions are rebuilt and `notifications/tools/list_changed` is sent.

## Per client

- **Claude Desktop doesn't pass its own approved folders to MCP servers.** It advertises the MCP roots capability
  but answers `roots/list` with an empty list, so folders you approve in a Claude chat never reach this server. Set
  `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and/or `SUBTITLE_MCP_READONLY_DIRS` (read-only) in its config.
- **Claude Code** (and other roots-capable clients) supplies its workspace folders automatically; add the env
  settings only for extra folders (e.g. a read-only masters share).

Setup per client: [clients.md](clients.md).

## Checking the folders in effect

The `list_allowed_folders` tool returns the folders in effect right now, each with `mode` (read-write/read-only)
and `source` (`config`/`client-roots`), plus a `state`:

| `state` | Meaning |
|---|---|
| `ready` | Folders are available |
| `waiting-for-roots` | The client's roots haven't arrived yet |
| `roots-unsupported` | The client doesn't support roots |
| `roots-empty` | The client sent an empty list (Claude Desktop) |
| `roots-failed` | The client's `roots/list` failed |
| `none` | No folders from either source |

When there are none, it adds a hint naming the settings. Path errors (`path-not-allowed`) include the current list
in their hint.

## Notes

- Roots are deprecated as of MCP protocol `2026-07-28` (SEP-2577), so configuration stays the primary mechanism;
  client roots are a convenience while clients still send them.
- Every `roots/list` answer is logged at `info` level (count, folders hashed unless `SUBTITLE_MCP_LOG_PATHS=true`,
  and skipped entries with the reason), so the client's MCP log shows what it actually sent.
