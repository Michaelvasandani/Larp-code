import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

type PackageMetadata = { version: string };

const packageMetadata = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as PackageMetadata;
const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "development-only-key";

function exactBackendOrigins(rawUrl: string): { httpsOrigin: string; realtimeOrigin: string } {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use http or https.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("SUPABASE_URL must be an origin without a path, query, or credentials.");
  }
  return {
    httpsOrigin: url.origin,
    realtimeOrigin: `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`,
  };
}

function manifestPlugin(): Plugin {
  return {
    name: "larp-code-extension-manifest",
    generateBundle() {
      const { httpsOrigin, realtimeOrigin } = exactBackendOrigins(supabaseUrl);
      const manifest = {
        manifest_version: 3,
        name: "larp-code",
        version: packageMetadata.version,
        minimum_chrome_version: "116",
        description: "A shared NeetCode 150 accountability companion for two Members.",
        action: {
          default_popup: "popup.html",
          default_title: "Open larp-code",
        },
        background: {
          service_worker: "service-worker.js",
          type: "module",
        },
        permissions: ["storage"],
        host_permissions: [`${httpsOrigin}/*`],
        content_security_policy: {
          extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${httpsOrigin} ${realtimeOrigin}`,
        },
      };
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: resolve(process.cwd(), "src"),
  publicDir: false,
  plugins: [react(), manifestPlugin()],
  define: {
    __CLIENT_VERSION__: JSON.stringify(packageMetadata.version),
    __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
  },
  build: {
    outDir: resolve(process.cwd(), "dist"),
    emptyOutDir: true,
    target: "chrome116",
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(process.cwd(), "src/popup.html"),
        "service-worker": resolve(process.cwd(), "src/worker/service-worker.ts"),
      },
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: (chunk) => chunk.name === "service-worker"
          ? "service-worker.js"
          : "assets/[name]-[hash].js",
      },
    },
  },
});
