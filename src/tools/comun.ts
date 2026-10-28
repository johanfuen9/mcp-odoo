// Piezas compartidas por todas las herramientas.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { OdooClient } from "../odoo/client.js";
import { mensajeParaUsuario, OdooError } from "../odoo/errors.js";
import { respuestaError, respuestaTabular, type Tabla } from "../tabular.js";

export interface ContextoHerramienta {
  cliente: OdooClient;
  config: Config;
  log: (datos: Record<string, unknown>) => void;
}

export const esquemaFecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD");

export const esquemaEmpresa = z
  .union([z.number().int().positive(), z.string().min(1)])
  .optional()
  .describe(
    "Empresa a consultar: id, nombre o NIT. Obligatorio si el usuario tiene varias empresas en Odoo (usa la herramienta empresas para verlas). Incluye sus sucursales.",
  );

export function esquemaLimite(config: Config) {
  return z
    .number()
    .int()
    .min(1)
    .max(config.maxRowLimit)
    .optional()
    .describe(`Máximo de filas a devolver. Por defecto ${config.defaultRowLimit}, máximo ${config.maxRowLimit}.`);
}

export function limiteEfectivo(config: Config, limite?: number): number {
  return Math.min(limite ?? config.defaultRowLimit, config.maxRowLimit);
}

export function validarRango(desde?: string, hasta?: string): void {
  if (desde && hasta && desde > hasta) {
    throw new OdooError("parametros", `La fecha "desde" (${desde}) es posterior a "hasta" (${hasta}).`);
  }
}

export const ANOTACIONES_LECTURA = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Registra una herramienta de solo lectura: atrapa errores, los traduce a
 * mensajes para el usuario y deja una línea de log sin datos sensibles.
 */
export function registrarHerramienta<Forma extends z.ZodRawShape>(
  server: McpServer,
  ctx: ContextoHerramienta,
  nombre: string,
  definicion: { titulo: string; descripcion: string; parametros: Forma },
  ejecutar: (args: z.infer<z.ZodObject<Forma>>) => Promise<Tabla>,
): void {
  server.registerTool(
    nombre,
    {
      title: definicion.titulo,
      description: definicion.descripcion,
      inputSchema: definicion.parametros,
      annotations: { title: definicion.titulo, ...ANOTACIONES_LECTURA },
    },
    (async (args: z.infer<z.ZodObject<Forma>>) => {
      const inicio = Date.now();
      try {
        const tabla = await ejecutar(args);
        ctx.log({ evento: "herramienta", herramienta: nombre, host: ctx.cliente.host, filas: tabla.filas.length, ms: Date.now() - inicio });
        return respuestaTabular(tabla, ctx.config.maxResponseChars);
      } catch (err) {
        ctx.log({
          evento: "herramienta_error",
          herramienta: nombre,
          host: ctx.cliente.host,
          tipo: err instanceof OdooError ? err.tipo : "inesperado",
          detalle: err instanceof OdooError ? err.detalle : String((err as Error)?.message ?? err).slice(0, 200),
          ms: Date.now() - inicio,
        });
        return respuestaError(mensajeParaUsuario(err));
      }
    }) as never,
  );
}

export const esquemaNivel = z
  .enum(["clase", "grupo", "cuenta", "subcuenta", "auxiliar"])
  .describe(
    "Nivel del PUC: clase (1 dígito), grupo (2), cuenta (4), subcuenta (6) o auxiliar (la cuenta completa de Odoo).",
  );

/** Variación absoluta y porcentual entre dos valores. */
export function variacion(actual: number, anterior: number): { variacion: number; variacion_pct: number | null } {
  const v = actual - anterior;
  return { variacion: Math.round(v * 100) / 100, variacion_pct: anterior === 0 ? null : Math.round((v / Math.abs(anterior)) * 10000) / 100 };
}
