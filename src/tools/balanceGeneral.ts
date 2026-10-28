// Herramienta `balance_general`: estado de situación financiera a una fecha de corte.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cierreFiscal,
  dominioApuntes,
  inicioEjercicio,
  leerCuentas,
  nombresDeNivel,
  prefijoNivel,
  sumasPorCuenta,
  type CuentaContable,
  type Nivel,
} from "../odoo/contabilidad.js";
import type { OdooClient } from "../odoo/client.js";
import { resolverEmpresa, type AlcanceEmpresa } from "../odoo/empresa.js";
import { redondear } from "../tabular.js";
import { esquemaEmpresa, esquemaFecha, esquemaNivel, registrarHerramienta, variacion, type ContextoHerramienta } from "./comun.js";
import { fechaHoy } from "./facturas.js";

export const SECCIONES_BALANCE = [
  { clave: "activo_corriente", nombre: "Activo corriente", signo: 1 },
  { clave: "activo_no_corriente", nombre: "Activo no corriente", signo: 1 },
  { clave: "pasivo_corriente", nombre: "Pasivo corriente", signo: -1 },
  { clave: "pasivo_no_corriente", nombre: "Pasivo no corriente", signo: -1 },
  { clave: "patrimonio", nombre: "Patrimonio", signo: -1 },
] as const;

type ClaveSeccion = (typeof SECCIONES_BALANCE)[number]["clave"];

export function seccionBalance(tipo: string): ClaveSeccion | null {
  switch (tipo) {
    case "asset_receivable":
    case "asset_cash":
    case "asset_current":
    case "asset_prepayments":
      return "activo_corriente";
    case "asset_non_current":
    case "asset_fixed":
      return "activo_no_corriente";
    case "liability_payable":
    case "liability_credit_card":
    case "liability_current":
      return "pasivo_corriente";
    case "liability_non_current":
      return "pasivo_no_corriente";
    case "equity":
    case "equity_unaffected":
      return "patrimonio";
    default:
      return null; // resultados y cuentas de orden
  }
}

interface Linea {
  seccion: ClaveSeccion;
  codigo: string;
  nombre: string | null;
  valor: number;
}

async function calcular(
  cliente: OdooClient,
  alcance: AlcanceEmpresa,
  corte: string,
  nivel: Nivel,
  cierre: { mes: number; dia: number },
): Promise<{ lineas: Map<string, Linea>; cuentas: Map<number, CuentaContable>; inicioEj: string }> {
  const inicioEj = inicioEjercicio(corte, cierre.mes, cierre.dia);
  const [todo, anteriores] = await Promise.all([
    sumasPorCuenta(cliente, alcance, dominioApuntes(alcance, [["date", "<=", corte]])),
    sumasPorCuenta(cliente, alcance, dominioApuntes(alcance, [["date", "<", inicioEj]])),
  ]);
  const cuentas = await leerCuentas(cliente, alcance, todo.map((t) => t.cuentaId));
  const mAnteriores = new Map(anteriores.map((a) => [a.cuentaId, a.sumas.saldo]));

  const lineas = new Map<string, Linea>();
  let resultadoEjercicio = 0;
  let resultadosAnteriores = 0;
  for (const { cuentaId, sumas } of todo) {
    const cuenta = cuentas.get(cuentaId);
    if (!cuenta) continue;
    const seccion = seccionBalance(cuenta.tipo);
    if (!seccion) {
      if (cuenta.tipo !== "off_balance") {
        // Cuenta de resultados: su saldo se lleva al patrimonio como utilidad.
        const previo = mAnteriores.get(cuentaId) ?? 0;
        resultadosAnteriores -= previo;
        resultadoEjercicio -= sumas.saldo - previo;
      }
      continue;
    }
    const signo = SECCIONES_BALANCE.find((s) => s.clave === seccion)!.signo;
    const codigo = prefijoNivel(cuenta.codigo, nivel);
    const clave = `${seccion}|${codigo}`;
    const linea = lineas.get(clave) ?? { seccion, codigo, nombre: nivel === "auxiliar" ? cuenta.nombre : null, valor: 0 };
    linea.valor += signo * sumas.saldo;
    lineas.set(clave, linea);
  }
  if (Math.abs(resultadoEjercicio) >= 0.005) {
    lineas.set("patrimonio|RESULTADO-EJERCICIO", {
      seccion: "patrimonio",
      codigo: "RESULTADO-EJERCICIO",
      nombre: "Resultado del ejercicio (calculado)",
      valor: resultadoEjercicio,
    });
  }
  if (Math.abs(resultadosAnteriores) >= 0.005) {
    lineas.set("patrimonio|RESULTADOS-ANTERIORES", {
      seccion: "patrimonio",
      codigo: "RESULTADOS-ANTERIORES",
      nombre: "Resultados de ejercicios anteriores sin asiento de cierre (calculado)",
      valor: resultadosAnteriores,
    });
  }
  return { lineas, cuentas, inicioEj };
}

function totales(lineas: Iterable<Linea>) {
  const t: Record<ClaveSeccion, number> = {
    activo_corriente: 0,
    activo_no_corriente: 0,
    pasivo_corriente: 0,
    pasivo_no_corriente: 0,
    patrimonio: 0,
  };
  for (const l of lineas) t[l.seccion] += l.valor;
  const activo = t.activo_corriente + t.activo_no_corriente;
  const pasivo = t.pasivo_corriente + t.pasivo_no_corriente;
  return {
    activo_corriente: redondear(t.activo_corriente),
    activo_no_corriente: redondear(t.activo_no_corriente),
    total_activo: redondear(activo),
    pasivo_corriente: redondear(t.pasivo_corriente),
    pasivo_no_corriente: redondear(t.pasivo_no_corriente),
    total_pasivo: redondear(pasivo),
    total_patrimonio: redondear(t.patrimonio),
    diferencia: redondear(activo - pasivo - t.patrimonio),
    cuadra: Math.abs(activo - pasivo - t.patrimonio) < 1,
    capital_de_trabajo: redondear(t.activo_corriente - t.pasivo_corriente),
    razon_corriente: t.pasivo_corriente ? redondear(t.activo_corriente / t.pasivo_corriente) : null,
    endeudamiento_pct: activo ? redondear((pasivo / activo) * 100) : null,
  };
}

export function registrarBalanceGeneral(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "balance_general",
    {
      titulo: "Balance general",
      descripcion:
        "Balance general (estado de situación financiera) de Odoo a una fecha de corte, solo con asientos publicados. " +
        "Devuelve filas con: seccion (Activo corriente, Activo no corriente, Pasivo corriente, Pasivo no corriente, Patrimonio), codigo, nombre y saldo en positivo, al nivel del PUC pedido. " +
        "El resultado del ejercicio se calcula a partir de las cuentas de ingresos, costos y gastos y aparece como fila del patrimonio. " +
        "Con 'comparar_con' agrega saldo_comparativo, variacion y variacion_pct. " +
        "El resumen trae totales por sección, si cuadra (activo = pasivo + patrimonio), capital de trabajo, razón corriente y endeudamiento.",
      parametros: {
        fecha_corte: esquemaFecha.optional().describe("Fecha de corte (AAAA-MM-DD). Por defecto, hoy."),
        nivel: esquemaNivel.default("cuenta"),
        comparar_con: esquemaFecha.optional().describe("Otra fecha de corte para comparar, por ejemplo el cierre del año anterior."),
        empresa: esquemaEmpresa,
      },
    },
    async (args) => {
      const { cliente } = ctx;
      const corte = args.fecha_corte ?? fechaHoy(ctx.config.zonaHoraria);
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const cierre = await cierreFiscal(cliente, alcance);
      const actual = await calcular(cliente, alcance, corte, args.nivel, cierre);
      const anterior = args.comparar_con ? await calcular(cliente, alcance, args.comparar_con, args.nivel, cierre) : null;

      const todasCuentas = new Map([...actual.cuentas, ...(anterior?.cuentas ?? [])]);
      if (args.nivel !== "auxiliar") {
        const codigos = [...actual.lineas.values(), ...(anterior?.lineas.values() ?? [])].map((l) => l.codigo);
        const nombres = await nombresDeNivel(cliente, alcance, codigos, todasCuentas);
        for (const l of [...actual.lineas.values(), ...(anterior?.lineas.values() ?? [])]) {
          l.nombre ??= nombres.get(l.codigo) ?? null;
        }
      }

      const claves = [...new Set([...actual.lineas.keys(), ...(anterior?.lineas.keys() ?? [])])];
      const orden = (s: ClaveSeccion) => SECCIONES_BALANCE.findIndex((x) => x.clave === s);
      const filas = claves
        .map((k) => {
          const a = actual.lineas.get(k);
          const b = anterior?.lineas.get(k);
          const base = (a ?? b)!;
          return {
            seccion_clave: base.seccion,
            seccion: SECCIONES_BALANCE.find((s) => s.clave === base.seccion)!.nombre,
            codigo: base.codigo,
            nombre: base.nombre,
            saldo: redondear(a?.valor ?? 0),
            ...(anterior ? { saldo_comparativo: redondear(b?.valor ?? 0), ...variacion(a?.valor ?? 0, b?.valor ?? 0) } : {}),
          };
        })
        .filter((f) => Math.abs(f.saldo) >= 0.005 || ("saldo_comparativo" in f && Math.abs(f.saldo_comparativo as number) >= 0.005))
        .sort(
          (x, y) =>
            orden(x.seccion_clave) - orden(y.seccion_clave) || x.codigo.localeCompare(y.codigo, "es", { numeric: true }),
        )
        .map(({ seccion_clave: _omitir, ...resto }) => resto);

      return {
        herramienta: "balance_general",
        filtros: { ...args, fecha_corte: corte, empresa: alcance.empresa.nombre },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          fecha_corte: corte,
          inicio_ejercicio: actual.inicioEj,
          ...totales(actual.lineas.values()),
          ...(anterior ? { comparativo: { fecha_corte: args.comparar_con, ...totales(anterior.lineas.values()) } } : {}),
        },
        filas,
      };
    },
  );
}

// Exportado para pruebas.
export { totales as totalesBalance };
