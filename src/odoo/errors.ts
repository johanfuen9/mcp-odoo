// Errores de Odoo traducidos a mensajes que un contador pueda entender.

export type TipoErrorOdoo =
  | "sin_credenciales"
  | "credenciales"
  | "permisos"
  | "modulo_no_instalado"
  | "tiempo_agotado"
  | "conexion"
  | "url_no_permitida"
  | "no_es_odoo"
  | "parametros"
  | "metodo_no_permitido"
  | "modelo_no_permitido"
  | "odoo";

export class OdooError extends Error {
  readonly tipo: TipoErrorOdoo;
  /** Detalle técnico corto (sin datos sensibles) para los logs del servidor. */
  readonly detalle?: string;

  constructor(tipo: TipoErrorOdoo, mensaje: string, detalle?: string) {
    super(mensaje);
    this.name = "OdooError";
    this.tipo = tipo;
    this.detalle = detalle;
  }
}

/** Cuerpo de error que devuelve /json/2 (ver odoo/http.py, Json2Dispatcher). */
export interface CuerpoErrorOdoo {
  name?: string;
  message?: string;
  arguments?: unknown[];
}

function primeraLinea(texto: string | undefined, max = 300): string {
  const linea = (texto ?? "").split("\n").find((l) => l.trim()) ?? "";
  return linea.length > max ? `${linea.slice(0, max)}…` : linea;
}

/**
 * Convierte una respuesta HTTP de error de Odoo en un OdooError con mensaje claro.
 * `modelo` y `metodo` solo se usan para dar contexto en el mensaje.
 */
export function errorDesdeRespuesta(
  status: number,
  cuerpo: CuerpoErrorOdoo | null,
  modelo: string,
  metodo: string,
): OdooError {
  const nombre = cuerpo?.name ?? "";
  const mensajeOdoo = primeraLinea(cuerpo?.message);
  const detalle = `HTTP ${status} ${nombre} ${mensajeOdoo}`.trim();

  if (status === 401 || nombre.endsWith("AccessDenied")) {
    return new OdooError(
      "credenciales",
      "La clave API no es válida o ya venció. Genera una nueva en Odoo (Preferencias > Seguridad de la cuenta > Nueva clave API) y actualízala en el conector.",
      detalle,
    );
  }

  if (status === 403 || nombre.endsWith("AccessError")) {
    return new OdooError(
      "permisos",
      `El usuario de la clave API no tiene permisos para consultar ${modelo}. Pide a un administrador de Odoo que le dé acceso de lectura (por ejemplo, Contabilidad > Auditor o Facturación) o revisa las reglas de registro.`,
      detalle,
    );
  }

  if (status === 404) {
    if (/model .* does not exist/i.test(mensajeOdoo)) {
      return new OdooError(
        "modulo_no_instalado",
        `El modelo ${modelo} no existe en esta base de Odoo. Lo más probable es que el módulo correspondiente no esté instalado.`,
        detalle,
      );
    }
    if (/database|base de datos|db not found/i.test(mensajeOdoo)) {
      return new OdooError(
        "credenciales",
        "No se encontró la base de datos indicada en X-Odoo-Database. Revisa el nombre o deja el encabezado vacío.",
        detalle,
      );
    }
    if (nombre || mensajeOdoo) {
      return new OdooError(
        "parametros",
        `Odoo no reconoce el método ${metodo} sobre ${modelo}. Puede que la versión de Odoo no sea la 19 o que el método no sea público.`,
        detalle,
      );
    }
    return new OdooError(
      "no_es_odoo",
      "La URL no responde como una instancia de Odoo 19 con API JSON-2. Revisa la URL y que el plan de Odoo permita el acceso por API.",
      detalle,
    );
  }

  if (status === 422 || nombre.endsWith("UserError") || nombre.endsWith("ValidationError")) {
    return new OdooError("parametros", `Odoo rechazó la consulta: ${mensajeOdoo || "parámetros no válidos"}.`, detalle);
  }

  if (/Invalid field|no field|Invalid domain|Invalid leaf|unknown field/i.test(mensajeOdoo)) {
    return new OdooError(
      "parametros",
      `Odoo rechazó la consulta: ${mensajeOdoo}. Revisa los nombres de los campos o el dominio.`,
      detalle,
    );
  }

  if (status === 429) {
    return new OdooError("odoo", "Odoo está recibiendo demasiadas peticiones. Espera un momento y vuelve a intentar.", detalle);
  }

  if (status >= 500) {
    return new OdooError(
      "odoo",
      `Odoo devolvió un error interno al consultar ${modelo}${mensajeOdoo ? `: ${mensajeOdoo}` : ""}.`,
      detalle,
    );
  }

  return new OdooError("odoo", `Odoo respondió con un error inesperado (HTTP ${status}).`, detalle);
}

/** Texto final que ve Claude cuando una herramienta falla. */
export function mensajeParaUsuario(err: unknown): string {
  if (err instanceof OdooError) return err.message;
  return "Ocurrió un error inesperado al consultar Odoo. Intenta de nuevo en unos minutos.";
}
