# Troubleshooting

Start with `list_allowed_folders` (folders and their `state`) and the server's log (JSON lines on stderr, shown in
the client's MCP log). Every error carries a `code`, a `hint` and a `source`:

- `source: "api"`: the converter API raised it. Look it up on the API's
  [errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page (what happened, why, and what to do).
  This page does not repeat those codes.
- `source: "mcp"`: this server raised it, about local folders, files, or talking to the API. They are explained
  below.

Warnings from the API are passed through unchanged; they are on that same page. The MCP adds only
`mcp-api-version-mismatch`, `mcp-ebu-size` and `max-bytes-clamped`.

## Version mismatch

**Symptom:** results carry an `mcp-api-version-mismatch` warning, or the startup log warns about the API version.

The MCP reads the API's `/healthz` at startup and compares major.minor with its own; use the MCP release whose
major.minor matches the API (patch versions may differ). There are no fallbacks for older APIs. It also checks
that `GET /v1/limits` exists and warns if it doesn't.

If you did update and still see an older MCP version in the warning, the client is running a different copy:

- Check which command the client starts (`claude mcp get smart-subtitle-convert` in Claude Code, the JSON config elsewhere).
- Built from source: rerun `npm ci && npm run build` after `git pull`.
- Client in a VM or container: it runs the copy **inside** that environment. If you copied `dist/` there, copy it
  again after every update ([clients.md](clients.md#clients-in-a-vm-or-container)).
- Restart the client completely afterwards.

## No allowed folders, or `path-not-allowed`

- Set `SUBTITLE_MCP_ALLOWED_DIRS` / `SUBTITLE_MCP_READONLY_DIRS` to the folders that hold your files
  ([folders-and-roots.md](folders-and-roots.md)). Claude Desktop never passes chat-approved folders here.
- `state: none` or `roots-empty`: no configured folders (and no client extras). Name them in the settings.
- `state: waiting-for-roots`: a client that still offers the older roots feature hasn't sent them yet; the tool
  descriptions update once it does. Prefer configured folders so you don't wait on that.
- `path-not-allowed`: the path is outside the allowed folders, relative, inside a read-only folder for a write, or
  goes through a symbolic link. The hint lists the folders in effect.

**`hidden-path`**

- **What:** The file or one of its folders starts with `.` (for example `.env`, `.git/…`, or an allowed folder that
  is itself hidden). Nothing was read, listed or written.
- **Why:** Hidden files often hold settings or secrets, so they are off limits for every tool, reads and writes alike.
- **What to do:** Copy or rename the file to a name and folder without a leading dot, or pick a visible output name.

**`extension-not-allowed`**

- **What:** The file name doesn't end in a subtitle extension (for example `notes.pdf`, or `README` with none), or
  an `outputPath` doesn't match the format being written (`out.srt` for WebVTT).
- **Why:** Only subtitle files are read, listed or written, so a mistaken path can't expose other files.
- **What to do:** Use the subtitle file itself, or rename it with the right extension. For outputs, name the file
  after the target format, as the error says.

**`folder-too-large`**

- **What:** The folder (or the `prefix` you gave) holds more than 5000 subtitle files and sub-folders, so it wasn't
  listed. The error's `limit` says the cap.
- **Why:** Very large folders would take long to walk and fill the agent's context.
- **What to do:** List it with a `prefix` (for example the first letters of the names) or a sub-folder.

**Symbolic links: `path-not-allowed` "Symlinks are not followed"**

- **What:** The path, or a folder on it, is a symbolic link. Links are never followed, even when they point inside an
  allowed folder, and `list_files` doesn't show them.
- **What to do:** Use the real path, or add the target folder to the allowed folders.

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

- **What:** The output folder is on a different disk or mount than its allowed output folder.
- **Why:** Files are committed with an atomic rename, which only works within one filesystem; there is never a
  non-atomic copy.
- **What to do:** Configure that mount as its own allowed output folder.

**`staging-unavailable`**

- **What:** The `.subtitle-mcp-staging/` folder in the allowed output folder can't be created or used.
- **Why:** Every write is staged there first.
- **What to do:** Make that folder writable for the MCP's user (in the sidecar image, the container user), or
  choose another allowed output folder.

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

Auth failures from the API are on that
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page; the MCP sends `SUBTITLE_API_KEY` (or `_FILE`).
The API asks for a key by default: `unauthorized` usually means `SUBTITLE_API_KEY_FILE` isn't set, isn't readable by
the MCP, or holds another key than the API's `api_keys.txt`. `host-not-allowed` means the host name in `SUBTITLE_API_URL` isn't in the
API's `ALLOWED_HOSTS` (add it there, for example the Compose service name).

When the API is busy it answers `503` with `Retry-After`: `queue-full` (conversions), `browse-busy` (listings and
file reads) or `conversion-engine-stuck` (a conversion hung and the API is restarting). The MCP waits and retries
listings and reads on its own, within `SUBTITLE_MCP_RETRY_*`; if the error still reaches you, try again later.

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

These apply when `convert_subtitle` uses API-side `input` / `output` locations, and to `preview_text`.
Storage, overwrite, sidecar and job codes from the API are on the
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page.

Cancelling an MCP call, or running out of wait time, does not cancel work the API has already accepted.
If the MCP stops waiting it reports `job-not-ready` and keeps the `jobId`; the API job continues. Don't send
the same convert again just because you stopped waiting: the first job may still finish and write its `output`.
Use an API `output` location for work that may take a while (job records don't keep subtitle bytes). MCP-local
folder grants don't give the API access to its own storage.

**`job-metadata-truncated`**

- **What:** The job finished, but its detailed result was too large for the API's job record.
- **What to do:** Read the full diagnostics from the sidecar (`sidecar: true`).

**`preview-source-changed`**

- **What:** `preview_text` was called with a `cursor`, but the stored file is no longer the one the cursor was made
  for.
- **Why:** Pages are read statelessly. Each call re-reads the file and compares a fingerprint of its bytes with the
  one in the cursor, so a file replaced or edited between pages is caught instead of mixing two versions.
- **What to do:** Call `preview_text` again without `cursor` to start from the first page.

**`preview-cursor-invalid`**

- **What:** The `cursor` isn't one `preview_text` returned (empty, altered, too long, or pointing somewhere this
  file's pages never start), or it was returned for another job, `which` or location.
- **What to do:** Pass the `next` value from the previous page unchanged, with the same `jobId` and `which` (or the
  same `location`), or start again without `cursor`.

**`preview-cue-too-large`**

- **What:** A single cue (or line) is larger than `SUBTITLE_MCP_PREVIEW_MAX_BYTES`, the largest page this server
  returns. The text from that cue on can't be previewed.
- **Why:** Pages never split a cue.
- **What to do:** The file is already stored: read it directly at the `location` in the error. Or ask the operator
  to raise `SUBTITLE_MCP_PREVIEW_MAX_BYTES` (up to 1048576) and restart the server
  ([configuration.md](configuration.md)).

**`max-bytes-clamped`** warning (from the MCP)

- **What:** The `maxBytes` you asked `preview_text` for was outside the allowed range, so pages use the nearest
  allowed size. `details.fields` has the `requested` and `applied` values.
- **What to do:** Nothing; the page is valid. Ask for a size in range next time to avoid the warning.

**`job-output-not-stored`** and **`job-input-not-stored`** from `preview_text`

These come from the API; the MCP rewords them for the common case. An inline `convert_subtitle` result (no
output location) is attached to the convert result and stored nowhere, so there is no output to preview: save the
attached file and read it locally, or convert again with an API `output`. A source sent as `content` or a local
`path` has no stored input either.

## Browsing and reading by location

**`list_files` is missing, or `preview_text` rejects `location`**

- **Why:** Browsing is off by default.
- **What to do:** Set `SUBTITLE_MCP_LIST_ENABLED=true` and restart the server
  ([tools.md](tools.md#browsing-and-reading-by-location)).

**`storage-list-disabled`**

- **What:** An API location was listed or read, but the API doesn't allow browsing (or is older than this feature).
  `list_allowed_folders` shows `remote.state: "disabled-api"`.
- **What to do:** Local folders still work. For the API's storage, the API operator sets `STORAGE_LIST_ENABLED=true`.
  The MCP picks the change up when its limits cache expires (`SUBTITLE_MCP_LIMITS_TTL_MS`) or at once after a refused
  call.

**`storage-not-listable`**

- **What:** The location is an HTTPS URL (or another kind the API can't list). HTTPS works as a conversion `input` or
  `output`, but it can't be browsed or read by location.

**`list-cursor-invalid`** and **`storage-cursor-invalid`**

- **What:** The `list_files` `cursor` is altered, or belongs to another location, prefix or side (local or API).
- **What to do:** Pass `next` unchanged with the same `location` and `prefix`, or start again without `cursor`.

**Hidden files: `hidden-path` for a dotfile or dot-named folder**

- **What:** The path, or one of its folders, starts with `.` (also because the allowed folder itself is hidden).
  Hidden files are never read, listed or written, locally or by the API.
- **What to do:** Copy or rename the file to a name and folder without a leading dot
  ([tools.md](tools.md#hidden-files-and-folders)).

**`storage-location-rejected`** or **`path-not-allowed`** from `list_files`

- **What:** The location is outside the API's allowlists or the MCP's allowed folders. Pick one from
  `list_allowed_folders`.

## Character sets and formats

API format and encoding errors and warnings are on the
[errors and warnings](https://github.com/Wauter/smart-subtitle-converter-api/blob/main/docs/errors.md) page.

**`mcp-ebu-size`** warning (from the MCP)

- **What:** A local `.stl` file is larger than the API's EBU STL size limit.
- **Why:** It may be rejected if it is EBU STL; Avid STL shares the extension and may be fine.
- **What to do:** Nothing unless the conversion fails; then check what kind of STL file it is.
