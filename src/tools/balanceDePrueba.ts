// Herramienta `balance_de_prueba`: saldos por cuenta entre dos fechas.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cierreFiscal,
  dominioApuntes,
  etiquetaTipo,
  inicioEjercicio,
  leerCuentas,
  nombresDeNivel,
  prefijoNivel,
  sumasPorCuenta,
  type SumasCuenta,
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

const CODIGO_RESULTADOS_ANTERIORES = "RESULTADOS-ANTERIORES";

export function registrarBalanceDePrueba(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "balance_de_prueba",
    {
      titulo: "Balance de prueba",
      descripcion:
        "Balance de prueba (balance de comprobación) de Odoo entre dos fechas, solo con asientos publicados. " +
        "Devuelve una fila por cuenta (o por clase, grupo, cuenta o subcuenta del PUC según 'nivel') con: codigo, nombre, tipo, saldo_inicial, debito, credito y saldo_final. " +
        "Saldos como débito menos crédito (positivo = saldo débito, negativo = saldo crédito). " +
        "El saldo inicial de las cuentas de resultados (4, 5, 6, 7) arranca en cero al inicio del ejercicio fiscal; si hay resultados de ejercicios anteriores sin asiento de cierre, aparecen en una fila calculada. " +
        "Incluye un resumen que confirma si débitos y créditos cuadran.",
      parametros: {
        desde: esquemaFecha.describe("Fecha inicial del período (AAAA-MM-DD)."),
        hasta: esquemaFecha.describe("Fecha final del período (AAAA-MM-DD)."),
        nivel: esquemaNivel.default("auxiliar"),
        cuenta: z
          .string()
          .regex(/^[0-9A-Za-z.]+$/)
          .optional()
          .describe("Filtra por código de cuenta que empiece así, por ejemplo 11 (disponible) o 1305 (clientes)."),
        incluir_sin_movimiento: z
          .boolean()
          .default(false)
          .describe("Incluir cuentas con saldo inicial, movimientos y saldo final en cero."),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const cierre = await cierreFiscal(cliente, alcance);
      const inicioEj = inicioEjercicio(args.desde, cierre.mes, cierre.dia);
      const filtroCuenta = args.cuenta ? [["account_id.code", "=like", `${args.cuenta}%`]] : [];

      const [antes, ejercicioAntes, periodo] = await Promise.all([
        sumasPorCuenta(cliente, alcance, dominioApuntes(alcance, [["date", "<", args.desde], ...filtroCuenta])),
        inicioEj < args.desde
          ? sumasPorCuenta(
              cliente,
              alcance,
              dominioApuntes(alcance, [["date", ">=", inicioEj], ["date", "<", args.desde], ...filtroCuenta]),
            )
          : Promise.resolve([]),
        sumasPorCuenta(
          cliente,
          alcance,
          dominioApuntes(alcance, [["date", ">=", args.desde], ["date", "<=", args.hasta], ...filtroCuenta]),
        ),
      ]);

      const aMapa = (lista: { cuentaId: number; sumas: SumasCuenta }[]) => new Map(lista.map((x) => [x.cuentaId, x.sumas]));
      const mAntes = aMapa(antes);
      const mEjercicio = aMapa(ejercicioAntes);
      const mPeriodo = aMapa(periodo);
      const cuentas = await leerCuentas(cliente, alcance, [...mAntes.keys(), ...mPeriodo.keys()]);

      interface Acum {
        codigo: string;
        nombre: string | null;
        tipo: string;
        saldo_inicial: number;
        debito: number;
        credito: number;
        saldo_final: number;
      }
      const filas = new Map<string, Acum>();
      let resultadosAnteriores = 0;

      for (const cuenta of cuentas.values()) {
        const previo = mAntes.get(cuenta.id)?.saldo ?? 0;
        const delEjercicio = mEjercicio.get(cuenta.id)?.saldo ?? 0;
        const inicial = cuenta.arrastraSaldo ? previo : delEjercicio;
        if (!cuenta.arrastraSaldo) resultadosAnteriores += previo - delEjercicio;
        const mov = mPeriodo.get(cuenta.id) ?? { debito: 0, credito: 0, saldo: 0 };
        const clave = prefijoNivel(cuenta.codigo, args.nivel);
        const fila = filas.get(clave) ?? {
          codigo: clave,
          nombre: args.nivel === "auxiliar" ? cuenta.nombre : null,
          tipo: args.nivel === "auxiliar" ? etiquetaTipo(cuenta.tipo) : "",
          saldo_inicial: 0,
          debito: 0,
          credito: 0,
          saldo_final: 0,
        };
        fila.saldo_inicial += inicial;
        fila.debito += mov.debito;
        fila.credito += mov.credito;
        fila.saldo_final += inicial + mov.saldo;
        filas.set(clave, fila);
      }

      if (args.nivel !== "auxiliar") {
        const nombres = await nombresDeNivel(cliente, alcance, [...filas.keys()], cuentas);
        for (const f of filas.values()) f.nombre = nombres.get(f.codigo) ?? null;
      }

      let lista = [...filas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, "es", { numeric: true }));
      if (Math.abs(resultadosAnteriores) >= 0.005) {
        lista.push({
          codigo: CODIGO_RESULTADOS_ANTERIORES,
          nombre: "Resultados de ejercicios anteriores sin asiento de cierre (calculado)",
          tipo: "Patrimonio",
          saldo_inicial: resultadosAnteriores,
          debito: 0,
          credito: 0,
          saldo_final: resultadosAnteriores,
        });
      }
      if (!args.incluir_sin_movimiento) {
        lista = lista.filter((f) => [f.saldo_inicial, f.debito, f.credito, f.saldo_final].some((v) => Math.abs(v) >= 0.005));
      }

      const totalDebito = lista.reduce((s, f) => s + f.debito, 0);
      const totalCredito = lista.reduce((s, f) => s + f.credito, 0);
      const limite = limiteEfectivo(ctx.config, args.limite);
      const redondeadas = lista.map((f) => ({
        codigo: f.codigo,
        nombre: f.nombre,
        tipo: f.tipo,
        saldo_inicial: redondear(f.saldo_inicial),
        debito: redondear(f.debito),
        credito: redondear(f.credito),
        saldo_final: redondear(f.saldo_final),
      }));

      return {
        herramienta: "balance_de_prueba",
        filtros: { ...args, empresa: alcance.empresa.nombre, inicio_ejercicio: inicioEj },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          cuentas: lista.length,
          total_debito: redondear(totalDebito),
          total_credito: redondear(totalCredito),
          cuadra: Math.abs(totalDebito - totalCredito) < 1,
          suma_saldos_iniciales: redondear(lista.reduce((s, f) => s + f.saldo_inicial, 0)),
          suma_saldos_finales: redondear(lista.reduce((s, f) => s + f.saldo_final, 0)),
        },
        total_registros: redondeadas.length,
        filas: redondeadas.slice(0, limite),
      };
    },
  );
}
