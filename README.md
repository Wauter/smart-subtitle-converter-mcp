# subtitle-mcp

A planned [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents
convert subtitles. It is a thin TypeScript client over
[subtitle-api](https://github.com/Wauter/subtitle-api) and does no conversion itself.

**Status: design phase. There is no code yet.** Design: [subtitle-api/docs/design.md §10](https://github.com/Wauter/subtitle-api/blob/main/docs/design.md#10-mcp-server-subtitle-mcp).

## Stack

- TypeScript on Node 22 LTS
- Official SDK [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk), with `zod` input schemas
- Tool descriptions generated from the API's OpenAPI (`/openapi/v1.json`) at build time

## Tools

| Tool | subtitle-api endpoint | Purpose |
|---|---|---|
| `list_formats` | `GET /v1/formats` | Supported formats (id, name, extension, read/write) |
| `list_presets` | `GET /v1/profiles` | Built-in and mounted presets, with validity and load errors |
| `get_profile` | `GET /v1/profiles/{name}` | Resolved preset JSON |
| `detect_format` | `POST /v1/detect` | Detect format, encoding and language of content |
| `convert_subtitle` | `POST /v1/convert/json` | Convert content using a preset and/or profile overrides |
| `validate_profile` | `POST /v1/profiles/validate` | Validate a profile and return errors with fix hints |

Errors come back as `isError: true` with the API's error `code`, `hint` and `requestId`.

## Transports

- **stdio**: `npx subtitle-mcp`, for desktop agents such as Claude Desktop and Cursor
- **Streamable HTTP**: `subtitle-mcp --http :3000`, endpoint `/mcp`, stateless

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SUBTITLE_API_URL` | yes | Base URL of subtitle-api, e.g. `http://localhost:8080` (or `--api-url`) |
| `SUBTITLE_API_KEY` | no | Bearer key sent to the API when its auth is enabled |
| `SUBTITLE_MCP_MAX_BYTES` | no | Max content size accepted by tools |
| `SUBTITLE_MCP_TIMEOUT_MS` | no | Timeout for API calls |

In HTTP mode, an incoming `Authorization: Bearer` header is passed through to subtitle-api unchanged
and takes precedence over `SUBTITLE_API_KEY`. The server stores no keys and logs none.

## Depends on

A running [subtitle-api](https://github.com/Wauter/subtitle-api) v1 instance.

## License

MIT, see [LICENSE](LICENSE).
