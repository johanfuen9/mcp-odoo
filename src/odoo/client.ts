// Cliente mínimo de la API externa JSON-2 de Odoo 19:
//   POST {url}/json/2/{modelo}/{metodo}
//   Authorization: bearer {clave API}
//   X-Odoo-Database: {base}   (opcional)
// Todos los argumentos van nombrados en el cuerpo JSON. Cada llamada es una
// transacción independiente en Odoo.

import { Agent, fetch as undiciFetch } from "undici";
import { lookupSeguro, UrlNoPermitidaError } from "../security/ssrf.js";
import { errorDesdeRespuesta, OdooError, type CuerpoErrorOdoo } from "./errors.js";

/**
 * Únicos métodos que este servidor puede invocar en Odoo. Todos son de lectura.
 * En Odoo 19 el método público de agrupación es `formatted_read_group`
 * (addons/web/models/models.py); `read_group` quedó obsoleto.
 */
export const METODOS_PERMITIDOS = new Set(["search_read", "search_count", "read", "formatted_read_group"]);

export function verificarMetodoPermitido(metodo: string): void {
  if (!METODOS_PERMITIDOS.has(metodo)) {
    throw new OdooError(
      "metodo_no_permitido",
      `El método "${metodo}" no está permitido. Este conector es solo de lectura y únicamente usa: ${[...METODOS_PERMITIDOS].join(", ")}.`,
    );
  }
}

export interface CredencialesOdoo {
  url: URL;
  apiKey: string;
  db?: string;
  /** Solo para la URL del .env en desarrollo. */
  permitirPrivadas?: boolean;
  /** De dónde salieron las credenciales (para logs, nunca la clave). */
  origen: "encabezados" | "ruta" | "entorno";
}

export type FetchLike = (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export interface OpcionesCliente {
  timeoutMs: number;
  /** Para pruebas: reemplaza el fetch real. */
  fetchImpl?: FetchLike;
}

const USER_AGENT = "mcp-odoo/0.1 (+conector MCP de solo lectura)";
// Odoo puede devolver respuestas grandes; se corta en 50 MB por seguridad.
const MAX_BYTES_RESPUESTA = 50 * 1024 * 1024;

const agenteSeguro = new Agent({
  connect: { lookup: lookupSeguro as never },
  connections: 50,
});
const agentePermisivo = new Agent({ connections: 10 });

export interface OpcionesSearchRead {
  limit?: number;
  offset?: number;
  order?: string;
  context?: Record<string, unknown>;
}

export class OdooClient {
  readonly credenciales: CredencialesOdoo;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(credenciales: CredencialesOdoo, opciones: OpcionesCliente) {
    this.credenciales = credenciales;
    this.timeoutMs = opciones.timeoutMs;
    this.fetchImpl = opciones.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  }

  get host(): string {
    return this.credenciales.url.host;
  }

  async call<T = unknown>(modelo: string, metodo: string, params: Record<string, unknown> = {}): Promise<T> {
    verificarMetodoPermitido(metodo);
    if (!/^[a-z0-9_.]+$/i.test(modelo)) {
      throw new OdooError("parametros", `El nombre de modelo "${modelo}" no es válido.`);
    }

    const destino = new URL(`/json/2/${modelo}/${metodo}`, this.credenciales.url);
    const headers: Record<string, string> = {
      Authorization: `bearer ${this.credenciales.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.credenciales.db) headers["X-Odoo-Database"] = this.credenciales.db;

    let resp: Response;
    try {
      resp = await this.fetchImpl(destino.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        dispatcher: this.credenciales.permitirPrivadas ? agentePermisivo : agenteSeguro,
      });
    } catch (err) {
      throw this.errorDeTransporte(err);
    }

    if (resp.status >= 300 && resp.status < 400) {
      throw new OdooError(
        "no_es_odoo",
        "La URL de Odoo redirige a otra dirección. Usa la URL exacta de tu instancia (por ejemplo https://empresa.odoo.com, sin rutas adicionales).",
        `HTTP ${resp.status} redirect`,
      );
    }

    let texto: string;
    try {
      texto = await leerConLimite(resp, MAX_BYTES_RESPUESTA);
    } catch (err) {
      throw this.errorDeTransporte(err);
    }

    let cuerpo: unknown = null;
    let esJson = true;
    try {
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      esJson = false;
    }

    if (!resp.ok) {
      throw errorDesdeRespuesta(resp.status, esJson ? (cuerpo as CuerpoErrorOdoo) : null, modelo, metodo);
    }
    if (!esJson) {
      throw new OdooError(
        "no_es_odoo",
        "La URL respondió, pero no como la API JSON-2 de Odoo 19. Revisa la URL y la versión de Odoo.",
        `HTTP ${resp.status} sin JSON`,
      );
    }
    return cuerpo as T;
  }

  searchRead<T = Record<string, unknown>>(
    modelo: string,
    domain: unknown[],
    fields: string[],
    opciones: OpcionesSearchRead = {},
  ): Promise<T[]> {
    return this.call<T[]>(modelo, "search_read", { domain, fields, ...limpiar(opciones) });
  }

  searchCount(modelo: string, domain: unknown[], context?: Record<string, unknown>): Promise<number> {
    return this.call<number>(modelo, "search_count", limpiar({ domain, context }));
  }

  read<T = Record<string, unknown>>(
    modelo: string,
    ids: number[],
    fields: string[],
    context?: Record<string, unknown>,
  ): Promise<T[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.call<T[]>(modelo, "read", limpiar({ ids, fields, context }));
  }

  /**
   * Agrupa en el servidor de Odoo con formatted_read_group.
   * `groupby`: p. ej. ["partner_id", "invoice_date:month"].
   * `aggregates`: p. ej. ["amount_total:sum"]. Siempre se agrega "__count".
   */
  agrupar(
    modelo: string,
    domain: unknown[],
    groupby: string[],
    aggregates: string[],
    opciones: { order?: string; limit?: number; context?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>[]> {
    const aggs = aggregates.includes("__count") ? aggregates : [...aggregates, "__count"];
    return this.call<Record<string, unknown>[]>(
      modelo,
      "formatted_read_group",
      limpiar({ domain, groupby, aggregates: aggs, ...opciones }),
    );
  }

  private errorDeTransporte(err: unknown): OdooError {
    const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } };
    const causa = e?.cause;
    if (e?.name === "TimeoutError" || e?.name === "AbortError" || causa?.name === "TimeoutError") {
      return new OdooError(
        "tiempo_agotado",
        `Odoo tardó más de ${Math.round(this.timeoutMs / 1000)} segundos en responder. Prueba con un rango de fechas más corto o con menos filas.`,
        "timeout",
      );
    }
    if (err instanceof UrlNoPermitidaError || causa instanceof UrlNoPermitidaError || causa?.code === "ESSRFBLOCKED") {
      return new OdooError(
        "url_no_permitida",
        "La URL de Odoo resuelve a una IP privada o reservada y no está permitida.",
        "ssrf",
      );
    }
    if (err instanceof OdooError) return err;
    const codigo = causa?.code ?? e?.code ?? "";
    if (codigo === "ENOTFOUND" || codigo === "EAI_AGAIN") {
      return new OdooError("conexion", `No se encontró el servidor ${this.host}. Revisa la URL de Odoo.`, codigo);
    }
    if (/CERT|SSL|TLS/i.test(codigo)) {
      return new OdooError("conexion", `El certificado HTTPS de ${this.host} no es válido.`, codigo);
    }
    return new OdooError(
      "conexion",
      `No se pudo conectar con Odoo en ${this.host}. Verifica la URL y que el servidor esté en línea.`,
      codigo || e?.name,
    );
  }
}

function limpiar<T extends object>(obj: T): Partial<T> {
  const salida: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (salida as Record<string, unknown>)[k] = v;
  }
  return salida;
}

async function leerConLimite(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OdooError(
        "odoo",
        "La respuesta de Odoo es demasiado grande. Usa filtros más específicos o un límite de filas menor.",
        "respuesta > limite",
      );
    }
    partes.push(value);
  }
  return Buffer.concat(partes).toString("utf-8");
}
