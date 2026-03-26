import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  clean: true,
  banner: {
    js: "import { createRequire as __mcpCjsRequire } from 'node:module';\nconst require = __mcpCjsRequire(import.meta.url);",
  },
});
