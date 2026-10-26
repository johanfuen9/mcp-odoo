import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextoHerramienta } from "./comun.js";
import { registrarEmpresas } from "./empresas.js";
import { registrarFacturas } from "./facturas.js";

export function registrarHerramientas(server: McpServer, ctx: ContextoHerramienta): void {
  registrarEmpresas(server, ctx);
  registrarFacturas(server, ctx);
}
