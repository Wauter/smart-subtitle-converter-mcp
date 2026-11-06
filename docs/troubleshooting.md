# Troubleshooting

Start with `list_allowed_folders` (folders and their `state`) and the server's log (JSON lines on stderr, shown in
the client's MCP log). Every error carries a `code`, a `hint` and a `source`:

- `source: "api"`: the converter API raised it. The API's [errors and warnings reference](https://github.com/Wauter/subtitleedit-converter-api/blob/main/docs/errors.md) explains every
  API error and warning code: what happened, why, and what to do. The sections below repeat the ones MCP users
  meet most.
- `source: "mcp"`: this server raised it, about local folders, files, or talking to the API. They are explained on
  this page.

Warnings come from the API and are passed through unchanged; only `mcp-api-version-mismatch` and `mcp-ebu-size`
are added by the MCP.

## Version mismatch

**Symptom:** results carry an `mcp-api-version-mismatch` warning, or the startup log warns about the API version.

The MCP reads the API's `/healthz` at startup and compares major.minor with its own; use the MCP release whose
major.minor matches the API (patch versions may differ). There are no fallbacks for older APIs. It also checks
that `GET /v1/limits` exists and warns if it doesn't.

If you did update and still see an older MCP version in the warning, the client is running a different copy:

- Check which command the client starts (`claude mcp get subtitleedit` in Claude Code, the JSON config elsewhere).
- Built from source: rerun `npm ci && npm run build` after `git pull`.
- Client in a VM or container: it runs the copy **inside** that environment. If you copied `dist/` there, copy it
  again after every update ([clients.md](clients.md#clients-in-a-vm-or-container)).
- Restart the client completely afterwards.

## No allowed folders, or `path-not-allowed`

- `state: roots-empty` in Claude Desktop is expected: it doesn't pass approved folders. Set
  `SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS` ([folders-and-roots.md](folders-and-roots.md)).
- `state: waiting-for-roots`: the client hasn't sent its roots yet; the tool descriptions update once it does.
- `path-not-allowed`: the path is outside the allowed folders, relative, or inside a read-only folder for a write.
  The hint lists the folders in effect.

## Local file errors

These are about MCP-local `path`, `outputPath` and `outputDir`. The error carries `path`, and `osError` for operating
system failures.

**`output-exists`**

- **What:** The output file already exists, so nothing was written.
- **Why:** Existing files are never overwritten unless you ask. It may come from an earlier run.
- **What to do:** Check the existing file, then pick another `outputPath`, or send `ifExists: "replace"` to replace
  it on purpose ([writing-files.md](writing-files.md)). A folder at the output path can't be replaced.

**`source-overwrite-refused`**

- **What:** The output would replace the input file itself.
- **Why:** Writing over the source would destroy it if anything went wrong.
- **What to do:** Choose another output folder or file name.

**`cross-device`**

- **What:** The output folder is on a different disk or mount than its output root.
- **Why:** Files are committed with an atomic rename, which only works within one filesystem; there is never a
  non-atomic copy.
- **What to do:** Configure that mount as its own output root.

**`staging-unavailable`**

- **What:** The `.subtitle-mcp-staging/` folder in the output root can't be created or used.
- **Why:** Every write is staged there first.
- **What to do:** Make that folder writable for the MCP's user (in the sidecar image, the container user), or
  choose another output root.

**`path-not-found`, `not-a-file`, `not-a-directory`**

- **What:** The path doesn't exist, or is a folder where a file is expected (or the reverse for `outputDir`).
- **Why:** Paths are checked before anything is read or written. Missing output folders inside an allowed folder
  are created, but an input must exist and a file can't stand where a folder is expected.
- **What to do:** Check the path, and that it points at a file (input) or a folder (`outputDir`).

**`disk-full`, `permission-denied`, `read-only-filesystem`, `output-locked`, `path-too-long`, `io-error`, `write-failed`**

- **What:** The operating system refused the write; the code names the reason.
- **Why:** No space, missing permissions, a read-only mount, another program holding the file open, a path that
  is too long, or a disk or network share problem.
- **What to do:** Follow the hint (free space, fix permissions, close the other program, shorten the name). An
  existing file is kept when a replacement fails.

**`multiple-outputs`**

- **What:** The conversion produced several files, but `outputPath` names one.
- **Why:** A profile with `target.additional` writes more than one format. Nothing was written.
- **What to do:** Use `outputDir` instead of `outputPath`.

**`precheck-too-large`**

- **What:** The file or profile is larger than the API accepts, so it wasn't sent.
- **Why:** The MCP checks the API's limits before uploading.
- **What to do:** Split the file, or simplify the profile. `error.limit` shows the limit and the actual size.

## Talking to the API

**`api-unreachable`**

- **What:** The MCP couldn't reach the API, or the connection dropped.
- **Why:** Usually a wrong `SUBTITLE_API_URL` or the API isn't running.
- **What to do:** Check that the API is running and the URL is right. On your machine that's the host port
  (`http://localhost:8080` with the API's defaults); from a container on the same Docker network it's the container
  port (`http://api:8080`). From a VM, `localhost` may not be your host.

**`unauthorized`** (from the API)

- **What:** The API didn't accept the key.
- **What to do:** Set `SUBTITLE_API_KEY` (or `_FILE`) to a key the API accepts.

**`mcp-timeout`**

- **What:** The API didn't answer within the MCP's timeout.
- **Why:** The converter may be busy or the work is large.
- **What to do:** Retry later, or raise `SUBTITLE_MCP_TIMEOUT_MS` for slow work.

**`cancelled`**

- **What:** The client cancelled the call.
- **Why:** You or the client stopped it.
- **What to do:** If the error has a `jobId`, the API job may still be running and may still write its output:
  check it before you run the conversion again.

**`api-protocol-error`**

- **What:** The API answered with something the MCP didn't expect (no problem body, an unknown endpoint, an
  unexpected job response).
- **Why:** Usually a wrong `SUBTITLE_API_URL` or an API version that doesn't match this MCP.
- **What to do:** Check the URL and the versions ([Version mismatch](#version-mismatch)); otherwise report it
  with the `requestId`.

**`invalid-arguments`**

- **What:** The tool call's arguments don't fit together (for example two sources, or no target).
- **What to do:** Follow the message; `errors[]` points at the argument.

## Startup fails

- `SUBTITLE_API_URL` is required.
- Unknown `SUBTITLE_MCP_*` variables fail startup on purpose (typo protection); check the spelling against
  [configuration.md](configuration.md).
- `--http` needs an inbound token ([http-sidecar.md](http-sidecar.md)); `--hosted` isn't available yet.

## Jobs and storage URIs

These apply when `convert_subtitle` uses API-side `input` / `output` locations, and to `get_job_file`.

**`storage-location-rejected`** (from the API)

- **What:** The API may not use that location.
- **Why:** API storage is limited to the API's own allowlists. MCP-local folder grants don't give the API access.
- **What to do:** Name a complete file (not a folder) inside an allowed location, or ask the API's operator to
  allowlist it. API filesystem storage requires a Linux server.

**`output-exists`** (from the API)

- **What:** The API output already exists, so nothing was overwritten.
- **What to do:** Check it, then choose another name or send `ifExists: "replace"`.

**`job-not-ready`**

- **What:** The result isn't available yet.
- **Why:** Either the MCP stopped waiting after its time budget, or `get_job_file` asked for an output that is still
  being produced. The job keeps running in the API.
- **What to do:** Keep the `jobId` and check the job or the output location later. Don't resubmit writes blindly:
  the first job may still finish.

**`job-not-found`**

- **What:** The API no longer has a record of the job.
- **Why:** The record expired, was evicted, or the API restarted. It does **not** mean the conversion failed.
- **What to do:** Check the output location directly.

**`job-output-not-stored`**

- **What:** There is no stored output to fetch.
- **Why:** The conversion ran without an API `output` and took longer than the wait, so its bytes were not kept;
  or the conversion failed. No empty local file was created.
- **What to do:** Use an API `output` location for work that may take a while.

**`job-metadata-truncated`**

- **What:** The job finished, but its detailed result was too large for the API's job record.
- **What to do:** Read the full diagnostics from the sidecar (`sidecar: true`).

**`job-input-not-stored`, `job-file-gone`, `job-location-not-replayable`** (from the API, `get_job_file`)

The input was a local upload, the file has since moved, or it was a signed HTTPS URL whose signature isn't kept.
Use the original file, or check the storage directly; details in the API's [reference](https://github.com/Wauter/subtitleedit-converter-api/blob/main/docs/errors.md#job-file-errors).

**Sidecar warnings** (from the API): `sidecar-write-failed` (the subtitle was written, its `{output}.json` wasn't),
`sidecar-delete-failed` (an older `{output}.json` couldn't be removed after a write without `sidecar`), and
`sidecar-skipped` (HTTPS outputs get no sidecar). In all three the subtitle itself is fine; see the API's
[reference](https://github.com/Wauter/subtitleedit-converter-api/blob/main/docs/errors.md#sidecar-write-failed).

## Character sets and formats

**`ambiguous-encoding`** (from the API)

- **What:** The API couldn't tell which character set the file uses, and won't guess.
- **Why:** The same bytes read as different letters in different character sets. `error.probe` says which check
  failed: `pac-code-page` (a PAC file, often a very short one) or `text-encoding` (a text file that isn't UTF-8 and
  still reads as words in more than one encoding after script-priority filtering). For `text-encoding`,
  `error.candidates` is a list of `{encoding, language, hits, sample}` (samples are always present). For PAC,
  `candidates` are code page name strings and may be empty.
- **What to do:** For PAC, pass `profile.formatOptions.pac.inputCodePage` (for example `greek`), chosen from the
  candidates or the file's language. For text, show the samples to the user, pick **only** from the candidate
  list, say what you chose, then retry with `profile.encoding.input` or `profile.encoding.language` (ISO code
  such as `ar`, `he`, `th`), or save the file as UTF-8.

**`ambiguous-format`** (from the API)

- **What:** The file could be PAC or Unicode PAC (FPC).
- **What to do:** Pass `profile.source.format` (`pac` or `fpc`), or give the file its `.pac` / `.fpc` name.

**`encoding-guessed`** warning (from the API): the text's character set was guessed. Check the converted text; if
letters look wrong, pass `profile.encoding.input`.

**`encoding-forced`** warning (from the API): `profile.encoding.input` forced the page (including a wrong one).
Confirm the text.

**`language-applied`** warning (from the API): `profile.encoding.language` selected the page. Confirm the text; if
wrong, pass `profile.encoding.input` instead.

**`mcp-ebu-size`** warning (from the MCP)

- **What:** A local `.stl` file is larger than the API's EBU STL size limit.
- **Why:** It may be rejected if it is EBU STL; Avid STL shares the extension and may be fine.
- **What to do:** Nothing unless the conversion fails; then check what kind of STL file it is.
