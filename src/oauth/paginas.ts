// Páginas HTML del flujo de conexión (OAuth). Sin JavaScript ni recursos externos.

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ESTILOS = `
:root{--fondo:#f6f5f2;--tarjeta:#fff;--texto:#1f1f1f;--suave:#5f5f5f;--borde:#d9d6cf;--acento:#714b67;--error:#b3261e;--errorfondo:#fdecea}
@media (prefers-color-scheme:dark){:root{--fondo:#1b1a19;--tarjeta:#262524;--texto:#ecebe8;--suave:#b0ada7;--borde:#3d3b38;--acento:#c9a2bf;--error:#ffb4ab;--errorfondo:#3b1d1a}}
*{box-sizing:border-box}
body{margin:0;background:var(--fondo);color:var(--texto);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:40px auto;padding:0 16px}
.tarjeta{background:var(--tarjeta);border:1px solid var(--borde);border-radius:12px;padding:28px}
h1{font-size:1.4rem;margin:0 0 8px}
p,li{color:var(--suave)}
label{display:block;font-weight:600;margin:18px 0 6px}
.ayuda{font-weight:400;font-size:.9rem;color:var(--suave)}
input{width:100%;padding:10px 12px;border:1px solid var(--borde);border-radius:8px;background:transparent;color:var(--texto);font-size:1rem}
input:focus{outline:2px solid var(--acento);outline-offset:1px}
.botones{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
button{padding:10px 18px;border-radius:8px;border:1px solid var(--acento);font-size:1rem;cursor:pointer}
.primario{background:var(--acento);color:#fff}
.secundario{background:transparent;color:var(--acento)}
.error{background:var(--errorfondo);color:var(--error);border-radius:8px;padding:12px;margin:16px 0}
details{margin-top:20px}
summary{cursor:pointer;color:var(--suave)}
code{font-size:.9em}
`;

function pagina(titulo: string, cuerpo: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escaparHtml(titulo)}</title>
<style>${ESTILOS}</style>
</head>
<body><main><div class="tarjeta">${cuerpo}</div></main></body>
</html>`;
}

export interface DatosFormulario {
  solicitud: string;
  /** Host al que se devolverá al usuario (p. ej. claude.ai). */
  destino: string;
  error?: string;
  url?: string;
  db?: string;
  modoPersonal: boolean;
}

export function paginaConexion(d: DatosFormulario): string {
  const error = d.error ? `<div class="error" role="alert">${escaparHtml(d.error)}</div>` : "";
  const personal = d.modoPersonal
    ? `<details>
  <summary>Soy el administrador de este servidor</summary>
  <label for="codigo">Código de acceso personal <span class="ayuda">(MCP_ACCESS_TOKEN). Usa el Odoo configurado en el servidor.</span></label>
  <input id="codigo" name="codigo_personal" type="password" autocomplete="off">
</details>`
    : "";

  return pagina(
    "Conectar Odoo con Claude",
    `<h1>Conectar tu Odoo</h1>
<p>Claude podrá <strong>consultar</strong> facturas, cartera, saldos contables e inventario. No podrá crear, modificar ni borrar nada.</p>
${error}
<form method="post" action="/authorize">
  <input type="hidden" name="solicitud" value="${escaparHtml(d.solicitud)}">
  <label for="url">URL de Odoo <span class="ayuda">Por ejemplo https://empresa.odoo.com</span></label>
  <input id="url" name="odoo_url" type="url" inputmode="url" placeholder="https://empresa.odoo.com" value="${escaparHtml(d.url ?? "")}" autocomplete="url">
  <label for="clave">Clave API <span class="ayuda">Odoo: Preferencias &gt; Seguridad de la cuenta &gt; Nueva clave API</span></label>
  <input id="clave" name="odoo_api_key" type="password" autocomplete="off" spellcheck="false">
  <label for="db">Base de datos <span class="ayuda">(opcional, solo si tu servidor tiene varias)</span></label>
  <input id="db" name="odoo_db" type="text" value="${escaparHtml(d.db ?? "")}" autocomplete="off" spellcheck="false">
  ${personal}
  <div class="botones">
    <button class="primario" type="submit" name="accion" value="conectar">Conectar</button>
    <button class="secundario" type="submit" name="accion" value="cancelar">Cancelar</button>
  </div>
</form>
<details>
  <summary>¿Qué pasa con mi clave?</summary>
  <p>Este servidor no guarda tu clave. La valida contra tu Odoo y la entrega cifrada dentro del token que guarda Claude; solo este servidor puede descifrarla. Para cortar el acceso, revoca la clave en Odoo.</p>
  <p>Recomendación: crea en Odoo un usuario solo para el conector, con permisos de lectura, y genera la clave con ese usuario.</p>
</details>
<p class="ayuda">Al conectar volverás a <strong>${escaparHtml(d.destino)}</strong>.</p>`,
  );
}

export function paginaError(mensaje: string): string {
  return pagina(
    "No se pudo conectar",
    `<h1>No se pudo iniciar la conexión</h1><div class="error" role="alert">${escaparHtml(mensaje)}</div>
<p>Vuelve a Claude e intenta conectar el conector de nuevo.</p>`,
  );
}
