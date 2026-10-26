// Multiempresa. Sin `allowed_company_ids` en el contexto, Odoo 19 devuelve los
// registros de TODAS las empresas del usuario (odoo/orm/environments.py,
// Environment.companies), lo que mezclaría la contabilidad de varias empresas.
// Por eso cada herramienta fija la empresa en el contexto y en el dominio.

import type { OdooClient } from "./client.js";
import { OdooError } from "./errors.js";

export interface EmpresaOdoo {
  id: number;
  nombre: string;
  nit: string | null;
  moneda: string | null;
  empresa_padre_id: number | null;
}

export interface AlcanceEmpresa {
  empresa: EmpresaOdoo;
  /** La empresa y sus sucursales (empresas hijas). */
  ids: number[];
  context: Record<string, unknown>;
  /** Filtro para modelos con company_id. */
  dominio: unknown[];
}

type Many2one = [number, string] | false;

export async function listarEmpresas(cliente: OdooClient): Promise<EmpresaOdoo[]> {
  const filas = await cliente.searchRead<{ id: number; name: string; vat: string | false; currency_id: Many2one; parent_id: Many2one }>(
    "res.company",
    [],
    ["name", "vat", "currency_id", "parent_id"],
    { order: "sequence, id", limit: 200 },
  );
  return filas.map((f) => ({
    id: f.id,
    nombre: f.name,
    nit: f.vat || null,
    moneda: f.currency_id ? f.currency_id[1] : null,
    empresa_padre_id: f.parent_id ? f.parent_id[0] : null,
  }));
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function describir(empresas: EmpresaOdoo[]): string {
  return empresas.map((e) => `${e.id} = ${e.nombre}${e.nit ? ` (NIT ${e.nit})` : ""}`).join("; ");
}

/**
 * Resuelve el parámetro `empresa` (id, nombre o NIT). Si se omite y el usuario
 * tiene una sola empresa, usa esa; si tiene varias, pide que se especifique.
 */
export async function resolverEmpresa(cliente: OdooClient, empresa?: string | number): Promise<AlcanceEmpresa> {
  const empresas = await listarEmpresas(cliente);
  if (empresas.length === 0) {
    throw new OdooError("permisos", "El usuario de la clave API no tiene acceso a ninguna empresa en Odoo.");
  }

  let elegida: EmpresaOdoo | undefined;
  if (empresa === undefined || empresa === "") {
    const raices = empresas.filter((e) => !e.empresa_padre_id || !empresas.some((x) => x.id === e.empresa_padre_id));
    if (raices.length === 1) {
      elegida = raices[0];
    } else {
      throw new OdooError(
        "parametros",
        `Este usuario tiene acceso a ${empresas.length} empresas. Indica el parámetro "empresa" con el id o el nombre: ${describir(empresas)}.`,
      );
    }
  } else if (typeof empresa === "number") {
    elegida = empresas.find((e) => e.id === empresa);
  } else if (/^\d+$/.test(empresa.trim()) && empresas.some((e) => e.id === Number(empresa))) {
    elegida = empresas.find((e) => e.id === Number(empresa));
  } else {
    const buscado = normalizar(String(empresa));
    const soloDigitos = buscado.replace(/\D/g, "");
    const exactas = empresas.filter((e) => normalizar(e.nombre) === buscado);
    const porNit = soloDigitos.length >= 6 ? empresas.filter((e) => e.nit?.replace(/\D/g, "").startsWith(soloDigitos)) : [];
    const parciales = empresas.filter((e) => normalizar(e.nombre).includes(buscado));
    const todas = exactas.length ? exactas : porNit.length ? porNit : parciales;
    // Las sucursales comparten NIT con su empresa principal: si coinciden ambas,
    // se queda la principal (que ya incluye a sus sucursales).
    const candidatas = todas.filter((e) => !todas.some((x) => x.id === e.empresa_padre_id));
    if (candidatas.length > 1) {
      throw new OdooError(
        "parametros",
        `"${empresa}" coincide con varias empresas: ${describir(candidatas)}. Indica el id.`,
      );
    }
    elegida = candidatas[0];
  }

  if (!elegida) {
    throw new OdooError("parametros", `No se encontró la empresa "${empresa}". Empresas disponibles: ${describir(empresas)}.`);
  }

  // Incluir sucursales (empresas hijas) a las que el usuario tiene acceso.
  const ids = [elegida.id];
  for (let i = 0; i < ids.length; i++) {
    for (const e of empresas) if (e.empresa_padre_id === ids[i] && !ids.includes(e.id)) ids.push(e.id);
  }

  return {
    empresa: elegida,
    ids,
    context: { allowed_company_ids: ids },
    dominio: [["company_id", "in", ids]],
  };
}
