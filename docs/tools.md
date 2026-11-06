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
| `detect_format` | `POST /v1/detect` | Format, encoding and language of inline content, a local `path` or API `input`, plus `bom`, `lineEndings` and source `warnings` |
| `convert_subtitle` | `POST /v1/convert/json` | Convert one file: exactly one content/path/input; result inline, local outputPath/outputDir or API output |
| `get_job_file` | `GET /v1/jobs/{id}/input` or `/output` | Re-read the job's current stored input or single subtitle output |
| `list_allowed_folders` | – (local) | The folders in effect, with `mode`, `source` and `state` ([folders-and-roots.md](folders-and-roots.md)) |

`list_allowed_folders` stays registered even when paths are unavailable (empty folders, state none). Its roots cover MCP-local paths only, never API input/output URIs. Inline text outputs larger than `SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` come back as an embedded resource.
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

Binary outputs carry `outputs[].verification`: the written file is read back and compared, with a verdict `lossless` | `quantised` |
`lossy` | `unverified`, cue counts, timing shift and replaced characters by cue. The summary shows one line per
output.

A clean round trip proves the file is self-consistent through the converter's own reader, not that a given playout
system accepts it.

## API storage and job ids

`convert_subtitle` accepts `input`, `output` and `sidecar`; `detect_format` accepts `input`. Use exactly one source: inline `content`, MCP-local `path` or API-side `input`. API locations can be `file:///data/file.srt`, a bare absolute path, `s3://bucket/key` or `https://host/file`; they are resolved by the API, not the MCP's local folder roots. `output` is an exact API destination and cannot be mixed with local `outputPath`/`outputDir`. `sidecar:true` applies only to API output and is ignored for local outputPath/outputDir. `ifExists` is error (default) | replace for both local and API destinations. Filesystem/S3 default to collision errors; presigned HTTPS PUT follows what its signer allowed, not a disk/S3 lock.

The result surfaces `jobId`. The MCP polls `GET /v1/jobs/{id}` after a 202, respecting Retry-After and the tool timeout/cancellation budget. It accepts only the exact relative job URL; no arbitrary Location is followed with bearer credentials. Poll timeout/cancellation does not cancel the accepted API job. A gone record is reported as `job-not-found`, not a conversion failure.

Jobs retain metadata only, never subtitle bytes. For asynchronous work use an API `output` URI: the MCP can report that stored result. If response-only work overruns the wait, the MCP returns `job-output-not-stored` with jobId and writes nothing locally. Do not retry uncertain writes blindly. Conversion POSTs are never automatically replayed; transient I/O retries happen inside the accepted API job.

Failed admitted conversions also surface `error.jobId` / `error.jobUrl` when supplied by the API. Tool output
schemas permit structured errors as well as success results; required success fields are validated before
returning a success. No external polling location is followed.

## Re-reading a job file

`get_job_file` accepts exactly `{jobId, which:"input"|"output"}`. Use it after storage-to-storage conversion
when the actual files are needed, often alongside warnings. Output means the single subtitle destination,
never a sidecar. There is no arbitrary URI or local save-path parameter. Local path uploads have no stored
input, and omitted API output has no stored output: use the original local file or conversion response.

It uses the configured API key, not an owner/admin role. Job ids are unguessable capability tokens. It re-reads
current storage through current API allowlists/limits, without detection or conversion. Files can change or
vanish; a signed HTTPS query is not retained, so that location cannot be replayed.

Results include jobId, which, fileName, mediaType, decoded bytes, redacted location, contentEncoding and
where the body is in content[]. Unicode text is inline up to the normal text limit; larger text and binary
are embedded resources. Subtitle text is not logged. Errors distinguish `job-not-ready`, `job-not-found`,
`job-input-not-stored`, `job-output-not-stored`, `job-file-gone` and `job-location-not-replayable`; the last two
include a redacted location. Input may be readable while output is pending. A failed job has no successful
stored output. A missing job is not a failed conversion.

The convert description reports API storage schemes when limits are known; `subtitleedit://limits` exposes
the full API response. The schemes line is omitted if either input/output scheme array is missing. `Prefer: wait` is bounded by MCP timeout and API maximum wait, not by destination.
A poll timeout is `job-not-ready` with jobId; accepted work may still finish and write its output.
