import { defineConfig } from "tsdown";

// `@oomol-lab/connector` (dependency) and `@mastra/core` (peer) stay external; the bundle is only
// this package's own source.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
