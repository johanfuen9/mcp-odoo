// Herramienta `estado_de_resultados`: ingresos, costos y gastos de un período.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  dominioApuntes,
  leerCuentas,
  nombresDeNivel,
  prefijoNivel,
  sumarDias,
  sumasPorCuenta,
  TIPOS_RESULTADO,
  type CuentaContable,
} from "../odoo/contabilidad.js";
import { resolverEmpresa, type AlcanceEmpresa } from "../odoo/empresa.js";
import type { OdooClient } from "../odoo/client.js";
import { OdooError } from "../odoo/errors.js";
import { redondear } from "../tabular.js";
import {
  esquemaEmpresa,
  esquemaFecha,
  esquemaNivel,
  registrarHerramienta,
  validarRango,
  variacion,
  type ContextoHerramienta,
} from "./comun.js";
import { diasEntre } from "./facturas.js";

/** Secciones en el orden en que se presentan. `signo` convierte el saldo (débito − crédito) en valor positivo. */
export const SECCIONES = [
  { clave: "ingresos", nombre: "Ingresos operacionales", signo: -1 },
  { clave: "costo_ventas", nombre: "Costo de ventas", signo: 1 },
  { clave: "gastos", nombre: "Gastos operacionales", signo: 1 },
  { clave: "depreciaciones", nombre: "Depreciaciones y amortizaciones", signo: 1 },
  { clave: "otros_ingresos", nombre: "Otros ingresos", signo: -1 },
  { clave: "otros_gastos", nombre: "Otros gastos", signo: 1 },
  { clave: "impuesto_renta", nombre: "Impuesto de renta", signo: 1 },
] as const;

type ClaveSeccion = (typeof SECCIONES)[number]["clave"];

export function seccionDe(cuenta: CuentaContable): ClaveSeccion | null {
  // En el PUC, el grupo 54 es el impuesto de renta aunque Odoo lo tipifique como gasto.
  if (cuenta.codigo.startsWith("54") && cuenta.tipo.startsWith("expense")) return "impuesto_renta";
  switch (cuenta.tipo) {
    case "income":
      return "ingresos";
    case "income_other":
      return "otros_ingresos";
    case "expense_direct_cost":
      return "costo_ventas";
    case "expense":
      return "gastos";
    case "expense_depreciation":
      return "depreciaciones";
    case "expense_other":
      return "otros_gastos";
    default:
      return null;
  }
}

export type TotalesResultado = Record<ClaveSeccion, number>;

export function indicadores(t: TotalesResultado) {
  const utilidadBruta = t.ingresos - t.costo_ventas;
  const utilidadOperacional = utilidadBruta - t.gastos - t.depreciaciones;
  const antesImpuestos = utilidadOperacional + t.otros_ingresos - t.otros_gastos;
  const neta = antesImpuestos - t.impuesto_renta;
  const pct = (v: number) => (t.ingresos ? redondear((v / t.ingresos) * 100) : null);
  return {
    ingresos_operacionales: redondear(t.ingresos),
    costo_ventas: redondear(t.costo_ventas),
    utilidad_bruta: redondear(utilidadBruta),
    gastos_operacionales: redondear(t.gastos + t.depreciaciones),
    utilidad_operacional: redondear(utilidadOperacional),
    otros_ingresos: redondear(t.otros_ingresos),
    otros_gastos: redondear(t.otros_gastos),
    utilidad_antes_de_impuestos: redondear(antesImpuestos),
    impuesto_renta: redondear(t.impuesto_renta),
    utilidad_neta: redondear(neta),
    margen_bruto_pct: pct(utilidadBruta),
    margen_operacional_pct: pct(utilidadOperacional),
    margen_neto_pct: pct(neta),
  };
}

const totalesVacios = (): TotalesResultado => ({
  ingresos: 0,
  costo_ventas: 0,
  gastos: 0,
  depreciaciones: 0,
  otros_ingresos: 0,
  otros_gastos: 0,
  impuesto_renta: 0,
});

interface LineaResultado {
  seccion: ClaveSeccion;
  codigo: string;
  mes: string | null;
  valor: number;
}

async function calcular(
  cliente: OdooClient,
  alcance: AlcanceEmpresa,
  desde: string,
  hasta: string,
  nivel: Parameters<typeof prefijoNivel>[1],
  porMes: boolean,
): Promise<{ lineas: LineaResultado[]; cuentas: Map<number, CuentaContable> }> {
  const grupos = await sumasPorCuenta(
    cliente,
    alcance,
    dominioApuntes(alcance, [["date", ">=", desde], ["date", "<=", hasta], ["account_id.account_type", "in", TIPOS_RESULTADO]]),
    porMes,
  );
  const cuentas = await leerCuentas(cliente, alcance, grupos.map((g) => g.cuentaId));
  const acumulado = new Map<string, LineaResultado>();
  for (const g of grupos) {
    const cuenta = cuentas.get(g.cuentaId);
    if (!cuenta) continue;
    const seccion = seccionDe(cuenta);
    if (!seccion) continue;
    const signo = SECCIONES.find((s) => s.clave === seccion)!.signo;
    const codigo = prefijoNivel(cuenta.codigo, nivel);
    const clave = `${g.mes ?? ""}|${seccion}|${codigo}`;
    const linea = acumulado.get(clave) ?? { seccion, codigo, mes: g.mes, valor: 0 };
    linea.valor += signo * g.sumas.saldo;
    acumulado.set(clave, linea);
  }
  return { lineas: [...acumulado.values()], cuentas };
}

function totalizar(lineas: LineaResultado[]): TotalesResultado {
  const t = totalesVacios();
  for (const l of lineas) t[l.seccion] += l.valor;
  return t;
}

/** Período con el que se compara. */
export function periodoComparativo(desde: string, hasta: string, modo: "periodo_anterior" | "mismo_periodo_ano_anterior") {
  if (modo === "mismo_periodo_ano_anterior") {
    const restarAnio = (f: string) => {
      const anio = Number(f.slice(0, 4)) - 1;
      const resto = f.slice(4);
      // 29 de febrero → 28 de febrero
      return resto === "-02-29" ? `${anio}-02-28` : `${anio}${resto}`;
    };
    return { desde: restarAnio(desde), hasta: restarAnio(hasta) };
  }
  const dias = diasEntre(desde, hasta);
  const hastaAnterior = sumarDias(desde, -1);
  return { desde: sumarDias(hastaAnterior, -dias), hasta: hastaAnterior };
}

export function registrarEstadoDeResultados(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "estado_de_resultados",
    {
      titulo: "Estado de resultados",
      descripcion:
        "Estado de resultados (pérdidas y ganancias) de Odoo para un período, solo con asientos publicados. " +
        "Devuelve filas con: seccion (Ingresos operacionales, Costo de ventas, Gastos operacionales, Depreciaciones y amortizaciones, Otros ingresos, Otros gastos, Impuesto de renta), " +
        "codigo y nombre de la cuenta al nivel del PUC pedido, y valor en positivo. " +
        "Con 'comparar' agrega valor_comparativo, variacion y variacion_pct; con 'por_mes' agrega la columna mes (AAAA-MM) para graficar la evolución. " +
        "El resumen trae utilidad bruta, operacional y neta, y los márgenes en porcentaje.",
      parametros: {
        desde: esquemaFecha.describe("Fecha inicial (AAAA-MM-DD)."),
        hasta: esquemaFecha.describe("Fecha final (AAAA-MM-DD)."),
        nivel: esquemaNivel.default("cuenta"),
        comparar: z
          .enum(["ninguno", "periodo_anterior", "mismo_periodo_ano_anterior"])
          .default("ninguno")
          .describe("Compara contra el período inmediatamente anterior de igual duración o contra el mismo período del año anterior."),
        por_mes: z.boolean().default(false).describe("Desglosa cada fila por mes."),
        empresa: esquemaEmpresa,
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      if (args.por_mes && args.comparar !== "ninguno") {
        throw new OdooError("parametros", "Usa 'por_mes' o 'comparar', no ambos a la vez.");
      }
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const actual = await calcular(cliente, alcance, args.desde, args.hasta, args.nivel, args.por_mes);
      const comp =
        args.comparar !== "ninguno" ? periodoComparativo(args.desde, args.hasta, args.comparar) : null;
      const anterior = comp ? await calcular(cliente, alcance, comp.desde, comp.hasta, args.nivel, false) : null;

      const todasCuentas = new Map([...actual.cuentas, ...(anterior?.cuentas ?? [])]);
      const codigos = [...new Set([...actual.lineas, ...(anterior?.lineas ?? [])].map((l) => l.codigo))];
      const nombres =
        args.nivel === "auxiliar"
          ? new Map([...todasCuentas.values()].map((c) => [c.codigo, c.nombre]))
          : await nombresDeNivel(cliente, alcance, codigos, todasCuentas);

      const orden = (s: ClaveSeccion) => SECCIONES.findIndex((x) => x.clave === s);
      const nombreSeccion = (s: ClaveSeccion) => SECCIONES.find((x) => x.clave === s)!.nombre;
      let filas: Record<string, unknown>[];

      if (anterior) {
        const claves = new Map<string, { seccion: ClaveSeccion; codigo: string }>();
        for (const l of [...actual.lineas, ...anterior.lineas]) claves.set(`${l.seccion}|${l.codigo}`, { seccion: l.seccion, codigo: l.codigo });
        const valor = (lineas: LineaResultado[], k: string) =>
          lineas.filter((l) => `${l.seccion}|${l.codigo}` === k).reduce((s, l) => s + l.valor, 0);
        filas = [...claves.entries()]
          .sort(([, a], [, b]) => orden(a.seccion) - orden(b.seccion) || a.codigo.localeCompare(b.codigo, "es", { numeric: true }))
          .map(([k, { seccion, codigo }]) => {
            const v = valor(actual.lineas, k);
            const va = valor(anterior.lineas, k);
            return {
              seccion: nombreSeccion(seccion),
              codigo,
              nombre: nombres.get(codigo) ?? null,
              valor: redondear(v),
              valor_comparativo: redondear(va),
              ...variacion(v, va),
            };
          });
      } else {
        filas = actual.lineas
          .sort(
            (a, b) =>
              (a.mes ?? "").localeCompare(b.mes ?? "") ||
              orden(a.seccion) - orden(b.seccion) ||
              a.codigo.localeCompare(b.codigo, "es", { numeric: true }),
          )
          .map((l) => ({
            ...(args.por_mes ? { mes: l.mes } : {}),
            seccion: nombreSeccion(l.seccion),
            codigo: l.codigo,
            nombre: nombres.get(l.codigo) ?? null,
            valor: redondear(l.valor),
          }));
      }

      const resumen: Record<string, unknown> = {
        empresa: alcance.empresa.nombre,
        moneda: alcance.empresa.moneda,
        periodo: `${args.desde} a ${args.hasta}`,
        ...indicadores(totalizar(actual.lineas)),
      };
      if (anterior && comp) {
        resumen.comparativo = { periodo: `${comp.desde} a ${comp.hasta}`, ...indicadores(totalizar(anterior.lineas)) };
      }
      if (args.por_mes) {
        const meses = [...new Set(actual.lineas.map((l) => l.mes!))].sort();
        resumen.mensual = meses.map((mes) => {
          const i = indicadores(totalizar(actual.lineas.filter((l) => l.mes === mes)));
          return {
            mes,
            ingresos_operacionales: i.ingresos_operacionales,
            costo_ventas: i.costo_ventas,
            gastos_operacionales: i.gastos_operacionales,
            utilidad_operacional: i.utilidad_operacional,
            utilidad_neta: i.utilidad_neta,
          };
        });
      }

      return {
        herramienta: "estado_de_resultados",
        filtros: { ...args, empresa: alcance.empresa.nombre },
        resumen,
        filas,
      };
    },
  );
}
