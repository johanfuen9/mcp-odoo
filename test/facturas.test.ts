import { describe, expect, it } from "vitest";
import { diasEntre, fechaHoy } from "../src/tools/facturas.js";
import { datosBase } from "./fixtures.js";
import { conectar, herramienta, montar } from "./helpers.js";

async function preparar(multiempresa = false) {
  const m = montar({ datos: datosBase(multiempresa) });
  const { access_token } = await conectar(m.app, m.mock.clave);
  return { ...m, token: access_token };
}

describe("facturas", () => {
  it("por defecto devuelve facturas de cliente publicadas, más recientes primero, con columnas planas", async () => {
    const { app, token } = await preparar();
    const { datos } = await herramienta(app, token, "facturas");
    expect(datos.filas.map((f: { numero: string }) => f.numero)).toEqual(["FEV-0003", "FEV-0002", "FEV-0001"]);
    expect(datos.columnas).toEqual([
      "numero",
      "referencia",
      "tipo",
      "fecha",
      "vencimiento",
      "dias_vencida",
      "tercero_id",
      "tercero_nombre",
      "nit",
      "moneda",
      "subtotal",
      "impuestos",
      "total",
      "saldo_pendiente",
      "total_moneda_empresa",
      "saldo_moneda_empresa",
      "estado",
      "estado_pago",
    ]);
    const f2 = datos.filas[1];
    expect(f2).toMatchObject({
      numero: "FEV-0002",
      fecha: "2026-02-03",
      vencimiento: "2026-03-05",
      tercero_id: 11,
      tercero_nombre: "Ferretería La Esquina",
      nit: "71234567",
      moneda: "COP",
      subtotal: 2_500_000,
      impuestos: 475_000,
      total: 2_975_000,
      saldo_pendiente: 1_975_000,
      estado: "Publicada",
      estado_pago: "Pago parcial",
    });
    // Ningún valor es una tupla [id, nombre].
    for (const fila of datos.filas) for (const v of Object.values(fila)) expect(Array.isArray(v)).toBe(false);
  });

  it("incluye un resumen con totales de todo el filtro, en moneda de la empresa", async () => {
    const { app, token } = await preparar();
    const { datos } = await herramienta(app, token, "facturas", { limite: 1 });
    expect(datos.filas).toHaveLength(1);
    expect(datos.truncado).toBe(true);
    expect(datos.total_registros).toBe(3);
    expect(datos.resumen).toMatchObject({
      empresa: "Comercializadora Andina SAS",
      documentos: 3,
      subtotal_moneda_empresa: 4_300_000,
      total_moneda_empresa: 5_117_000,
      saldo_pendiente_moneda_empresa: 2_927_000,
    });
  });

  it("filtra por estado de pago, tercero (nombre o NIT) y fechas", async () => {
    const { app, token } = await preparar();
    const numeros = async (args: Record<string, unknown>) =>
      (await herramienta(app, token, "facturas", args)).datos.filas.map((f: { numero: string }) => f.numero);
    expect(await numeros({ estado_pago: "pendiente" })).toEqual(["FEV-0003", "FEV-0002"]);
    expect(await numeros({ estado_pago: "pagada" })).toEqual(["FEV-0001"]);
    expect(await numeros({ tercero: "esquina" })).toEqual(["FEV-0002"]);
    expect(await numeros({ tercero: "800111" })).toEqual(["FEV-0003", "FEV-0001"]);
    expect(await numeros({ desde: "2026-02-01", hasta: "2026-02-28" })).toEqual(["FEV-0002"]);
    expect(await numeros({ estado: "borrador" })).toEqual(["/"]);
  });

  it("soporta facturas de proveedor y notas crédito", async () => {
    const { app, token } = await preparar();
    const prov = (await herramienta(app, token, "facturas", { tipo: "proveedor" })).datos;
    expect(prov.filas).toHaveLength(1);
    expect(prov.filas[0]).toMatchObject({ numero: "FACT/2026/0001", referencia: "FV-200", tercero_nombre: "Papelería Central Ltda", total_moneda_empresa: 357_000 });
    const nc = (await herramienta(app, token, "facturas", { tipo: "nota_credito_cliente" })).datos;
    expect(nc.filas.map((f: { numero: string }) => f.numero)).toEqual(["NC-0001"]);
  });

  it("nunca mezcla empresas: con una sola empresa no trae documentos de otras", async () => {
    const { app, token, mock } = await preparar();
    const { datos } = await herramienta(app, token, "facturas", { limite: 100 });
    expect(datos.filas.map((f: { numero: string }) => f.numero)).not.toContain("FEV-C-0001");
    const llamada = mock.llamadas.find((l) => l.modelo === "account.move" && l.metodo === "search_read")!;
    expect(llamada.cuerpo.context).toEqual({ allowed_company_ids: [1] });
    expect(llamada.cuerpo.domain).toContainEqual(["company_id", "in", [1]]);
  });

  it("valida el rango de fechas", async () => {
    const { app, token } = await preparar();
    const r = await herramienta(app, token, "facturas", { desde: "2026-05-01", hasta: "2026-01-01" });
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/posterior/);
  });

  it("rechaza un límite mayor al máximo permitido", async () => {
    const { app, token } = await preparar();
    const r = await herramienta(app, token, "facturas", { limite: 100_000 });
    expect(r.isError).toBe(true);
  });

  it("explica la falta de permisos sobre contabilidad", async () => {
    const m = montar({ sinPermiso: ["account.move"] });
    const { access_token } = await conectar(m.app, m.mock.clave);
    const r = await herramienta(m.app, access_token, "facturas");
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/no tiene permisos para consultar account.move/);
  });
});

describe("multiempresa", () => {
  it("si hay varias empresas y no se indica, pide el parámetro y lista las opciones", async () => {
    const { app, token } = await preparar(true);
    const r = await herramienta(app, token, "facturas");
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/Indica el parámetro "empresa"/);
    expect(r.texto).toContain("2 = Servicios del Caribe SAS");
  });

  it("acepta la empresa por id, por nombre parcial o por NIT, e incluye sus sucursales", async () => {
    const { app, token, mock } = await preparar(true);
    const porId = (await herramienta(app, token, "facturas", { empresa: 2 })).datos;
    expect(porId.filas.map((f: { numero: string }) => f.numero)).toEqual(["FEV-C-0001"]);
    const porNombre = (await herramienta(app, token, "facturas", { empresa: "caribe" })).datos;
    expect(porNombre.resumen.empresa).toBe("Servicios del Caribe SAS");
    const porNit = (await herramienta(app, token, "facturas", { empresa: "900123456" })).datos;
    expect(porNit.resumen.empresa).toBe("Comercializadora Andina SAS");
    const ultima = mock.llamadas.filter((l) => l.modelo === "account.move").pop()!;
    expect(ultima.cuerpo.context).toEqual({ allowed_company_ids: [1, 3] }); // incluye la sucursal
  });

  it("la herramienta empresas las lista", async () => {
    const { app, token } = await preparar(true);
    const { datos } = await herramienta(app, token, "empresas");
    expect(datos.filas).toEqual([
      { id: 1, nombre: "Comercializadora Andina SAS", nit: "900123456-7", moneda: "COP", empresa_padre_id: null },
      { id: 2, nombre: "Servicios del Caribe SAS", nit: "901555222-1", moneda: "COP", empresa_padre_id: null },
      { id: 3, nombre: "Andina Sucursal Medellín", nit: "900123456-7", moneda: "COP", empresa_padre_id: 1 },
    ]);
  });
});

describe("fechas", () => {
  it("calcula hoy en la zona horaria de Colombia", () => {
    expect(fechaHoy("America/Bogota", new Date("2026-03-01T03:00:00Z"))).toBe("2026-02-28");
  });

  it("cuenta días entre fechas", () => {
    expect(diasEntre("2026-01-31", "2026-03-02")).toBe(30);
  });
});
