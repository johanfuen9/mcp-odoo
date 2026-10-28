// Herramienta `consulta_avanzada`: search_read genérico sobre una lista blanca de modelos.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolverEmpresa } from "../odoo/empresa.js";
import { OdooError } from "../odoo/errors.js";
import { aplanarRegistro } from "../tabular.js";
import { esquemaEmpresa, esquemaLimite, limiteEfectivo, registrarHerramienta, type ContextoHerramienta } from "./comun.js";

const OPERADORES = new Set([
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "=?",
  "like",
  "not like",
  "ilike",
  "not ilike",
  "=like",
  "=ilike",
  "in",
  "not in",
  "child_of",
  "parent_of",
]);
const RUTA_CAMPO = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;
const CAMPO = /^[a-z_][a-z0-9_]*$/;
const escalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ORDEN = /^[a-z_][a-z0-9_]*( (asc|desc))?(, ?[a-z_][a-z0-9_]*( (asc|desc))?)*$/i;

/** Valida la forma de un dominio de Odoo (notación polaca). Lanza OdooError si no es válido. */
export function validarDominio(dominio: unknown): void {
  if (!Array.isArray(dominio)) throw new OdooError("parametros", "El dominio debe ser una lista.");
  if (dominio.length > 50) throw new OdooError("parametros", "El dominio tiene demasiadas condiciones (máximo 50).");
  for (const termino of dominio) {
    if (termino === "&" || termino === "|" || termino === "!") continue;
    if (!Array.isArray(termino) || termino.length !== 3) {
      throw new OdooError("parametros", `Condición no válida en el dominio: ${JSON.stringify(termino)}. Usa ["campo", "operador", valor]. Para campos de otro modelo usa la ruta con punto, por ejemplo "partner_id.vat".`);
    }
    const [campo, operador] = termino;
    if (typeof campo !== "string" || !RUTA_CAMPO.test(campo)) {
      throw new OdooError("parametros", `Nombre de campo no válido en el dominio: ${JSON.stringify(campo)}.`);
    }
    if (typeof operador !== "string" || !OPERADORES.has(operador)) {
      throw new OdooError("parametros", `Operador no válido en el dominio: ${JSON.stringify(operador)}.`);
    }
  }
}

export function registrarConsultaAvanzada(server: McpServer, ctx: ContextoHerramienta): void {
  const modelos = ctx.config.advancedQueryModels;
  registrarHerramienta(
    server,
    ctx,
    "consulta_avanzada",
    {
      titulo: "Consulta avanzada (search_read)",
      descripcion:
        "Consulta genérica de solo lectura (search_read) para preguntas que las otras herramientas no cubren. " +
        `Modelos permitidos: ${modelos.join(", ")}. ` +
        'Recibe modelo, dominio de Odoo (por ejemplo [["state","=","sale"],["date_order",">=","2026-01-01"]]), campos a leer y límite. ' +
        "Devuelve filas planas: los campos many2one se separan en <campo>_id y <campo>_nombre, y las listas de ids se devuelven como texto. " +
        "Si se indica 'empresa', solo ve los registros de esa empresa; si no, ve los de todas las empresas del usuario. " +
        "Prefiere las herramientas especializadas cuando existan: agregan en el servidor y devuelven menos datos.",
      parametros: {
        modelo: z.string().describe(`Modelo de Odoo. Uno de: ${modelos.join(", ")}.`),
        dominio: z
          .array(z.union([z.enum(["&", "|", "!"]), z.array(z.union([escalar, z.array(escalar)]))]))
          .default([])
          .describe('Dominio de Odoo en notación de lista, por ejemplo [["customer_rank",">",0]]. Vacío = todos los registros.'),
        campos: z
          .array(z.string())
          .min(1)
          .max(40)
          .describe('Campos a leer, por ejemplo ["name","vat","city"]. Máximo 40.'),
        orden: z.string().optional().describe('Orden, por ejemplo "date desc, id desc".'),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      if (!modelos.includes(args.modelo)) {
        throw new OdooError(
          "modelo_no_permitido",
          `El modelo "${args.modelo}" no está permitido en consulta_avanzada. Modelos permitidos: ${modelos.join(", ")}.`,
        );
      }
      validarDominio(args.dominio);
      const invalido = args.campos.find((c) => !CAMPO.test(c));
      if (invalido) throw new OdooError("parametros", `Nombre de campo no válido: "${invalido}".`);
      if (args.orden && !ORDEN.test(args.orden.trim())) {
        throw new OdooError("parametros", `Orden no válido: "${args.orden}". Ejemplo: "date desc, id desc".`);
      }

      const { cliente } = ctx;
      const context = args.empresa !== undefined ? (await resolverEmpresa(cliente, args.empresa)).context : undefined;
      const limite = limiteEfectivo(ctx.config, args.limite);
      const [registros, total] = await Promise.all([
        cliente.searchRead(args.modelo, args.dominio, args.campos, {
          limit: limite,
          order: args.orden?.trim(),
          context,
        }),
        cliente.searchCount(args.modelo, args.dominio, context),
      ]);
      return {
        herramienta: "consulta_avanzada",
        filtros: { modelo: args.modelo, dominio: args.dominio, campos: args.campos, orden: args.orden, empresa: args.empresa, limite },
        total_registros: total,
        filas: registros.map((r) => aplanarRegistro(r)),
      };
    },
  );
}
