// Configuración leída de variables de entorno. Se lee una sola vez al arrancar.

function bool(valor: string | undefined, porDefecto: boolean): boolean {
  if (valor === undefined || valor.trim() === "") return porDefecto;
  return ["1", "true", "yes", "si", "sí", "on"].includes(valor.trim().toLowerCase());
}

function int(valor: string | undefined, porDefecto: number): number {
  const n = Number.parseInt(valor ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

function lista(valor: string | undefined, porDefecto: string[]): string[] {
  if (!valor || !valor.trim()) return porDefecto;
  return valor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const vacioAUndefined = (v?: string) => (v && v.trim() ? v.trim() : undefined);

export const MODELOS_CONSULTA_AVANZADA_DEFECTO = [
  "res.partner",
  "res.company",
  "account.move",
  "account.move.line",
  "account.account",
  "account.journal",
  "account.payment",
  "account.bank.statement.line",
  "account.tax",
  "account.analytic.account",
  "sale.order",
  "purchase.order",
  "product.product",
  "stock.quant",
];

/** Callbacks de OAuth que se aceptan por defecto (claude.ai y su dominio alterno). */
export const REDIRECCIONES_OAUTH_DEFECTO = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

export interface Config {
  port: number;
  /** URL pública del servidor, p. ej. https://mcp.midominio.com (sin / final). */
  publicBaseUrl?: string;

  /** Llave con la que se cifran los tokens de OAuth. Obligatoria en producción. */
  tokenSecret?: string;
  /** Llave anterior, solo para descifrar mientras se rota. */
  tokenSecretPrevious?: string;
  accessTokenTtlSeg: number;
  refreshTokenTtlSeg: number;
  oauthRedirectUris: string[];
  oauthPermitirLoopback: boolean;

  /** Modo personal: usar las credenciales de Odoo del entorno. */
  allowEnvFallback: boolean;
  envOdooUrl?: string;
  envOdooApiKey?: string;
  envOdooDb?: string;
  /** Código que habilita el modo personal (como bearer o en la pantalla de conexión). */
  mcpAccessToken?: string;

  odooTimeoutMs: number;
  defaultRowLimit: number;
  maxRowLimit: number;
  /** Tope de caracteres de la respuesta de una herramienta (Claude acepta ~150.000). */
  maxResponseChars: number;
  rateLimitPerMinute: number;
  rateLimitLoginPerMinute: number;
  trustProxyHops: number;
  advancedQueryModels: string[];
  /** Zona horaria para calcular "hoy" (cartera por edades). */
  zonaHoraria: string;
  devAllowPrivateEnvUrl: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 3000),
    publicBaseUrl: vacioAUndefined(env.PUBLIC_BASE_URL)?.replace(/\/+$/, ""),

    tokenSecret: vacioAUndefined(env.TOKEN_SECRET),
    tokenSecretPrevious: vacioAUndefined(env.TOKEN_SECRET_PREVIOUS),
    accessTokenTtlSeg: int(env.ACCESS_TOKEN_TTL_SECONDS, 3600),
    refreshTokenTtlSeg: int(env.REFRESH_TOKEN_TTL_SECONDS, 90 * 24 * 3600),
    oauthRedirectUris: [...REDIRECCIONES_OAUTH_DEFECTO, ...lista(env.OAUTH_EXTRA_REDIRECT_URIS, [])],
    oauthPermitirLoopback: bool(env.OAUTH_ALLOW_LOOPBACK_REDIRECTS, true),

    allowEnvFallback: bool(env.ALLOW_ENV_FALLBACK, false),
    envOdooUrl: vacioAUndefined(env.ODOO_URL),
    envOdooApiKey: vacioAUndefined(env.ODOO_API_KEY),
    envOdooDb: vacioAUndefined(env.ODOO_DB),
    mcpAccessToken: vacioAUndefined(env.MCP_ACCESS_TOKEN),

    odooTimeoutMs: int(env.ODOO_TIMEOUT_MS, 20_000),
    defaultRowLimit: int(env.DEFAULT_ROW_LIMIT, 500),
    maxRowLimit: int(env.MAX_ROW_LIMIT, 5_000),
    maxResponseChars: int(env.MAX_RESPONSE_CHARS, 120_000),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 120),
    rateLimitLoginPerMinute: int(env.RATE_LIMIT_LOGIN_PER_MINUTE, 10),
    trustProxyHops: Number.parseInt(env.TRUST_PROXY_HOPS ?? "1", 10) || 0,
    advancedQueryModels: lista(env.ADVANCED_QUERY_MODELS, MODELOS_CONSULTA_AVANZADA_DEFECTO),
    zonaHoraria: vacioAUndefined(env.ZONA_HORARIA) ?? "America/Bogota",
    devAllowPrivateEnvUrl: bool(env.DEV_ALLOW_PRIVATE_ENV_URL, false),
  };
}

/** Errores de configuración que impiden arrancar de forma segura. */
export function validarConfig(config: Config, produccion = process.env.NODE_ENV === "production"): string[] {
  const errores: string[] = [];
  if (!config.tokenSecret || config.tokenSecret.length < 32) {
    errores.push("TOKEN_SECRET es obligatorio y debe tener al menos 32 caracteres (usa: openssl rand -hex 32).");
  }
  if (config.allowEnvFallback) {
    if (!config.envOdooUrl || !config.envOdooApiKey) {
      errores.push("ALLOW_ENV_FALLBACK=true requiere ODOO_URL y ODOO_API_KEY.");
    }
    if (!config.mcpAccessToken || config.mcpAccessToken.length < 24) {
      errores.push("ALLOW_ENV_FALLBACK=true requiere MCP_ACCESS_TOKEN de al menos 24 caracteres.");
    }
  }
  if (config.publicBaseUrl && !/^https?:\/\//.test(config.publicBaseUrl)) {
    errores.push("PUBLIC_BASE_URL debe empezar por https://.");
  }
  if (produccion) {
    if (!config.publicBaseUrl?.startsWith("https://")) {
      errores.push("En producción, PUBLIC_BASE_URL es obligatoria y debe ser https:// (por ejemplo https://mcp.midominio.com).");
    }
    if (config.devAllowPrivateEnvUrl) {
      errores.push("DEV_ALLOW_PRIVATE_ENV_URL=true no se permite en producción.");
    }
  }
  return errores;
}
