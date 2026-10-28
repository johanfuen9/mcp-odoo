// Herramientas `cartera_por_edades` (clientes) y `cuentas_por_pagar` (proveedores).
//
// Se calcula sobre los apuntes contables abiertos de las cuentas por cobrar o
// por pagar (account.move.line no conciliados), no sobre las facturas: así
// también entran saldos iniciales, anticipos y pagos sin aplicar.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dominioApuntes, sumarDias } from "../odoo/contabilidad.js";
import { resolverEmpresa } from "../odoo/empresa.js";
import { idDe, nombreDe, numero, redondear, texto } from "../tabular.js";
import {
  esquemaEmpresa,
  esquemaFecha,
  esquemaLimite,
  limiteEfectivo,
  registrarHerramienta,
  type ContextoHerramienta,
} from "./comun.js";
import { diasEntre, dominioTercero, fechaHoy } from "./facturas.js";

export const TRAMOS = ["corriente", "dias_1_30", "dias_31_60", "dias_61_90", "mas_de_90", "sin_vencimiento"] as const;
export type Tramo = (typeof TRAMOS)[number];

/** Dominio de cada tramo sobre date_maturity, relativo a la fecha de referencia. */
export function dominiosTramos(ref: string): Record<Tramo, unknown[]> {
  const menos = (d: number) => sumarDias(ref, -d);
  return {
    corriente: [["date_maturity", ">=", ref]],
    dias_1_30: [["date_maturity", "<", ref], ["date_maturity", ">=", menos(30)]],
    dias_31_60: [["date_maturity", "<", menos(30)], ["date_maturity", ">=", menos(60)]],
    dias_61_90: [["date_maturity", "<", menos(60)], ["date_maturity", ">=", menos(90)]],
    mas_de_90: [["date_maturity", "<", menos(90)]],
    sin_vencimiento: [["date_maturity", "=", false]],
  };
}

export function tramoDe(diasMora: number | null): Tramo {
  if (diasMora === null) return "sin_vencimiento";
  if (diasMora <= 0) return "corriente";
  if (diasMora <= 30) return "dias_1_30";
  if (diasMora <= 60) return "dias_31_60";
  if (diasMora <= 90) return "dias_61_90";
  return "mas_de_90";
}

interface Variante {
  nombre: string;
  titulo: string;
  tipoCuenta: "asset_receivable" | "liability_payable";
  /** +1 cartera (saldo débito), -1 proveedores (saldo crédito). */
  signo: 1 | -1;
  tercero: string;
  descripcion: string;
}

const VARIANTES: Variante[] = [
  {
    nombre: "cartera_por_edades",
    titulo: "Cartera por edades (cuentas por cobrar)",
    tipoCuenta: "asset_receivable",
    signo: 1,
    tercero: "cliente",
    descripcion:
      "Cartera pendiente por cobrar a clientes, agrupada por tramos de mora contra la fecha de vencimiento: corriente (aún no vence), dias_1_30, dias_31_60, dias_61_90, mas_de_90 y sin_vencimiento. ",
  },
  {
    nombre: "cuentas_por_pagar",
    titulo: "Cuentas por pagar por edades (proveedores)",
    tipoCuenta: "liability_payable",
    signo: -1,
    tercero: "proveedor",
    descripcion:
      "Saldos pendientes por pagar a proveedores, agrupados por tramos de mora contra la fecha de vencimiento: corriente (aún no vence), dias_1_30, dias_31_60, dias_61_90, mas_de_90 y sin_vencimiento. ",
  },
];

function registrarVariante(server: McpServer, ctx: ContextoHerramienta, v: Variante): void {
  registrarHerramienta(
    server,
    ctx,
    v.nombre,
    {
      titulo: v.titulo,
      descripcion:
        v.descripcion +
        `Con detalle='tercero' (por defecto) devuelve una fila por ${v.tercero}: tercero_id, tercero_nombre, nit, un valor por tramo, total_vencido y total, ordenado de mayor a menor saldo. ` +
        "Con detalle='documento' devuelve una fila por documento pendiente: documento, tercero, fecha, vencimiento, dias_mora, tramo y saldo. " +
        "Usa los apuntes contables abiertos (incluye anticipos y saldos iniciales); los saldos son los pendientes hoy en la moneda de la empresa. " +
        "El resumen trae el total por tramo y el porcentaje vencido.",
      parametros: {
        fecha_referencia: esquemaFecha
          .optional()
          .describe("Fecha contra la que se cuentan los días de mora (AAAA-MM-DD). Por defecto, hoy."),
        detalle: z.enum(["tercero", "documento"]).default("tercero"),
        tercero: z.string().min(2).optional().describe(`Nombre o NIT del ${v.tercero} (búsqueda parcial).`),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      const { cliente } = ctx;
      const ref = args.fecha_referencia ?? fechaHoy(ctx.config.zonaHoraria);
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const base = dominioApuntes(alcance, [
        ["account_id.account_type", "=", v.tipoCuenta],
        ["reconciled", "=", false],
        ["amount_residual", "!=", 0],
        ["date", "<=", ref],
        ...(args.tercero ? dominioTercero("partner_id", args.tercero) : []),
      ]);
      const tramos = dominiosTramos(ref);
      const limite = limiteEfectivo(ctx.config, args.limite);

      // Totales por tramo (y por tercero si aplica), calculados en Odoo.
      const groupby = args.detalle === "tercero" ? ["partner_id"] : [];
      const resultados = await Promise.all(
        TRAMOS.map((t) =>
          cliente.agrupar("account.move.line", [...base, ...tramos[t]], groupby, ["amount_residual:sum"], {
            context: alcance.context,
          }),
        ),
      );

      const totalTramo = {} as Record<Tramo, number>;
      TRAMOS.forEach((t, i) => {
        totalTramo[t] = v.signo * resultados[i].reduce((s, g) => s + numero(g["amount_residual:sum"]), 0);
      });
      const total = TRAMOS.reduce((s, t) => s + totalTramo[t], 0);
      const vencido = total - totalTramo.corriente - totalTramo.sin_vencimiento;
      const resumen = {
        empresa: alcance.empresa.nombre,
        moneda: alcance.empresa.moneda,
        fecha_referencia: ref,
        ...Object.fromEntries(TRAMOS.map((t) => [t, redondear(totalTramo[t])])),
        total_vencido: redondear(vencido),
        total: redondear(total),
        porcentaje_vencido: total ? redondear((vencido / total) * 100) : 0,
      };

      if (args.detalle === "tercero") {
        const porTercero = new Map<number | null, { nombre: string | null; valores: Record<Tramo, number> }>();
        TRAMOS.forEach((t, i) => {
          for (const g of resultados[i]) {
            const id = idDe(g.partner_id);
            const fila = porTercero.get(id) ?? {
              nombre: nombreDe(g.partner_id),
              valores: Object.fromEntries(TRAMOS.map((x) => [x, 0])) as Record<Tramo, number>,
            };
            fila.valores[t] += v.signo * numero(g["amount_residual:sum"]);
            porTercero.set(id, fila);
          }
        });
        const ids = [...porTercero.keys()].filter((id): id is number => id !== null);
        const nits = new Map<number, string | null>();
        if (ids.length) {
          const terceros = await cliente.read<{ id: number; vat: string | false }>("res.partner", ids, ["vat"], alcance.context);
          for (const t of terceros) nits.set(t.id, texto(t.vat));
        }
        const filas = [...porTercero.entries()]
          .map(([id, { nombre, valores }]) => {
            const tot = TRAMOS.reduce((s, t) => s + valores[t], 0);
            return {
              tercero_id: id,
              tercero_nombre: nombre ?? "(sin tercero)",
              nit: id === null ? null : (nits.get(id) ?? null),
              ...Object.fromEntries(TRAMOS.map((t) => [t, redondear(valores[t])])),
              total_vencido: redondear(tot - valores.corriente - valores.sin_vencimiento),
              total: redondear(tot),
            };
          })
          .filter((f) => Math.abs(f.total) >= 0.005 || Math.abs(f.total_vencido) >= 0.005)
          .sort((a, b) => b.total - a.total);
        return {
          herramienta: v.nombre,
          filtros: { ...args, fecha_referencia: ref, empresa: alcance.empresa.nombre },
          resumen: { ...resumen, terceros: filas.length },
          total_registros: filas.length,
          filas: filas.slice(0, limite),
        };
      }

      const [lineas, cantidad] = await Promise.all([
        cliente.searchRead("account.move.line", base, ["move_id", "partner_id", "date", "date_maturity", "amount_residual"], {
          limit: limite,
          order: "date_maturity asc, id asc",
          context: alcance.context,
        }),
        cliente.searchCount("account.move.line", base, alcance.context),
      ]);
      const filas = lineas.map((l) => {
        const vence = texto(l.date_maturity);
        const dias = vence ? diasEntre(vence, ref) : null;
        return {
          documento: nombreDe(l.move_id),
          tercero_id: idDe(l.partner_id),
          tercero_nombre: nombreDe(l.partner_id),
          fecha: texto(l.date),
          vencimiento: vence,
          dias_mora: dias !== null ? Math.max(0, dias) : null,
          tramo: tramoDe(dias),
          saldo: redondear(v.signo * numero(l.amount_residual)),
        };
      });
      return {
        herramienta: v.nombre,
        filtros: { ...args, fecha_referencia: ref, empresa: alcance.empresa.nombre },
        resumen,
        total_registros: cantidad,
        filas,
      };
    },
  );
}

export function registrarCartera(server: McpServer, ctx: ContextoHerramienta): void {
  for (const v of VARIANTES) registrarVariante(server, ctx, v);
}
