// Levanta el Odoo simulado en http://127.0.0.1:8069 para probar con MCP Inspector
// sin una instancia real:  npm run mock:odoo
import { datosBase } from "./fixtures.js";
import { crearMockOdoo } from "./mockOdoo.js";

const puerto = Number(process.env.MOCK_ODOO_PORT ?? 8069);
const mock = crearMockOdoo({ datos: datosBase(process.env.MOCK_MULTIEMPRESA === "true") });
await mock.escuchar(puerto);
console.log(`Odoo simulado en http://127.0.0.1:${puerto} — clave API: ${mock.clave}`);
