# Tools

The server is a thin client over the [Subtitle Edit Converter API](https://github.com/Wauter/subtitleedit-converter-api);
each tool maps to an API endpoint, except `list_allowed_folders`, which is local. The tool descriptions the client
sees are the authoritative, live version of this page (they include the allowed folders in effect).

| Tool | API endpoint | Purpose |
|---|---|---|
| `list_formats` | `GET /v1/formats` | Formats (id, name, extensions, read/write, text/binary); `includeBinary`, `writableOnly`, `limit` |
| `list_presets` | `GET /v1/profiles` | Built-in and mounted presets, with validity and load errors |
| `get_profile` | `GET /v1/profiles/{name}` | Raw and resolved preset JSON |
| `validate_profile` | `POST /v1/profiles/validate` | Validate a profile (inline or `profilePath`); pointer-level errors with hints |
| `detect_format` | `POST /v1/detect` | Format, encoding and language of inline content or a `path`, plus `bom`, `lineEndings` and source `warnings` |
| `convert_subtitle` | `POST /v1/convert/json` | Convert one file: inline content or `path`, result inline or to `outputPath`/`outputDir` |
| `convert_batch` | `POST /v1/convert/json` (base64 zip, chunked) | Convert a folder or list of files into a **new** folder, all or nothing |
| `list_allowed_folders` | – (local) | The folders in effect, with `mode`, `source` and `state` ([folders-and-roots.md](folders-and-roots.md)) |

`convert_batch` is listed only when a writable folder is available; `list_allowed_folders` whenever paths are
available. Inline text outputs larger than `SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` come back as an embedded resource.
How files are written: [writing-files.md](writing-files.md).

## Resources

`subtitleedit://schemas/profile.json`, `subtitleedit://formats`, `subtitleedit://limits`.

## Errors

Errors come back as `isError: true` with a structured `error`: `source`, `code`, `detail`, `hint`, `requestId`,
and for local write failures `path` + `osError`. API error codes are documented in the API's
[docs/errors.md](https://github.com/Wauter/subtitleedit-converter-api/blob/main/docs/errors.md); local codes
(`path-not-allowed`, `output-exists`, `cross-device`, …) in [troubleshooting.md](troubleshooting.md).

- `path-not-allowed` hints include the current allowed folders.
- PAC and Unicode PAC (FPC) files that can't be told apart by name fail with `ambiguous-format`, with the
  candidates in `error.candidates`; pass `profile.source.format` (`pac` or `fpc`).

## Warnings

Report every warning the tools return. Each has a `code` and `message`, and may carry:

- `hint`: the setting that fixes it. The API never switches code pages or character tables by itself.
- `details`: cue numbers and code points, never cue text.

Codes include `characters-replaced`, `text-truncated`, `zero-length-cue`, `source-replacement-chars`,
`verification-failed`, `frame-quantised`, `lossy-format` and `frame-rate-changed` (an EBU STL frame-rate code
mismatch: timings move by less than one frame, with no cumulative drift). `mcp-api-version-mismatch` is added by
the MCP itself ([troubleshooting.md](troubleshooting.md#version-mismatch)).

### `characters-replaced` remedy

`characters-replaced` carries `details.remedy`:

| Field | Meaning |
|---|---|
| `option` | The setting that controls it, e.g. `formatOptions.pac.codePage` |
| `allowedValues` | Every valid value of `option` |
| `currentValue` | The value in effect |
| `candidates` | Values that keep the characters (for PAC tested by the API: code pages that keep every character of the text) |
| `suggested` | Only when exactly one candidate fits |
| `unicodeAlternative` | `fpc` (Unicode PAC), which keeps any character |
| `note` | Known libse limits |

The API never guesses a language-based code page; with several candidates, choose by the text's language.
Full field list: the API's
[Remedy reference](https://github.com/Wauter/subtitleedit-converter-api/blob/main/docs/errors.md#remedy-characters-replaced).

## Verification

Binary outputs carry `verification` (`convert_subtitle`: `outputs[].verification`; `convert_batch`:
`entries[].verification`): the written file is read back and compared, with a verdict `lossless` | `quantised` |
`lossy` | `unverified`, cue counts, timing shift and replaced characters by cue. The summary shows one line per
output.

A clean round trip proves the file is self-consistent through the converter's own reader, not that a given playout
system accepts it.
