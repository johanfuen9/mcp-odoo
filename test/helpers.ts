import type { Hono } from "hono";
import { crearApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { sha256Base64Url } from "../src/security/sobres.js";
import { datosBase } from "./fixtures.js";
import { crearMockOdoo, type OpcionesMock } from "./mockOdoo.js";

export const BASE = "https://mcp.ejemplo.com";
export const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const VERIFICADOR = "verificador-pkce-de-prueba-0123456789-abcdefghijklmnop";

export function configPrueba(extra: Record<string, string> = {}): Config {
  return loadConfig({
    TOKEN_SECRET: "secreto-de-prueba-de-al-menos-32-caracteres-xx",
    PUBLIC_BASE_URL: BASE,
    TRUST_PROXY_HOPS: "0",
    ...extra,
  });
}

export function montar(opcionesMock: Partial<OpcionesMock> = {}, extraConfig: Record<string, string> = {}) {
  const mock = crearMockOdoo({ datos: datosBase(), ...opcionesMock });
  const logs: Record<string, unknown>[] = [];
  const config = configPrueba(extraConfig);
  const app = crearApp(config, {
    fetchOdoo: mock.fetchImpl,
    ipPorDefecto: "203.0.113.50",
    resolverDns: async () => [{ address: "34.120.10.5", family: 4 }],
    log: (d) => logs.push(d),
  });
  return { app, mock, logs, config };
}

/** Recorre el flujo OAuth completo y devuelve los tokens. */
export async function conectar(app: Hono, clave: string, url = "https://empresa.odoo.com") {
  const reg = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Claude", token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: sha256Base64Url(VERIFICADOR),
    code_challenge_method: "S256",
    state: "estado-123",
    scope: "odoo.lectura",
    resource: `${BASE}/mcp`,
  });
  const pagina = await (await app.request(`/authorize?${q}`)).text();
  const solicitud = pagina.match(/name="solicitud" value="([^"]+)"/)![1];
  const post = await app.request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ solicitud, odoo_url: url, odoo_api_key: clave, odoo_db: "", accion: "conectar" }).toString(),
  });
  const destino = new URL(post.headers.get("location")!);
  const tok = await app.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: destino.searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id,
      code_verifier: VERIFICADOR,
    }).toString(),
  });
  return { client_id, ...((await tok.json()) as { access_token: string; refresh_token: string }) };
}

let idRpc = 0;
export async function rpc(app: Hono, token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Protocol-Version": "2025-06-18",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++idRpc, method, params }) });
}

/** Llama una herramienta y devuelve el JSON de su respuesta (o el texto del error). */
export async function herramienta(app: Hono, token: string, nombre: string, args: Record<string, unknown> = {}) {
  const r = await rpc(app, token, "tools/call", { name: nombre, arguments: args });
  const cuerpo = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const texto = cuerpo.result.content[0].text;
  return { isError: !!cuerpo.result.isError, texto, datos: cuerpo.result.isError ? null : JSON.parse(texto) };
}
