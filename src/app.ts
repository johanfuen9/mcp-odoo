// Aplicación HTTP (Hono): endpoint MCP, OAuth y salud.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { extraerBearer, resolverCredenciales } from "./auth.js";
import type { Config } from "./config.js";
import { crearServidorMcp, VERSION } from "./mcp.js";
import { OdooClient, type CredencialesOdoo, type FetchLike } from "./odoo/client.js";
import { registrarRutasOAuth } from "./oauth/rutas.js";
import { ipCliente, LimitadorPorMinuto } from "./security/rateLimit.js";
import { huella, Sellador } from "./security/sobres.js";
import { validarUrlOdoo, type Resolutor } from "./security/ssrf.js";

export interface AppDeps {
  config: Config;
  sellador: Sellador;
  baseUrl: (c: Context) => string;
  /** true si la petición excede el límite del grupo. */
  limitar: (c: Context, grupo: string, maximoPorMinuto: number, extra?: string) => boolean;
  respuesta429: (c: Context) => Response;
  crearCliente: (cred: CredencialesOdoo) => OdooClient;
  /** Normaliza la URL de Odoo y valida su DNS contra SSRF. */
  validarUrl: (url: string) => Promise<URL>;
  log: (datos: Record<string, unknown>) => void;
}

export interface OpcionesApp {
  /** Para pruebas: reemplaza el fetch hacia Odoo. */
  fetchOdoo?: FetchLike;
  /** Para pruebas: IP del socket cuando no hay servidor Node real. */
  ipPorDefecto?: string;
  /** Para pruebas: resolutor DNS. */
  resolverDns?: Resolutor;
  log?: (datos: Record<string, unknown>) => void;
}

function logJson(datos: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...datos }));
}

function ipSocket(c: Context): string | undefined {
  // @hono/node-server expone el socket en c.env.incoming
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

export function crearApp(config: Config, opciones: OpcionesApp = {}): Hono {
  const app = new Hono();
  const sellador = new Sellador([config.tokenSecret, config.tokenSecretPrevious]);
  const limitadores = new Map<string, LimitadorPorMinuto>();
  const log = opciones.log ?? logJson;

  const deps: AppDeps = {
    config,
    sellador,
    baseUrl: (c) => {
      if (config.publicBaseUrl) return config.publicBaseUrl;
      const url = new URL(c.req.url);
      const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
      const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || url.host;
      return `${proto}://${host}`;
    },
    limitar: (c, grupo, maximo, extra) => {
      let limitador = limitadores.get(grupo);
      if (!limitador) {
        limitador = new LimitadorPorMinuto(maximo);
        limitadores.set(grupo, limitador);
      }
      const ip = ipCliente(c.req.header("x-forwarded-for"), ipSocket(c) ?? opciones.ipPorDefecto, config.trustProxyHops);
      return limitador.consumir(extra ? `${ip}|${extra}` : ip) > 0;
    },
    respuesta429: (c) => {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited", error_description: "Demasiadas peticiones. Espera un minuto." }, 429);
    },
    crearCliente: (cred) => new OdooClient(cred, { timeoutMs: config.odooTimeoutMs, fetchImpl: opciones.fetchOdoo }),
    validarUrl: (url) => validarUrlOdoo(url, {}, opciones.resolverDns),
    log,
  };

  // Log de acceso: método, ruta, estado y duración. Nunca encabezados ni cuerpos.
  app.use("*", async (c, next) => {
    const inicio = Date.now();
    await next();
    if (c.req.path !== "/health") {
      log({ evento: "http", metodo: c.req.method, ruta: c.req.path, estado: c.res.status, ms: Date.now() - inicio });
    }
  });

  app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

  app.get("/", (c) =>
    c.text(
      `Servidor MCP de Odoo (solo lectura) v${VERSION}.\nAgrégalo en Claude como conector personalizado con la URL ${deps.baseUrl(c)}/mcp\n`,
    ),
  );

  registrarRutasOAuth(app, deps);

  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
      maxAge: 86400,
    }),
  );

  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST") {
      // Modo stateless: no hay sesiones ni stream SSE por GET.
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido." }, id: null }, 405);
    }

    const base = deps.baseUrl(c);
    const token = extraerBearer(c.req.header("authorization"));
    const credenciales = resolverCredenciales(token, config, sellador, `${base}/mcp`);
    if (!credenciales) {
      const metadatos = `${base}/.well-known/oauth-protected-resource/mcp`;
      c.header(
        "WWW-Authenticate",
        token
          ? `Bearer error="invalid_token", error_description="El token no es válido o venció", resource_metadata="${metadatos}"`
          : `Bearer resource_metadata="${metadatos}", scope="odoo.lectura"`,
      );
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Se requiere autenticación." }, id: null }, 401);
    }

    if (deps.limitar(c, "mcp", config.rateLimitPerMinute, huella(token!))) return deps.respuesta429(c);

    const cliente = deps.crearCliente(credenciales);
    const server = crearServidorMcp({ cliente, config, log });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      void transport.close();
      void server.close();
    }
  });

  app.notFound((c) => c.json({ error: "no_encontrado" }, 404));
  app.onError((err, c) => {
    log({ evento: "error_no_controlado", ruta: c.req.path, mensaje: String(err?.message ?? err).slice(0, 200) });
    return c.json({ error: "error_interno" }, 500);
  });

  return app;
}
