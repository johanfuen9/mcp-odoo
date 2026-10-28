# Despliegue en Coolify

Guía para publicar el conector en un servidor propio con [Coolify](https://coolify.io) v4.
Coolify construye la imagen con el `Dockerfile` del repositorio y le pone HTTPS con su proxy
(Traefik) y Let's Encrypt.

> Los nombres de menús pueden variar un poco entre versiones de Coolify. Si alguno no
> coincide, consulta la [documentación del build pack Dockerfile](https://coolify.io/docs/applications/builds/dockerfile)
> y la de [health checks](https://coolify.io/docs/applications/configuration/health-checks).

## 1. Antes de empezar

- **Un subdominio** para el conector, por ejemplo `mcp.midominio.com`, con un registro **A**
  (y AAAA si tienes IPv6) apuntando a la IP de tu servidor de Coolify.
- **Puertos 80 y 443 abiertos** en el firewall del servidor. Claude se conecta desde la red de
  Anthropic: `160.79.104.0/21`. Si tu firewall restringe por IP, permite ese rango en el 443.
  El 80 solo lo necesita Let's Encrypt para emitir el certificado.
- **Dos secretos**, generados en tu computador:

  ```bash
  openssl rand -hex 32   # TOKEN_SECRET
  openssl rand -hex 24   # MCP_ACCESS_TOKEN (solo si usarás el modo personal)
  ```

## 2. Crear la aplicación

1. En Coolify: **Projects** → tu proyecto → **+ New** → **Resource**.
2. Elige el repositorio de GitHub (con la GitHub App de Coolify si es privado) y la rama que
   vas a desplegar.
3. **Build Pack:** `Dockerfile`.
4. **Ports Exposes:** `3000`.
5. **Domains:** `https://mcp.midominio.com`. Con `https://`, Coolify pide el certificado de
   Let's Encrypt automáticamente.

## 3. Variables de entorno

En la pestaña **Environment Variables** de la aplicación:

| Variable | Valor |
|---|---|
| `PUBLIC_BASE_URL` | `https://mcp.midominio.com` (sin `/` al final) |
| `TOKEN_SECRET` | el valor de `openssl rand -hex 32` |
| `TRUST_PROXY_HOPS` | `1` (o `2` si además usas Cloudflare con proxy activado) |

`NODE_ENV=production` y `PORT=3000` ya vienen en la imagen. En producción el servidor no
arranca si falta `PUBLIC_BASE_URL` o `TOKEN_SECRET`: lo verás en los logs.

**Modo personal (opcional).** Si quieres usar tu propio Odoo sin escribir la clave cada vez:

| Variable | Valor |
|---|---|
| `ALLOW_ENV_FALLBACK` | `true` |
| `ODOO_URL` | `https://tuempresa.odoo.com` |
| `ODOO_API_KEY` | tu clave API de Odoo |
| `ODOO_DB` | (opcional) |
| `MCP_ACCESS_TOKEN` | el valor de `openssl rand -hex 24` |

Luego, en la página de conexión, abre **"Soy el administrador de este servidor"** y escribe el
`MCP_ACCESS_TOKEN`. Déjalo en `false` si vas a compartir el conector con otras personas y no
lo necesitas.

**No cambies `TOKEN_SECRET` después:** todos los usuarios tendrían que volver a conectar. Si
necesitas rotarlo, pon el valor anterior en `TOKEN_SECRET_PREVIOUS` y el nuevo en
`TOKEN_SECRET`, y quita el anterior después de 90 días.

## 4. Health check

El `Dockerfile` ya trae un `HEALTHCHECK` contra `/health` (con el `wget` que incluye la
imagen), y Coolify lo usa. No hace falta configurar otro en **Configuration > Healthcheck**.

## 5. Desplegar y verificar

1. Clic en **Deploy** y revisa el log de construcción.
2. Cuando termine, verifica desde tu computador:

   ```bash
   curl https://mcp.midominio.com/health
   # {"status":"ok","version":"0.1.0"}

   curl https://mcp.midominio.com/.well-known/oauth-protected-resource/mcp
   # "resource": "https://mcp.midominio.com/mcp", ...

   curl -i -X POST https://mcp.midominio.com/mcp
   # HTTP/2 401 ... www-authenticate: Bearer resource_metadata="..."
   ```

   El `401` es correcto: le indica a Claude que debe iniciar la conexión OAuth.
3. Agrega el conector en Claude con `https://mcp.midominio.com/mcp` (ver el README, sección
   *Agregar el conector en Claude*).

## 6. Operación

- **Una sola réplica.** El límite de peticiones y el registro de códigos OAuth usados están en
  memoria. No escales a varias réplicas.
- **Actualizaciones.** Con el despliegue automático activado, cada push a la rama vuelve a
  desplegar. Los usuarios no pierden la conexión mientras `TOKEN_SECRET` no cambie.
- **Logs.** En la pestaña **Logs** de la aplicación. Cada línea es un JSON con el evento,
  la herramienta, el dominio de Odoo y la duración. Nunca incluyen claves ni tokens.
- **Cloudflare.** Si pones Cloudflare delante con proxy activado, sube `TRUST_PROXY_HOPS` a `2`
  y revisa que las reglas de WAF o de bots no bloqueen las IPs de Anthropic
  (`160.79.104.0/21`). Si Claude dice *"Couldn't reach the MCP server"* y en los logs del
  servidor no aparece la petición, casi siempre es el WAF o el firewall.

## 7. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| El contenedor se reinicia y el log dice `[config] ...` | Falta `TOKEN_SECRET` o `PUBLIC_BASE_URL`, o no es `https://`. |
| Claude no logra conectar ("Couldn't reach the MCP server") | DNS, certificado aún no emitido, firewall o WAF bloqueando `160.79.104.0/21`. |
| La página de conexión dice "No se encontró el dominio" | La URL de Odoo está mal escrita o el servidor no resuelve DNS externo. |
| "La clave API no es válida" | Clave vencida, mal copiada o, en Odoo Online, plan sin acceso a la API (requiere plan Custom). |
| "Este Odoo es la versión 17" | El conector requiere Odoo 19 o superior. |
| Después de cambiar `TOKEN_SECRET` nadie puede usar el conector | Es lo esperado: cada usuario debe hacer clic en **Conectar** de nuevo. |
