import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registrarBalanceDePrueba } from "./balanceDePrueba.js";
import { registrarBalanceGeneral } from "./balanceGeneral.js";
import { registrarCartera } from "./cartera.js";
import type { ContextoHerramienta } from "./comun.js";
import { registrarConsultaAvanzada } from "./consultaAvanzada.js";
import { registrarEmpresas } from "./empresas.js";
import { registrarEstadoDeResultados } from "./estadoDeResultados.js";
import { registrarFacturas } from "./facturas.js";
import { registrarGastosPorCuenta } from "./gastosPorCuenta.js";
import { registrarImpuestos } from "./impuestos.js";
import { registrarInventario } from "./inventario.js";
import { registrarVentasPorPeriodo } from "./ventasPorPeriodo.js";

export function registrarHerramientas(server: McpServer, ctx: ContextoHerramienta): void {
  registrarEmpresas(server, ctx);
  registrarFacturas(server, ctx);
  registrarVentasPorPeriodo(server, ctx);
  registrarCartera(server, ctx); // cartera_por_edades y cuentas_por_pagar
  registrarBalanceDePrueba(server, ctx);
  registrarEstadoDeResultados(server, ctx);
  registrarBalanceGeneral(server, ctx);
  registrarGastosPorCuenta(server, ctx);
  registrarImpuestos(server, ctx);
  registrarInventario(server, ctx);
  registrarConsultaAvanzada(server, ctx);
}
