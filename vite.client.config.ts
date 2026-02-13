import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from "path";

// Client build: outputs to dist/client for devvit.json post.dir
export default defineConfig({
  root: "src/client",
  plugins: [react(), tailwind(), tsconfigPaths()],
  build: {
    outDir: "../../dist/client",
    sourcemap: true,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/client/index.html"),
        preview: resolve(__dirname, "src/client/preview.html"),
      },
    },
  },
});
