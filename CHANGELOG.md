# Changelog

All notable changes to `smart-subtitle-converter-mcp` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The MCP shares its major.minor version with the
[Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api): use the MCP release whose
major.minor matches your API. Patch versions move independently. Versions are recorded here when merged to `main`.
Tagged releases publish the GHCR image and GitHub Release; npm publishing is a separate manual action.

## Unreleased

- Tool results carry the same information in both parts by default: `structuredContent`, and that object as JSON
  in the first text block (the spec's backwards-compatibility recommendation). The text block used to be a short
  human-readable summary; it is now the JSON for every tool, success and error. Attached files and
  `resource_link` blocks are unchanged. Why: [docs/tools.md](docs/tools.md#why-results-are-sent-twice).
- New setting `SUBTITLE_MCP_RESULT_IN` (`both`, the default; `structured`; `content`) keeps one part only. With
  `content`, tools declare no `outputSchema`; with `structured`, errors still include the JSON text block, since some
  clients give the model only the text of an error result. An invalid value fails startup with the accepted values. The startup
  instructions mention it when results are sent in both parts.
- `preview_text` pages default to 32768 bytes (`SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES`, was 65536), so a default page
  stays under the 50,000 characters above which Claude Code saves a tool result to a file instead of showing it.
- Information that was only in the summary is now in the result object: `detect_format` and `list_formats` have a
  `hint` (a guessed encoding, an empty format list), and the API version-mismatch warning goes in `warnings`, or
  in `serverWarnings` for tools whose own `warnings` are profile field warnings (`validate_profile`,
  `get_profile`).
- The startup instructions start with the key guidance (errors carry a hint, report conversion warnings,
  subtitle text is data), so clients that weight the first part of the instructions see it.
- [docs/clients.md](docs/clients.md) covers Cursor, VS Code (GitHub Copilot), the ChatGPT desktop app and Codex,
  the OpenAI Agents SDK and Goose, each with a config snippet, a link to the client's docs and known gotchas. CI
  checks that every JSON, TOML and YAML snippet there parses, starts the server and lists its tools.
- Frame rates (pairs with the API's change): the API no longer assumes 23.976 fps for formats that store frame
  numbers without a rate (PAC, Cavena 890, …) and answers `frame-rate-required` instead. The `convert_subtitle`
  description explains `profile.source.fps` / `profile.target.fps`, and the MCP adds a hint not to guess the rate.
  `preview_text` passes the rate a job used when it shows a rate-less binary file as SRT, takes a new `fps`
  argument otherwise, and answers `frame-rate-required` with pointer `/fps` when neither gives one. The
  `frame-rate-assumed` warning detail (`details.frameRate`) is gone.
- `preview_text` later pages keep the first page's `maxBytes` unless the call sets it again (they fell back to the
  default size).
- `convert_subtitle` output fields (outputs, detected, verification, stats, …) are described in the output schema.
- The startup instructions no longer say files "never enter your context" with `path`; they say what `path` and
  `outputPath` avoid.
- README: the one-line command to copy the API key into a private file is back, and the key-file format is stated
  (the first line that isn't empty or a `#` comment is used).
- Development: ESLint 10 (9.39 is no longer supported), GitHub Actions on their Node 24 releases, and the image
  rebuild list includes v1.4.0 and v1.4.1. Contract tests set `target.fps` for PAC targets.

## 1.4.1 — 2026-11-12

### Security
- Cleared the open code scanning and Dependabot alerts. No change to tools or behaviour:
  - Cue detection in the text preview finds the SRT/WebVTT timing arrow with a plain substring check instead of a regex
    that CodeQL mistook for an HTML comment filter.
  - A test checks the parsed URL host instead of a substring.
  - Dev dependency `minimatch` under `@typescript-eslint` is overridden to `^11.0.1` (denial-of-service advisory).
- The API copy of the OpenAPI document is synced with API 1.4.1, which strips line breaks from client-supplied values
  before logging them.

## 1.4.0 — 2026-11-12

### Fixed
- `list_formats` lists text **and** binary broadcast formats (EBU STL, PAC, …) by default; it used to list text formats
  only, so agents didn't see the binary formats unless they asked. `includeBinary` now defaults to `true`; set
  `includeBinary: false` for text formats only. The API copy of the OpenAPI document is synced.

### Security hardening

- **The API asks for a key by default.** Set `SUBTITLE_API_KEY_FILE` to a file holding the key from the API's
  `api_keys.txt` (or `SUBTITLE_API_KEY`). The `unauthorized` hint says so; README, client and sidecar docs show how.
- **Hidden files and folders are never written either.** Reads and listings already refused them; now a dot-named
  `outputPath`, an output in a hidden folder, an `outputDir` in a hidden allowed folder, or an API-chosen output name
  starting with `.` is refused before anything is converted. The error is the new `hidden-path` (it was
  `path-not-allowed`). A path outside the allowed folders still gets `path-not-allowed` first.
- **Symbolic links are never followed.** A link anywhere below an allowed folder is refused for reads, listings and
  writes, even when it points inside (`path-not-allowed`, "Symlinks are not followed"); `list_files` leaves links out;
  `ifExists: "replace"` never replaces a link or a special file. Files are opened without following links and checked
  again after opening (Linux: the opened file's path; elsewhere: device and inode), so a folder swapped for a link
  mid-call is caught. FIFOs and other special files are never opened. An allowed folder reached through a link (such
  as `/var` on macOS) still works.
- **Subtitle files only.** Local reads, listings and writes accept only names ending in a subtitle extension the
  engine reads, always from the API (`GET /v1/limits` `storage.extensions`; the MCP keeps no copy that could go stale).
  With an older API that doesn't report the list, local files are read, listed and written without this check, and
  the result carries the warning `mcp-extension-check-skipped` (update the API); the allowed-folder, hidden and
  symbolic-link rules still apply. Anything else,
  including names without an extension, is the new `extension-not-allowed`, with a one-line message. A chosen
  `outputPath` must end in the target format's extension (`out.vtt` for WebVTT). Sub-folders are listed whatever their
  names.
- **Folder cap.** `list_files` on a local folder (or prefix) with more than 5000 subtitle files and sub-folders fails
  with `folder-too-large` and a `limit`; narrow it with `prefix`. The API has the same cap for its storage.
- **Preview cache.** `preview_text` keeps decoded texts in memory (`SUBTITLE_MCP_PREVIEW_CACHE_BYTES`, default
  67108864, least recently used first; `SUBTITLE_MCP_PREVIEW_CACHE_TTL_MS`, default 300000; `0` bytes turns it off),
  so later pages don't read or convert the file again. Every call still checks for changes: local files by size,
  modification time and inode; API files by `ETag` / `If-None-Match` (a `304` means unchanged). Changed files are read
  again and old cursors give `preview-source-changed`, as before.
- **Busy API.** `browse-busy` and `conversion-engine-stuck` (503 with `Retry-After`) are retried for reads and
  listings like `queue-full`, with progress messages saying why; hints for these and for `host-not-allowed` /
  `origin-not-allowed`. OpenAPI snapshot and types refreshed.
- Contract suite: run 1 starts the API with `API_AUTH_DISABLED=true` (needed for APIs that require a key; older
  images ignore it). New feature-detected contract tests for the extension list, `ETag` change checks feeding the
  preview cache, and (on a shared filesystem) symbolic links.

### Breaking changes

These change tool names, result shapes and configuration. The project is still an early alpha, so there are no aliases or compatibility shims; update clients and settings when you upgrade.

- **`get_job_file` is renamed to `preview_text`.** It is a text preview for the model, not a file download: it never returns bytes to save, base64 or an embedded resource. Arguments are `jobId` and `which` (`input` | `output`), plus the new optional `maxBytes` and `cursor`. The text is in the structured result's `text` field only; it is no longer repeated as a content text block, which used to send it twice.
- **`preview_text` pages long text** instead of cutting it off. A page ends on a whole cue (SRT, WebVTT) or a whole line (other text) and never splits a character; only a single cue larger than the page size is returned alone over it. `maxBytes` sets the page size in UTF-8 bytes (default 64 KB, clamped to 4 KB up to the server maximum). When more text follows, `truncated` is true and `next` is an opaque cursor to pass back as `cursor`. Each page reports `unit`, `fromCue`/`toCue`/`returnedCues`/`totalCues` (or the `…Line` equivalents), `returnedBytes`, `totalBytes` and the `maxBytes` in effect. Byte counts are UTF-8 without a BOM. Paging is stateless: if the stored file changes between pages, the call fails with `preview-source-changed`; a cursor that doesn't belong to the call fails with `preview-cursor-invalid`; a single cue over the server maximum fails with `preview-cue-too-large`.
- **Inline `convert_subtitle` results are always the whole file as an embedded resource**, for text and binary targets alike (text formats as text, binary as base64). The resource is the deliverable for the client to save. Text results are no longer returned as a plain text block or in `outputs[].text`, and are never cut. `outputs[].attached` is true for an attached file. Inline results are not stored anywhere, so `preview_text` can't read them; the structured result has the `jobId` and a short `hint`: save the attached file and read it locally, or convert with an API `output` to preview it.
- **`SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` is removed**, and setting it now fails startup with a message saying what replaced it. Preview page sizes are set with `SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES` (default 65536) and `SUBTITLE_MCP_PREVIEW_MAX_BYTES` (default 262144, at most 1048576).
- Removed `resourceUri` and `inline` from the `convert_subtitle` results and schema; the embedded resource's `uri` only labels the block.
- The inline embedded resource is byte-identical to the stored deliverable. UTF-8 text keeps its byte order mark (a leading U+FEFF when the encoding is `utf-8`), and `outputs[].bytes` is the size of the attached file. Text in other encodings (UTF-16, legacy code pages) is attached as a base64 `blob` of the exact bytes instead of re-encoded text. The MCP now asks the API for base64 on every inline conversion.
- A malformed `preview_text` `cursor` (empty, wrong characters, too long, or a forged position or unit) is `preview-cursor-invalid`, not `invalid-arguments` or `preview-source-changed`. `preview-source-changed` now means only that the stored bytes changed.
- `preview_text` results have a new required `source` field (`job`, `local` or `remote`). With browsing on (the default), `jobId` and `which` become optional in its input and output schemas, because a call can give `location` instead.

### New: browsing and reading by location (on by default)

- Browsing is on by default and follows the API: the new `list_files` tool is registered and `preview_text` takes a `location` instead of `jobId` and `which`. Local allowed folders are browsable; the API's storage is browsable when the API reports `storage.list` on (`GET /v1/limits`, its `STORAGE_LIST_ENABLED`, also on by default), read at startup and when the limits cache expires. With the API's browsing off, API locations fail with `storage-list-disabled` and a hint naming the API setting. `SUBTITLE_MCP_LIST_ENABLED` is optional: `false` hides `list_files` and `preview_text {location}`; `true` is the same as unset.
- `preview_text` and its `location` argument start by saying that `location` takes the file's full URI (`s3://bucket/key`, `file:///path`) or an absolute local path, with examples including a sidecar (`s3://subs/show.srt.json`). `list_files` says to pass each item's `location` unchanged, and its text result names one as an example.
- `list_files {location, prefix?, cursor?}` lists one page (up to 200) of files and sub-folders in a local folder or an API `file://` / `s3://` location, in name order, with `name`, `location`, `type`, `size` and `modified`. `prefix` filters names (a `/` descends into a sub-folder); there are no globs, totals, date sorting or offsets. Paging uses an opaque stateless cursor bound to the location, prefix and side; files present for the whole walk appear exactly once, and there is no snapshot.
- `preview_text {location}` reads a file by location with the same paging, change detection and SRT view of binary files as a job preview, inside the same allowlists and guards. HTTPS can't be read or listed by location.
- `list_allowed_folders` adds a `remote` member when browsing is on: `state` (`on`, `disabled-api`, `unknown`), the API's `locations` (only when its switch is on) and a hint. With browsing off it is unchanged.
- **Hidden files and folders are never read or listed**, by any tool, with browsing on or off: a path with any component starting with `.` (a dotfile, anything inside a dot-named folder, or anything in a hidden allowed folder) is `path-not-allowed` for `preview_text {location}`, `list_files`, and the `path` / `profilePath` of `convert_subtitle`, `detect_format` and `validate_profile`. Checked on the requested path before any filesystem call and again on its real path, so a symbolic link can't alias a hidden target. Before, hidden entries were only left out of listings. Hidden allowed folders are no longer named in `list_allowed_folders` (new optional `hiddenFolders` count), tool descriptions or hints. Dotted names (`show.en.srt`) and writes are unaffected. API locations get the same rule from the API.
- The `preview_text` error for `jobId` without `which` has its `errors[]` pointer (`/which`) and hint again, as for other argument errors; the other `location` / `jobId` combinations name their argument too.
- New error codes: `list-cursor-invalid` (local cursor), and from the API `storage-list-disabled`, `storage-not-listable` and `storage-cursor-invalid`. OpenAPI snapshot and types refreshed.

### Other changes

- **Not-configured mode (stdio).** A configuration problem the user can fix (`SUBTITLE_API_URL` missing or invalid, an API key file that doesn't exist, can't be read or has no key, both `SUBTITLE_API_KEY` and `SUBTITLE_API_KEY_FILE`, an allowed folder that doesn't exist, a mistyped `SUBTITLE_MCP_*` variable or argument) no longer exits before the handshake, where clients only show "failed". The server starts, its instructions open with `NOT CONFIGURED`, the problem and the fix, and every tool returns the new error `mcp-misconfigured` with the same problem and fix. The full message also goes to stderr; secrets never appear. In HTTP mode these problems still stop startup (exit code 2). Key-file errors now name the file and say whether it is missing, unreadable, a folder or empty.
- `preview_text` converts binary files (EBU STL, PAC, Cavena 890, …) to SRT through the API to show their text, inline only and without writing anything. The result has `convertedFrom` (the stored format id), `convertedTo: "srt"` and the conversion `warnings`. A failed conversion returns the normal error with its candidates, plus a hint to read the file with `convert_subtitle`. Text files are returned as stored, legacy encodings included.
- A missing or invalid argument says it is required or names the valid values, instead of zod's "Invalid option" (all tools). A single invalid argument is no longer repeated on a second line of the error text.
- `preview_text` warns with `max-bytes-clamped` (requested and applied values) when it clamps `maxBytes`.
- `preview-cue-too-large` names the stored file's location and suggests reading it directly or raising `SUBTITLE_MCP_PREVIEW_MAX_BYTES` (up to 1 MiB), instead of converting to a file.
- `preview_text` rewords the API's `job-output-not-stored` and `job-input-not-stored` for the usual inline case: the converted file was attached to the convert result and not stored, so save it and read it locally, or convert with an API `output`.
- Logs and errors: `attempts` counts the tries of a single API request (1 unless retried), not every request a tool makes. `preview_text` used to report `attempts: 2` and the same request id twice, because its job metadata and file requests were counted as attempts and shared one `X-Request-Id`; the file request now has its own id (`<id>.f`, and `<id>.s` for the SRT conversion). Conversions and detection from an API `input` log `source` as the scheme (`s3`, `file`, `https`) instead of `inline`, and the summary names the input file instead of "content". Presigned query strings never reach the logs.
- Every `preview_text` input and output field has a description, and output schemas list the `warnings` array once instead of twice.
- Fix `ambiguous-encoding` `candidates` for text encodings: the API's `{encoding, language, hits, sample}` objects are passed through as objects instead of `"[object Object]"`, and the error text lists them one per line. The error schema accepts strings and these objects; OpenAPI snapshot and types refreshed.
- Stored outputs report the stored object's name in `outputs[].fileName` (the last segment of `output`, e.g. `test2-145152.srt`) instead of the name generated from the source (`show.srt`). The API now does the same; the MCP derives it from `output` for older APIs too.

- Keep npm publishing manual and make the existing GitHub Release step safe to rerun.

- Rename the product to **Smart Subtitle Converter** and update repository, container image, npm package and CLI identifiers. The npm package is published as `smart-subtitle-converter-mcp`. Versions and existing release tags are unchanged.

- Public release: drop `package.json` `"private": true` and the CI publishing guard; document how tags publish.
- Examples and `CONTRACT_API_URL` use the API's default host port `http://localhost:8080` (Compose publishes `127.0.0.1:8080:8080`); Docker-network URLs stay `http://api:8080`.

## 1.3.0 — Unreleased

- Add a GitHub security policy (`SECURITY.md`) and [docs/security.md](docs/security.md) covering allowed folders, writes, API keys and HTTP mode.
- Docs: troubleshooting explains MCP error codes with what happened, why and what to do, and points to the API's errors reference for API codes; README lists `get_job_file` and covers API locations and jobs in the main flow; tools lists the error and warning detail fields.
- Pass through API `ambiguous-encoding` (with `candidates` and the new `error.probe`) with a hint naming `formatOptions.pac.inputCodePage` or `encoding.input`. Keep the new API warning details (`durations`, `fields`, `timecode`, `frameRate`) for `long-cue`, `format-defaults-applied`, `programme-start-not-applied` and `frame-rate-assumed`; refresh the OpenAPI snapshot and types.
- Pass through `profile.encoding.language`; document text-encoding `candidates` as `{encoding, language, hits, sample}` and the agent retry (`encoding.input` / `encoding.language`, pick only from the list, tell the user). Cover `encoding-forced` and `language-applied` warnings in troubleshooting.
- Add get_job_file(jobId, input|output), current-location metadata and Unicode/binary body blocks; no generic URI fetch or local save parameter. Surface distinct job state/storage/replay errors with redacted locations.
- Collapse ifExists to error | replace everywhere; remove archive/delete helpers, error codes and the local operator gate. Pass explicit policy to API outputs; HTTPS follows signer/receiver policy.
- Negotiate wait from MCP timeout and API maximum, expose separate input/output URI schemes in descriptions/limits (omit missing scheme arrays), retain list_allowed_folders even without path access, report polling timeout as job-not-ready and missing asynchronous response bytes as job-output-not-stored. Never replay a conversion POST.


Pairs with API 1.3.0.

- Move schema validation to Zod 4.6.7 and refresh body-parser/fast-uri locks to satisfy the existing production dependency-audit gate; retain structured success/error and validation regression coverage.

- Complete API/local storage distinctions, asynchronous timeout/error guidance and configuration/README pointers. Preserve admitted synchronous failure job ids; refresh effective-limits types.

- Include structured tool errors in advertised output schemas, retaining required-success validation, so clients that list tools can read failed job/conversion results.

- Pass input/output/sidecar to the API, expose jobId and poll 202 job URLs with a bounded wait. Preserve local single-file writes; report metadata-only asynchronous results without inventing empty files.
- Mark possible API storage writes in tool annotations; do not replay uncertain conversion POSTs after a connection loss.

- Breaking: remove convert_batch, ZIP helpers and batch configuration. Submit one subtitle per call.

## [1.2.1] - 2026-10-17

Pairs with API 1.2.x (contract-tested against API 1.2.1).

### Added
- `characters-replaced` warnings pass through the API's structured `details.remedy`: `option`
  (e.g. `formatOptions.pac.codePage`), `allowedValues`, `currentValue`, `candidates` (for PAC: code pages the API
  tested to keep every character), `suggested` (only when exactly one fits), `unicodeAlternative` (`fpc`) and
  `note` (libse limits). With several candidates, the agent chooses by the text's language. (#7)

## [1.2.0] - 2026-10-17

Pairs with API 1.2.x (contract-tested against API 1.2.0).

### Added
- Binary outputs carry the API's read-back `verification` (`convert_subtitle`: `outputs[].verification`;
  `convert_batch`: `entries[].verification`) with a verdict `lossless` | `quantised` | `lossy` | `unverified`,
  cue counts, timing shift and replaced characters by cue. The tool summary shows one line per output. (#6)
- Warnings may carry a `hint` (the setting that fixes them) and `details` (cue numbers and code points, never cue
  text). New warning codes passed through: `text-truncated`, `zero-length-cue`, `source-replacement-chars`,
  `verification-failed`. (#6)
- `detect_format` returns `bom`, `lineEndings` and source `warnings`. (#6)

### Changed
- PAC and Unicode PAC (FPC) inputs that can't be told apart by file name fail with `ambiguous-format`, listing
  the candidates in `error.candidates`; pass `profile.source.format` (`pac` or `fpc`). (#6)

## [1.1.3] - 2026-10-17

Pairs with API 1.1.x.

### Added
- `list_allowed_folders` tool: the folders in effect, each with `mode` (read-write/read-only) and `source`
  (`config`/`client-roots`), plus a `state` (`ready`, `waiting-for-roots`, `roots-unsupported`, `roots-empty`,
  `roots-failed`, `none`) and a hint when there are none. (#5)

### Changed
- Configured folders (`SUBTITLE_MCP_ALLOWED_DIRS`, `SUBTITLE_MCP_READONLY_DIRS`) are now **combined** with the
  client's MCP roots instead of replacing them. A configured read-only folder stays read-only inside a client root;
  an empty or failing `roots/list` never removes configured folders. (#5)
- Startup instructions no longer state "Allowed folders: none yet" before the client's roots arrive; they name
  both sources and point to the tool descriptions and `list_allowed_folders`. (#5)
- `path-not-allowed` hints include the current allowed folders. (#5)

## [1.1.2] - 2026-10-17

Pairs with API 1.1.x (contract-tested against API 1.1.1).

### Changed
- Examples and `CONTRACT_API_URL` use the API's new default host port `http://localhost:4041`; Docker-network
  examples keep `http://api:8080` (container port). `SUBTITLE_API_URL` stays required. (#4)

## [1.1.1] - 2026-10-17

Pairs with API 1.1.x.

### Added
- Every path-taking tool lists the allowed folders in its description, each marked read-write or read-only; with
  none, it says paths are disabled and names the settings. (#3)
- Every `roots/list` answer is logged at `info` (count, hashed paths, skipped entries with reasons). (#3)

### Changed
- Tool descriptions are rebuilt after every roots change and `notifications/tools/list_changed` is sent. (#3)

### Fixed
- An empty (Claude Desktop) or failing `roots/list` can no longer wipe configured folders; a failing one keeps the
  previous client roots. (#3)
- `file://` root URIs are decoded correctly (drive letters, percent-encoding, UNC). (#3)
- CI smoke test no longer fails with exit 141 (SIGPIPE) under `pipefail`. (#2)

## [1.1.0] - 2026-10-17

First version. Pairs with API 1.1.x (contract-tested against API 1.1.0).

### Added
- Tools `list_formats`, `list_presets`, `get_profile`, `validate_profile`, `detect_format`, `convert_subtitle`
  and `convert_batch`; resources for the profile schema, formats and limits. (#1)
- stdio transport and stateless Streamable HTTP transport with a required inbound bearer token. (#1)
- Allowed folders (read-write and read-only), with MCP client roots used when none are configured. (#1)
- Atomic writes through a staging folder and the original collision policies (superseded by error | replace). (#1)
- All-or-nothing `convert_batch` into a new folder (decision D-44). (#1)
- API version check at startup with an `mcp-api-version-mismatch` warning, retries for 429/503, CI and a
  distroless Dockerfile. (#1)

### Changed
- Project renamed from `subtitleedit-mcp` to `subtitleedit-converter-mcp` (the API from `subtitleedit-api` to
  `subtitleedit-converter-api`).

[Unreleased]: https://github.com/Wauter/smart-subtitle-converter-mcp/compare/074953f...HEAD
[1.2.1]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/7
[1.2.0]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/6
[1.1.3]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/5
[1.1.2]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/4
[1.1.1]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/3
[1.1.0]: https://github.com/Wauter/smart-subtitle-converter-mcp/pull/1
