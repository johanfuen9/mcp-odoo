// Contabilidad de ejemplo de "Comercializadora Andina SAS" (empresa 1), con
// asientos cuadrados en 2025 y el primer trimestre de 2026. Las cifras
// esperadas de las pruebas están calculadas a mano a partir de estos asientos.

import { datosBase } from "./fixtures.js";
import type { Datos, Registro } from "./mockOdoo.js";

type M2o = [number, string];
const EMPRESA_1: M2o = [1, "Comercializadora Andina SAS"];
const EMPRESA_2: M2o = [2, "Servicios del Caribe SAS"];
const SOL: M2o = [10, "Distribuidora El Sol SAS"];
const ESQUINA: M2o = [11, "Ferretería La Esquina"];
const PAPELERIA: M2o = [12, "Papelería Central Ltda"];

interface Cuenta {
  id: number;
  code: string;
  name: string;
  account_type: string;
}

const CUENTAS: Cuenta[] = [
  { id: 1, code: "111005", name: "Bancos nacionales", account_type: "asset_cash" },
  { id: 2, code: "130505", name: "Clientes nacionales", account_type: "asset_receivable" },
  { id: 3, code: "143505", name: "Mercancías no fabricadas", account_type: "asset_current" },
  { id: 4, code: "152405", name: "Equipo de oficina", account_type: "asset_fixed" },
  { id: 5, code: "159205", name: "Depreciación acumulada equipo de oficina", account_type: "asset_fixed" },
  { id: 6, code: "220505", name: "Proveedores nacionales", account_type: "liability_payable" },
  { id: 7, code: "236540", name: "Retención en la fuente compras", account_type: "liability_current" },
  { id: 8, code: "240805", name: "IVA generado", account_type: "liability_current" },
  { id: 9, code: "240810", name: "IVA descontable", account_type: "liability_current" },
  { id: 10, code: "240405", name: "Impuesto de renta por pagar", account_type: "liability_current" },
  { id: 11, code: "311505", name: "Aportes sociales", account_type: "equity" },
  { id: 12, code: "413505", name: "Comercio al por mayor y al por menor", account_type: "income" },
  { id: 13, code: "421005", name: "Intereses", account_type: "income_other" },
  { id: 14, code: "510506", name: "Sueldos", account_type: "expense" },
  { id: 15, code: "516005", name: "Depreciación equipo de oficina", account_type: "expense_depreciation" },
  { id: 16, code: "530505", name: "Gastos bancarios", account_type: "expense_other" },
  { id: 17, code: "540405", name: "Impuesto de renta y complementarios", account_type: "expense" },
  { id: 18, code: "613505", name: "Costo de ventas comercio", account_type: "expense_direct_cost" },
];

const ARRASTRA = (tipo: string) => !["income", "income_other", "expense", "expense_other", "expense_depreciation", "expense_direct_cost"].includes(tipo);
const porId = new Map(CUENTAS.map((c) => [c.id, c]));
const m2oCuenta = (id: number): M2o => [id, `${porId.get(id)!.code} ${porId.get(id)!.name}`];

const IVA_VENTA: M2o = [1, "IVA 19% ventas"];
const IVA_COMPRA: M2o = [2, "IVA 19% compras"];
const RETEFTE: M2o = [3, "ReteFte 2,5% compras"];

interface Linea {
  cuenta: number;
  debe?: number;
  haber?: number;
  partner?: M2o;
  vence?: string;
  residual?: number;
  conciliada?: boolean;
  impuesto?: M2o;
  base?: number;
}

const lineas: Registro[] = [];
let idLinea = 1000;
function asiento(
  id: number,
  nombre: string,
  fecha: string,
  ls: Linea[],
  opciones: { estado?: string; empresa?: M2o } = {},
) {
  const debe = ls.reduce((s, l) => s + (l.debe ?? 0), 0);
  const haber = ls.reduce((s, l) => s + (l.haber ?? 0), 0);
  if (debe !== haber) throw new Error(`Asiento ${nombre} descuadrado: ${debe} != ${haber}`);
  for (const l of ls) {
    const balance = (l.debe ?? 0) - (l.haber ?? 0);
    lineas.push({
      id: idLinea++,
      move_id: [id, nombre],
      date: fecha,
      parent_state: opciones.estado ?? "posted",
      company_id: opciones.empresa ?? EMPRESA_1,
      account_id: m2oCuenta(l.cuenta),
      partner_id: l.partner ?? false,
      debit: l.debe ?? 0,
      credit: l.haber ?? 0,
      balance,
      amount_residual: l.residual ?? 0,
      reconciled: l.conciliada ?? false,
      date_maturity: l.vence ?? false,
      tax_line_id: l.impuesto ?? false,
      tax_base_amount: l.base ?? 0,
    });
  }
}

// ── 2025 ────────────────────────────────────────────────────────────────────
asiento(1, "APERTURA", "2025-01-01", [{ cuenta: 1, debe: 10_000_000 }, { cuenta: 11, haber: 10_000_000 }]);
asiento(21, "COMPRA-EQUIPO", "2025-03-01", [{ cuenta: 4, debe: 2_000_000 }, { cuenta: 1, haber: 2_000_000 }]);
asiento(2, "FEV-2025-1", "2025-06-15", [
  { cuenta: 2, debe: 1_190_000, partner: SOL, vence: "2025-07-15", conciliada: true },
  { cuenta: 12, haber: 1_000_000, partner: SOL },
  { cuenta: 8, haber: 190_000, partner: SOL, impuesto: IVA_VENTA, base: 1_000_000 },
]);
asiento(3, "RC-2025-1", "2025-06-30", [
  { cuenta: 1, debe: 1_190_000 },
  { cuenta: 2, haber: 1_190_000, partner: SOL, conciliada: true },
]);
asiento(18, "FEV-2025-2", "2025-10-01", [
  { cuenta: 2, debe: 500_000, partner: ESQUINA, vence: "2025-10-31", residual: 500_000 },
  { cuenta: 12, haber: 500_000, partner: ESQUINA },
]);
asiento(4, "NOM-2025-12", "2025-12-15", [{ cuenta: 14, debe: 400_000 }, { cuenta: 1, haber: 400_000 }]);

// ── 2026 (primer trimestre) ─────────────────────────────────────────────────
asiento(100, "FEV-0001", "2026-01-15", [
  { cuenta: 2, debe: 1_190_000, partner: SOL, vence: "2026-02-14", conciliada: true },
  { cuenta: 12, haber: 1_000_000, partner: SOL },
  { cuenta: 8, haber: 190_000, partner: SOL, impuesto: IVA_VENTA, base: 1_000_000 },
]);
asiento(6, "RC-0001", "2026-01-20", [
  { cuenta: 1, debe: 1_190_000 },
  { cuenta: 2, haber: 1_190_000, partner: SOL, conciliada: true },
]);
asiento(200, "FACT/2026/0001", "2026-01-20", [
  { cuenta: 3, debe: 300_000, partner: PAPELERIA },
  { cuenta: 9, debe: 57_000, partner: PAPELERIA, impuesto: IVA_COMPRA, base: 300_000 },
  { cuenta: 7, haber: 7_500, partner: PAPELERIA, impuesto: RETEFTE, base: 300_000 },
  { cuenta: 6, haber: 349_500, partner: PAPELERIA, vence: "2026-02-19", residual: -349_500 },
]);
asiento(101, "FEV-0002", "2026-02-03", [
  { cuenta: 2, debe: 2_975_000, partner: ESQUINA, vence: "2026-03-05", residual: 1_975_000 },
  { cuenta: 12, haber: 2_500_000, partner: ESQUINA },
  { cuenta: 8, haber: 475_000, partner: ESQUINA, impuesto: IVA_VENTA, base: 2_500_000 },
]);
asiento(104, "NC-0001", "2026-02-10", [
  { cuenta: 12, debe: 100_000, partner: SOL },
  { cuenta: 8, debe: 19_000, partner: SOL, impuesto: IVA_VENTA, base: -100_000 },
  { cuenta: 2, haber: 119_000, partner: SOL, vence: "2026-02-10", residual: -119_000 },
]);
asiento(8, "RC-0002", "2026-02-20", [
  { cuenta: 1, debe: 1_000_000 },
  { cuenta: 2, haber: 1_000_000, partner: ESQUINA, conciliada: true },
]);
asiento(11, "NOM-2026-02", "2026-02-28", [{ cuenta: 14, debe: 600_000 }, { cuenta: 1, haber: 600_000 }]);
asiento(13, "COSTO-2026-03", "2026-03-15", [{ cuenta: 18, debe: 200_000 }, { cuenta: 3, haber: 200_000 }]);
asiento(102, "FEV-0003", "2026-03-20", [
  { cuenta: 2, debe: 952_000, partner: SOL, vence: "2026-04-19", residual: 952_000 },
  { cuenta: 12, haber: 800_000, partner: SOL },
  { cuenta: 8, haber: 152_000, partner: SOL, impuesto: IVA_VENTA, base: 800_000 },
]);
asiento(20, "INT-2026-03", "2026-03-25", [{ cuenta: 1, debe: 30_000 }, { cuenta: 13, haber: 30_000 }]);
asiento(12, "DEP-2026-03", "2026-03-31", [{ cuenta: 15, debe: 50_000 }, { cuenta: 5, haber: 50_000 }]);
asiento(14, "BAN-2026-03", "2026-03-31", [{ cuenta: 16, debe: 20_000 }, { cuenta: 1, haber: 20_000 }]);
asiento(19, "RENTA-2026-03", "2026-03-31", [{ cuenta: 17, debe: 100_000 }, { cuenta: 10, haber: 100_000 }]);

// No deben contar: un borrador y un asiento de otra empresa.
asiento(16, "BORRADOR", "2026-03-31", [{ cuenta: 14, debe: 999_999 }, { cuenta: 1, haber: 999_999 }], { estado: "draft" });
asiento(17, "OTRA-EMPRESA", "2026-02-01", [
  { cuenta: 2, debe: 5_000_000, partner: SOL, vence: "2026-03-01", residual: 5_000_000 },
  { cuenta: 12, haber: 5_000_000, partner: SOL },
], { empresa: EMPRESA_2 });

export function datosContables(opciones: { conGruposDeCuentas?: boolean } = {}): Datos {
  const base = datosBase();
  const datos: Datos = {
    ...base,
    "res.company": base["res.company"].map((c) => ({ ...c, fiscalyear_last_month: "12", fiscalyear_last_day: 31 })),
    "account.account": CUENTAS.map((c) => ({ ...c, include_initial_balance: ARRASTRA(c.account_type) })),
    "account.move.line": lineas,
    "account.tax": [
      { id: 1, name: "IVA 19% ventas", type_tax_use: "sale", amount: 19, amount_type: "percent", tax_group_id: [1, "IVA 19%"] },
      { id: 2, name: "IVA 19% compras", type_tax_use: "purchase", amount: 19, amount_type: "percent", tax_group_id: [1, "IVA 19%"] },
      { id: 3, name: "ReteFte 2,5% compras", type_tax_use: "purchase", amount: -2.5, amount_type: "percent", tax_group_id: [2, "Retención en la fuente"] },
    ],
    "account.move": base["account.move"].map((m) => ({
      ...m,
      commercial_partner_id: m.partner_id,
      invoice_user_id: m.partner_id && (m.partner_id as M2o)[0] === 10 ? [2, "Ana Vendedora"] : false,
    })),
    "stock.location": [
      { id: 8, name: "Stock", complete_name: "WH/Stock", usage: "internal" },
      { id: 9, name: "Customers", complete_name: "Partners/Customers", usage: "customer" },
      { id: 10, name: "Bodega 2", complete_name: "WH2/Stock", usage: "internal" },
    ],
    "product.product": [
      { id: 50, name: "Cuaderno argollado", default_code: "CUA-01", categ_id: [1, "Papelería"], uom_id: [1, "Unidades"], standard_price: 2_000 },
      { id: 51, name: "Lapicero negro", default_code: "LAP-02", categ_id: [1, "Papelería"], uom_id: [1, "Unidades"], standard_price: 1_000 },
      { id: 52, name: "Resma carta", default_code: "RES-03", categ_id: [2, "Insumos"], uom_id: [1, "Unidades"], standard_price: 15_000 },
    ],
    "stock.quant": [
      { id: 1, product_id: [50, "[CUA-01] Cuaderno argollado"], location_id: [8, "WH/Stock"], quantity: 30, reserved_quantity: 5, value: 66_000, company_id: EMPRESA_1 },
      { id: 2, product_id: [50, "[CUA-01] Cuaderno argollado"], location_id: [9, "Partners/Customers"], quantity: 10, reserved_quantity: 0, value: 22_000, company_id: EMPRESA_1 },
      { id: 3, product_id: [51, "[LAP-02] Lapicero negro"], location_id: [8, "WH/Stock"], quantity: 40, reserved_quantity: 0, value: 40_000, company_id: EMPRESA_1 },
      { id: 4, product_id: [50, "[CUA-01] Cuaderno argollado"], location_id: [10, "WH2/Stock"], quantity: 10, reserved_quantity: 0, value: 22_000, company_id: EMPRESA_1 },
      { id: 5, product_id: [52, "[RES-03] Resma carta"], location_id: [8, "WH/Stock"], quantity: 4, reserved_quantity: 0, value: 60_000, company_id: EMPRESA_1 },
      { id: 6, product_id: [51, "[LAP-02] Lapicero negro"], location_id: [8, "WH/Stock"], quantity: 99, reserved_quantity: 0, value: 99_000, company_id: EMPRESA_2 },
    ],
  };
  if (opciones.conGruposDeCuentas) {
    datos["account.group"] = [
      { id: 1, name: "Bancos", code_prefix_start: "1110", code_prefix_end: "1110" },
      { id: 2, name: "Gastos de personal", code_prefix_start: "5105", code_prefix_end: "5105" },
    ];
  }
  return datos;
}
