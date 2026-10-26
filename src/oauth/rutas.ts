// Servidor de autorización OAuth 2.1 sin estado (sin base de datos).
//
// - Registro dinámico de clientes (RFC 7591): el client_id es un sobre sellado
//   con las redirect_uris del cliente.
// - /authorize muestra un formulario donde el usuario escribe la URL y la clave
//   API de su Odoo; se validan contra Odoo y viajan cifradas en el código.
// - /token canjea el código (PKCE S256 obligatorio) por un access token y un
//   refresh token, también sellados.
//
// Requisitos de Claude: https://claude.com/docs/connectors/building/authentication

import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { CredSellada, DatosAccessToken } from "../auth.js";
import { credencialesDesdeSobre } from "../auth.js";
import type { AppDeps } from "../app.js";
import { OdooError } from "../odoo/errors.js";
import { UrlNoPermitidaError } from "../security/ssrf.js";
import { huella, igualSeguro, sha256Base64Url } from "../security/sobres.js";
import { paginaConexion, paginaError } from "./paginas.js";

export const SCOPE = "odoo.lectura";

interface DatosCliente {
  /** redirect_uris */
  r: string[];
  /** client_name */
  n?: string;
  /** emitido (segundos) */
  t: number;
}

interface DatosSolicitud {
  cid: string;
  r: string;
  cc: string;
  s?: string;
  sc: string;
  exp: number;
}

interface DatosCodigo {
  c: CredSellada;
  cid: string;
  r: string;
  cc: string;
  sc: string;
  exp: number;
  j: string;
}

type DatosRefresh = DatosAccessToken;

const ahoraSeg = () => Math.floor(Date.now() / 1000);

/** Códigos ya canjeados (en memoria, solo mientras viven: 5 minutos). */
class CodigosUsados {
  private readonly usados = new Map<string, number>();
  marcar(jti: string, exp: number): boolean {
    const t = ahoraSeg();
    for (const [k, e] of this.usados) if (e < t) this.usados.delete(k);
    if (this.usados.has(jti)) return false;
    this.usados.set(jti, exp);
    return true;
  }
}

export function redireccionPermitida(uri: string, permitidas: string[], permitirLoopback: boolean): boolean {
  if (permitidas.includes(uri)) return true;
  if (!permitirLoopback) return false;
  try {
    const u = new URL(uri);
    return (
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.hash
    );
  } catch {
    return false;
  }
}

function errorOAuth(c: Context, status: 400 | 401, error: string, descripcion: string) {
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: descripcion }, status);
}

async function leerCuerpo(c: Context): Promise<Record<string, string>> {
  const tipo = c.req.header("content-type") ?? "";
  if (tipo.includes("application/json")) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]));
  }
  const cuerpo = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(
    Object.entries(cuerpo).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  );
}

export function registrarRutasOAuth(app: Hono, deps: AppDeps): void {
  const { config, sellador } = deps;
  const usados = new CodigosUsados();
  const modoPersonal = !!(config.allowEnvFallback && config.mcpAccessToken && config.envOdooUrl);

  const corsPublico = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 86400 });
  app.use("/.well-known/*", corsPublico);
  app.use("/register", corsPublico);
  app.use("/token", corsPublico);

  // ── Descubrimiento ────────────────────────────────────────────────────────
  const metadatosRecurso = (c: Context) => {
    const base = deps.baseUrl(c);
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Odoo (solo lectura)",
    });
  };
  app.get("/.well-known/oauth-protected-resource", metadatosRecurso);
  app.get("/.well-known/oauth-protected-resource/mcp", metadatosRecurso);

  const metadatosServidor = (c: Context) => {
    const base = deps.baseUrl(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get("/.well-known/oauth-authorization-server", metadatosServidor);
  app.get("/.well-known/oauth-authorization-server/mcp", metadatosServidor);

  // ── Registro dinámico de clientes ─────────────────────────────────────────
  app.post("/register", async (c) => {
    if (deps.limitar(c, "registro", config.rateLimitLoginPerMinute)) return deps.respuesta429(c);
    const meta = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!meta || typeof meta !== "object") {
      return errorOAuth(c, 400, "invalid_client_metadata", "El cuerpo debe ser JSON.");
    }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
      return errorOAuth(c, 400, "invalid_redirect_uri", "redirect_uris debe ser una lista de 1 a 5 URLs.");
    }
    const noPermitida = (uris as string[]).find(
      (u) => !redireccionPermitida(u, config.oauthRedirectUris, config.oauthPermitirLoopback),
    );
    if (noPermitida) {
      return errorOAuth(c, 400, "invalid_redirect_uri", `La redirect_uri ${noPermitida} no está permitida en este servidor.`);
    }
    const nombre = typeof meta.client_name === "string" ? meta.client_name.slice(0, 80) : undefined;
    const t = ahoraSeg();
    const clientId = sellador.sellar("cliente", { r: uris, n: nombre, t } satisfies DatosCliente);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: t,
        client_name: nombre,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPE,
      },
      201,
    );
  });

  // ── Autorización: formulario de conexión ──────────────────────────────────
  const cabecerasPagina = (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  };

  app.get("/authorize", (c) => {
    cabecerasPagina(c);
    const q = c.req.query();
    const cliente = sellador.abrir<DatosCliente>("cliente", q.client_id);
    if (!cliente) {
      return c.html(paginaError("El cliente OAuth no es válido. Quita el conector en Claude y vuelve a agregarlo."), 400);
    }
    let redirectUri = q.redirect_uri;
    if (!redirectUri && cliente.r.length === 1) redirectUri = cliente.r[0];
    if (
      !redirectUri ||
      !cliente.r.includes(redirectUri) ||
      !redireccionPermitida(redirectUri, config.oauthRedirectUris, config.oauthPermitirLoopback)
    ) {
      return c.html(paginaError("La dirección de retorno (redirect_uri) no coincide con la registrada."), 400);
    }

    const volverConError = (error: string, descripcion: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", descripcion);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", deps.baseUrl(c));
      return c.redirect(u.toString(), 302);
    };

    if (q.response_type !== "code") return volverConError("unsupported_response_type", "Solo se admite response_type=code.");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return volverConError("invalid_request", "Se requiere PKCE con code_challenge_method=S256.");
    }
    const recurso = `${deps.baseUrl(c)}/mcp`;
    if (q.resource && q.resource.replace(/\/+$/, "") !== recurso && q.resource.replace(/\/+$/, "") !== deps.baseUrl(c)) {
      return volverConError("invalid_target", "El recurso solicitado no corresponde a este servidor.");
    }

    const solicitud = sellador.sellar("solicitud", {
      cid: huella(q.client_id),
      r: redirectUri,
      cc: q.code_challenge,
      s: q.state,
      sc: SCOPE,
      exp: ahoraSeg() + 15 * 60,
    } satisfies DatosSolicitud);

    return c.html(paginaConexion({ solicitud, destino: new URL(redirectUri).host, modoPersonal }));
  });

  app.post("/authorize", async (c) => {
    cabecerasPagina(c);
    const f = await leerCuerpo(c);
    const sol = sellador.abrir<DatosSolicitud>("solicitud", f.solicitud);
    if (!sol || sol.exp < ahoraSeg()) {
      return c.html(paginaError("La solicitud venció. Vuelve a Claude e intenta conectar de nuevo."), 400);
    }
    const destino = new URL(sol.r).host;
    const redirigir = (params: Record<string, string | undefined>) => {
      const u = new URL(sol.r);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
      if (sol.s) u.searchParams.set("state", sol.s);
      u.searchParams.set("iss", deps.baseUrl(c));
      return c.redirect(u.toString(), 302);
    };

    if (f.accion === "cancelar") {
      return redirigir({ error: "access_denied", error_description: "El usuario canceló la conexión." });
    }

    const reintentar = (error: string, status: 400 | 429 = 400) =>
      c.html(
        paginaConexion({ solicitud: f.solicitud, destino, error, url: f.odoo_url, db: f.odoo_db, modoPersonal }),
        status,
      );

    if (deps.limitar(c, "login", config.rateLimitLoginPerMinute)) {
      return reintentar("Demasiados intentos. Espera un minuto y vuelve a intentar.", 429);
    }

    let cred: CredSellada;
    const codigoPersonal = (f.codigo_personal ?? "").trim();
    if (codigoPersonal) {
      if (!modoPersonal || !igualSeguro(codigoPersonal, config.mcpAccessToken!)) {
        return reintentar("El código de acceso personal no es correcto.");
      }
      cred = { e: 1 };
    } else {
      const urlCruda = (f.odoo_url ?? "").trim();
      const clave = (f.odoo_api_key ?? "").replace(/\s+/g, "");
      const db = (f.odoo_db ?? "").trim();
      if (!urlCruda || !clave) return reintentar("Escribe la URL de Odoo y la clave API.");
      if (db && !/^[\w.-]{1,63}$/.test(db)) return reintentar("El nombre de la base de datos no es válido.");
      let url: URL;
      try {
        url = await deps.validarUrl(urlCruda);
      } catch (err) {
        return reintentar(err instanceof UrlNoPermitidaError ? err.message : "La URL de Odoo no es válida.");
      }
      cred = { u: url.origin, k: clave, d: db || undefined };
    }

    // Probar las credenciales con una consulta mínima.
    const credenciales = credencialesDesdeSobre(cred, config);
    if (!credenciales) return reintentar("No hay credenciales de Odoo configuradas en el servidor.");
    try {
      await deps.crearCliente(credenciales).searchRead("res.company", [], ["name"], { limit: 1 });
    } catch (err) {
      const mensaje = err instanceof OdooError ? err.message : "No se pudo validar la conexión con Odoo.";
      deps.log({ evento: "conexion_fallida", host: credenciales.url.host, tipo: err instanceof OdooError ? err.tipo : "desconocido" });
      const pista =
        err instanceof OdooError && (err.tipo === "credenciales" || err.tipo === "permisos")
          ? " En Odoo Online, la API externa solo está disponible en el plan Custom."
          : "";
      return reintentar(mensaje + pista);
    }

    const codigo = sellador.sellar("codigo", {
      c: cred,
      cid: sol.cid,
      r: sol.r,
      cc: sol.cc,
      sc: sol.sc,
      exp: ahoraSeg() + 5 * 60,
      j: randomUUID(),
    } satisfies DatosCodigo);
    deps.log({ evento: "conexion_autorizada", host: credenciales.url.host, origen: credenciales.origen });
    return redirigir({ code: codigo });
  });

  // ── Token ─────────────────────────────────────────────────────────────────
  app.post("/token", async (c) => {
    if (deps.limitar(c, "token", config.rateLimitPerMinute)) return deps.respuesta429(c);
    const f = await leerCuerpo(c);
    const recurso = `${deps.baseUrl(c)}/mcp`;
    if (f.resource && f.resource.replace(/\/+$/, "") !== recurso && f.resource.replace(/\/+$/, "") !== deps.baseUrl(c)) {
      return errorOAuth(c, 400, "invalid_target", "El recurso no corresponde a este servidor.");
    }

    const emitir = (cred: CredSellada, cid: string, sc: string) => {
      const t = ahoraSeg();
      const access: DatosAccessToken = { c: cred, cid, aud: recurso, scp: sc, exp: t + config.accessTokenTtlSeg };
      const refresh: DatosRefresh = { c: cred, cid, aud: recurso, scp: sc, exp: t + config.refreshTokenTtlSeg };
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json({
        access_token: sellador.sellar("access", access),
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeg,
        refresh_token: sellador.sellar("refresh", refresh),
        scope: sc,
      });
    };

    if (f.grant_type === "authorization_code") {
      const cod = sellador.abrir<DatosCodigo>("codigo", f.code);
      if (!cod || cod.exp < ahoraSeg()) return errorOAuth(c, 400, "invalid_grant", "El código no es válido o venció.");
      if (!f.client_id || huella(f.client_id) !== cod.cid || !sellador.abrir<DatosCliente>("cliente", f.client_id)) {
        return errorOAuth(c, 400, "invalid_grant", "El código no pertenece a este cliente.");
      }
      if (f.redirect_uri && f.redirect_uri !== cod.r) {
        return errorOAuth(c, 400, "invalid_grant", "La redirect_uri no coincide.");
      }
      const verificador = f.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verificador) || sha256Base64Url(verificador) !== cod.cc) {
        return errorOAuth(c, 400, "invalid_grant", "El code_verifier (PKCE) no es válido.");
      }
      if (!usados.marcar(cod.j, cod.exp)) {
        return errorOAuth(c, 400, "invalid_grant", "El código ya fue usado.");
      }
      return emitir(cod.c, cod.cid, cod.sc);
    }

    if (f.grant_type === "refresh_token") {
      const ref = sellador.abrir<DatosRefresh>("refresh", f.refresh_token);
      if (!ref || ref.exp < ahoraSeg()) {
        return errorOAuth(c, 400, "invalid_grant", "La sesión venció. Vuelve a conectar el conector.");
      }
      if (f.client_id && huella(f.client_id) !== ref.cid) {
        return errorOAuth(c, 400, "invalid_grant", "El token no pertenece a este cliente.");
      }
      // Si la clave de Odoo ya no sirve, se obliga a reconectar en vez de emitir un token inútil.
      const credenciales = credencialesDesdeSobre(ref.c, config);
      if (!credenciales) return errorOAuth(c, 400, "invalid_grant", "Las credenciales ya no son válidas. Vuelve a conectar.");
      try {
        await deps.crearCliente(credenciales).searchRead("res.company", [], ["name"], { limit: 1 });
      } catch (err) {
        if (err instanceof OdooError && err.tipo === "credenciales") {
          return errorOAuth(c, 400, "invalid_grant", "La clave API de Odoo ya no es válida. Vuelve a conectar con una clave nueva.");
        }
        // Odoo caído o lento: no se castiga al usuario, se renueva igual.
      }
      return emitir(ref.c, ref.cid, ref.scp);
    }

    return errorOAuth(c, 400, "unsupported_grant_type", "Solo se admiten authorization_code y refresh_token.");
  });
}
