# Conector MCP de Odoo para Claude (solo lectura)

Servidor MCP remoto que conecta Claude, y en especial **Claude Dashboards**, con Odoo 19
para consultar en vivo facturas, ventas, cartera, estados financieros, impuestos e
inventario. **Es solo de lectura: no crea, modifica ni borra nada en Odoo.**

Cada usuario conecta su propio Odoo con su propia clave API. El servidor **no guarda
nada**: no tiene base de datos.

- [Herramientas](#herramientas)
- [Cómo se conecta un usuario](#cómo-se-conecta-un-usuario)
- [Agregar el conector en Claude, paso a paso](#agregar-el-conector-en-claude-paso-a-paso)
- [Generar la clave API en Odoo](#generar-la-clave-api-en-odoo)
- [Preguntas de ejemplo para Claude Dashboards](#preguntas-de-ejemplo-para-claude-dashboards)
- [Requisitos del Odoo de cada cliente](#requisitos-del-odoo-de-cada-cliente)
- [Correrlo localmente y probarlo con MCP Inspector](#correrlo-localmente-y-probarlo-con-mcp-inspector)
- [Desplegarlo](#desplegarlo)
- [Configuración](#configuración)
- [Seguridad](#seguridad)
- [Notas de compatibilidad con Odoo 19](#notas-de-compatibilidad-con-odoo-19)
- [Estado y limitaciones](#estado-y-limitaciones)

## Herramientas

Todas devuelven JSON con `filas`, una lista de objetos con **columnas planas** (sin tuplas
`[id, nombre]`; por ejemplo `tercero_id` y `tercero_nombre` van por separado), lista para
tablas y gráficos. También devuelven un `resumen` con totales. Siempre que se puede, la
agregación se hace en Odoo y no se traen miles de registros.

| Herramienta | Qué devuelve |
|---|---|
| `empresas` | Empresas a las que tiene acceso el usuario: id, nombre, NIT, moneda y empresa padre (sucursales). |
| `facturas` | Facturas o notas crédito de cliente o proveedor: número, fecha, vencimiento, días vencida, tercero, NIT, subtotal, impuestos, total, saldo pendiente, estado y estado de pago. El resumen trae los totales de *todo* el filtro. |
| `ventas_por_periodo` | Ventas facturadas netas de notas crédito, agrupadas por mes, cliente, vendedor o combinaciones: ventas netas, impuestos, documentos y ticket promedio. |
| `cartera_por_edades` | Cuentas por cobrar por cliente en tramos de mora contra la fecha de vencimiento: corriente, 1-30, 31-60, 61-90, más de 90 y sin vencimiento. También por documento. |
| `cuentas_por_pagar` | Lo mismo, para proveedores. |
| `balance_de_prueba` | Por cuenta o nivel del PUC: saldo inicial, débito, crédito y saldo final entre dos fechas. Confirma si cuadra. |
| `estado_de_resultados` | Ingresos, costo de ventas, gastos, otros ingresos y gastos, e impuesto de renta por nivel del PUC. Incluye utilidad bruta, operacional y neta y márgenes. Admite comparativo contra el período anterior o el mismo período del año anterior, o desglose por mes. |
| `balance_general` | Activo, pasivo y patrimonio (corriente y no corriente) a una fecha de corte, con el resultado del ejercicio calculado, capital de trabajo, razón corriente y endeudamiento. Admite comparativo contra otra fecha. |
| `gastos_por_cuenta` | Gastos por cuenta y por mes (clase 5 del PUC, o tipos de gasto de Odoo si la empresa no usa el PUC). |
| `impuestos` | IVA generado y descontable, saldo a pagar, retenciones practicadas y retenciones que le practicaron, por impuesto o por cuenta contable, y opcionalmente por mes. |
| `inventario` | Existencias en ubicaciones internas por producto, ubicación o categoría: cantidad, reservada, disponible, valor y costo unitario. Si el módulo no está instalado, lo dice. |
| `consulta_avanzada` | `search_read` genérico sobre una lista blanca de modelos, para preguntas que las demás herramientas no cubren. |

**Multiempresa.** Si el usuario de la clave tiene varias empresas en Odoo, las herramientas
piden el parámetro `empresa` (id, nombre o NIT) y nunca mezclan la contabilidad de varias
empresas. Al elegir una empresa se incluyen sus sucursales.

**Niveles del PUC.** Las herramientas contables aceptan `nivel`: `clase` (1 dígito), `grupo`
(2), `cuenta` (4), `subcuenta` (6) o `auxiliar` (la cuenta completa). Los nombres de los
niveles agregados salen de los grupos de cuentas de Odoo; si no existen, de la tabla del PUC
(Decreto 2650).

## Cómo se conecta un usuario

La conexión usa **OAuth sin base de datos**:

1. El usuario agrega el conector en Claude con la URL `https://<tu-servidor>/mcp` y hace clic
   en **Conectar**.
2. Se abre una página de este servidor. Ahí el usuario escribe la **URL de su Odoo**, su
   **clave API** y, si hace falta, la **base de datos**.
3. El servidor prueba esas credenciales contra Odoo. Si funcionan, se las entrega a Claude
   **cifradas (AES-256-GCM) dentro del token**. Solo este servidor puede descifrarlas, y no
   las guarda en ningún lado.
4. En cada consulta, Claude envía el token; el servidor lo descifra en memoria, llama a
   Odoo y responde.

Para cortar el acceso de alguien basta con **revocar su clave API en Odoo**. Las claves de
Odoo vencen como máximo a los 3 meses; cuando eso pase, el usuario vuelve a hacer clic en
**Conectar** con una clave nueva.

## Agregar el conector en Claude, paso a paso

**Planes Pro y Max (cada persona):**

1. Abre Claude y ve a **Personalizar > Conectores**.
2. Haz clic en **+ Agregar** y luego en **Agregar conector personalizado**.
3. Nombre: `Odoo`. URL del servidor MCP: `https://<tu-servidor>/mcp`.
4. No llenes los campos de OAuth (client ID y secret): el servidor se registra solo.
5. Haz clic en **Agregar** y luego en **Conectar**.
6. En la página que se abre, escribe la URL de tu Odoo (por ejemplo `https://empresa.odoo.com`),
   tu clave API y, solo si tu servidor tiene varias bases, el nombre de la base de datos.
   Haz clic en **Conectar**.
7. Vuelves a Claude y el conector aparece como **Conectado**.

**Planes Team y Enterprise:** un **Owner** agrega el conector una sola vez en **Configuración
de la organización > Conectores > Agregar > Personalizado** (tipo Web) con la misma URL.
Después **cada miembro** va a **Personalizar > Conectores**, busca el conector y hace clic en
**Conectar** con *su propia* clave de Odoo.

**Usarlo en un chat:** en el botón **+** del chat, entra a **Conectores** y activa **Odoo**.
Como todas las herramientas son de solo lectura, puedes marcarlas como **Permitir siempre**
en la configuración del conector.

> Antes los encabezados `X-Odoo-Url`, `X-Odoo-Api-Key` y `X-Odoo-Database` se planearon como
> forma de conexión. Se cambiaron por OAuth: en claude.ai los encabezados personalizados están
> en beta para pocas organizaciones, solo los configura el Owner, comparten una sola clave
> para toda la organización y los nombres no estándar requieren aprobación de Anthropic.

## Generar la clave API en Odoo

1. En Odoo, haz clic en tu avatar (arriba a la derecha) y entra a **Mi perfil / Preferencias**.
2. Abre la pestaña **Seguridad de la cuenta** y haz clic en **Nueva clave API**.
3. Confirma tu contraseña, escribe una descripción (por ejemplo `Claude`), elige la duración
   (máximo 3 meses) y haz clic en **Generar clave**.
4. **Copia la clave de inmediato**: Odoo la muestra una sola vez.

**Recomendación: usa un usuario de Odoo solo para el conector, con permisos de lectura.** La
clave tiene exactamente los permisos del usuario que la genera. Con un usuario dedicado:

- Contabilidad: **Auditor** (solo lectura), si tu edición lo ofrece; si no, **Facturación**.
- Ventas y Compras: **Usuario: todos los documentos**, si vas a usar `consulta_avanzada` sobre
  pedidos.
- Inventario: **Usuario**. El valor contable del inventario solo lo ve un **Administrador** de
  inventario; sin ese permiso, `inventario` estima el valor con el costo del producto y lo
  avisa.
- Acceso a todas las empresas que se quieran consultar.

Aunque este conector nunca escribe, un usuario de solo lectura limita el daño si la clave se
filtra por cualquier otro medio.

## Preguntas de ejemplo para Claude Dashboards

Con el conector activo, pídele a Claude, por ejemplo:

1. **"Arma un tablero de ventas por mes y cartera por edades de este año."**
   Usa `ventas_por_periodo` y `cartera_por_edades`.
2. **"Crea un tablero financiero del primer semestre: estado de resultados mes a mes con margen
   neto, el balance general al 30 de junio con razón corriente y endeudamiento, y los 10 gastos
   más grandes por cuenta."**
   Usa `estado_de_resultados` con `por_mes`, `balance_general` y `gastos_por_cuenta`.
3. **"Haz un tablero de impuestos de 2026 por bimestre (IVA generado, descontable y
   retenciones) y otro de cuentas por pagar por proveedor resaltando lo vencido a más de 60
   días."**
   Usa `impuestos` con `por_mes` y `cuentas_por_pagar`.

Si el usuario tiene varias empresas, agrega el nombre de la empresa a la pregunta.

## Requisitos del Odoo de cada cliente

| Tipo de Odoo | Requisitos |
|---|---|
| **Odoo Online** (`*.odoo.com`) | Versión 19 o superior y plan **Custom**: en Odoo Online la API externa solo está disponible en ese plan. |
| **Odoo.sh** | Versión 19 o superior. La URL `https://<proyecto>.odoo.com` ya tiene HTTPS. |
| **Enterprise o Community instalado por el cliente** | Versión 19 o superior, y **accesible desde internet por HTTPS con un certificado válido**. |

**Odoo instalado en la red del cliente.** El conector corre en tu servidor, no en la red del
cliente, así que Odoo debe tener una URL pública HTTPS. Opciones:

- **Proxy inverso** (Nginx, Traefik, Caddy) con certificado de Let's Encrypt delante de Odoo,
  con `proxy_mode = True` en la configuración de Odoo.
- **Cloudflare Tunnel**, si el cliente no puede abrir puertos.
- Para más seguridad, el firewall del cliente puede aceptar conexiones a Odoo **solo desde la
  IP de tu servidor**.

El conector **rechaza** URLs `http://`, certificados inválidos, IPs privadas y nombres
internos (protección contra SSRF). Si el servidor del cliente aloja varias bases de datos, el
usuario escribe el nombre de la base en el campo **Base de datos** de la página de conexión
(se envía como `X-Odoo-Database`).

Si un Odoo es anterior a la 19, la página de conexión dice qué versión encontró.

## Correrlo localmente y probarlo con MCP Inspector

Requiere **Node.js 22.19 o superior**.

```bash
npm install
cp .env.example .env      # completa TOKEN_SECRET (openssl rand -hex 32)
npm run dev               # http://localhost:3000/mcp
npm test                  # 161 pruebas
```

### Contra tu Odoo real (modo personal)

En `.env`:

```
ALLOW_ENV_FALLBACK=true
ODOO_URL=https://tuempresa.odoo.com
ODOO_API_KEY=<tu clave API>
ODOO_DB=                     # opcional
MCP_ACCESS_TOKEN=<openssl rand -hex 24>
```

El archivo `.env` está en `.gitignore`: **nunca se sube al repositorio**.

### Sin Odoo (Odoo simulado)

```bash
npm run mock:odoo         # Odoo simulado en http://127.0.0.1:8069, con contabilidad de ejemplo
```

y en `.env`: `ODOO_URL=http://127.0.0.1:8069`, `ODOO_API_KEY=clave-valida-de-prueba`,
`DEV_ALLOW_PRIVATE_ENV_URL=true` (solo para desarrollo).

### MCP Inspector

Línea de comandos:

```bash
export T=<tu MCP_ACCESS_TOKEN>
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer $T" --method tools/list

npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http \
  --header "Authorization: Bearer $T" --method tools/call \
  --tool-name estado_de_resultados --tool-arg desde=2026-01-01 --tool-arg hasta=2026-03-31
```

Interfaz gráfica: `npx @modelcontextprotocol/inspector`, transporte **Streamable HTTP**, URL
`http://localhost:3000/mcp`. Desde sus opciones de autenticación se puede recorrer el flujo
OAuth completo, incluida la página de conexión; o pegar el `MCP_ACCESS_TOKEN` como token
Bearer.

## Desplegarlo

El servidor debe quedar en internet por **HTTPS**, porque Claude se conecta desde la nube de
Anthropic (IPs `160.79.104.0/21`), no desde tu computador.

- **Coolify** (recomendado): ver **[docs/despliegue-coolify.md](docs/despliegue-coolify.md)**.
- **Cualquier servidor con Docker:** el `Dockerfile` del repositorio sirve tal cual. Expón el
  puerto 3000 detrás de un proxy con HTTPS y define las variables de la sección siguiente.

Corre **una sola instancia**: el límite de peticiones y el registro de códigos OAuth ya
usados viven en memoria.

## Configuración

Todas las variables están explicadas en [`.env.example`](.env.example). Las importantes:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `TOKEN_SECRET` | Sí | Llave con la que se cifran los tokens. Mínimo 32 caracteres (`openssl rand -hex 32`). Si cambia, todos deben reconectar. |
| `PUBLIC_BASE_URL` | Sí, en producción | URL pública, por ejemplo `https://mcp.midominio.com`. |
| `TRUST_PROXY_HOPS` | No (1) | Proxies delante del servidor: Coolify = 1; Coolify + Cloudflare = 2. |
| `TOKEN_SECRET_PREVIOUS` | No | Para rotar `TOKEN_SECRET` sin desconectar a nadie. |
| `ALLOW_ENV_FALLBACK`, `ODOO_URL`, `ODOO_API_KEY`, `ODOO_DB`, `MCP_ACCESS_TOKEN` | No | Modo personal: usar un Odoo fijo con un código de acceso. Apagado por defecto. |
| `DEFAULT_ROW_LIMIT` / `MAX_ROW_LIMIT` | No (500 / 5000) | Filas por respuesta (parámetro `limite`). |
| `ODOO_TIMEOUT_MS` | No (20000) | Tiempo máximo por llamada a Odoo. |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_LOGIN_PER_MINUTE` | No (120 / 10) | Límite de peticiones por IP (y por token). |
| `ADVANCED_QUERY_MODELS` | No | Modelos permitidos en `consulta_avanzada`. |
| `ZONA_HORARIA` | No (America/Bogota) | Para calcular "hoy" en la cartera. |

## Seguridad

- **Solo lectura.** El cliente de Odoo únicamente puede llamar `search_read`, `search_count`,
  `read` y `formatted_read_group`; cualquier otro método se rechaza antes de llamar a Odoo.
- **SSRF.** Solo URLs `https://`. Se bloquean localhost, IPs privadas y reservadas (IPv4 e
  IPv6, incluidas las formas mapeadas), servicios de metadatos de la nube (`169.254.169.254`,
  `fd00:ec2::254`, `metadata.google.internal`) y nombres internos sin dominio (como los
  contenedores de Docker). El DNS se valida antes de llamar **y otra vez al abrir el socket**
  (contra DNS rebinding). No se siguen redirecciones.
- **OAuth.** PKCE S256 obligatorio. Las redirecciones solo pueden ir a claude.ai o a
  `localhost` (Claude Code y MCP Inspector). Los códigos son de un solo uso y vencen en 5
  minutos. Los tokens van cifrados y autenticados, con el recurso (`/mcp`) atado al token.
- **Logs.** Nunca registran la clave API, los tokens ni los encabezados. Solo método, ruta,
  estado, duración, herramienta y el dominio del Odoo consultado.
- **Límites.** 20 s por llamada a Odoo, filas por respuesta, unos 120.000 caracteres por
  respuesta (el máximo de Claude es ~150.000), cuerpos de 1 MB y límite de peticiones por IP.
- **Errores entendibles.** Se distinguen credenciales inválidas, falta de permisos, módulo no
  instalado, versión de Odoo no soportada, tiempo agotado y problemas de conexión, sin
  mostrar detalles técnicos.

## Notas de compatibilidad con Odoo 19

Estos puntos se verificaron en el código fuente de Odoo 19.0 y determinaron cómo se
escribieron las herramientas:

| Tema | Qué hace el conector |
|---|---|
| Agrupación | Odoo 19 usa `formatted_read_group` (en `web`); `read_group` quedó obsoleto. Solo se permite `formatted_read_group`. |
| Multiempresa | Sin `allowed_company_ids`, Odoo 19 devuelve los datos de **todas** las empresas del usuario. Cada herramienta fija la empresa en el contexto y en el dominio. |
| `account.move.line.account_type` | Es un campo relacionado **no almacenado**: sirve para filtrar pero no para agrupar. Se filtra con `account_id.account_type` y se agrupa por `account_id`. |
| `account.account.code` | Depende de la empresa (`code_store`). Se lee con el contexto de la empresa consultada. |
| `account.account.company_ids` | Las cuentas pueden ser compartidas entre empresas; por eso se filtran los apuntes (`company_id`), no las cuentas. |
| Tipos de cuenta | Se usa la lista de Odoo 19, que incluye `expense_other`. El grupo 54 del PUC se presenta como impuesto de renta. |
| Saldo inicial | Las cuentas de resultados (`include_initial_balance = False`) se reinician al inicio del ejercicio fiscal (`fiscalyear_last_month/day` de la empresa). Las utilidades de años sin asiento de cierre aparecen como una fila calculada. |
| `stock.quant.value` | Es calculado, no almacenado, y solo lo leen los administradores de inventario. Se suma en el servidor; sin permiso se estima con `standard_price`. |
| Retenciones | En Colombia se configuran como impuestos con tasa negativa; así se distinguen del IVA. La base se calcula desde el valor y la tasa. |
| Ventas por cliente | Se agrupa por `commercial_partner_id` para no separar contactos de la misma empresa. |

**Pendiente de verificar contra una instancia real:** estos supuestos salen del código
fuente y de pruebas con un Odoo simulado. En la primera prueba real conviene revisar:

- que `formatted_read_group` acepte agrupar sin `groupby` y con `date:month`;
- el signo de `tax_base_amount`;
- que existan grupos de cuentas (`account.group`) en el plan contable colombiano;
- los nombres de los grupos de permisos de lectura.

Si algún campo cambió de nombre, se ajusta y se documenta aquí.

## Estado y limitaciones

- La **cartera** usa los saldos pendientes **a hoy**. La fecha de referencia solo cambia cómo
  se cuentan los días de mora, no reconstruye saldos históricos.
- Montos en la **moneda de la empresa** (en `facturas` también en la del documento).
- `facturas` cabe en unas **300 filas** por respuesta por el límite de tamaño de Claude. El
  resumen de totales siempre es completo; para análisis grandes usa las herramientas
  agregadas.
- **Solo Odoo 19 o superior** (API JSON-2).
- **Una sola instancia** del servidor (límites y códigos OAuth en memoria).
- Fuera de alcance por ahora: herramientas de escritura, flujo de caja y bancos, contabilidad
  analítica, y un conector equivalente para Siigo.
