import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/task-aware.ts"],
    format: ["cjs", "esm"],
    outputOptions: { exports: "named" },
    dts: true,
    clean: true,
    fixedExtension: false,
  },
  {
    // The `stats` command; ESM only, as it is never imported.
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    dts: false,
    fixedExtension: false,
  },
]);
