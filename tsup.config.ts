import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

// Bundle everything (SDK, zod, fflate, picomatch) so `npx` starts fast and the
// distroless image needs no node_modules.
export default defineConfig({
  entry: { index: "src/index.ts", healthcheck: "src/healthcheck.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  shims: false,
  define: { __MCP_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
