# Conector MCP de Odoo para Claude (solo lectura)

Servidor MCP remoto que permite a Claude, y en especial a Claude Dashboards,
consultar datos de Odoo 19 en vivo: facturas, cartera, saldos contables e
inventario. **No crea, modifica ni borra nada.**

> Estado: **etapa 1**. Ya funcionan el servidor, la conexión por OAuth y las
> herramientas `facturas` y `empresas`. Las demás herramientas llegan en la etapa 2,
> y la guía completa de despliegue en Coolify en la etapa 3.

## Cómo se conecta un usuario

1. En Claude: **Personalizar > Conectores > + Agregar > Agregar conector personalizado**,
   con la URL `https://tu-servidor/mcp`.
2. Clic en **Conectar**. Se abre una página de este servidor donde el usuario escribe
   la URL de su Odoo, su clave API y, si hace falta, la base de datos.
3. El servidor valida esos datos contra Odoo y se los entrega a Claude **cifrados dentro
   del token**. El servidor no guarda nada ni usa base de datos.

Funciona con Odoo Online (plan Custom, que es el que habilita la API externa), Odoo.sh
y Odoo Enterprise instalado por el cliente. Requisitos: **Odoo 19 o superior** (API
JSON-2) y acceso desde internet por **HTTPS con certificado válido**.

## Herramientas disponibles

| Herramienta | Qué devuelve |
|---|---|
| `empresas` | Empresas a las que tiene acceso el usuario: id, nombre, NIT, moneda y empresa padre. |
| `facturas` | Facturas o notas crédito de cliente o proveedor, con resumen de totales. |

Todas devuelven JSON con `filas`: una lista de objetos con columnas planas, sin tuplas
`[id, nombre]`.

## Correrlo localmente

```bash
npm install
cp .env.example .env     # completa TOKEN_SECRET (openssl rand -hex 32)
npm run dev              # http://localhost:3000/mcp
npm test                 # pruebas unitarias y de integración
```

### Probar sin un Odoo real (Odoo simulado)

```bash
npm run mock:odoo        # Odoo simulado en http://127.0.0.1:8069
```

En `.env`:

```
ALLOW_ENV_FALLBACK=true
ODOO_URL=http://127.0.0.1:8069
ODOO_API_KEY=clave-valida-de-prueba
MCP_ACCESS_TOKEN=un-token-largo-de-al-menos-24-caracteres
DEV_ALLOW_PRIVATE_ENV_URL=true
```

### Probar con MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer $MCP_ACCESS_TOKEN" --method tools/list

npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer $MCP_ACCESS_TOKEN" \
  --method tools/call --tool-name facturas --tool-arg estado_pago=pendiente
```

Sin `--cli`, el Inspector abre su interfaz gráfica y permite probar el flujo OAuth
completo, con la pantalla de conexión incluida.
