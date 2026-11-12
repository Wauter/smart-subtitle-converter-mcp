# Tools

The server is a thin client over the [Smart Subtitle Converter API](https://github.com/Wauter/smart-subtitle-converter-api);
each tool maps to an API endpoint, except `list_allowed_folders` and local `list_files` calls, which stay in the MCP. The tool descriptions the client
sees are the authoritative, live version of this page (they include the allowed folders in effect).

| Tool | API endpoint | Purpose |
|---|---|---|
| `list_formats` | `GET /v1/formats` | Formats (id, name, extensions, read/write, text/binary); text and binary by default, `includeBinary: false` for text only; `writableOnly`, `limit` |
| `list_presets` | `GET /v1/profiles` | Built-in and mounted presets, with validity and load errors |
| `get_profile` | `GET /v1/profiles/{name}` | Raw and resolved preset JSON |
| `validate_profile` | `POST /v1/profiles/validate` | Validate a profile (inline or `path`); pointer-level errors with hints |
| `detect_format` | `POST /v1/detect` | Format, encoding and language of inline content, a local `path` or API `input`, plus `bom`, `lineEndings` and source `warnings` |
| `convert_subtitle` | `POST /v1/convert/json` | Convert one file: exactly one content/path/input; result inline, local outputPath/outputDir or API output |
| `preview_text` | `GET /v1/jobs/{id}/input` or `/output`, or `GET /v1/storage/file` for an API location (+ `POST /v1/convert/json` to SRT for binary files) | Read the text of a job's stored input or output, or of a file by location, one page at a time |
| `list_files` | – (local) or `GET /v1/storage/list` | Unless `SUBTITLE_MCP_LIST_ENABLED=false`: one page of the files and sub-folders in a location |
| `list_allowed_folders` | – (local), + `GET /v1/storage/locations` when browsing is on | The folders in effect, with `mode`, `source` and `state` ([folders-and-roots.md](folders-and-roots.md)); with browsing on, also the API's storage locations |

`list_allowed_folders` stays registered even when paths are unavailable (empty folders, state none). With browsing
off (the default) it covers MCP-local folders only, never API input/output URIs.

## Result format

Every tool result, success or error, is one JSON object. By default it is sent in two forms with the same
information: as `structuredContent`, and as that object serialized to JSON in the first text content block.
Errors set `isError: true` and carry the object `{ "error": … }`. A converted file attached by `convert_subtitle`,
or a `resource_link` to a written file, follows as an extra content block. `SUBTITLE_MCP_RESULT_IN`
([configuration.md](configuration.md)) can keep one form only:

| Value | `structuredContent` | JSON text block | `outputSchema` on tools |
|---|---|---|---|
| `both` (default) | yes | yes | yes |
| `structured` | yes | no | yes |
| `content` | no | yes | no (the spec requires `structuredContent` when a tool declares one) |

Extra blocks (an attached file, a `resource_link`) are sent in every mode. With `structured`, a result without one
has an empty `content` array.

### Why results are sent twice

An MCP tool result can carry a readable part (`content`, a list of text and other blocks) and a structured data
part (`structuredContent`). The MCP specification describes both but doesn't say which one an AI app passes to its
model; it only asks servers, for backwards compatibility, that "a tool that returns structured content SHOULD also
return the serialized JSON in a TextContent block"
([Tools, Structured Content](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content),
same wording in later versions). Proposals to settle it, such as
[SEP-1624](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624) and
[SEP-2200 (PR #2200)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2200), were closed without
a change to the spec.

Apps differ in practice. Claude Code and VS Code pass `structuredContent` to the model when it is present; Cursor
reportedly passes only `content`. So by default the server sends the same information in both parts, and no app
loses a warning, hint or preview page. This only affects the local message from this server to the app; the
requests to the converter API are the same. In apps that pass both parts to the model, the result costs extra
tokens; there, `SUBTITLE_MCP_RESULT_IN=structured` or `content` keeps the part that app uses. The startup
instructions mention the setting, so the model can suggest it.

## Browsing and reading by location

Browsing is on by default and follows the API:

- `list_files` is registered and `preview_text` takes a `location` unless the MCP has
  `SUBTITLE_MCP_LIST_ENABLED=false`. The MCP's local allowed folders are always browsable then.
- The API's own `STORAGE_LIST_ENABLED` (on by default) decides whether the API lists and reads its own storage (`STORAGE_FILE_ROOTS` and
  `S3_ALLOWED_BUCKETS` × `S3_ALLOWED_PREFIXES`). The MCP finds out from `GET /v1/limits` (`storage.list`) when it
  starts, and again whenever the limits cache (`SUBTITLE_MCP_LIMITS_TTL_MS`) expires. The API checks its own switch
  on every request, so a stale cache can't get past it.

| MCP | API | `list_allowed_folders` | `list_files` / `preview_text {location}` |
|---|---|---|---|
| `false` | any | Local folders only, as before; no `remote` member | `list_files` not registered; `location` not accepted |
| unset or `true` | off, older API, or unreachable | Local folders, plus `remote: {state: "disabled-api" or "unknown", locations: [], hint}` | Local paths work; API locations fail with `storage-list-disabled` (or `api-unreachable`) and a hint |
| unset or `true` | on | Local folders, plus `remote: {state: "on", locations: [...]}` | Local paths and API `file://` / `s3://` locations work |

API allowlists never appear while the API's switch is off. Job previews (`jobId` + `which`) work in every combination.

### `list_allowed_folders` with browsing on

`remote.locations[]` has `location` (a folder URI such as `file:///data/subtitles/` or `s3://subs/tmp/`), `scheme`,
`listable`, `readable`, and when useful `prefix` (an allowed S3 key prefix that ends mid-name, such as `tmp/show-`,
which `list_files` uses as its name filter) and `note`. HTTPS hosts are listed with `listable: false` and
`readable: false`: they can be used as conversion `input` and `output`, but can't be browsed or previewed by
location. Locations never contain credentials, query strings or presigned parts.

Local folders (the `folders` list) are paths on the MCP's machine. API locations are paths on the API's machine or
in its buckets, even when they look alike. In a sidecar deployment the two are usually different filesystems.

### Hidden files and folders

Hidden files and folders are never read, listed or written, by any tool, with browsing on or off. A path is hidden when any
of its components starts with `.`: a dotfile (`.env`), anything inside a dot-named folder at any depth
(`.git/config`), and everything in an allowed folder that is itself hidden or inside a hidden folder
(`/home/me/.subtitles`). Dots inside names are fine: `show.en.v2.srt` and `v1.2/ep.srt` are ordinary files.

- **Local (this MCP server):** applies to `preview_text {location}`, `list_files` (and its `prefix`), the `path` and
  `profilePath` of `convert_subtitle`, `detect_format` and `validate_profile`, and to `outputPath` / `outputDir` and
  the names of the files written there. A path outside the allowed folders is `path-not-allowed` first; a hidden
  path inside them is `hidden-path`, whether the file exists or not. The requested path is checked before any
  filesystem call. Plain paths are taken literally: `%2Eenv` is a file named `%2Eenv`, not `.env`.
- **API locations:** the API applies the same rule to `file://` and `s3://` locations (percent-decoded first, so
  `%2Eenv` is `.env`), for reads, listings, writes, conversion inputs and job file reads, and answers `hidden-path`.
  HTTPS URLs are not affected.
- **Hidden allowed folders** aren't named in `list_allowed_folders`, tool descriptions or error hints;
  `list_allowed_folders` reports how many there are as `hiddenFolders`. The API leaves hidden roots and prefixes out
  of its locations.
- **Writes** follow the same rule: a dot-named output, an output in a hidden folder, or a hidden allowed folder is
  refused before anything is converted or written. (The MCP's own `.subtitle-mcp-staging/` folder is internal.)
- **Limits:** the rule is name-based on every platform. Windows hidden or system attributes and macOS `UF_HIDDEN`
  aren't consulted.

### `list_files`

| Argument | Required | Description |
|---|---|---|
| `location` | yes | A folder: a local absolute path inside the allowed folders, or an API `file://` or `s3://` folder URI |
| `prefix` | no | Name prefix filter. A `/` in it descends into a sub-folder (`season1/ep` lists `season1/` names starting with `ep`). No globs |
| `cursor` | no | `next` from the previous page, unchanged |

The result has `location`, `where` (`local` or `remote`), `prefix`, `items`, `returned`, `truncated` and, when
truncated, `next`. Each item has `name` (folders end in `/`), `location` (pass it to `preview_text` for a file or to
`list_files` for a folder), `type` (`file` or `folder`), and for files `size` and `modified` (ISO 8601, UTC).

A page has up to 200 items, in name order (local folders and the API filesystem sort by UTF-8 bytes; S3 uses the
bucket's key order). There is no total count, no sorting by date and no offsets. Hidden entries (names starting with
`.`), symbolic links, special files and files without a subtitle extension are skipped, and a hidden folder or
prefix can't be listed ([hidden files](#hidden-files-and-folders)). Sub-folders are listed whatever their names.
A folder (or prefix) with more than 5000 such entries fails with `folder-too-large`; list it with a narrower
`prefix`. The API does the same with its own cap (`GET /v1/limits` `storage.listMaxEntries`).

Paging is stateless and there is no snapshot. A file that exists for the whole walk and isn't renamed appears
exactly once. A file added or removed during the walk may or may not appear. A cursor belongs to one location,
prefix and side (local or API); anything else fails with `list-cursor-invalid` (local) or `storage-cursor-invalid`
(API). A location outside the allowlists fails with `path-not-allowed` (local) or `storage-location-rejected` (API),
an HTTPS location with `storage-not-listable`.

## Inline convert results

Without an output location (`outputPath`/`outputDir` or an API `output`), `convert_subtitle` attaches the whole
converted file to its result as an embedded resource, for text and binary targets alike, with the format's
`mimeType`. The file is never cut, and it is byte-identical to what the same conversion would store with an API
`output`:

- UTF-8 text (`encoding` `utf-8`, which has a byte order mark, or `utf-8-no-bom`) comes as `text`. With `utf-8` the
  text starts with U+FEFF, so writing it out as UTF-8 reproduces the BOM.
- Binary formats (EBU STL, PAC, …) and text in other encodings (UTF-16, legacy code pages) come as a base64
  `blob` of the exact bytes. `responseEncoding: "base64"` sends UTF-8 text as a `blob` too.

`outputs[].contentEncoding` says which (`text` or `base64`), and `outputs[].bytes` is the size of the file the
resource holds. The resource is the deliverable, for the client to save; its `uri` only labels the block and is
not readable with `resources/read`.

The structured result describes the file but doesn't repeat its content: `outputs[]` has `fileName`, `format`,
`formatId`, `kind`, `mediaType`, `encoding`, `cues`, `bytes` and `attached: true`, plus `verification` for
binary targets. Alongside it are `jobId`, `detected`, `stats`, `warnings` and a short `hint` on reading the
converted text. The JSON text block holds the same object, not the file.

Inline results are not stored anywhere, so `preview_text` cannot read them: the attached file is the only copy. If
the text is needed, save the file to disk and read it locally. To preview it with `preview_text` instead, convert
with an API `output` location, then call `preview_text` with `which: "output"`. When the source came from an API
`input`, `preview_text` with `which: "input"` works straight away. `hint` says which of these applies.

Example result for an inline conversion to EBU STL:

```json
{
  "content": [
    { "type": "text", "text": "{\"jobId\":\"0de4707d46fe4ff9b06ae83736f7dbbb\",\"outputs\":[…],\"hint\":\"…\",\"warnings\":[],…}" },
    { "type": "resource", "resource": { "uri": "subtitleedit://outputs/mcp-…/show.stl", "mimeType": "application/octet-stream", "blob": "…" } }
  ],
  "structuredContent": {
    "jobId": "0de4707d46fe4ff9b06ae83736f7dbbb",
    "outputs": [{ "fileName": "show.stl", "format": "EBU STL", "formatId": "ebustl", "kind": "binary", "mediaType": "application/octet-stream",
                  "encoding": "iso-6937", "contentEncoding": "base64", "cues": 412, "bytes": 52224, "attached": true, "verification": { "…": "…" } }],
    "hint": "The whole file is in the attached embedded resource; save it to disk and read it locally if you need the text. To preview it with preview_text instead, convert with an API `output` location.",
    "warnings": [], "…": "…"
  }
}
```

How files are written: [writing-files.md](writing-files.md).

## Resources

`subtitleedit://schemas/profile.json`, `subtitleedit://formats`, `subtitleedit://limits`.

## Frame rates

Formats that store frame numbers without a frame rate (PAC, Cavena 890, Cheetah CAP, MicroDVD, …) need one, and
the API doesn't guess it. `convert_subtitle` takes it in the profile: `profile.source.fps` when such a file is the
source, `profile.target.fps` for such a target when the source gives no rate (SRT, WebVTT, …). The output uses the
source's rate (`source.fps`, an EBU STL header, SCC timecodes) unless `target.fps` is set. Without a rate the call
fails with `frame-rate-required`, and `errors[0].pointer` names the field (`/source/fps` or `/target/fps`). No rate
is needed between such formats (PAC to PAC) without `target.fps` or millisecond timing settings, and EBU STL output
defaults to 25 fps when nothing else gives a rate. Details: the API's
[formats page](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/formats.md).

## Errors

Errors come back as `isError: true` with a structured `error`: `source` (`api` or `mcp`), `code`, `detail`, `hint`,
`requestId`, and where they apply `errors[]` (pointer, message, hint), `candidates` and `probe` (strings for `ambiguous-format` and PAC code pages; `{encoding, language, hits, sample}` objects for `ambiguous-encoding` with probe `text-encoding`), `jobId` /
`jobUrl`, a redacted `location`, `limit`, `retryAfterSeconds`, and for local write failures `path` + `osError`.
API codes are on the API's [errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page
(what happened, why, what to do). MCP codes (`mcp-misconfigured`, `path-not-allowed`, `hidden-path`, `extension-not-allowed`, `folder-too-large`, `output-exists`, `cross-device`, …) are in
[troubleshooting.md](troubleshooting.md). `path-not-allowed` hints include the current allowed folders.

## Warnings

Report every warning the tools return. Each has a `code` and `message`, and may carry a `hint` (the setting
that fixes it) and `details` (positions and settings, never cue text). What each API warning means, including
`characters-replaced` remedy fields: the API's [errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page.

The MCP passes API warnings through unchanged. It adds only `mcp-api-version-mismatch`
([troubleshooting.md](troubleshooting.md#version-mismatch)), `mcp-ebu-size` (a local `.stl` larger than
the API's EBU STL limit) and `max-bytes-clamped` (a `preview_text` page size out of range).

## Verification

Binary outputs carry `outputs[].verification` (verdict, cue counts, timing shift, replaced characters). How to read the verdict and fields is on the same
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
| `jobId` | yes, unless `location` | The `jobId` from `convert_subtitle` |
| `which` | with `jobId` | `input` (the stored source) or `output` (the single stored subtitle result, never a sidecar) |
| `location` | instead of `jobId` | The file's full URI or absolute path, as `list_files` `items[].location`: `s3://bucket/key`, `file:///path`, or a local absolute path inside the allowed folders (e.g. `s3://subs/show.srt`, or the sidecar `s3://subs/show.srt.json`). Not with `SUBTITLE_MCP_LIST_ENABLED=false` ([browsing](#browsing-and-reading-by-location)) |
| `maxBytes` | no | Page size in UTF-8 bytes. Defaults to `SUBTITLE_MCP_PREVIEW_DEFAULT_BYTES` (65536); values below 4096 are raised to 4096 and values above `SUBTITLE_MCP_PREVIEW_MAX_BYTES` (262144) are lowered to it, with a `max-bytes-clamped` warning (`details.fields.requested` and `applied`). The value in effect comes back as `maxBytes` |
| `fps` | no | Frame rate for binary formats that store frame numbers without one (PAC, Cavena 890, …), used only for the times in the SRT view, e.g. `25`. A job's file defaults to the rate the job used (`target.fps`, else `source.fps`, for its output; `source.fps` for its input) |
| `cursor` | no | The `next` value from the previous page, unchanged. Omit it for the first page |

Give either `jobId` and `which`, or `location`. With browsing off, files are reached by job id only. Local path
uploads and inline content have no stored input, and a conversion without an API `output` has no stored output.

A `location` read goes through the same checks as a conversion source: the local allowed folders (with traversal and
symbolic-link checks) for a path, or the API's allowlists, its traversal and symbolic-link guards and its decoding
checks for a URI. HTTPS URLs can't be read by location. The paging, the SRT view of binary files and the result are
the same as for a job, with `source` saying which kind of read it was (`job`, `local` or `remote`).

Text files are returned as stored (UTF-8, UTF-16 or the recorded legacy encoding, decoded exactly). Binary files
(EBU STL, PAC, Cavena 890, …) are converted to SRT through the API, inline only (nothing is written, the stored
file is unchanged). Then `convertedFrom` is the stored format id, `convertedTo` is `"srt"`, and `warnings` say what
the SRT view lost. If that conversion fails (for example `ambiguous-encoding` on a PAC file), the normal error comes
back with its candidates, and the hint says how to read the file with `convert_subtitle` and the right setting.
A format without a recorded frame rate needs one for the SRT times: when neither `fps` nor the job gives one, the
call fails with `frame-rate-required` (pointer `/fps`); ask the user for the rate rather than guessing.

### Pages

The text is split into whole units: cues for SRT and WebVTT (a WebVTT header or `NOTE` block travels with the
next cue), lines for everything else. A page is the longest run of whole units that fits in `maxBytes`. Pages
always end on a whole cue and never split a character. Only a single cue larger than `maxBytes` makes a page go
over it, and that cue is then returned alone. A cue larger than `SUBTITLE_MCP_PREVIEW_MAX_BYTES` can't be
previewed (`preview-cue-too-large`, which names the stored file's location), and nor can the text after it.
Joining all pages gives back the whole text exactly.

Byte counts are UTF-8 bytes of the text without a byte order mark, so `totalBytes` can be a few bytes smaller
than `bytes`, the stored file's size. For a binary file they count the SRT text, not the stored bytes.

When more text follows, `truncated` is `true` and `next` holds an opaque cursor. Call again with the same `jobId`
and `which` (or the same `location`, and the same `fps`) and `cursor: next`. Later pages keep the first page's
`maxBytes` unless you pass a new one. The last page has `truncated: false` and no
`next`.

Paging is stateless: there is nothing to close or expire on the server. Each call reads the stored file again, and
the cursor carries a fingerprint (a SHA-256 hash) of the stored bytes. If the file changed between pages, the call
fails with `preview-source-changed`, and you start again without `cursor`. Any other cursor problem is
`preview-cursor-invalid`: a value that isn't one `preview_text` returned (empty, altered, too long), or a cursor
used with another job, `which`, location or `fps`.

The decoded text is cached in memory (`SUBTITLE_MCP_PREVIEW_CACHE_BYTES`, default 64 MiB, least recently used first,
dropped after `SUBTITLE_MCP_PREVIEW_CACHE_TTL_MS` unused), so later pages don't read or convert the file again. Each
call still checks that the file hasn't changed: locally by its size, modification time and inode, for API files by
asking with the cached `ETag` (`If-None-Match`; a `304` means unchanged). A changed file is read again, and a cursor
from before the change gives `preview-source-changed`. Older APIs without an `ETag` mean every page reads the file
again, as before.

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
| `source` | `job`, `local` or `remote` |
| `jobId`, `which`, `fileName`, `mediaType`, `bytes`, `location`, `format` | The file: name, media type, size, redacted location and recorded format id (`jobId`, `which` and `format` for job previews) |
| `convertedFrom`, `convertedTo` | Set for binary files converted to SRT |
| `warnings` | `max-bytes-clamped` when `maxBytes` was out of range, and what the SRT conversion of a binary file lost |

The page's text is in `text`, in the same result object as the rest ([Result format](#result-format)). Subtitle
text is not logged.

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
