// Container healthcheck for distroless (no curl): GET /healthz on the MCP port.
import http from "node:http";

const spec = process.env.SUBTITLE_MCP_HTTP ?? process.argv[2] ?? "3000";
const port = Number(/(\d+)$/.exec(spec)?.[1] ?? 3000);
const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => process.exit(1));
