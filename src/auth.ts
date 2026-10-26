// Convierte el token que envía Claude en credenciales de Odoo.

import type { Config } from "./config.js";
import type { CredencialesOdoo } from "./odoo/client.js";
import { normalizarUrlOdoo } from "./security/ssrf.js";
import { igualSeguro, type Sellador } from "./security/sobres.js";

/** Credenciales tal como viajan dentro de los sobres (claves cortas para que el token sea pequeño). */
export interface CredSellada {
  /** URL de Odoo */
  u?: string;
  /** clave API */
  k?: string;
  /** base de datos */
  d?: string;
  /** 1 = usar las credenciales del entorno (modo personal) */
  e?: 1;
}

export interface DatosAccessToken {
  c: CredSellada;
  /** huella del client_id */
  cid: string;
  /** recurso (URL del endpoint MCP) */
  aud: string;
  scp: string;
  exp: number;
}

export function credencialesDelEntorno(config: Config): CredencialesOdoo | null {
  if (!config.allowEnvFallback || !config.envOdooUrl || !config.envOdooApiKey) return null;
  return {
    url: normalizarUrlOdoo(config.envOdooUrl, { permitirPrivadas: config.devAllowPrivateEnvUrl }),
    apiKey: config.envOdooApiKey,
    db: config.envOdooDb,
    permitirPrivadas: config.devAllowPrivateEnvUrl,
    origen: "entorno",
  };
}

export function credencialesDesdeSobre(cred: CredSellada, config: Config): CredencialesOdoo | null {
  if (cred.e) return credencialesDelEntorno(config);
  if (!cred.u || !cred.k) return null;
  try {
    return { url: normalizarUrlOdoo(cred.u), apiKey: cred.k, db: cred.d || undefined, origen: "oauth" };
  } catch {
    return null;
  }
}

export function extraerBearer(autorizacion: string | undefined): string | undefined {
  const m = autorizacion?.match(/^\s*bearer\s+(\S+)\s*$/i);
  return m?.[1];
}

/**
 * Resuelve las credenciales de Odoo de una petición al endpoint MCP.
 * Devuelve null si no hay token, si es inválido o si venció (el servidor responde 401).
 */
export function resolverCredenciales(
  token: string | undefined,
  config: Config,
  sellador: Sellador,
  recurso: string,
  ahoraSeg = Math.floor(Date.now() / 1000),
): CredencialesOdoo | null {
  if (!token) return null;

  // Modo personal: el token es directamente MCP_ACCESS_TOKEN.
  if (config.allowEnvFallback && config.mcpAccessToken && igualSeguro(token, config.mcpAccessToken)) {
    return credencialesDelEntorno(config);
  }

  const datos = sellador.abrir<DatosAccessToken>("access", token);
  if (!datos || datos.exp <= ahoraSeg || datos.aud !== recurso) return null;
  return credencialesDesdeSobre(datos.c, config);
}
