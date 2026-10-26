import { describe, expect, it } from "vitest";
import { aplanarRegistro, respuestaTabular } from "../src/tabular.js";

describe("aplanarRegistro", () => {
  it("separa los many2one en _id y _nombre", () => {
    expect(aplanarRegistro({ id: 1, partner_id: [7, "ACME SAS"], amount_total: 100 })).toEqual({
      id: 1,
      partner_id: 7,
      partner_nombre: "ACME SAS",
      amount_total: 100,
    });
  });

  it("deja id y nombre en null cuando el many2one está vacío", () => {
    expect(aplanarRegistro({ user_id: false })).toEqual({ user_id: null, user_nombre: null });
  });

  it("convierte listas de ids y objetos en texto plano", () => {
    expect(aplanarRegistro({ tax_ids: [1, 2, 3], analytic_distribution: { "5": 100 } })).toEqual({
      tax_ids: "1,2,3",
      analytic_distribution: '{"5":100}',
    });
  });

  it("no toca booleanos ni textos", () => {
    expect(aplanarRegistro({ active: false, name: "X", reconciled: true })).toEqual({ active: false, name: "X", reconciled: true });
  });
});

describe("respuestaTabular", () => {
  const filas = Array.from({ length: 1000 }, (_, i) => ({ numero: `FEV-${i}`, total: i * 1000, tercero_nombre: "Cliente de prueba con nombre largo" }));

  it("devuelve JSON con filas y columnas", () => {
    const r = respuestaTabular({ herramienta: "x", filas: filas.slice(0, 2) }, 100_000);
    const cuerpo = JSON.parse((r.content[0] as { text: string }).text);
    expect(cuerpo.columnas).toEqual(["numero", "total", "tercero_nombre"]);
    expect(cuerpo.filas).toHaveLength(2);
    expect(cuerpo.truncado).toBe(false);
  });

  it("recorta filas para no superar el tope de caracteres y lo avisa", () => {
    const r = respuestaTabular({ herramienta: "x", filas }, 20_000);
    const texto = (r.content[0] as { text: string }).text;
    expect(texto.length).toBeLessThanOrEqual(20_000);
    const cuerpo = JSON.parse(texto);
    expect(cuerpo.truncado).toBe(true);
    expect(cuerpo.filas.length).toBeGreaterThan(100);
    expect(cuerpo.filas.length).toBeLessThan(1000);
    expect(cuerpo.avisos.join(" ")).toMatch(/límite de tamaño/);
  });

  it("marca truncado cuando Odoo tiene más registros que las filas devueltas", () => {
    const r = respuestaTabular({ herramienta: "x", filas: filas.slice(0, 5), total_registros: 50 }, 100_000);
    const cuerpo = JSON.parse((r.content[0] as { text: string }).text);
    expect(cuerpo.truncado).toBe(true);
    expect(cuerpo.avisos[0]).toMatch(/50 registros/);
  });
});
