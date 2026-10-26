// Crea un servidor MCP por petición (modo stateless): cada petición trae su
// propio token y, por lo tanto, su propio cliente de Odoo.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextoHerramienta } from "./tools/comun.js";
import { registrarHerramientas } from "./tools/index.js";

export const NOMBRE_SERVIDOR = "odoo-lectura";
export const VERSION = "0.1.0";

const INSTRUCCIONES = `Conector de SOLO LECTURA a Odoo 19 (contabilidad colombiana, PUC).
- Todas las herramientas devuelven JSON con "filas": una lista de objetos con columnas planas, lista para tablas y gráficos.
- Fechas en formato AAAA-MM-DD. Montos en la moneda indicada en cada columna.
- Si el usuario tiene varias empresas, pasa el parámetro "empresa" (la herramienta "empresas" las lista).
- Si "truncado" es true, hay más registros de los devueltos: filtra más o usa una herramienta agregada.
- Prefiere las herramientas que agregan en el servidor en lugar de traer miles de documentos.`;

export function crearServidorMcp(ctx: ContextoHerramienta): McpServer {
  const server = new McpServer(
    { name: NOMBRE_SERVIDOR, title: "Odoo (solo lectura)", version: VERSION },
    { instructions: INSTRUCCIONES },
  );
  registrarHerramientas(server, ctx);
  return server;
}
