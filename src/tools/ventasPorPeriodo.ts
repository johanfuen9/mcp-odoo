// Herramienta `ventas_por_periodo`: ventas facturadas agrupadas en Odoo.

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

const CAMPO_GRUPO = {
  mes: "invoice_date:month",
  cliente: "commercial_partner_id",
  vendedor: "invoice_user_id",
} as const;

const AGRUPACIONES = {
  mes: ["mes"],
  cliente: ["cliente"],
  vendedor: ["vendedor"],
  mes_y_cliente: ["mes", "cliente"],
  mes_y_vendedor: ["mes", "vendedor"],
} as const;

export function registrarVentasPorPeriodo(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "ventas_por_periodo",
    {
      titulo: "Ventas por período",
      descripcion:
        "Ventas facturadas en Odoo (solo facturas de cliente publicadas, netas de notas crédito) en un rango de fechas, agrupadas en el servidor por mes, cliente, vendedor o combinaciones. " +
        "Devuelve filas con las columnas de agrupación (mes AAAA-MM, cliente_id, cliente_nombre, nit, vendedor_id, vendedor_nombre) y: ventas_netas (sin impuestos), impuestos, ventas_con_impuestos, documentos y ticket_promedio, en la moneda de la empresa. " +
        "Ideal para gráficos de tendencia mensual, top de clientes o ranking de vendedores.",
      parametros: {
        desde: esquemaFecha.describe("Fecha de factura inicial (AAAA-MM-DD)."),
        hasta: esquemaFecha.describe("Fecha de factura final (AAAA-MM-DD)."),
        agrupar_por: z.enum(["mes", "cliente", "vendedor", "mes_y_cliente", "mes_y_vendedor"]).default("mes"),
        incluir_notas_credito: z
          .boolean()
          .default(true)
          .describe("Restar las notas crédito de cliente (ventas netas). Si es false, solo facturas."),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      validarRango(args.desde, args.hasta);
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const tipos = args.incluir_notas_credito ? ["out_invoice", "out_refund"] : ["out_invoice"];
      const dominio = [
        ["move_type", "in", tipos],
        ["state", "=", "posted"],
        ["invoice_date", ">=", args.desde],
        ["invoice_date", "<=", args.hasta],
        ...alcance.dominio,
      ];
      const dimensiones = AGRUPACIONES[args.agrupar_por];
      const groupby = dimensiones.map((d) => CAMPO_GRUPO[d]);
      const grupos = await cliente.agrupar(
        "account.move",
        dominio,
        groupby,
        ["amount_untaxed_signed:sum", "amount_tax_signed:sum", "amount_total_signed:sum"],
        { context: alcance.context },
      );

      const ids = [...new Set(grupos.map((g) => idDe(g.commercial_partner_id)).filter((id): id is number => id !== null))];
      const nits = new Map<number, string | null>();
      if (ids.length) {
        const terceros = await cliente.read<{ id: number; vat: string | false }>("res.partner", ids, ["vat"], alcance.context);
        for (const t of terceros) nits.set(t.id, texto(t.vat));
      }

      let filas = grupos.map((g) => {
        const fila: Record<string, unknown> = {};
        for (const d of dimensiones) {
          const v = g[CAMPO_GRUPO[d]];
          if (d === "mes") fila.mes = Array.isArray(v) && typeof v[0] === "string" ? v[0].slice(0, 7) : null;
          if (d === "cliente") {
            fila.cliente_id = idDe(v);
            fila.cliente_nombre = nombreDe(v);
            fila.nit = nits.get(idDe(v) ?? -1) ?? null;
          }
          if (d === "vendedor") {
            fila.vendedor_id = idDe(v);
            fila.vendedor_nombre = nombreDe(v) ?? "(sin vendedor)";
          }
        }
        const netas = numero(g["amount_untaxed_signed:sum"]);
        const documentos = numero(g.__count);
        fila.ventas_netas = redondear(netas);
        fila.impuestos = redondear(numero(g["amount_tax_signed:sum"]));
        fila.ventas_con_impuestos = redondear(numero(g["amount_total_signed:sum"]));
        fila.documentos = documentos;
        fila.ticket_promedio = documentos ? redondear(netas / documentos) : 0;
        return fila;
      });

      filas = filas.sort((a, b) =>
        dimensiones[0] === "mes"
          ? String(a.mes).localeCompare(String(b.mes)) || (b.ventas_netas as number) - (a.ventas_netas as number)
          : (b.ventas_netas as number) - (a.ventas_netas as number),
      );

      const total = filas.reduce((s, f) => s + (f.ventas_netas as number), 0);
      const documentos = filas.reduce((s, f) => s + (f.documentos as number), 0);
      const limite = limiteEfectivo(ctx.config, args.limite);
      return {
        herramienta: "ventas_por_periodo",
        filtros: { ...args, empresa: alcance.empresa.nombre },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          ventas_netas: redondear(total),
          impuestos: redondear(filas.reduce((s, f) => s + (f.impuestos as number), 0)),
          ventas_con_impuestos: redondear(filas.reduce((s, f) => s + (f.ventas_con_impuestos as number), 0)),
          documentos,
          ticket_promedio: documentos ? redondear(total / documentos) : 0,
        },
        total_registros: filas.length,
        filas: filas.slice(0, limite),
      };
    },
  );
}
