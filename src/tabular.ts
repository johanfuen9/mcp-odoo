// Utilidades para devolver filas tabulares planas, listas para graficar.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** true si el valor tiene la forma many2one de Odoo: [id, "nombre"]. */
export function esMany2one(valor: unknown): valor is [number, string] {
  return Array.isArray(valor) && valor.length === 2 && typeof valor[0] === "number" && typeof valor[1] === "string";
}

export function idDe(valor: unknown): number | null {
  return esMany2one(valor) ? valor[0] : null;
}

export function nombreDe(valor: unknown): string | null {
  return esMany2one(valor) ? valor[1] : null;
}

/** Odoo devuelve `false` en campos vacíos; en columnas no booleanas se pasa a null. */
export function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}

export function numero(valor: unknown): number {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0;
}

/** Redondeo a 2 decimales para montos (evita 0.30000000000000004). */
export function redondear(valor: number, decimales = 2): number {
  const f = 10 ** decimales;
  return Math.round((valor + Number.EPSILON) * f) / f;
}

/**
 * Aplana un registro genérico de Odoo:
 * - many2one `partner_id: [7, "ACME"]` → `partner_id: 7`, `partner_nombre: "ACME"`
 * - many2one vacío en campos *_id → id y nombre en null
 * - listas de ids (one2many/many2many) → texto "1,2,3"
 * - objetos (p. ej. distribución analítica) → JSON en texto
 */
export function aplanarRegistro(registro: Record<string, unknown>): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(registro)) {
    const base = clave.endsWith("_id") ? clave.slice(0, -3) : clave;
    if (esMany2one(valor)) {
      salida[`${base}_id`] = valor[0];
      salida[`${base}_nombre`] = valor[1];
    } else if (valor === false && clave.endsWith("_id")) {
      salida[`${base}_id`] = null;
      salida[`${base}_nombre`] = null;
    } else if (Array.isArray(valor)) {
      salida[clave] = valor.every((v) => typeof v === "number") ? valor.join(",") : JSON.stringify(valor);
    } else if (valor !== null && typeof valor === "object") {
      salida[clave] = JSON.stringify(valor);
    } else {
      salida[clave] = valor;
    }
  }
  return salida;
}

export interface Tabla {
  herramienta: string;
  descripcion?: string;
  filtros?: Record<string, unknown>;
  resumen?: Record<string, unknown>;
  filas: Record<string, unknown>[];
  /** Registros que cumplen el filtro en Odoo (puede ser mayor que filas.length). */
  total_registros?: number;
  avisos?: string[];
}

/**
 * Serializa la tabla para Claude. Si supera `maxCaracteres`, recorta filas
 * (Claude acepta ~150.000 caracteres por respuesta) y lo avisa.
 */
export function respuestaTabular(tabla: Tabla, maxCaracteres: number): CallToolResult {
  const armar = (filas: Record<string, unknown>[], recortada: boolean) => {
    const avisos = [...(tabla.avisos ?? [])];
    if (recortada) {
      avisos.push(
        `Se muestran ${filas.length} de ${tabla.filas.length} filas por el límite de tamaño de respuesta de Claude. Usa filtros más específicos o una herramienta agregada.`,
      );
    }
    const total = tabla.total_registros;
    if (total !== undefined && total > tabla.filas.length && !recortada) {
      avisos.push(`Hay ${total} registros que cumplen el filtro; se devolvieron ${tabla.filas.length}. Sube "limite" o filtra más.`);
    }
    const cuerpo = {
      herramienta: tabla.herramienta,
      ...(tabla.descripcion ? { descripcion: tabla.descripcion } : {}),
      ...(tabla.filtros ? { filtros: tabla.filtros } : {}),
      ...(tabla.resumen ? { resumen: tabla.resumen } : {}),
      columnas: filas.length ? Object.keys(filas[0]) : [],
      total_filas: filas.length,
      ...(total !== undefined ? { total_registros: total } : {}),
      truncado: recortada || (total !== undefined && total > filas.length),
      ...(avisos.length ? { avisos } : {}),
      filas,
    };
    return JSON.stringify(cuerpo);
  };

  let textoFinal = armar(tabla.filas, false);
  if (textoFinal.length > maxCaracteres) {
    let bajo = 0;
    let alto = tabla.filas.length;
    while (bajo < alto) {
      const medio = Math.ceil((bajo + alto) / 2);
      if (armar(tabla.filas.slice(0, medio), true).length <= maxCaracteres) bajo = medio;
      else alto = medio - 1;
    }
    textoFinal = armar(tabla.filas.slice(0, bajo), true);
  }
  return { content: [{ type: "text", text: textoFinal }] };
}

export function respuestaError(mensaje: string): CallToolResult {
  return { content: [{ type: "text", text: mensaje }], isError: true };
}
