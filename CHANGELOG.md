# Changelog

All notable changes to `subtitleedit-converter-mcp` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The MCP shares its major.minor version with the
[Subtitle Edit Converter API](https://github.com/Wauter/subtitleedit-converter-api): use the MCP release whose
major.minor matches your API. Patch versions move independently. Versions are recorded here when merged to `main`;
tags and releases follow on the owner's go-ahead.

## 1.3.0 — Unreleased

- Docs: troubleshooting explains MCP error codes with what happened, why and what to do, and points to the API's errors reference for API codes; README lists `get_job_file` and covers API locations and jobs in the main flow; tools lists the error and warning detail fields.
- Pass through API `ambiguous-encoding` (with `candidates` and the new `error.probe`) with a hint naming `formatOptions.pac.inputCodePage` or `encoding.input`. Keep the new API warning details (`durations`, `fields`, `timecode`, `frameRate`) for `long-cue`, `format-defaults-applied`, `programme-start-not-applied` and `frame-rate-assumed`; refresh the OpenAPI snapshot and types.
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

[Unreleased]: https://github.com/Wauter/subtitleedit-converter-mcp/compare/074953f...HEAD
[1.2.1]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/7
[1.2.0]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/6
[1.1.3]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/5
[1.1.2]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/4
[1.1.1]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/3
[1.1.0]: https://github.com/Wauter/subtitleedit-converter-mcp/pull/1
