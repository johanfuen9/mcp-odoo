// Herramienta `gastos_por_cuenta`: gastos agrupados por cuenta y por mes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  dominioApuntes,
  leerCuentas,
  nombresDeNivel,
  prefijoNivel,
  sumasPorCuenta,
  TIPOS_GASTO,
} from "../odoo/contabilidad.js";
import { resolverEmpresa } from "../odoo/empresa.js";
import { redondear } from "../tabular.js";
import {
  esquemaEmpresa,
  esquemaFecha,
  esquemaLimite,
  esquemaNivel,
  limiteEfectivo,
  registrarHerramienta,
  validarRango,
  type ContextoHerramienta,
} from "./comun.js";

const CRITERIOS = {
  puc_clase_5: [["account_id.code", "=like", "5%"]],
  tipo_gasto: [["account_id.account_type", "in", TIPOS_GASTO]],
  gastos_y_costos: [["account_id.account_type", "in", [...TIPOS_GASTO, "expense_direct_cost"]]],
} as const;

export function registrarGastosPorCuenta(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "gastos_por_cuenta",
    {
      titulo: "Gastos por cuenta",
      descripcion:
        "Gastos contabilizados en Odoo (solo asientos publicados) en un rango de fechas, agrupados por cuenta y, por defecto, por mes. " +
        "Por defecto toma las cuentas de la clase 5 del PUC; si la empresa no usa el PUC, toma las cuentas de tipo gasto de Odoo. " +
        "Devuelve filas con: mes (AAAA-MM, si por_mes), codigo, nombre y valor (débito menos crédito, positivo = gasto). " +
        "El resumen trae el total y el total por mes. Ideal para gráficos de evolución y composición del gasto.",
      parametros: {
        desde: esquemaFecha.describe("Fecha inicial (AAAA-MM-DD)."),
        hasta: esquemaFecha.describe("Fecha final (AAAA-MM-DD)."),
        nivel: esquemaNivel.default("cuenta"),
        por_mes: z.boolean().default(true),
        criterio: z
          .enum(["puc_clase_5", "tipo_gasto", "gastos_y_costos"])
          .default("puc_clase_5")
          .describe(
            "puc_clase_5 = cuentas que empiezan por 5; tipo_gasto = cuentas con tipo de gasto en Odoo; gastos_y_costos = además el costo de ventas.",
          ),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const fechas = [["date", ">=", args.desde], ["date", "<=", args.hasta]];
      const avisos: string[] = [];

      let criterio: keyof typeof CRITERIOS = args.criterio;
      let grupos = await sumasPorCuenta(
        cliente,
        alcance,
        dominioApuntes(alcance, [...fechas, ...CRITERIOS[criterio]]),
        args.por_mes,
      );
      if (grupos.length === 0 && criterio === "puc_clase_5") {
        criterio = "tipo_gasto";
        grupos = await sumasPorCuenta(cliente, alcance, dominioApuntes(alcance, [...fechas, ...CRITERIOS[criterio]]), args.por_mes);
        if (grupos.length) avisos.push("No hay cuentas de la clase 5 con movimiento; se usaron las cuentas de tipo gasto de Odoo.");
      }

      const cuentas = await leerCuentas(cliente, alcance, grupos.map((g) => g.cuentaId));
      const acumulado = new Map<string, { mes: string | null; codigo: string; valor: number }>();
      for (const g of grupos) {
        const cuenta = cuentas.get(g.cuentaId);
        if (!cuenta) continue;
        const codigo = prefijoNivel(cuenta.codigo, args.nivel);
        const clave = `${g.mes ?? ""}|${codigo}`;
        const fila = acumulado.get(clave) ?? { mes: g.mes, codigo, valor: 0 };
        fila.valor += g.sumas.saldo;
        acumulado.set(clave, fila);
      }
      const nombres =
        args.nivel === "auxiliar"
          ? new Map([...cuentas.values()].map((c) => [c.codigo, c.nombre]))
          : await nombresDeNivel(cliente, alcance, [...new Set([...acumulado.values()].map((f) => f.codigo))], cuentas);

      const filas = [...acumulado.values()]
        .filter((f) => Math.abs(f.valor) >= 0.005)
        .sort((a, b) => (a.mes ?? "").localeCompare(b.mes ?? "") || b.valor - a.valor)
        .map((f) => ({
          ...(args.por_mes ? { mes: f.mes } : {}),
          codigo: f.codigo,
          nombre: nombres.get(f.codigo) ?? null,
          valor: redondear(f.valor),
        }));

      const porMes = new Map<string, number>();
      for (const f of acumulado.values()) if (f.mes) porMes.set(f.mes, (porMes.get(f.mes) ?? 0) + f.valor);
      const limite = limiteEfectivo(ctx.config, args.limite);

      return {
        herramienta: "gastos_por_cuenta",
        filtros: { ...args, criterio, empresa: alcance.empresa.nombre },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          total: redondear([...acumulado.values()].reduce((s, f) => s + f.valor, 0)),
          ...(args.por_mes
            ? { por_mes: [...porMes.entries()].sort().map(([mes, valor]) => ({ mes, valor: redondear(valor) })) }
            : {}),
        },
        total_registros: filas.length,
        avisos,
        filas: filas.slice(0, limite),
      };
    },
  );
}
