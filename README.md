# Smart Subtitle Converter MCP

[![CI](https://github.com/Wauter/smart-subtitle-converter-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Wauter/smart-subtitle-converter-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**An MCP server that lets Claude, Cursor and other AI agents convert and check subtitles with Subtitle Edit's
proven engine, with verified output, honest warnings, and access only to the folders you allow.**

Ask your AI client to convert between SRT, WebVTT, TTML, ASS and broadcast formats such as EBU STL, PAC and
Cavena 890, and to tell you whether anything was lost. The agent gets a verdict and a suggested fix it can act on,
and your subtitle content never passes through the model.

> **Built on Subtitle Edit.** Conversions run in the
> [Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api), which wraps `libse`, the
> library behind [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) by **Nikolaj Olsson** (MIT).
> This is a community project, **not an official Subtitle Edit project**.
>
> **Status: alpha.** This is early software. It works and is tested, but hasn't been through real-world use yet.
> Expect changes, and please [report issues](https://github.com/Wauter/smart-subtitle-converter-mcp/issues).

## How it fits together

```text
AI client or agent  -->  Smart Subtitle Converter MCP  -->  Smart Subtitle Converter API  -->  libse
(Claude, Cursor, ...)    (this repo; your local folders)    (one container; storage, jobs)     (Subtitle Edit's engine)
```

This [Model Context Protocol](https://modelcontextprotocol.io) server does no conversion itself. It gives AI agents
the [Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api) and adds what an agent
working on your files needs. To call the API from your own platform or automation instead, use the API directly.

## Why use it

- **The agent can tell you whether the output is right.** Binary broadcast outputs (EBU STL, PAC and others)
  carry the API's `verification` verdict, and warnings carry a `hint` and structured `details`, such as a `remedy`
  for lost characters.
- **Subtitle content stays out of the model.** Files travel by `path`, so their contents don't pass through the
  model's context. Content, keys and tokens are never logged.
- **The agent only sees the folders you name.** It reads and writes only inside the folders in your settings
  (`SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS`). Read-only folders stay read-only.
- **Subtitle files only.** It reads, lists and writes only files with a subtitle extension, never touches hidden
  files or folders (names starting with `.`), and never follows symbolic links
  ([security](docs/security.md#allowed-folders)).
- **Writes are atomic.** Single files are staged and committed with a rename, and existing files are never
  overwritten unless you allow it.
- **Errors an agent can act on.** Errors have a stable `code`, a `hint` and, for path errors, the allowed folders.
  If the setup is wrong, the agent is told what is wrong and how to fix it instead of seeing a closed connection.

## Quick start (Claude Code)

**1. Start the API.** Its [quick start](https://github.com/Wauter/smart-subtitle-converter-api#quick-start) serves
`http://localhost:8080` and writes an API key to `api_keys.txt`.

**2. Copy the key for the MCP.** The API asks for a key by default and keeps it in its `api_keys.txt`, readable
only by the API's container user. Copy the key once (the MCP sends the first key in the file and picks up changes):

```bash
sudo grep -v -e '^#' -e '^$' api_keys.txt | head -n 1 > ~/subtitle-api-key.txt && chmod 600 ~/subtitle-api-key.txt
```

**3. Add the server.** Point `SUBTITLE_MCP_ALLOWED_DIRS` at the folder that holds your subtitles:

```bash
claude mcp add \
  --env SUBTITLE_API_URL=http://localhost:8080 \
  --env SUBTITLE_API_KEY_FILE=/Users/me/subtitle-api-key.txt \
  --env SUBTITLE_MCP_ALLOWED_DIRS=/Users/me/Subtitles \
  --transport stdio \
  smart-subtitle-convert -- npx -y smart-subtitle-converter-mcp
```

`SUBTITLE_API_KEY=<key>` works too. Without a key, conversions fail with `unauthorized`.

**4. Ask for a conversion:**

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
| `preview_text` | Read the text of an API job's stored input or output, or of a file by location, page by page (binary formats shown as SRT) |
| `list_files` | List a local folder or an API storage location, page by page (`SUBTITLE_MCP_LIST_ENABLED=false` hides it) |
| `list_allowed_folders` | The folders in effect right now, with mode and source; with browsing on, also the API's storage locations |

Inputs, results and warning fields: [docs/tools.md](docs/tools.md).

## API storage and job tracking

- **API locations.** Besides local files, `convert_subtitle` can hand the API its own `input` and `output`
  locations (an allowlisted folder on the API server, an S3-compatible bucket or an HTTPS URL), with an optional
  `sidecar` JSON next to the output. `detect_format` accepts `input` too. These are resolved by the API with its
  own allowlists, separately from the MCP's local folders.
- **No silent overwrites.** Outputs are never overwritten unless you send `ifExists: "replace"`. One file per call.
- **Jobs.** Every conversion returns a `jobId`. When work outlasts the wait, the MCP polls the job. The API keeps
  metadata only, so use an API `output` location for work that may take a while.
- **Previewing.** `preview_text` reads the text of a job's stored input or output, in pages that end on whole
  cues, while the API still has its record.
- **Browsing.** `list_files` lists a folder and `preview_text` reads a file by its full URI or path. The API's
  storage is browsable whenever the API allows it (its default)
  ([browsing](docs/tools.md#browsing-and-reading-by-location)).
- **Inline results.** Without any output location, `convert_subtitle` attaches the whole converted file to its
  result for the client to save.

See [tools](docs/tools.md#api-storage-and-job-ids),
[configuration](docs/configuration.md#api-storage-and-asynchronous-jobs) and
[writing files](docs/writing-files.md#api-destinations-are-separate).

## Safeguards

The usual setup is stdio: the server talks to one local client, not the network. It reaches only the folders you
name, and the API applies its own key, host name and storage allowlist checks.

**It has not been independently audited.** It is meant for a trusted environment, not for exposure to the public
internet. Details: [docs/security.md](docs/security.md) and the API's
[security notes](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/security.md).

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

## Feedback and author

This is early software, and reports from real files and real agent sessions are the most useful thing you can
send. Please [open an issue](https://github.com/Wauter/smart-subtitle-converter-mcp/issues) for a bug, a confusing
tool result, or a client that doesn't work.

Built and maintained by [Wauter De Bruyne](https://www.linkedin.com/in/wauterdebruyne/), a hands-on solution
architect working on media workflow automation for broadcasters, sports organisations and streaming platforms.

## Credits and license

All subtitle format support comes from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) and its
`libse` library by Nikolaj Olsson and contributors (MIT), through the
[Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api). Thank you.

This server is MIT licensed, see [LICENSE](LICENSE).
