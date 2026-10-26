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

export const MODELOS_CONSULTA_AVANZADA_DEFECTO = [
  "res.partner",
  "account.move",
  "account.move.line",
  "account.account",
  "sale.order",
  "purchase.order",
  "product.product",
  "stock.quant",
];

export interface Config {
  port: number;
  allowEnvFallback: boolean;
  envOdooUrl?: string;
  envOdooApiKey?: string;
  envOdooDb?: string;
  mcpAccessToken?: string;
  odooTimeoutMs: number;
  defaultRowLimit: number;
  maxRowLimit: number;
  rateLimitPerMinute: number;
  trustProxyHops: number;
  advancedQueryModels: string[];
  devAllowPrivateEnvUrl: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vacioAUndefined = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  return {
    port: int(env.PORT, 3000),
    allowEnvFallback: bool(env.ALLOW_ENV_FALLBACK, true),
    envOdooUrl: vacioAUndefined(env.ODOO_URL),
    envOdooApiKey: vacioAUndefined(env.ODOO_API_KEY),
    envOdooDb: vacioAUndefined(env.ODOO_DB),
    mcpAccessToken: vacioAUndefined(env.MCP_ACCESS_TOKEN),
    odooTimeoutMs: int(env.ODOO_TIMEOUT_MS, 20_000),
    defaultRowLimit: int(env.DEFAULT_ROW_LIMIT, 500),
    maxRowLimit: int(env.MAX_ROW_LIMIT, 5_000),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 120),
    trustProxyHops: Number.parseInt(env.TRUST_PROXY_HOPS ?? "1", 10) || 0,
    advancedQueryModels: lista(env.ADVANCED_QUERY_MODELS, MODELOS_CONSULTA_AVANZADA_DEFECTO),
    devAllowPrivateEnvUrl: bool(env.DEV_ALLOW_PRIVATE_ENV_URL, false),
  };
}
