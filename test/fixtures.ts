// Datos de ejemplo con la forma que devuelve Odoo 19 (many2one = [id, "nombre"]).

import type { Datos, Registro } from "./mockOdoo.js";

const COP: [number, string] = [8, "COP"];
const EMPRESA_1: [number, string] = [1, "Comercializadora Andina SAS"];
const EMPRESA_2: [number, string] = [2, "Servicios del Caribe SAS"];

export const empresas: Registro[] = [
  { id: 1, name: "Comercializadora Andina SAS", vat: "900123456-7", currency_id: COP, parent_id: false, sequence: 1 },
];

export const empresasMulti: Registro[] = [
  ...empresas,
  { id: 2, name: "Servicios del Caribe SAS", vat: "901555222-1", currency_id: COP, parent_id: false, sequence: 2 },
  { id: 3, name: "Andina Sucursal Medellín", vat: "900123456-7", currency_id: COP, parent_id: [1, "Comercializadora Andina SAS"], sequence: 3 },
];

export const terceros: Registro[] = [
  { id: 10, name: "Distribuidora El Sol SAS", vat: "800111222-3" },
  { id: 11, name: "Ferretería La Esquina", vat: "71234567" },
  { id: 12, name: "Papelería Central Ltda", vat: "860999888-1" },
];

function factura(
  id: number,
  name: string,
  move_type: string,
  partner: [number, string],
  fecha: string,
  vence: string,
  subtotal: number,
  pagado: number,
  extra: Partial<Registro> = {},
): Registro {
  const iva = Math.round(subtotal * 0.19);
  const total = subtotal + iva;
  const saldo = total - pagado;
  const signo = move_type === "out_invoice" || move_type === "in_refund" ? 1 : -1;
  return {
    id,
    name,
    ref: move_type.startsWith("in_") ? `FV-${id}` : false,
    move_type,
    state: "posted",
    invoice_date: fecha,
    invoice_date_due: vence,
    partner_id: partner,
    currency_id: COP,
    company_id: EMPRESA_1,
    amount_untaxed: subtotal,
    amount_tax: iva,
    amount_total: total,
    amount_residual: saldo,
    amount_untaxed_signed: signo * subtotal,
    amount_tax_signed: signo * iva,
    amount_total_signed: signo * total,
    amount_residual_signed: signo * saldo,
    payment_state: saldo === 0 ? "paid" : pagado > 0 ? "partial" : "not_paid",
    ...extra,
  };
}

const SOL: [number, string] = [10, "Distribuidora El Sol SAS"];
const ESQUINA: [number, string] = [11, "Ferretería La Esquina"];
const PAPELERIA: [number, string] = [12, "Papelería Central Ltda"];

export const facturas: Registro[] = [
  factura(100, "FEV-0001", "out_invoice", SOL, "2026-01-15", "2026-02-14", 1_000_000, 1_190_000),
  factura(101, "FEV-0002", "out_invoice", ESQUINA, "2026-02-03", "2026-03-05", 2_500_000, 1_000_000),
  factura(102, "FEV-0003", "out_invoice", SOL, "2026-03-20", "2026-04-19", 800_000, 0),
  factura(103, "FEV-0004", "out_invoice", ESQUINA, "2026-09-01", "2026-10-01", 400_000, 0, { state: "draft", name: "/" }),
  factura(104, "NC-0001", "out_refund", SOL, "2026-02-10", "2026-02-10", 100_000, 0),
  factura(200, "FACT/2026/0001", "in_invoice", PAPELERIA, "2026-01-20", "2026-02-19", 300_000, 0),
  factura(300, "FEV-C-0001", "out_invoice", SOL, "2026-02-01", "2026-03-01", 5_000_000, 0, { company_id: EMPRESA_2 }),
];

export function datosBase(multiempresa = false): Datos {
  return {
    "res.company": multiempresa ? empresasMulti : empresas,
    "res.partner": terceros,
    "account.move": facturas,
  };
}
