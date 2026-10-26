// Herramienta `facturas`: facturas y notas crédito de cliente o proveedor (account.move).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolverEmpresa } from "../odoo/empresa.js";
import { idDe, nombreDe, numero, redondear, texto } from "../tabular.js";
import {
  esquemaEmpresa,
  esquemaFecha,
  esquemaLimite,
  limiteEfectivo,
  registrarHerramienta,
  validarRango,
  type ContextoHerramienta,
} from "./comun.js";

export const TIPOS_FACTURA = {
  cliente: "out_invoice",
  proveedor: "in_invoice",
  nota_credito_cliente: "out_refund",
  nota_credito_proveedor: "in_refund",
} as const;

export const ESTADOS_DOCUMENTO: Record<string, string> = {
  draft: "Borrador",
  posted: "Publicada",
  cancel: "Cancelada",
};

export const ESTADOS_PAGO: Record<string, string> = {
  not_paid: "Sin pagar",
  partial: "Pago parcial",
  in_payment: "En proceso de pago",
  paid: "Pagada",
  reversed: "Revertida",
  blocked: "Bloqueada",
  invoicing_legacy: "Sistema anterior",
};

const CAMPOS = [
  "name",
  "ref",
  "move_type",
  "state",
  "invoice_date",
  "invoice_date_due",
  "partner_id",
  "currency_id",
  "company_id",
  "amount_untaxed",
  "amount_tax",
  "amount_total",
  "amount_residual",
  "amount_total_signed",
  "amount_residual_signed",
  "payment_state",
];

/** Dominio para buscar un tercero por nombre o NIT. */
export function dominioTercero(campo: string, tercero: string): unknown[] {
  return ["|", [`${campo}.name`, "ilike", tercero], [`${campo}.vat`, "ilike", tercero]];
}

export function registrarFacturas(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "facturas",
    {
      titulo: "Facturas de cliente o proveedor",
      descripcion:
        "Lista facturas o notas crédito de Odoo (account.move) con filtros por tipo, rango de fechas de factura, estado, estado de pago y tercero. " +
        "Devuelve una fila por documento con: numero, referencia, tipo, fecha, vencimiento, dias_vencida, tercero_id, tercero_nombre, nit, moneda, " +
        "subtotal, impuestos, total y saldo_pendiente (en la moneda del documento), total_moneda_empresa y saldo_moneda_empresa (en la moneda de la empresa), estado y estado_pago. " +
        "Incluye un resumen con la cantidad y los totales de TODOS los documentos que cumplen el filtro, aunque se devuelvan menos filas. " +
        "Para totales por mes, cliente o vendedor usa ventas_por_periodo; para saldos vencidos usa cartera_por_edades o cuentas_por_pagar.",
      parametros: {
        tipo: z
          .enum(["cliente", "proveedor", "nota_credito_cliente", "nota_credito_proveedor"])
          .default("cliente")
          .describe("cliente = facturas de venta; proveedor = facturas de compra; nota_credito_* = notas crédito."),
        desde: esquemaFecha.optional().describe("Fecha de factura inicial (AAAA-MM-DD), incluida."),
        hasta: esquemaFecha.optional().describe("Fecha de factura final (AAAA-MM-DD), incluida."),
        estado: z
          .enum(["publicada", "borrador", "cancelada", "todas"])
          .default("publicada")
          .describe("Estado del documento. Por defecto solo publicadas (contabilizadas)."),
        estado_pago: z
          .enum(["pendiente", "pagada", "todas"])
          .default("todas")
          .describe("pendiente = sin pagar o con pago parcial; pagada = pagada o en proceso de pago."),
        tercero: z.string().min(2).optional().describe("Nombre o NIT del cliente/proveedor (búsqueda parcial)."),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);

      const dominio: unknown[] = [["move_type", "=", TIPOS_FACTURA[args.tipo]], ...alcance.dominio];
      if (args.estado !== "todas") {
        dominio.push(["state", "=", { publicada: "posted", borrador: "draft", cancelada: "cancel" }[args.estado]]);
      }
      if (args.estado_pago === "pendiente") dominio.push(["payment_state", "in", ["not_paid", "partial"]]);
      if (args.estado_pago === "pagada") dominio.push(["payment_state", "in", ["paid", "in_payment"]]);
      if (args.desde) dominio.push(["invoice_date", ">=", args.desde]);
      if (args.hasta) dominio.push(["invoice_date", "<=", args.hasta]);
      if (args.tercero) dominio.push(...dominioTercero("partner_id", args.tercero));

      const limite = limiteEfectivo(ctx.config, args.limite);
      const [registros, totales] = await Promise.all([
        cliente.searchRead("account.move", dominio, CAMPOS, {
          limit: limite,
          order: "invoice_date desc, name desc, id desc",
          context: alcance.context,
        }),
        cliente.agrupar(
          "account.move",
          dominio,
          [],
          ["amount_untaxed_signed:sum", "amount_tax_signed:sum", "amount_total_signed:sum", "amount_residual_signed:sum"],
          { context: alcance.context },
        ),
      ]);

      // NIT de los terceros (una sola consulta).
      const idsTerceros = [...new Set(registros.map((r) => idDe(r.partner_id)).filter((id): id is number => id !== null))];
      const nits = new Map<number, string | null>();
      if (idsTerceros.length) {
        const terceros = await cliente.read<{ id: number; vat: string | false }>("res.partner", idsTerceros, ["vat"], alcance.context);
        for (const t of terceros) nits.set(t.id, texto(t.vat));
      }

      const hoy = fechaHoy(ctx.config.zonaHoraria);
      const filas = registros.map((r) => {
        const vencimiento = texto(r.invoice_date_due);
        const saldo = numero(r.amount_residual);
        return {
          numero: texto(r.name),
          referencia: texto(r.ref),
          tipo: args.tipo,
          fecha: texto(r.invoice_date),
          vencimiento,
          dias_vencida: vencimiento && saldo > 0 ? Math.max(0, diasEntre(vencimiento, hoy)) : 0,
          tercero_id: idDe(r.partner_id),
          tercero_nombre: nombreDe(r.partner_id),
          nit: nits.get(idDe(r.partner_id) ?? -1) ?? null,
          moneda: nombreDe(r.currency_id),
          subtotal: numero(r.amount_untaxed),
          impuestos: numero(r.amount_tax),
          total: numero(r.amount_total),
          saldo_pendiente: saldo,
          total_moneda_empresa: redondear(Math.abs(numero(r.amount_total_signed))),
          saldo_moneda_empresa: redondear(Math.abs(numero(r.amount_residual_signed))),
          estado: ESTADOS_DOCUMENTO[String(r.state)] ?? String(r.state),
          estado_pago: ESTADOS_PAGO[String(r.payment_state)] ?? texto(r.payment_state),
        };
      });

      const g = totales[0] ?? {};
      const cantidad = numero(g.__count);
      return {
        herramienta: "facturas",
        filtros: { ...args, empresa: alcance.empresa.nombre, limite },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda_empresa: alcance.empresa.moneda,
          documentos: cantidad,
          subtotal_moneda_empresa: redondear(Math.abs(numero(g["amount_untaxed_signed:sum"]))),
          impuestos_moneda_empresa: redondear(Math.abs(numero(g["amount_tax_signed:sum"]))),
          total_moneda_empresa: redondear(Math.abs(numero(g["amount_total_signed:sum"]))),
          saldo_pendiente_moneda_empresa: redondear(Math.abs(numero(g["amount_residual_signed:sum"]))),
        },
        total_registros: cantidad,
        filas,
      };
    },
  );
}

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria indicada. */
export function fechaHoy(zonaHoraria: string, ahora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}

/** Días desde `desde` hasta `hasta` (ambas AAAA-MM-DD). Positivo si `hasta` es posterior. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}
