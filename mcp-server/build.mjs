import { build } from "esbuild";

await build({
  entryPoints: ["mcp-server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "mcp-server/dist/index.mjs",
  external: [
    "mysql2",
    "@hono/node-server",
    "hono",
  ],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

console.log("MCP server built → mcp-server/dist/index.mjs");
