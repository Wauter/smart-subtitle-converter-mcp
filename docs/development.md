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
`MAX_UPLOAD_BYTES=1048576`. In CI the contract job pulls the pinned API image (`API_IMAGE`
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

1. `tools/list` shows every tool from [tools.md](tools.md); `list_allowed_folders` whenever paths are available.
2. `list_formats` returns `subrip`, `webvtt`, `ebustl`.
3. `convert_subtitle` with inline SRT → WebVTT returns the text inline.
4. `convert_subtitle` with `path` + `outputDir`: the file appears atomically; a second run fails with `output-exists`.
5. Convert another single file; the caller owns any loop.
6. HTTP mode: a request without the token gets 401; `/healthz` answers without one.

Optional `CONTRACT_STORAGE_ROOT` points at an already-existing directory allowlisted by the API and visible
at the same absolute path to the test process. The suite creates its own source/output there and removes only
those files. This covers API URI output and the metadata sidecar without cloud credentials. The normal
contract suite also checks job ids and direct `Prefer: wait=0` polling.

The API image in CI targets the matching major/minor series. Until that image is published, CI reports the
contract image unavailable; unit/MCP/e2e suites still run. Run against the locally built API during development;
do not publish an image just to make this check run.
