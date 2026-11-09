# Tools

The server is a thin client over the [Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api);
each tool maps to an API endpoint, except `list_allowed_folders`, which is local. The tool descriptions the client
sees are the authoritative, live version of this page (they include the allowed folders in effect).

| Tool | API endpoint | Purpose |
|---|---|---|
| `list_formats` | `GET /v1/formats` | Formats (id, name, extensions, read/write, text/binary); `includeBinary`, `writableOnly`, `limit` |
| `list_presets` | `GET /v1/profiles` | Built-in and mounted presets, with validity and load errors |
| `get_profile` | `GET /v1/profiles/{name}` | Raw and resolved preset JSON |
| `validate_profile` | `POST /v1/profiles/validate` | Validate a profile (inline or `path`); pointer-level errors with hints |
| `detect_format` | `POST /v1/detect` | Format, encoding and language of inline content, a local `path` or API `input`, plus `bom`, `lineEndings` and source `warnings` |
| `convert_subtitle` | `POST /v1/convert/json` | Convert one file: exactly one content/path/input; result inline, local outputPath/outputDir or API output |
| `get_job_file` | `GET /v1/jobs/{id}/input` or `/output` (+ `POST /v1/convert/json` to SRT for binary files) | Re-read the job's current stored input or single subtitle output as text |
| `list_allowed_folders` | – (local) | The folders in effect, with `mode`, `source` and `state` ([folders-and-roots.md](folders-and-roots.md)) |

`list_allowed_folders` stays registered even when paths are unavailable (empty folders, state none). It covers MCP-local folders only, never API input/output URIs. Inline text results of `convert_subtitle` come back in `outputs[].text` (and as a text block); binary results are attached as an embedded resource the client can save, and that resource's `uri` only labels the block (it is not readable with `resources/read`).

Text longer than `SUBTITLE_MCP_INLINE_TEXT_MAX_BYTES` (UTF-8 bytes, default 65536) is cut, never inside a character: SRT at the last whole cue, other text at the last full line. Text results carry `truncated` (true when cut), `returnedBytes` and `totalBytes`, and for SRT `returnedCues` and `totalCues`; the summary says plainly when the text was cut. To keep a whole long file, write it with `outputPath`/`outputDir` or an API `output`.
How files are written: [writing-files.md](writing-files.md).

## Resources

`subtitleedit://schemas/profile.json`, `subtitleedit://formats`, `subtitleedit://limits`.

## Errors

Errors come back as `isError: true` with a structured `error`: `source` (`api` or `mcp`), `code`, `detail`, `hint`,
`requestId`, and where they apply `errors[]` (pointer, message, hint), `candidates` and `probe` (strings for `ambiguous-format` and PAC code pages; `{encoding, language, hits, sample}` objects for `ambiguous-encoding` with probe `text-encoding`), `jobId` /
`jobUrl`, a redacted `location`, `limit`, `retryAfterSeconds`, and for local write failures `path` + `osError`.
API codes are on the API's [errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page
(what happened, why, what to do). MCP codes (`path-not-allowed`, `output-exists`, `cross-device`, …) are in
[troubleshooting.md](troubleshooting.md). `path-not-allowed` hints include the current allowed folders.

## Warnings

Report every warning the tools return. Each has a `code` and `message`, and may carry a `hint` (the setting
that fixes it) and `details` (positions and settings, never cue text). What each API warning means, including
`characters-replaced` remedy fields: the API's [errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page.

The MCP passes API warnings through unchanged. It adds only `mcp-api-version-mismatch`
([troubleshooting.md](troubleshooting.md#version-mismatch)) and `mcp-ebu-size` (a local `.stl` larger than
the API's EBU STL limit).

## Verification

Binary outputs carry `outputs[].verification` (verdict, cue counts, timing shift, replaced characters). The
summary shows one line per output. How to read the verdict and fields is on the same
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page.

A clean round trip proves the file is self-consistent through the converter's own reader, not that a given
playout system accepts it.

## API storage and job ids

`convert_subtitle` accepts `input`, `output` and `sidecar`; `detect_format` accepts `input`. Use exactly one source: inline `content`, MCP-local `path` or API-side `input`. API locations can be `file:///data/file.srt`, a bare absolute path, `s3://bucket/key` or `https://host/file`; they are resolved by the API, not the MCP's local allowed folders. `output` is an exact API destination and cannot be mixed with local `outputPath`/`outputDir`. `sidecar:true` applies only to API output and is ignored for local outputPath/outputDir. `ifExists` is error (default) | replace for both local and API destinations. Filesystem/S3 default to collision errors; presigned HTTPS PUT follows what its signer allowed, not a disk/S3 lock.

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

Results include jobId, which, fileName, mediaType, `bytes` (the stored file's size), the redacted location, `format`
when the job recorded it, and the file content as text in `text` (also sent as a text block). Text files are returned
as stored (UTF-8, UTF-16 or the recorded legacy encoding, decoded exactly). Binary files (EBU STL, PAC, Cavena 890, …)
are converted to SRT through the API for reading, inline only (no output location, nothing written, the stored file
is unchanged): the result then has `convertedFrom` (the stored format id), `convertedTo: "srt"` and the
conversion's `warnings`, which say what the SRT view lost. If that conversion fails (for example `ambiguous-encoding`
on a PAC file), the normal error comes back with its candidates, and the hint says how to read the file with
`convert_subtitle` and the right setting. `text` follows the same size limit and `truncated` fields as inline
conversion results. Base64 is never returned, and there is no embedded resource or `resourceUri`.
A missing `jobId` or `which` is reported as required, with the valid values. Subtitle text is not logged. Errors distinguish `job-not-ready`, `job-not-found`,
`job-input-not-stored`, `job-output-not-stored`, `job-file-gone` and `job-location-not-replayable` (see the API's
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page); the last two
include a redacted location. Input may be readable while output is pending. A failed job has no successful
stored output. A missing job is not a failed conversion.

The convert description reports API storage schemes when limits are known; `subtitleedit://limits` exposes
the full API response. The schemes line is omitted if either input/output scheme array is missing. `Prefer: wait` is bounded by MCP timeout and API maximum wait, not by destination.
A poll timeout is `job-not-ready` with jobId; accepted work may still finish and write its output.
