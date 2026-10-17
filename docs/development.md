# Development

```sh
npm ci
npm run lint && npm run typecheck
npm test                     # unit + MCP-level
npm run build && npm run test:e2e
scripts/contract.sh ghcr.io/wauter/subtitleedit-converter-api:edge   # contract suite against a real API image
```

The contract suite can also target a running API: `CONTRACT_API_URL=http://127.0.0.1:4041 npm run test:contract`
(the API's Compose). Add `CONTRACT_API_KEY` and `CONTRACT_SMALL_LIMITS=1` for an API started with `API_KEYS`,
`MAX_UPLOAD_BYTES=1048576` and `ZIP_MAX_ENTRIES=3`. In CI the contract job pulls the pinned API image (`API_IMAGE`
in `.github/workflows/ci.yml`); it is skipped (with a notice) when the image can't be pulled, unless the repo
variable `CONTRACT_REQUIRED=true`.

## Versions

- **The MCP shares the API's major.minor.** An MCP release pairs with the API release of the same major.minor;
  they are released together, and patch versions may differ within a pair.
- **`package.json` `version` is bumped on every change that ships** (any merged change to `src/`, the Dockerfile
  or the bundled output), with a [CHANGELOG.md](../CHANGELOG.md) entry that includes a "Pairs with API x.y" line.
  Docs-only changes go under Unreleased without a bump.
- At startup the MCP reads `/healthz` and logs the API version. If major.minor differs from its own it logs a
  warning and adds `mcp-api-version-mismatch` to conversion results. It also feature-detects `GET /v1/limits`
  (200/401 = present) and warns if it is missing. There are no fallbacks for older APIs.
- The CI contract image (`API_IMAGE`) is bumped deliberately together with `package.json`.

## Publishing

Every publish step (npm package, image) is gated behind the repo variable `PUBLISH_ENABLED` (default `false`).
Tags and releases are cut only on the owner's go-ahead.

## Smoke checklist (Claude Desktop / Cursor, MCP Inspector)

1. `tools/list` shows every tool from [tools.md](tools.md); `convert_batch` only when a writable root is
   configured, `list_allowed_folders` whenever paths are available.
2. `list_formats` returns `subrip`, `webvtt`, `ebustl`.
3. `convert_subtitle` with inline SRT → WebVTT returns the text inline.
4. `convert_subtitle` with `path` + `outputDir`: the file appears atomically; a second run fails with `output-exists`.
5. `convert_batch` into a new folder: the folder appears complete; a run with one broken file writes nothing and
   names it.
6. HTTP mode: a request without the token gets 401; `/healthz` answers without one.
