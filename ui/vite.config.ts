import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const backend = process.env.VITE_BACKEND_URL || "http://localhost:4000";

const proxiedRoutes = [
  "/status",
  "/metrics",
  "/logs",
  "/history",
  "/api/config",
  "/telemetry",
  "/sessions",
  "/engines",
  "/reindex",
  "/reset",
  "/lmstudio",
  "/search",
  "/query",
  "/v1",
  "/chat",
  "/models",
  "/presets",
  "/hardware",
  "/summary",
  "/rag",
  "/debug",
  "/gpu",
  "/health",
  "/bootstrap",
];

export default defineConfig(({ command }) => {
  const base = command === "build" ? "/ui/" : "/";
  return {
    base,
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: proxiedRoutes.reduce<Record<string, { target: string; changeOrigin: boolean; ws?: boolean }>>(
        (acc, route) => {
          acc[route] = { target: backend, changeOrigin: true, ws: route === "/v1" || route === "/chat" };
          return acc;
        },
        {
          "/ws": { target: backend.replace("http", "ws"), changeOrigin: true, ws: true },
        }
      ),
    },
  };
});
