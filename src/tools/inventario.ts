// Herramienta `inventario`: existencias por producto y ubicación (stock.quant).
//
// En Odoo 19, stock.quant.value (módulo stock_account) es calculado, no se
// almacena y solo lo pueden leer los administradores de inventario
// (groups='stock.group_stock_manager'). Si no se puede leer, se estima con el
// costo del producto (standard_price) y se avisa.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolverEmpresa } from "../odoo/empresa.js";
import { OdooError } from "../odoo/errors.js";
import { idDe, nombreDe, numero, redondear, texto } from "../tabular.js";
import { esquemaEmpresa, esquemaLimite, limiteEfectivo, registrarHerramienta, type ContextoHerramienta } from "./comun.js";

const TAMANO_PAGINA = 5000;
const MAX_QUANTS = 50_000;

type Quant = Record<string, unknown> & { id: number };

export function registrarInventario(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "inventario",
    {
      titulo: "Inventario: existencias y valor",
      descripcion:
        "Existencias actuales de Odoo (stock.quant) en ubicaciones internas, con cantidad y valor. " +
        "Con agrupar_por='producto' (por defecto) devuelve una fila por producto con: producto_id, referencia, producto, categoria, unidad, cantidad, reservada, disponible, valor y costo_unitario. " +
        "También agrupa por 'producto_ubicacion', 'ubicacion' o 'categoria'. Ordenado de mayor a menor valor. " +
        "Si el usuario no puede ver el valor contable del inventario, el valor se estima con el costo del producto y se avisa. " +
        "Si el módulo de Inventario no está instalado, lo indica.",
      parametros: {
        agrupar_por: z.enum(["producto", "producto_ubicacion", "ubicacion", "categoria"]).default("producto"),
        producto: z.string().min(2).optional().describe("Nombre o referencia interna del producto (búsqueda parcial)."),
        ubicacion: z.string().min(2).optional().describe("Nombre de la ubicación o bodega (búsqueda parcial), por ejemplo WH/Stock."),
        empresa: esquemaEmpresa,
        limite: esquemaLimite(ctx.config),
      },
    },
    async (args) => {
      const { cliente } = ctx;
      const alcance = await resolverEmpresa(cliente, args.empresa);
      const dominio: unknown[] = [["location_id.usage", "=", "internal"], ...alcance.dominio];
      if (args.producto) {
        dominio.push("|", ["product_id.name", "ilike", args.producto], ["product_id.default_code", "ilike", args.producto]);
      }
      if (args.ubicacion) dominio.push(["location_id.complete_name", "ilike", args.ubicacion]);

      const avisos: string[] = [];
      const camposBase = ["product_id", "location_id", "quantity", "reserved_quantity"];
      let conValor = true;

      const leerPaginas = async (campos: string[]) => {
        const todos: Quant[] = [];
        for (let offset = 0; offset < MAX_QUANTS; offset += TAMANO_PAGINA) {
          const pagina = await cliente.searchRead<Quant>("stock.quant", dominio, campos, {
            limit: TAMANO_PAGINA,
            offset,
            order: "id",
            context: alcance.context,
          });
          todos.push(...pagina);
          if (pagina.length < TAMANO_PAGINA) return todos;
        }
        avisos.push(`Se leyeron los primeros ${MAX_QUANTS} registros de existencias; usa filtros para ver el resto.`);
        return todos;
      };

      let quants: Quant[];
      try {
        quants = await leerPaginas([...camposBase, "value"]);
      } catch (err) {
        if (err instanceof OdooError && err.tipo === "modulo_no_instalado") {
          throw new OdooError("modulo_no_instalado", "El módulo de Inventario no está instalado en esta base de Odoo.", err.detalle);
        }
        if (err instanceof OdooError && (err.tipo === "permisos" || err.tipo === "parametros")) {
          // Sin acceso al valor (o sin stock_account): se reintenta sin él.
          conValor = false;
          quants = await leerPaginas(camposBase);
        } else {
          throw err;
        }
      }

      // Datos de los productos (referencia, categoría, unidad y costo).
      const idsProductos = [...new Set(quants.map((q) => idDe(q.product_id)).filter((id): id is number => id !== null))];
      const productos = new Map<number, { referencia: string | null; categoria: string | null; unidad: string | null; costo: number }>();
      for (let i = 0; i < idsProductos.length; i += 1000) {
        const lote = await cliente.read<Record<string, unknown> & { id: number }>(
          "product.product",
          idsProductos.slice(i, i + 1000),
          ["default_code", "categ_id", "uom_id", "standard_price"],
          alcance.context,
        );
        for (const p of lote) {
          productos.set(p.id, {
            referencia: texto(p.default_code),
            categoria: nombreDe(p.categ_id),
            unidad: nombreDe(p.uom_id),
            costo: numero(p.standard_price),
          });
        }
      }
      if (!conValor) {
        avisos.push(
          "El usuario no puede ver el valor contable del inventario (requiere permiso de Administrador de Inventario); el valor se estimó con el costo de cada producto.",
        );
      }

      interface Acum {
        claves: Record<string, unknown>;
        cantidad: number;
        reservada: number;
        valor: number;
      }
      const grupos = new Map<string, Acum>();
      for (const q of quants) {
        const pid = idDe(q.product_id);
        const prod = pid !== null ? productos.get(pid) : undefined;
        const cantidad = numero(q.quantity);
        const valor = conValor ? numero(q.value) : cantidad * (prod?.costo ?? 0);
        let claves: Record<string, unknown>;
        switch (args.agrupar_por) {
          case "producto":
            claves = { producto_id: pid, referencia: prod?.referencia ?? null, producto: nombreDe(q.product_id), categoria: prod?.categoria ?? null, unidad: prod?.unidad ?? null };
            break;
          case "producto_ubicacion":
            claves = {
              producto_id: pid,
              referencia: prod?.referencia ?? null,
              producto: nombreDe(q.product_id),
              ubicacion_id: idDe(q.location_id),
              ubicacion: nombreDe(q.location_id),
              unidad: prod?.unidad ?? null,
            };
            break;
          case "ubicacion":
            claves = { ubicacion_id: idDe(q.location_id), ubicacion: nombreDe(q.location_id) };
            break;
          case "categoria":
            claves = { categoria: prod?.categoria ?? "(sin categoría)" };
            break;
        }
        const k = JSON.stringify(claves);
        const g = grupos.get(k) ?? { claves, cantidad: 0, reservada: 0, valor: 0 };
        g.cantidad += cantidad;
        g.reservada += numero(q.reserved_quantity);
        g.valor += valor;
        grupos.set(k, g);
      }

      const porProducto = args.agrupar_por === "producto" || args.agrupar_por === "producto_ubicacion";
      const filas = [...grupos.values()]
        .map((g) => ({
          ...g.claves,
          ...(porProducto
            ? {
                cantidad: redondear(g.cantidad, 4),
                reservada: redondear(g.reservada, 4),
                disponible: redondear(g.cantidad - g.reservada, 4),
              }
            : { productos_unidades: redondear(g.cantidad, 4) }),
          valor: redondear(g.valor),
          ...(porProducto ? { costo_unitario: g.cantidad ? redondear(g.valor / g.cantidad) : null } : {}),
        }))
        .sort((a, b) => b.valor - a.valor);

      const limite = limiteEfectivo(ctx.config, args.limite);
      return {
        herramienta: "inventario",
        filtros: { ...args, empresa: alcance.empresa.nombre },
        resumen: {
          empresa: alcance.empresa.nombre,
          moneda: alcance.empresa.moneda,
          valor_total: redondear(filas.reduce((s, f) => s + f.valor, 0)),
          valor_es_estimado: !conValor,
          productos: idsProductos.length,
          registros_de_existencias: quants.length,
        },
        total_registros: filas.length,
        avisos,
        filas: filas.slice(0, limite),
      };
    },
  );
}
