// Herramienta `empresas`: empresas de Odoo a las que tiene acceso la clave API.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listarEmpresas } from "../odoo/empresa.js";
import { registrarHerramienta, type ContextoHerramienta } from "./comun.js";

export function registrarEmpresas(server: McpServer, ctx: ContextoHerramienta): void {
  registrarHerramienta(
    server,
    ctx,
    "empresas",
    {
      titulo: "Empresas disponibles",
      descripcion:
        "Lista las empresas de Odoo a las que tiene acceso el usuario conectado. Devuelve una fila por empresa con: id, nombre, nit, moneda y empresa_padre_id (las sucursales tienen empresa padre). " +
        "Úsala cuando haya varias empresas para saber qué valor pasar en el parámetro empresa de las demás herramientas.",
      parametros: {},
    },
    async () => {
      const empresas = await listarEmpresas(ctx.cliente);
      return { herramienta: "empresas", filas: empresas.map((e) => ({ ...e })) };
    },
  );
}
