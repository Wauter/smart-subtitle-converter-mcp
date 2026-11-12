# Client setup

How to add the server to each MCP client. All examples use stdio (the client starts the server) and assume the
API runs on `http://localhost:8080`, the host port the API's `docker-compose.yml` publishes (bound to `127.0.0.1`;
the container itself listens on 8080). If you changed that mapping, use your host port.

Name the folders the server may use with `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and, if needed,
`SUBTITLE_MCP_READONLY_DIRS` (read-only). Without those, local `path` / `outputPath` / `outputDir` calls have
nowhere to work.

The API asks for an API key by default. Put the key in a file your user can read (the API's `api_keys.txt` is
readable only by its container user, so copy it:
`sudo grep -v -e '^#' -e '^$' api_keys.txt | head -n 1 > ~/subtitle-api-key.txt && chmod 600 ~/subtitle-api-key.txt`)
and point `SUBTITLE_API_KEY_FILE` at it; the MCP uses the first key and re-reads the file when it changes. Or set
`SUBTITLE_API_KEY`.

## About these sections

Claude Code is **tested by us**; the other sections are **based on the client's docs** (linked, with the date we
checked). If a section disagrees with the linked page, the page wins. Replace the server name and the
`/Users/me/...` paths with your own. CI checks that every JSON, TOML and YAML snippet here parses and starts the
server.

Separate several folders with `:` (`;` on Windows), or give a JSON array such as
`["/Users/me/subtitles","/Users/me/exports"]`.

## Claude Code

Tested by us.

```bash
claude mcp add \
  --env SUBTITLE_API_URL=http://localhost:8080 \
  --env SUBTITLE_API_KEY_FILE=/Users/me/subtitle-api-key.txt \
  --env SUBTITLE_MCP_ALLOWED_DIRS=/Users/me/subtitles:/Users/me/exports \
  --transport stdio \
  smart-subtitle-convert -- npx -y smart-subtitle-converter-mcp
```

Gotcha: `--env` swallows every following `KEY=value`, so keep `--transport stdio` between the last `--env` and the
server name. To change settings, `claude mcp remove smart-subtitle-convert`, add it again and restart.

## Claude Desktop

Add to `claude_desktop_config.json`
([docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers), checked on 2026-11-12):

```json
{
  "mcpServers": {
    "smart-subtitle-convert": {
      "command": "npx",
      "args": ["-y", "smart-subtitle-converter-mcp"],
      "env": {
        "SUBTITLE_API_URL": "http://localhost:8080",
        "SUBTITLE_API_KEY_FILE": "/Users/me/subtitle-api-key.txt",
        "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/subtitles:/Users/me/exports"
      }
    }
  }
}
```

Gotchas: folders approved in a chat are not passed to this server, so name them in `SUBTITLE_MCP_ALLOWED_DIRS`;
fully quit and reopen the app after every change.

## Cursor

Add to `~/.cursor/mcp.json` or a project's `.cursor/mcp.json`
([docs](https://cursor.com/docs/mcp), checked on 2026-11-12):

```json
{
  "mcpServers": {
    "smart-subtitle-convert": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "smart-subtitle-converter-mcp"],
      "env": {
        "SUBTITLE_API_URL": "http://localhost:8080",
        "SUBTITLE_API_KEY_FILE": "/Users/me/subtitle-api-key.txt",
        "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/subtitles:/Users/me/exports"
      }
    }
  }
}
```


## VS Code (GitHub Copilot)

Add to `~/.copilot/mcp-config.json` or `.mcp.json` at the workspace root
([docs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), checked on 2026-11-12):

```json
{
  "mcpServers": {
    "smart-subtitle-convert": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "smart-subtitle-converter-mcp"],
      "env": {
        "SUBTITLE_API_URL": "http://localhost:8080",
        "SUBTITLE_API_KEY_FILE": "/Users/me/subtitle-api-key.txt",
        "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/subtitles:/Users/me/exports"
      },
      "tools": ["*"]
    }
  }
}
```

Gotcha: the older `.vscode/mcp.json` (`servers`) belongs to a harness VS Code lists as deprecated.

## ChatGPT desktop app and Codex (CLI, IDE extension)

All three read `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project)
([docs](https://learn.chatgpt.com/docs/extend/mcp), checked on 2026-11-12):

```toml
[mcp_servers.smart-subtitle-convert]
command = "npx"
args = ["-y", "smart-subtitle-converter-mcp"]
tool_timeout_sec = 150

[mcp_servers.smart-subtitle-convert.env]
SUBTITLE_API_URL = "http://localhost:8080"
SUBTITLE_API_KEY_FILE = "/Users/me/subtitle-api-key.txt"
SUBTITLE_MCP_ALLOWED_DIRS = "/Users/me/subtitles:/Users/me/exports"
```

Gotchas: Codex's default `tool_timeout_sec` of 60 s is shorter than the MCP's own wait (`SUBTITLE_MCP_TIMEOUT_MS`,
120 s by default), so long conversions would otherwise be cut off. ChatGPT on the web
does not read this file and is not covered.

## OpenAI Agents SDK (Python)

Use `MCPServerStdio` ([docs](https://openai.github.io/openai-agents-python/mcp/), checked on 2026-11-12):

```python
from agents.mcp import MCPServerStdio

subtitles = MCPServerStdio(
    name="smart-subtitle-convert",
    params={
        "command": "npx",
        "args": ["-y", "smart-subtitle-converter-mcp"],
        "env": {
            "SUBTITLE_API_URL": "http://localhost:8080",
            "SUBTITLE_API_KEY_FILE": "/Users/me/subtitle-api-key.txt",
            "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/subtitles:/Users/me/exports",
        },
    },
    client_session_timeout_seconds=150,
)
```

Gotcha: the default `client_session_timeout_seconds` is 5, too short for conversions.

## Goose

Add to `~/.config/goose/config.yaml`
([docs](https://goose-docs.ai/docs/getting-started/using-extensions), checked on 2026-11-12):

```yaml
extensions:
  smart-subtitle-convert:
    type: stdio
    name: smart-subtitle-convert
    cmd: npx
    args: ["-y", "smart-subtitle-converter-mcp"]
    envs:
      SUBTITLE_API_URL: "http://localhost:8080"
      SUBTITLE_API_KEY_FILE: "/Users/me/subtitle-api-key.txt"
      SUBTITLE_MCP_ALLOWED_DIRS: "/Users/me/subtitles:/Users/me/exports"
    enabled: true
    timeout: 300
```

## Windows

- `SUBTITLE_MCP_ALLOWED_DIRS` uses `;` as the separator (`:` elsewhere; a JSON array works everywhere).
- Some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "smart-subtitle-converter-mcp"]`.

## Building from source instead of npx

Requires the Node.js version in `package.json` (`engines`).

```bash
git clone https://github.com/Wauter/smart-subtitle-converter-mcp.git && cd smart-subtitle-converter-mcp
npm ci && npm run build        # rerun after every git pull
```

Then replace `npx -y smart-subtitle-converter-mcp` with `node /path/to/smart-subtitle-converter-mcp/dist/index.js`
(in JSON configs: `"command": "node", "args": ["/path/to/smart-subtitle-converter-mcp/dist/index.js"]`).

## Check that it works

Ask the agent to call `list_allowed_folders`. It returns the folders in effect, each with `mode` and `source`, and a
`state` such as `ready` or `none`. See [troubleshooting.md](troubleshooting.md) if the list is empty.
