// Herramienta `impuestos`: IVA generado y descontable, y retenciones, por período.
//
// Se basa en los apuntes de impuesto (account.move.line con tax_line_id), que
// es donde Odoo registra cada impuesto calculado en facturas y asientos.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dominioApuntes, leerCuentas } from "../odoo/contabilidad.js";
import { resolverEmpresa } from "../odoo/empresa.js";
import { idDe, nombreDe, numero, redondear } from "../tabular.js";
import { esquemaEmpresa, esquemaFecha, registrarHerramienta, validarRango, type ContextoHerramienta } from "./comun.js";

export type Naturaleza = "generado" | "descontable" | "retencion_practicada" | "retencion_recibida" | "otro";

export const NOMBRE_NATURALEZA: Record<Naturaleza, string> = {
  generado: "Impuesto generado (ventas)",
  descontable: "Impuesto descontable (compras)",
  retencion_practicada: "Retención practicada a terceros (por pagar)",
  retencion_recibida: "Retención que le practicaron (a favor)",
  otro: "Otro",
};

/**
 * Clasifica un impuesto y da el signo que convierte su saldo (débito − crédito)
 * en un valor positivo. En Colombia las retenciones se configuran como impuestos
 * con tasa negativa.
 */
export function naturalezaImpuesto(uso: string, tasa: number): { naturaleza: Naturaleza; signo: 1 | -1 } {
  if (uso === "sale") return tasa >= 0 ? { naturaleza: "generado", signo: -1 } : { naturaleza: "retencion_recibida", signo: 1 };
  if (uso === "purchase") {
    return tasa >= 0 ? { naturaleza: "descontable", signo: 1 } : { naturaleza: "retencion_practicada", signo: -1 };
  }
  return { naturaleza: "otro", signo: -1 };
}

export function registrarImpuestos(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "impuestos",
    {
      titulo: "Impuestos: IVA y retenciones",
      descripcion:
        "Impuestos registrados en Odoo (solo asientos publicados) en un rango de fechas: IVA u otros impuestos generados en ventas, descontables en compras, retenciones practicadas a proveedores (por pagar) y retenciones que le practicaron a la empresa. " +
        "Con agrupar_por='impuesto' devuelve una fila por impuesto con: impuesto, naturaleza, uso, tasa, base y valor (positivo). " +
        "Con agrupar_por='cuenta' devuelve una fila por cuenta contable de impuestos (por ejemplo 2408, 2365, 2367, 2368) con su saldo neto crédito menos débito. " +
        "Con por_mes agrega la columna mes. El resumen trae IVA generado, descontable, saldo a pagar y retenciones.",
      parametros: {
        desde: esquemaFecha.describe("Fecha inicial (AAAA-MM-DD), por ejemplo el inicio del bimestre."),
        hasta: esquemaFecha.describe("Fecha final (AAAA-MM-DD)."),
        agrupar_por: z.enum(["impuesto", "cuenta"]).default("impuesto"),
        por_mes: z.boolean().default(false),
        empresa: esquemaEmpresa,
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const dominio = dominioApuntes(alcance, [
        ["tax_line_id", "!=", false],
        ["date", ">=", args.desde],
        ["date", "<=", args.hasta],
      ]);
      const mesDe = (g: Record<string, unknown>) => {
        const v = g["date:month"];
        return Array.isArray(v) && typeof v[0] === "string" ? v[0].slice(0, 7) : null;
      };

      // Siempre se agrupa por impuesto para el resumen.
      const porImpuesto = await cliente.agrupar(
        "account.move.line",
        dominio,
        args.por_mes && args.agrupar_por === "impuesto" ? ["tax_line_id", "date:month"] : ["tax_line_id"],
        ["balance:sum", "tax_base_amount:sum"],
        { context: alcance.context },
      );
      const idsImpuestos = [...new Set(porImpuesto.map((g) => idDe(g.tax_line_id)).filter((id): id is number => id !== null))];
      const impuestos = new Map<number, { nombre: string; uso: string; tasa: number; tipoCalculo: string; grupo: string | null }>();
      if (idsImpuestos.length) {
        const filas = await cliente.read<{
          id: number;
          name: string;
          type_tax_use: string;
          amount: number;
          amount_type: string;
          tax_group_id: [number, string] | false;
        }>("account.tax", idsImpuestos, ["name", "type_tax_use", "amount", "amount_type", "tax_group_id"], alcance.context);
        for (const t of filas) {
          impuestos.set(t.id, {
            nombre: t.name,
            uso: t.type_tax_use,
            tasa: t.amount,
            tipoCalculo: t.amount_type,
            grupo: nombreDe(t.tax_group_id),
          });
        }
      }

      const totales: Record<Naturaleza, number> = { generado: 0, descontable: 0, retencion_practicada: 0, retencion_recibida: 0, otro: 0 };
      const filasImpuesto = porImpuesto.map((g) => {
        const id = idDe(g.tax_line_id);
        const imp = id !== null ? impuestos.get(id) : undefined;
        const { naturaleza, signo } = naturalezaImpuesto(imp?.uso ?? "", imp?.tasa ?? 0);
        const valor = signo * numero(g["balance:sum"]);
        totales[naturaleza] += valor;
        // La base se deduce del valor y la tasa (evita ambigüedades de signo de tax_base_amount).
        const base =
          imp && imp.tipoCalculo === "percent" && imp.tasa !== 0
            ? valor / (Math.abs(imp.tasa) / 100)
            : Math.abs(numero(g["tax_base_amount:sum"]));
        return {
          ...(args.por_mes ? { mes: mesDe(g) } : {}),
          impuesto: imp?.nombre ?? nombreDe(g.tax_line_id),
          grupo: imp?.grupo ?? null,
          naturaleza: NOMBRE_NATURALEZA[naturaleza],
          uso: imp?.uso === "sale" ? "Ventas" : imp?.uso === "purchase" ? "Compras" : (imp?.uso ?? null),
          tasa: imp?.tasa ?? null,
          base: redondear(base),
          valor: redondear(valor),
        };
      });

      let filas: Record<string, unknown>[] = filasImpuesto;
      if (args.agrupar_por === "cuenta") {
        const porCuenta = await cliente.agrupar(
          "account.move.line",
          dominio,
          args.por_mes ? ["account_id", "date:month"] : ["account_id"],
          ["balance:sum"],
          { context: alcance.context },
        );
        const cuentas = await leerCuentas(
          cliente,
          alcance,
          porCuenta.map((g) => idDe(g.account_id)).filter((id): id is number => id !== null),
        );
        filas = porCuenta.map((g) => {
          const cuenta = cuentas.get(idDe(g.account_id) ?? -1);
          return {
            ...(args.por_mes ? { mes: mesDe(g) } : {}),
            codigo: cuenta?.codigo ?? null,
            nombre: cuenta?.nombre ?? nombreDe(g.account_id),
            saldo_neto: redondear(-numero(g["balance:sum"])),
          };
        });
      }

      filas.sort(
        (a, b) =>
          String(a.mes ?? "").localeCompare(String(b.mes ?? "")) ||
          String(a.naturaleza ?? a.codigo ?? "").localeCompare(String(b.naturaleza ?? b.codigo ?? ""), "es", { numeric: true }),
      );

      return {
        herramienta: "impuestos",
        filtros: { ...args, empresa: alcance.empresa.nombre },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          impuesto_generado: redondear(totales.generado),
          impuesto_descontable: redondear(totales.descontable),
          saldo_a_pagar: redondear(totales.generado - totales.descontable),
          retenciones_practicadas_por_pagar: redondear(totales.retencion_practicada),
          retenciones_que_le_practicaron: redondear(totales.retencion_recibida),
          otros: redondear(totales.otro),
        },
        filas,
      };
    },
  );
}

