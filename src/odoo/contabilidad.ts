// Utilidades contables compartidas: ejercicio fiscal, saldos por cuenta y
// agrupación por niveles del PUC colombiano.
//
// Notas de Odoo 19 verificadas en el código fuente:
// - account.move.line.balance = débito - crédito (almacenado, agregable).
// - account.move.line.account_type es un related NO almacenado: sirve para
//   filtrar, no para agrupar. Se agrupa por account_id.
// - account.account.code depende de la empresa (code_store company_dependent):
//   se lee con allowed_company_ids de la empresa consultada.
// - account.account.include_initial_balance indica si la cuenta arrastra saldo
//   (balance) o se reinicia cada ejercicio (resultados).

import type { OdooClient } from "./client.js";
import type { AlcanceEmpresa } from "./empresa.js";
import { idDe, numero } from "../tabular.js";

export type Nivel = "clase" | "grupo" | "cuenta" | "subcuenta" | "auxiliar";

export const DIGITOS_NIVEL: Record<Nivel, number | null> = {
  clase: 1,
  grupo: 2,
  cuenta: 4,
  subcuenta: 6,
  auxiliar: null,
};

/** Clases y grupos del PUC (Decreto 2650 de 1993), para nombrar niveles agregados. */
export const PUC: Record<string, string> = {
  "1": "Activo",
  "2": "Pasivo",
  "3": "Patrimonio",
  "4": "Ingresos",
  "5": "Gastos",
  "6": "Costos de ventas",
  "7": "Costos de producción o de operación",
  "8": "Cuentas de orden deudoras",
  "9": "Cuentas de orden acreedoras",
  "11": "Disponible (efectivo y equivalentes)",
  "12": "Inversiones",
  "13": "Deudores",
  "14": "Inventarios",
  "15": "Propiedades, planta y equipo",
  "16": "Intangibles",
  "17": "Diferidos",
  "18": "Otros activos",
  "19": "Valorizaciones",
  "21": "Obligaciones financieras",
  "22": "Proveedores",
  "23": "Cuentas por pagar",
  "24": "Impuestos, gravámenes y tasas",
  "25": "Obligaciones laborales",
  "26": "Pasivos estimados y provisiones",
  "27": "Diferidos",
  "28": "Otros pasivos",
  "29": "Bonos y papeles comerciales",
  "31": "Capital social",
  "32": "Superávit de capital",
  "33": "Reservas",
  "34": "Revalorización del patrimonio",
  "35": "Dividendos o participaciones decretados en acciones o cuotas",
  "36": "Resultados del ejercicio",
  "37": "Resultados de ejercicios anteriores",
  "38": "Superávit por valorizaciones",
  "41": "Ingresos operacionales",
  "42": "Ingresos no operacionales",
  "47": "Ajustes por inflación",
  "51": "Gastos operacionales de administración",
  "52": "Gastos operacionales de ventas",
  "53": "Gastos no operacionales",
  "54": "Impuesto de renta y complementarios",
  "59": "Ganancias y pérdidas",
  "61": "Costo de ventas y de prestación de servicios",
  "62": "Compras",
  "71": "Materia prima",
  "72": "Mano de obra directa",
  "73": "Costos indirectos",
  "74": "Contratos de servicios",
  "81": "Derechos contingentes",
  "82": "Deudoras fiscales",
  "83": "Deudoras de control",
  "84": "Derechos contingentes por contra",
  "86": "Deudoras fiscales por contra",
  "87": "Deudoras de control por contra",
  "91": "Responsabilidades contingentes",
  "92": "Acreedoras fiscales",
  "93": "Acreedoras de control",
  "94": "Responsabilidades contingentes por contra",
  "95": "Acreedoras fiscales por contra",
  "96": "Acreedoras de control por contra",
};

/** Tipos de cuenta de Odoo 19 (account.account.account_type) con su nombre en español. */
export const TIPOS_CUENTA: Record<string, string> = {
  asset_receivable: "Cuentas por cobrar",
  asset_cash: "Bancos y caja",
  asset_current: "Activo corriente",
  asset_non_current: "Activo no corriente",
  asset_prepayments: "Gastos pagados por anticipado",
  asset_fixed: "Activos fijos",
  liability_payable: "Cuentas por pagar",
  liability_credit_card: "Tarjetas de crédito",
  liability_current: "Pasivo corriente",
  liability_non_current: "Pasivo no corriente",
  equity: "Patrimonio",
  equity_unaffected: "Resultados del ejercicio",
  income: "Ingresos",
  income_other: "Otros ingresos",
  expense: "Gastos",
  expense_other: "Otros gastos",
  expense_depreciation: "Depreciaciones",
  expense_direct_cost: "Costo de ventas",
  off_balance: "Cuentas de orden",
};

export const TIPOS_RESULTADO = ["income", "income_other", "expense", "expense_other", "expense_depreciation", "expense_direct_cost"];
export const TIPOS_GASTO = ["expense", "expense_other", "expense_depreciation"];

export interface CuentaContable {
  id: number;
  codigo: string;
  nombre: string;
  tipo: string;
  /** true = cuenta de balance (arrastra saldo); false = de resultados (se reinicia cada ejercicio). */
  arrastraSaldo: boolean;
}

// ── Fechas ──────────────────────────────────────────────────────────────────

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaValida(anio: number, mes: number, dia: number): string {
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(dia, ultimo)).padStart(2, "0")}`;
}

/** Primer día del ejercicio fiscal que contiene `fecha`, según el cierre de la empresa. */
export function inicioEjercicio(fecha: string, ultimoMes = 12, ultimoDia = 31): string {
  const anio = Number(fecha.slice(0, 4));
  const cierreEsteAnio = fechaValida(anio, ultimoMes, ultimoDia);
  const cierreAnterior = fecha <= cierreEsteAnio ? fechaValida(anio - 1, ultimoMes, ultimoDia) : cierreEsteAnio;
  return sumarDias(cierreAnterior, 1);
}

export async function cierreFiscal(cliente: OdooClient, alcance: AlcanceEmpresa): Promise<{ mes: number; dia: number }> {
  try {
    const [c] = await cliente.read<{ fiscalyear_last_month: string; fiscalyear_last_day: number }>(
      "res.company",
      [alcance.empresa.id],
      ["fiscalyear_last_month", "fiscalyear_last_day"],
      alcance.context,
    );
    return { mes: Number(c?.fiscalyear_last_month) || 12, dia: Number(c?.fiscalyear_last_day) || 31 };
  } catch {
    return { mes: 12, dia: 31 };
  }
}

// ── Saldos ──────────────────────────────────────────────────────────────────

/** Dominio base: apuntes contables publicados de la empresa. */
export function dominioApuntes(alcance: AlcanceEmpresa, extra: unknown[] = []): unknown[] {
  return [["parent_state", "=", "posted"], ...alcance.dominio, ...extra];
}

export interface SumasCuenta {
  debito: number;
  credito: number;
  saldo: number;
}

/**
 * Suma débito, crédito y saldo por cuenta (y opcionalmente por mes) en Odoo,
 * sin traer los apuntes individuales.
 */
export async function sumasPorCuenta(
  cliente: OdooClient,
  alcance: AlcanceEmpresa,
  dominio: unknown[],
  porMes = false,
): Promise<{ cuentaId: number; mes: string | null; sumas: SumasCuenta }[]> {
  const groupby = porMes ? ["account_id", "date:month"] : ["account_id"];
  const grupos = await cliente.agrupar("account.move.line", dominio, groupby, ["debit:sum", "credit:sum", "balance:sum"], {
    context: alcance.context,
  });
  const salida: { cuentaId: number; mes: string | null; sumas: SumasCuenta }[] = [];
  for (const g of grupos) {
    const cuentaId = idDe(g.account_id);
    if (cuentaId === null) continue;
    const mesCrudo = g["date:month"];
    const mes = Array.isArray(mesCrudo) && typeof mesCrudo[0] === "string" ? mesCrudo[0].slice(0, 7) : null;
    salida.push({
      cuentaId,
      mes,
      sumas: { debito: numero(g["debit:sum"]), credito: numero(g["credit:sum"]), saldo: numero(g["balance:sum"]) },
    });
  }
  return salida;
}

export async function leerCuentas(
  cliente: OdooClient,
  alcance: AlcanceEmpresa,
  ids: number[],
): Promise<Map<number, CuentaContable>> {
  const unicos = [...new Set(ids)];
  const mapa = new Map<number, CuentaContable>();
  if (!unicos.length) return mapa;
  const filas = await cliente.read<{
    id: number;
    code: string | false;
    name: string;
    account_type: string;
    include_initial_balance: boolean;
  }>("account.account", unicos, ["code", "name", "account_type", "include_initial_balance"], alcance.context);
  for (const f of filas) {
    mapa.set(f.id, {
      id: f.id,
      codigo: f.code || "",
      nombre: f.name,
      tipo: f.account_type,
      arrastraSaldo: !!f.include_initial_balance,
    });
  }
  return mapa;
}

// ── Niveles del PUC ─────────────────────────────────────────────────────────

export function prefijoNivel(codigo: string, nivel: Nivel): string {
  const n = DIGITOS_NIVEL[nivel];
  return n === null || codigo.length <= n ? codigo : codigo.slice(0, n);
}

/**
 * Nombres para códigos agregados: primero los grupos de cuentas de Odoo
 * (account.group), luego el PUC y por último una cuenta con ese código exacto.
 */
export async function nombresDeNivel(
  cliente: OdooClient,
  alcance: AlcanceEmpresa,
  prefijos: string[],
  cuentas: Map<number, CuentaContable>,
): Promise<Map<string, string>> {
  const nombres = new Map<string, string>();
  const porCodigo = new Map([...cuentas.values()].map((c) => [c.codigo, c.nombre]));
  let grupos: { name: string; code_prefix_start: string | false; code_prefix_end: string | false }[] = [];
  try {
    grupos = await cliente.searchRead("account.group", [], ["name", "code_prefix_start", "code_prefix_end"], {
      limit: 2000,
      context: alcance.context,
    });
  } catch {
    // Sin grupos de cuentas: se usa el PUC.
  }
  const deGrupos = new Map<string, string>();
  for (const g of grupos) {
    if (g.code_prefix_start && g.code_prefix_start === g.code_prefix_end) deGrupos.set(g.code_prefix_start, g.name);
  }
  const todas = [...cuentas.values()];
  for (const p of prefijos) {
    let nombre = deGrupos.get(p) ?? PUC[p] ?? porCodigo.get(p);
    if (!nombre) {
      // Sin nombre para el prefijo: si hay una sola cuenta debajo, su nombre;
      // si hay varias, el del grupo del PUC con el código entre paréntesis.
      const debajo = todas.filter((c) => c.codigo.startsWith(p));
      if (debajo.length === 1) nombre = debajo[0].nombre;
      else if (PUC[p.slice(0, 2)]) nombre = `${PUC[p.slice(0, 2)]} (${p})`;
    }
    if (nombre) nombres.set(p, nombre);
  }
  return nombres;
}

export function etiquetaTipo(tipo: string): string {
  return TIPOS_CUENTA[tipo] ?? tipo;
}
