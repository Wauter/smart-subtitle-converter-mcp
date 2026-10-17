# Subtitle Edit Converter MCP

**Let Claude and other AI agents convert subtitles with Subtitle Edit's engine, safely inside the folders you allow.**

> **Built on Subtitle Edit.** Conversions run in the
> [Subtitle Edit Converter API](https://github.com/Wauter/subtitleedit-converter-api), which wraps `libse`, the
> library behind [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) by **Nikolaj Olsson** (MIT).
> This is a community project, **not an official Subtitle Edit project**.

This [Model Context Protocol](https://modelcontextprotocol.io) server gives AI agents the Subtitle Edit Converter
API and adds what an agent working on your files needs: access only to folders you or your client name, atomic
writes that never leave a half-written file or folder, all-or-nothing batch conversion, and structured errors and
warnings the agent can act on. It does no conversion itself.

## What it adds

- **Allowed folders only:** it reads and writes only inside folders you configure or your client shares as MCP
  roots (Claude Code does this automatically). Read-only folders stay read-only.
- **Atomic writes:** single files are staged and committed with a rename; existing files are never overwritten
  unless you allow it.
- **All-or-nothing batches:** `convert_batch` writes into a new folder that appears only when every file succeeded.
- **Results you can trust:** binary outputs carry the API's `verification` verdict, and warnings carry a `hint`
  and a structured `remedy`. Errors have a stable `code`, a `hint` and, for path errors, the allowed folders.
- **Content stays on your machine:** files go by `path`, so their contents don't pass through the model's context;
  content, keys and tokens are never logged.

## Quick start (Claude Code)

Start the API first (its [quick start](https://github.com/Wauter/subtitleedit-converter-api#quick-start) serves
`http://localhost:4041`), then:

```bash
claude mcp add --transport stdio \
  --env SUBTITLE_API_URL=http://localhost:4041 \
  subtitleedit -- npx -y subtitleedit-converter-mcp
```

Start Claude Code in the folder that holds your subtitles; it shares that folder with the server. Then ask:

> Convert `movie.srt` in this folder to EBU STL at 25 fps and tell me whether anything was lost.

Claude Desktop, Cursor, Windows, a VM, or building from source: see [docs/clients.md](docs/clients.md).

## Tools

| Tool | What it does |
|---|---|
| `convert_subtitle` | Convert one file (inline or `path`) to text inline or to `outputPath`/`outputDir` |
| `convert_batch` | Convert a folder or list of files into a **new** folder, all or nothing |
| `detect_format` | Format, encoding, BOM, line endings and language of a file |
| `list_formats` | Formats with read/write and text/binary flags |
| `list_presets` / `get_profile` | Built-in and mounted presets, raw and resolved |
| `validate_profile` | Check a profile, with pointer-level errors and hints |
| `list_allowed_folders` | The folders in effect right now, with mode and source |

Inputs, results and warning fields: [docs/tools.md](docs/tools.md).

## Documentation

| Read this | When you want to |
|---|---|
| [docs/clients.md](docs/clients.md) | Set it up in Claude Code, Claude Desktop, Cursor, Windows or a VM; build from source |
| [docs/folders-and-roots.md](docs/folders-and-roots.md) | Understand which folders it may use and how roots combine with config |
| [docs/tools.md](docs/tools.md) | See every tool's inputs, results, verification and warning fields |
| [docs/writing-files.md](docs/writing-files.md) | Know how files are staged and committed, `ifExists`, batch rules, race windows |
| [docs/configuration.md](docs/configuration.md) | Look up every `SUBTITLE_MCP_*` variable and flag |
| [docs/http-sidecar.md](docs/http-sidecar.md) | Run it over Streamable HTTP next to the API in Docker |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Fix version-mismatch warnings, missing folders, stale builds |
| [docs/development.md](docs/development.md) | Build, test, run the contract suite and the smoke checklist |
| [CHANGELOG.md](CHANGELOG.md) | See what changed in each version |

**Versions:** use the MCP release whose major.minor matches your API; patch versions may differ. On a mismatch the
server adds an `mcp-api-version-mismatch` warning.

## Credits and license

All subtitle format support comes from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) and its
`libse` library by Nikolaj Olsson and contributors (MIT), through the
[Subtitle Edit Converter API](https://github.com/Wauter/subtitleedit-converter-api). Thank you.

This server is MIT licensed, see [LICENSE](LICENSE).
