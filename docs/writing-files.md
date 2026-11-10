# Writing files

Every MCP-local output is staged next to its destination and committed with an atomic rename, so a failed or interrupted
write doesn't leave a half-written file behind.

## `convert_subtitle`

Writes through a staging file in `<output-root>/.subtitle-mcp-staging/` and commits it with an atomic link/rename.

`ifExists`:

| Value | Behaviour |
|---|---|
| `error` (default) | Fail with `output-exists` |
| `replace` | Explicit replacement through a complete staging file and rename; no separate operator gate |

Nothing is ever suffixed (`_2`).

Before anything is converted, the output is checked: a dot-named file or folder is `hidden-path`, a name without a
subtitle extension is `extension-not-allowed`, and an `outputPath` must end in the extension of the target format
(`out.vtt` for WebVTT; `out.srt` is refused). File names the API picks for `outputDir` get the same checks before they
are written. `ifExists: "replace"` never replaces a symbolic link or anything that isn't a regular file
(`path-not-allowed`), and output folders reached through a symbolic link are refused.

## Staging rules

- The staging folder must be on the same filesystem as the destination. A mount inside an allowed folder fails with
  `cross-device` (configure that mount as its own allowed output folder); there is never a non-atomic copy.
- Stale staging files (older than `SUBTITLE_MCP_PARTIAL_MAX_AGE_MS`) are swept at startup and
  periodically, only inside `.subtitle-mcp-staging/`. No state is stored.
- In the sidecar image the output folders must be writable by uid 65532 ([http-sidecar.md](http-sidecar.md)).

## Race windows

Documented and small:

- On filesystems without hard links (many SMB shares, FAT/exFAT) a single-file commit is a plain `rename` right
  after an `lstat`, so a file created at the same instant by another program could be overwritten.

## API destinations are separate

Local `path`/`outputPath`/`outputDir` still use the rules above. API `input`/`output` locations are evaluated on the API server, with its own allowlists and permissions. API filesystem and S3 output default to `ifExists:error`; explicit `replace` permits replacement. API filesystem replacement uses sibling staging; S3 default PUT is conditional. HTTPS follows the signer/receiver policy and has no claimed disk/S3 collision guarantee. API `sidecar:true` writes `{output}.json` except for HTTPS, which warns and skips it. An API output written without `sidecar` removes an older `{output}.json` next to it (filesystem and S3), since it would describe a file that is no longer there; if that fails the API adds `sidecar-delete-failed` and keeps the subtitle. API filesystem outputs are created with mode `0644`, narrowed by the API server's umask.

A sidecar failure leaves the successfully written subtitle and is reported as a warning. For an asynchronous response without an API output, no file bytes are retained; the MCP never invents an empty local result.

`ifExists` is error (default) | replace everywhere. A collision hint lists both choices; a prior job or attempt may already have written, or still be writing, that location. Inspect the result before choosing replacement. No conversion POST is automatically replayed.
