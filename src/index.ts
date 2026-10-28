// Punto de entrada: servidor HTTP de Node.

import { serve } from "@hono/node-server";
import { crearApp } from "./app.js";
import { loadConfig, validarConfig } from "./config.js";
import { VERSION } from "./mcp.js";

const config = loadConfig();
const errores = validarConfig(config);
if (errores.length) {
  for (const e of errores) console.error(`[config] ${e}`);
  process.exit(1);
}
if (!config.publicBaseUrl) {
  console.warn("[config] PUBLIC_BASE_URL no está definida: se deduce de cada petición. Defínela en producción.");
}
if (config.allowEnvFallback) {
  console.warn("[config] Modo personal activo (ALLOW_ENV_FALLBACK=true): quien tenga MCP_ACCESS_TOKEN usa el Odoo del entorno.");
}

const app = crearApp(config);
// 0.0.0.0: el proxy de Coolify (Traefik) llega al contenedor por la red de Docker.
const server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`mcp-odoo v${VERSION} escuchando en el puerto ${info.port}`);
});

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
