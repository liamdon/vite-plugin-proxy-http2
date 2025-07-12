import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      outDir: "dist",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts"],
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "VitePluginProxyHttp2",
      fileName: (format) => {
        return format === "es" ? "index.mjs" : "index.js";
      },
      formats: ["es", "cjs"],
    },
    rollupOptions: {
      // Externalize dependencies that shouldn't be bundled
      external: [
        "vite",
        "http2",
        "https",
        "http",
        "url",
        "stream",
        "buffer",
        "util",
        "events",
        "net",
        "tls",
        "crypto",
        /^node:/,
      ],
      output: {
        // Ensure we get both ES and CJS outputs
        exports: "named",
        // Preserve the module structure
        preserveModules: false,
      },
    },
    sourcemap: true,
    // Generate declaration files will be handled by vite-plugin-dts
    emptyOutDir: true,
    outDir: "dist",
    target: "node14",
    minify: false,
    // Important: Configure for Node.js environment
    ssr: true,
  },
  // Ensure Node.js resolution
  resolve: {
    conditions: ["node"],
  },
});
