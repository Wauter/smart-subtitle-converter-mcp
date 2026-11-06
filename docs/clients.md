# Client setup

How to add the server to each MCP client. All examples use stdio (the client starts the server) and assume the
API runs on `http://localhost:8080`, the host port the API's `docker-compose.yml` publishes (bound to `127.0.0.1`;
the container itself listens on 8080). If you changed that mapping, use your host port.

Name the folders the server may use with `SUBTITLE_MCP_ALLOWED_DIRS` (read-write) and, if needed,
`SUBTITLE_MCP_READONLY_DIRS` (read-only). Without those, local `path` / `outputPath` / `outputDir` calls have
nowhere to work.

## Claude Code

```bash
claude mcp add --transport stdio \
  --env SUBTITLE_API_URL=http://localhost:8080 \
  --env SUBTITLE_MCP_ALLOWED_DIRS=/Users/me/Subtitles \
  subtitleedit -- npx -y subtitleedit-converter-mcp
```

- Add more folders the same way (`SUBTITLE_MCP_ALLOWED_DIRS` for read-write,
  `SUBTITLE_MCP_READONLY_DIRS=/Volumes/Masters` for read-only). Separate several paths with `:` (`;` on Windows),
  or use a JSON array.
- To change settings: `claude mcp remove subtitleedit`, add it again, and restart Claude Code.
- Check what is registered with `claude mcp get subtitleedit`.

## Claude Desktop and Cursor

Claude Desktop does not pass folders you approve in a chat to this server. Name them in the config:

```jsonc
{ "mcpServers": { "subtitleedit": {
    "command": "npx", "args": ["-y", "subtitleedit-converter-mcp"],
    "env": { "SUBTITLE_API_URL": "http://localhost:8080",
             "SUBTITLE_MCP_ALLOWED_DIRS": "/Users/me/Subtitles" } } } }
```

Quit the app completely (Cmd+Q on macOS) and reopen it after every change.

## Windows

- `SUBTITLE_MCP_ALLOWED_DIRS` uses `;` as the separator (`:` elsewhere; a JSON array works everywhere).
- Some clients need `"command": "cmd", "args": ["/c", "npx", "-y", "subtitleedit-converter-mcp"]`.

## Building from source instead of npx

Requires the Node.js version in `package.json` (`engines`).

```bash
git clone https://github.com/Wauter/subtitleedit-converter-mcp.git && cd subtitleedit-converter-mcp
npm ci && npm run build        # rerun after every git pull
```

Then replace `npx -y subtitleedit-converter-mcp` with `node /path/to/subtitleedit-converter-mcp/dist/index.js`
(in JSON configs: `"command": "node", "args": ["/path/to/subtitleedit-converter-mcp/dist/index.js"]`).

## Clients in a VM or container

If the client runs in a Linux VM or container (paths like `/mnt/mac/Users/...`), it starts whatever server exists
**inside** that environment, not the one on your host.

- Prefer `npx` inside the VM, point the client at a checkout the VM can see (a shared folder), or build inside the VM.
- If you copy `dist/` into the VM, copy it again after every update. A stale copy shows up as an
  `mcp-api-version-mismatch` warning naming an older MCP version, and newer tools or fields are missing.
- `SUBTITLE_API_URL` must be reachable from inside the VM; `localhost` there may not be your host.

## Check that it works

Ask the agent to call `list_allowed_folders`. It returns the folders in effect, each with `mode` and `source`, and a
`state` such as `ready` or `none`. See [troubleshooting.md](troubleshooting.md) if the list is empty.
