# Writing files

Every output is staged next to its destination and committed with an atomic rename, so a failed or interrupted
write doesn't leave a half-written file or folder behind.

## `convert_subtitle`

Writes through a staging file in `<output-root>/.subtitle-mcp-staging/` and commits it with an atomic link/rename.

`ifExists`:

| Value | Behaviour |
|---|---|
| `error` (default) | Fail with `output-exists` |
| `archive` | Rename the old file to `<name>.<UTC timestamp>.bak`, then write |
| `replace`, `delete` | Only with `SUBTITLE_MCP_ALLOW_DESTRUCTIVE=true` |

Nothing is ever suffixed (`_2`).

## Staging rules

- The staging folder must be on the same filesystem as the destination. A mount inside an output root fails with
  `cross-device` (configure that mount as its own output root); there is never a non-atomic copy.
- Stale staging files and folders (older than `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS`) are swept at startup and
  periodically, only inside `.subtitle-mcp-staging/`. No state is stored.
- In the sidecar image the output roots must be writable by uid 65532 ([http-sidecar.md](http-sidecar.md)).

## Race windows

Documented and small:

- On filesystems without hard links (many SMB shares, FAT/exFAT) a single-file commit is a plain `rename` right
  after an `lstat`, so a file created at the same instant by another program could be overwritten.
