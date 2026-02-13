import { defineConfig } from "vite";
import { builtinModules } from "node:module";
import tsconfigPaths from 'vite-tsconfig-paths';

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  ssr: {
    // Bundle dependencies into the output (Devvit server bundle must be self-contained)
    noExternal: true,
plugins: [tsconfigPaths()]
  },
  build: {
    ssr: "src/server/index.ts",
    outDir: "dist/server",
    target: "node22",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: builtins,
      output: {
        format: "cjs",
        entryFileNames: "index.cjs",
        inlineDynamicImports: true,
      },
    },
  },
});
