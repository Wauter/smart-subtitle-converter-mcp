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
| `preview_text` | `GET /v1/jobs/{id}/input` or `/output` (+ `POST /v1/convert/json` to SRT for binary files) | Read the text of a job's current stored input or single subtitle output, one page at a time |
| `list_allowed_folders` | – (local) | The folders in effect, with `mode`, `source` and `state` ([folders-and-roots.md](folders-and-roots.md)) |

`list_allowed_folders` stays registered even when paths are unavailable (empty folders, state none). It covers MCP-local folders only, never API input/output URIs.

## Inline convert results

Without an output location (`outputPath`/`outputDir` or an API `output`), `convert_subtitle` attaches the whole
converted file to its result as an embedded resource, for text and binary targets alike: text formats as `text`,
binary formats (EBU STL, PAC, …) as base64 `blob`, with the format's `mimeType`. The file is never cut. The
resource is the deliverable, for the client to save; its `uri` only labels the block and is not readable with
`resources/read`.

The structured result describes the file but doesn't repeat its content: `outputs[]` has `fileName`, `format`,
`formatId`, `kind`, `mediaType`, `encoding`, `cues`, `bytes` and `attached: true`, plus `verification` for
binary targets. Alongside it are `jobId`, `detected`, `stats`, `warnings` and a short `hint` on reading the
converted text. Some clients (Claude Code, for example) show the model only the structured result when there is
one, so the model sees this metadata and the client still receives the file.

To read converted text yourself, use `preview_text`. It reads stored files only: an inline result isn't stored, so
convert with an API `output` first, then call `preview_text` with `which: "output"`. When the source came from an
API `input`, `preview_text` with `which: "input"` reads it straight away. `hint` says which of these applies.

Example result for an inline conversion to EBU STL:

```json
{
  "content": [
    { "type": "text", "text": "Converted show.srt (SubRip, utf-8, en) → show.stl (EBU STL, iso-6937): 412 → 412 cues in 38 ms. The whole converted file is attached as an embedded resource." },
    { "type": "resource", "resource": { "uri": "subtitleedit://outputs/mcp-…/show.stl", "mimeType": "application/octet-stream", "blob": "…" } }
  ],
  "structuredContent": {
    "jobId": "0de4707d46fe4ff9b06ae83736f7dbbb",
    "outputs": [{ "fileName": "show.stl", "format": "EBU STL", "formatId": "ebustl", "kind": "binary", "mediaType": "application/octet-stream",
                  "encoding": "iso-6937", "contentEncoding": "base64", "cues": 412, "bytes": 52224, "attached": true, "verification": { "…": "…" } }],
    "hint": "The converted file is attached as an embedded resource for the client to save. It is not stored, so preview_text cannot read this output; …",
    "warnings": [], "…": "…"
  }
}
```

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

## Previewing a job's text

`preview_text` reads the subtitle text of a job's stored input or output so the model can check spelling,
language and timing. It is a view, not a download: it never returns bytes to save.

Arguments:

| Argument | Required | Description |
|---|---|---|
| `jobId` | yes | The `jobId` from `convert_subtitle` |
| `which` | yes | `input` (the stored source) or `output` (the single stored subtitle result, never a sidecar) |
| `maxBytes` | no | Page size in UTF-8 bytes. Defaults to `SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES` (65536); values below 4096 are raised to 4096 and values above `SUBTITLE_MCP_PREVIEW_MAX_BYTES` (262144) are lowered to it. The value in effect comes back as `maxBytes` |
| `cursor` | no | The `next` value from the previous page, unchanged. Omit it for the first page |

Files are reached by job id only. There is no URI or local save-path argument. Local path uploads and inline
content have no stored input, and a conversion without an API `output` has no stored output.

Text files are returned as stored (UTF-8, UTF-16 or the recorded legacy encoding, decoded exactly). Binary files
(EBU STL, PAC, Cavena 890, …) are converted to SRT through the API, inline only (nothing is written, the stored
file is unchanged). Then `convertedFrom` is the stored format id, `convertedTo` is `"srt"`, and `warnings` say what
the SRT view lost. If that conversion fails (for example `ambiguous-encoding` on a PAC file), the normal error comes
back with its candidates, and the hint says how to read the file with `convert_subtitle` and the right setting.

### Pages

The text is split into whole units: cues for SRT and WebVTT (a WebVTT header or `NOTE` block travels with the
next cue), lines for everything else. A page is the longest run of whole units that fits in `maxBytes`. Pages
always end on a whole cue and never split a character. Only a single cue larger than `maxBytes` makes a page go
over it, and that cue is then returned alone. A cue larger than `SUBTITLE_MCP_PREVIEW_MAX_BYTES` can't be
previewed (`preview-cue-too-large`). Joining all pages gives back the whole text exactly.

Byte counts are UTF-8 bytes of the text without a byte order mark, so `totalBytes` can be a few bytes smaller
than `bytes`, the stored file's size. For a binary file they count the SRT text, not the stored bytes.

When more text follows, `truncated` is `true` and `next` holds an opaque cursor. Call again with the same `jobId`
and `which` and `cursor: next`; `maxBytes` may change between pages. The last page has `truncated: false` and no
`next`.

Paging is stateless: there is nothing to close or expire on the server. Each call reads the stored file again, and
the cursor carries a fingerprint (a SHA-256 hash) of the stored bytes. If the file changed between pages, the call
fails with `preview-source-changed`, and you start again without `cursor`. A cursor used with another job or
`which` fails with `preview-cursor-invalid`. Every page re-reads the whole file (and converts a binary file
again), so prefer larger pages for long files when your context allows.

### Result

| Field | Description |
|---|---|
| `text` | One page of text, ending on a whole cue or line, without a BOM |
| `unit` | `cue` (SRT, WebVTT) or `line` (other text) |
| `truncated`, `next` | More text follows; pass `next` as `cursor` |
| `maxBytes` | Page size in effect after clamping |
| `returnedBytes`, `totalBytes` | UTF-8 bytes of this page and of the whole text |
| `fromCue`, `toCue`, `returnedCues`, `totalCues` | With `unit: "cue"`: 1-based position of this page and the cue counts |
| `fromLine`, `toLine`, `returnedLines`, `totalLines` | With `unit: "line"`: the same in lines |
| `jobId`, `which`, `fileName`, `mediaType`, `bytes`, `location`, `format` | The stored file: name, media type, size, redacted location and recorded format id |
| `convertedFrom`, `convertedTo`, `warnings` | Set for binary files converted to SRT |

The text is sent once, in the structured result's `text`. The content block is a one-line summary of the page
(which cues, how many bytes, whether more follows), without the text. Subtitle text is not logged.

It uses the configured API key, not an owner or admin role. Job ids are unguessable capability tokens. It reads
current storage through the API's current allowlists and limits; files can change or disappear, and a signed
HTTPS query is not kept, so that location cannot be read again. Errors distinguish `job-not-ready`,
`job-not-found`, `job-input-not-stored`, `job-output-not-stored`, `job-file-gone` and
`job-location-not-replayable` (see the API's
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page), and
the paging codes `preview-source-changed`, `preview-cursor-invalid` and `preview-cue-too-large`
([troubleshooting.md](troubleshooting.md#jobs-and-storage-uris)). Input may be readable while output is pending. A
failed job has no stored output. A missing job is not a failed conversion.

The convert description reports API storage schemes when limits are known; `subtitleedit://limits` exposes
the full API response. The schemes line is omitted if either input/output scheme array is missing. `Prefer: wait` is bounded by MCP timeout and API maximum wait, not by destination.
A poll timeout is `job-not-ready` with jobId; accepted work may still finish and write its output.
