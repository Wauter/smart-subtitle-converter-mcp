# Smart Subtitle Converter MCP

**Let Claude and other AI agents convert subtitles with Subtitle Edit's engine, only inside the folders you allow.**

> **Built on Subtitle Edit.** Conversions run in the
> [Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api), which wraps `libse`, the
> library behind [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) by **Nikolaj Olsson** (MIT).
> This is a community project, **not an official Subtitle Edit project**.
>
> **Status: alpha.** It works and is tested, but hasn't been through real-world use yet. Expect changes, and
> please [report issues](https://github.com/Wauter/smart-subtitle-converter-mcp/issues).

This [Model Context Protocol](https://modelcontextprotocol.io) server gives AI agents the Smart Subtitle Converter
API and adds what an agent working on your files needs: access only to folders you name, atomic single-file writes
through staging, and structured errors and warnings the agent can act on. It does no conversion itself.

## What it adds

- **Allowed folders only:** it reads and writes only inside folders you name in the settings
  (`SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS`). Read-only folders stay read-only.
- **Atomic writes:** single files are staged and committed with a rename; existing files are never overwritten
  unless you allow it.
- **Results with a verdict:** binary outputs carry the API's `verification` verdict, and warnings carry a `hint`
  and structured `details` (such as a `remedy` for lost characters). Errors have a stable `code`, a `hint` and,
  for path errors, the allowed folders.
- **Content stays on your machine:** files go by `path`, so their contents don't pass through the model's context;
  content, keys and tokens are never logged.

## Quick start (Claude Code)

Start the API first (its [quick start](https://github.com/Wauter/smart-subtitle-converter-api#quick-start) serves
`http://localhost:8080`), then:

```bash
claude mcp add --transport stdio \
  --env SUBTITLE_API_URL=http://localhost:8080 \
  --env SUBTITLE_MCP_ALLOWED_DIRS=/Users/me/Subtitles \
  smart-subtitle -- npx -y smart-subtitle-converter-mcp
```

Point `SUBTITLE_MCP_ALLOWED_DIRS` at the folder that holds your subtitles, then ask:

> Convert `movie.srt` in `/Users/me/Subtitles` to EBU STL at 25 fps and tell me whether anything was lost.

Claude Desktop, Cursor, Windows, a VM, or building from source: see [docs/clients.md](docs/clients.md).

## Tools

| Tool | What it does |
|---|---|
| `convert_subtitle` | Convert one file (`path`, inline, or API `input`) to inline, local output, or API `output` |
| `detect_format` | Format, encoding, BOM, line endings and language of a file |
| `list_formats` | Formats with read/write and text/binary flags |
| `list_presets` / `get_profile` | Built-in and mounted presets, raw and resolved |
| `validate_profile` | Check a profile, with pointer-level errors and hints |
| `get_job_file` | Re-read the stored input or output of an API job (storage-to-storage conversions) |
| `list_allowed_folders` | The folders in effect right now, with mode and source |

Inputs, results and warning fields: [docs/tools.md](docs/tools.md).

## API locations and job tracking

Besides local files, `convert_subtitle` can hand the API its own `input` and `output` locations (an allowlisted
folder on the API server, an S3-compatible bucket or an HTTPS URL), with an optional `sidecar` JSON next to the
output; `detect_format` accepts `input` too. These are resolved by the API with its own allowlists, separately from
the MCP's local folders. Outputs are never overwritten unless you send `ifExists: "replace"`. One file per call.

Every conversion returns a `jobId`. When work outlasts the wait, the MCP polls the job; the API keeps metadata only,
so use an API `output` location for work that may take a while. `get_job_file` re-reads a job's stored input or
output while the API still has its record. See [tools](docs/tools.md#api-storage-and-job-ids),
[configuration](docs/configuration.md#api-storage-and-asynchronous-jobs) and
[writing files](docs/writing-files.md#api-destinations-are-separate).

## Documentation

| Read this | When you want to |
|---|---|
| [docs/clients.md](docs/clients.md) | Set it up in Claude Code, Claude Desktop, Cursor, Windows or a VM; build from source |
| [docs/folders-and-roots.md](docs/folders-and-roots.md) | Understand which folders it may use |
| [docs/tools.md](docs/tools.md) | See every tool's inputs, results, verification and warning fields |
| [API errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) | Look up what an API error or warning means, why it happened and what to do |
| [docs/writing-files.md](docs/writing-files.md) | Know how files are staged and committed, `ifExists`, race windows |
| [docs/configuration.md](docs/configuration.md) | Look up every `SUBTITLE_MCP_*` variable and flag |
| [docs/security.md](docs/security.md) | See allowed folders, writes, API keys and HTTP-mode safeguards |
| [docs/http-sidecar.md](docs/http-sidecar.md) | Run it over Streamable HTTP next to the API in Docker |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Fix MCP-local errors (folders, writes, talking to the API); API codes are on the errors and warnings page above |
| [docs/development.md](docs/development.md) | Build, test, run the contract suite and the smoke checklist |
| [CHANGELOG.md](CHANGELOG.md) | See what changed in each version |

**Versions:** use the MCP release whose major.minor matches your API; patch versions may differ. On a mismatch the
server adds an `mcp-api-version-mismatch` warning.

## Credits and license

All subtitle format support comes from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) and its
`libse` library by Nikolaj Olsson and contributors (MIT), through the
[Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api). Thank you.

This server is MIT licensed, see [LICENSE](LICENSE).
