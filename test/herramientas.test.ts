import { describe, expect, it } from "vitest";
import { inicioEjercicio, prefijoNivel } from "../src/odoo/contabilidad.js";
import { dominiosTramos, tramoDe } from "../src/tools/cartera.js";
import { validarDominio } from "../src/tools/consultaAvanzada.js";
import { periodoComparativo } from "../src/tools/estadoDeResultados.js";
import { naturalezaImpuesto } from "../src/tools/impuestos.js";
import { datosContables } from "./fixturesContables.js";
import { conectar, herramienta, montar } from "./helpers.js";
import type { OpcionesMock } from "./mockOdoo.js";

async function preparar(opciones: Partial<OpcionesMock> = {}, conGrupos = false) {
  const m = montar({ datos: datosContables({ conGruposDeCuentas: conGrupos }), ...opciones });
  const { access_token } = await conectar(m.app, m.mock.clave);
  const llamar = async (nombre: string, args: Record<string, unknown> = {}) => {
    const r = await herramienta(m.app, access_token, nombre, args);
    if (r.isError) throw new Error(`${nombre} falló: ${r.texto}`);
    return r.datos;
  };
  const llamarError = async (nombre: string, args: Record<string, unknown> = {}) => {
    const r = await herramienta(m.app, access_token, nombre, args);
    if (!r.isError) throw new Error(`${nombre} debía fallar`);
    return r.texto;
  };
  return { ...m, llamar, llamarError };
}

type Fila = Record<string, unknown>;
const buscar = (filas: Fila[], campo: string, valor: unknown) => filas.find((f) => f[campo] === valor)!;

describe("utilidades contables", () => {
  it("calcula el inicio del ejercicio fiscal", () => {
    expect(inicioEjercicio("2026-05-10")).toBe("2026-01-01");
    expect(inicioEjercicio("2026-01-01")).toBe("2026-01-01");
    expect(inicioEjercicio("2026-05-10", 6, 30)).toBe("2025-07-01");
    expect(inicioEjercicio("2026-08-10", 6, 30)).toBe("2026-07-01");
    expect(inicioEjercicio("2025-03-15", 2, 31)).toBe("2025-03-01"); // 31 de febrero → 28
  });

  it("recorta códigos al nivel del PUC", () => {
    expect(prefijoNivel("11050501", "clase")).toBe("1");
    expect(prefijoNivel("11050501", "grupo")).toBe("11");
    expect(prefijoNivel("11050501", "cuenta")).toBe("1105");
    expect(prefijoNivel("11050501", "subcuenta")).toBe("110505");
    expect(prefijoNivel("11050501", "auxiliar")).toBe("11050501");
    expect(prefijoNivel("11", "subcuenta")).toBe("11");
  });

  it("arma el período comparativo", () => {
    expect(periodoComparativo("2026-01-01", "2026-03-31", "mismo_periodo_ano_anterior")).toEqual({ desde: "2025-01-01", hasta: "2025-03-31" });
    expect(periodoComparativo("2026-03-01", "2026-03-31", "periodo_anterior")).toEqual({ desde: "2026-01-29", hasta: "2026-02-28" });
    expect(periodoComparativo("2024-02-29", "2024-02-29", "mismo_periodo_ano_anterior")).toEqual({ desde: "2023-02-28", hasta: "2023-02-28" });
  });

  it("clasifica impuestos y retenciones", () => {
    expect(naturalezaImpuesto("sale", 19).naturaleza).toBe("generado");
    expect(naturalezaImpuesto("purchase", 19).naturaleza).toBe("descontable");
    expect(naturalezaImpuesto("purchase", -2.5).naturaleza).toBe("retencion_practicada");
    expect(naturalezaImpuesto("sale", -2.5).naturaleza).toBe("retencion_recibida");
  });

  it("asigna tramos de mora", () => {
    expect([null, -5, 0, 1, 30, 31, 60, 61, 90, 91].map(tramoDe)).toEqual([
      "sin_vencimiento",
      "corriente",
      "corriente",
      "dias_1_30",
      "dias_1_30",
      "dias_31_60",
      "dias_31_60",
      "dias_61_90",
      "dias_61_90",
      "mas_de_90",
    ]);
    expect(dominiosTramos("2026-05-01").dias_1_30).toEqual([
      ["date_maturity", "<", "2026-05-01"],
      ["date_maturity", ">=", "2026-04-01"],
    ]);
  });
});

describe("ventas_por_periodo", () => {
  it("agrupa por mes, neto de notas crédito y sin borradores ni otras empresas", async () => {
    const { llamar } = await preparar();
    const d = await llamar("ventas_por_periodo", { desde: "2026-01-01", hasta: "2026-12-31" });
    expect(d.filas).toEqual([
      { mes: "2026-01", ventas_netas: 1_000_000, impuestos: 190_000, ventas_con_impuestos: 1_190_000, documentos: 1, ticket_promedio: 1_000_000 },
      { mes: "2026-02", ventas_netas: 2_400_000, impuestos: 456_000, ventas_con_impuestos: 2_856_000, documentos: 2, ticket_promedio: 1_200_000 },
      { mes: "2026-03", ventas_netas: 800_000, impuestos: 152_000, ventas_con_impuestos: 952_000, documentos: 1, ticket_promedio: 800_000 },
    ]);
    expect(d.resumen).toMatchObject({ ventas_netas: 4_200_000, documentos: 4 });
  });

  it("agrupa por cliente con NIT y por vendedor, de mayor a menor", async () => {
    const { llamar } = await preparar();
    const clientes = await llamar("ventas_por_periodo", { desde: "2026-01-01", hasta: "2026-12-31", agrupar_por: "cliente" });
    expect(clientes.filas.map((f: Fila) => [f.cliente_nombre, f.nit, f.ventas_netas])).toEqual([
      ["Ferretería La Esquina", "71234567", 2_500_000],
      ["Distribuidora El Sol SAS", "800111222-3", 1_700_000],
    ]);
    const vendedores = await llamar("ventas_por_periodo", { desde: "2026-01-01", hasta: "2026-12-31", agrupar_por: "vendedor" });
    expect(vendedores.filas.map((f: Fila) => [f.vendedor_nombre, f.ventas_netas])).toEqual([
      ["(sin vendedor)", 2_500_000],
      ["Ana Vendedora", 1_700_000],
    ]);
  });

  it("sin notas crédito suma solo facturas", async () => {
    const { llamar } = await preparar();
    const d = await llamar("ventas_por_periodo", { desde: "2026-01-01", hasta: "2026-12-31", incluir_notas_credito: false });
    expect(d.resumen.ventas_netas).toBe(4_300_000);
  });
});

describe("cartera_por_edades y cuentas_por_pagar", () => {
  it("agrupa la cartera por cliente y tramo de mora", async () => {
    const { llamar } = await preparar();
    const d = await llamar("cartera_por_edades", { fecha_referencia: "2026-05-01" });
    expect(d.filas).toEqual([
      {
        tercero_id: 11,
        tercero_nombre: "Ferretería La Esquina",
        nit: "71234567",
        corriente: 0,
        dias_1_30: 0,
        dias_31_60: 1_975_000,
        dias_61_90: 0,
        mas_de_90: 500_000,
        sin_vencimiento: 0,
        total_vencido: 2_475_000,
        total: 2_475_000,
      },
      {
        tercero_id: 10,
        tercero_nombre: "Distribuidora El Sol SAS",
        nit: "800111222-3",
        corriente: 0,
        dias_1_30: 952_000,
        dias_31_60: 0,
        dias_61_90: -119_000,
        mas_de_90: 0,
        sin_vencimiento: 0,
        total_vencido: 833_000,
        total: 833_000,
      },
    ]);
    expect(d.resumen).toMatchObject({ total: 3_308_000, total_vencido: 3_308_000, porcentaje_vencido: 100, terceros: 2 });
  });

  it("con otra fecha de referencia cambia el tramo", async () => {
    const { llamar } = await preparar();
    const d = await llamar("cartera_por_edades", { fecha_referencia: "2026-04-01" });
    expect(d.resumen).toMatchObject({ corriente: 952_000, dias_1_30: 1_975_000, dias_31_60: -119_000, mas_de_90: 500_000 });
  });

  it("detalle por documento con días de mora", async () => {
    const { llamar } = await preparar();
    const d = await llamar("cartera_por_edades", { fecha_referencia: "2026-05-01", detalle: "documento" });
    expect(d.filas.map((f: Fila) => [f.documento, f.dias_mora, f.tramo, f.saldo])).toEqual([
      ["FEV-2025-2", 182, "mas_de_90", 500_000],
      ["NC-0001", 80, "dias_61_90", -119_000],
      ["FEV-0002", 57, "dias_31_60", 1_975_000],
      ["FEV-0003", 12, "dias_1_30", 952_000],
    ]);
    expect(d.total_registros).toBe(4);
  });

  it("cuentas por pagar presenta los saldos de proveedores en positivo", async () => {
    const { llamar } = await preparar();
    const d = await llamar("cuentas_por_pagar", { fecha_referencia: "2026-05-01" });
    expect(d.filas).toHaveLength(1);
    expect(d.filas[0]).toMatchObject({ tercero_nombre: "Papelería Central Ltda", dias_61_90: 349_500, total: 349_500 });
  });

  it("filtra por tercero", async () => {
    const { llamar } = await preparar();
    const d = await llamar("cartera_por_edades", { fecha_referencia: "2026-05-01", tercero: "Sol" });
    expect(d.filas.map((f: Fila) => f.tercero_nombre)).toEqual(["Distribuidora El Sol SAS"]);
  });
});

describe("balance_de_prueba", () => {
  it("calcula saldo inicial, movimientos y saldo final por cuenta, y cuadra", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_de_prueba", { desde: "2026-01-01", hasta: "2026-03-31" });
    const bancos = buscar(d.filas, "codigo", "111005");
    expect(bancos).toMatchObject({ nombre: "Bancos nacionales", saldo_inicial: 8_790_000, debito: 2_220_000, credito: 620_000, saldo_final: 10_390_000 });
    const clientes = buscar(d.filas, "codigo", "130505");
    expect(clientes).toMatchObject({ saldo_inicial: 500_000, saldo_final: 3_308_000 });
    const ventas = buscar(d.filas, "codigo", "413505");
    // Las cuentas de resultados arrancan en cero al inicio del ejercicio.
    expect(ventas).toMatchObject({ saldo_inicial: 0, debito: 100_000, credito: 4_300_000, saldo_final: -4_200_000 });
    // La utilidad de 2025 sin asiento de cierre aparece como fila calculada.
    expect(buscar(d.filas, "codigo", "RESULTADOS-ANTERIORES")).toMatchObject({ saldo_inicial: -1_100_000 });
    expect(d.resumen).toMatchObject({ cuadra: true, suma_saldos_iniciales: 0, suma_saldos_finales: 0 });
    expect(d.resumen.total_debito).toBe(d.resumen.total_credito);
    // No incluye el borrador (999.999) ni la otra empresa.
    expect(buscar(d.filas, "codigo", "510506")).toMatchObject({ debito: 600_000 });
  });

  it("dentro del ejercicio, el saldo inicial de resultados acumula desde el inicio del año", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_de_prueba", { desde: "2026-03-01", hasta: "2026-03-31" });
    expect(buscar(d.filas, "codigo", "413505")).toMatchObject({ saldo_inicial: -3_400_000, saldo_final: -4_200_000 });
    expect(d.resumen.suma_saldos_iniciales).toBe(0);
  });

  it("agrega por clase del PUC con nombres", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_de_prueba", { desde: "2026-01-01", hasta: "2026-03-31", nivel: "clase" });
    expect(d.filas.map((f: Fila) => [f.codigo, f.nombre, f.saldo_final])).toEqual([
      ["1", "Activo", 15_748_000],
      ["2", "Pasivo", -1_388_000],
      ["3", "Patrimonio", -10_000_000],
      ["4", "Ingresos", -4_230_000],
      ["5", "Gastos", 770_000],
      ["6", "Costos de ventas", 200_000],
      ["RESULTADOS-ANTERIORES", "Resultados de ejercicios anteriores sin asiento de cierre (calculado)", -1_100_000],
    ]);
  });

  it("filtra por prefijo de cuenta", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_de_prueba", { desde: "2026-01-01", hasta: "2026-03-31", cuenta: "24" });
    expect(d.filas.map((f: Fila) => f.codigo)).toEqual(["240405", "240805", "240810"]);
  });
});

describe("estado_de_resultados", () => {
  it("calcula secciones, utilidades y márgenes", async () => {
    const { llamar } = await preparar();
    const d = await llamar("estado_de_resultados", { desde: "2026-01-01", hasta: "2026-03-31", nivel: "subcuenta" });
    expect(d.resumen).toMatchObject({
      ingresos_operacionales: 4_200_000,
      costo_ventas: 200_000,
      utilidad_bruta: 4_000_000,
      gastos_operacionales: 650_000,
      utilidad_operacional: 3_350_000,
      otros_ingresos: 30_000,
      otros_gastos: 20_000,
      utilidad_antes_de_impuestos: 3_360_000,
      impuesto_renta: 100_000,
      utilidad_neta: 3_260_000,
      margen_neto_pct: 77.62,
    });
    expect(d.filas.map((f: Fila) => [f.seccion, f.codigo, f.valor])).toEqual([
      ["Ingresos operacionales", "413505", 4_200_000],
      ["Costo de ventas", "613505", 200_000],
      ["Gastos operacionales", "510506", 600_000],
      ["Depreciaciones y amortizaciones", "516005", 50_000],
      ["Otros ingresos", "421005", 30_000],
      ["Otros gastos", "530505", 20_000],
      ["Impuesto de renta", "540405", 100_000],
    ]);
  });

  it("compara con el mismo período del año anterior", async () => {
    const { llamar } = await preparar();
    const d = await llamar("estado_de_resultados", {
      desde: "2026-01-01",
      hasta: "2026-12-31",
      nivel: "grupo",
      comparar: "mismo_periodo_ano_anterior",
    });
    const ingresos = d.filas.find((f: Fila) => f.seccion === "Ingresos operacionales");
    expect(ingresos).toMatchObject({ codigo: "41", nombre: "Ingresos operacionales", valor: 4_200_000, valor_comparativo: 1_500_000, variacion: 2_700_000, variacion_pct: 180 });
    expect(d.resumen.comparativo).toMatchObject({ periodo: "2025-01-01 a 2025-12-31", utilidad_neta: 1_100_000 });
  });

  it("desglosa por mes para graficar", async () => {
    const { llamar } = await preparar();
    const d = await llamar("estado_de_resultados", { desde: "2026-01-01", hasta: "2026-03-31", nivel: "clase", por_mes: true });
    expect(d.resumen.mensual.map((m: Fila) => [m.mes, m.ingresos_operacionales, m.utilidad_neta])).toEqual([
      ["2026-01", 1_000_000, 1_000_000],
      ["2026-02", 2_400_000, 1_800_000],
      ["2026-03", 800_000, 460_000],
    ]);
    expect(d.filas[0]).toHaveProperty("mes", "2026-01");
  });

  it("no permite por_mes y comparar a la vez", async () => {
    const { llamarError } = await preparar();
    expect(
      await llamarError("estado_de_resultados", { desde: "2026-01-01", hasta: "2026-03-31", por_mes: true, comparar: "periodo_anterior" }),
    ).toMatch(/no ambos/);
  });
});

describe("balance_general", () => {
  it("presenta activo, pasivo y patrimonio con el resultado calculado, y cuadra", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_general", { fecha_corte: "2026-03-31", nivel: "auxiliar" });
    expect(d.resumen).toMatchObject({
      inicio_ejercicio: "2026-01-01",
      activo_corriente: 13_798_000,
      activo_no_corriente: 1_950_000,
      total_activo: 15_748_000,
      pasivo_corriente: 1_388_000,
      total_pasivo: 1_388_000,
      total_patrimonio: 14_360_000,
      cuadra: true,
      capital_de_trabajo: 12_410_000,
    });
    expect(buscar(d.filas, "codigo", "RESULTADO-EJERCICIO")).toMatchObject({ seccion: "Patrimonio", saldo: 3_260_000 });
    expect(buscar(d.filas, "codigo", "RESULTADOS-ANTERIORES")).toMatchObject({ saldo: 1_100_000 });
    expect(buscar(d.filas, "codigo", "159205")).toMatchObject({ seccion: "Activo no corriente", saldo: -50_000 });
    // Sin cuentas de resultados como filas sueltas.
    expect(d.filas.some((f: Fila) => String(f.codigo).startsWith("4"))).toBe(false);
  });

  it("compara contra otra fecha de corte", async () => {
    const { llamar } = await preparar();
    const d = await llamar("balance_general", { fecha_corte: "2026-03-31", comparar_con: "2025-12-31", nivel: "grupo" });
    expect(buscar(d.filas, "codigo", "11")).toMatchObject({ nombre: "Disponible (efectivo y equivalentes)", saldo: 10_390_000, saldo_comparativo: 8_790_000, variacion: 1_600_000 });
    expect(d.resumen.comparativo).toMatchObject({ total_activo: 11_290_000, cuadra: true });
  });

  it("usa los grupos de cuentas de Odoo para nombrar niveles cuando existen", async () => {
    const { llamar } = await preparar({}, true);
    const d = await llamar("balance_general", { fecha_corte: "2026-03-31", nivel: "cuenta" });
    expect(buscar(d.filas, "codigo", "1110").nombre).toBe("Bancos");
  });
});

describe("gastos_por_cuenta", () => {
  it("agrupa la clase 5 por cuenta y mes", async () => {
    const { llamar } = await preparar();
    const d = await llamar("gastos_por_cuenta", { desde: "2026-01-01", hasta: "2026-03-31" });
    expect(d.filas.map((f: Fila) => [f.mes, f.codigo, f.valor])).toEqual([
      ["2026-02", "5105", 600_000],
      ["2026-03", "5404", 100_000],
      ["2026-03", "5160", 50_000],
      ["2026-03", "5305", 20_000],
    ]);
    // Sin grupos de Odoo: con una sola cuenta debajo, usa su nombre.
    expect(d.filas[0].nombre).toBe("Sueldos");
    expect(d.resumen).toMatchObject({ total: 770_000, por_mes: [{ mes: "2026-02", valor: 600_000 }, { mes: "2026-03", valor: 170_000 }] });
  });

  it("por tipo de gasto de Odoo, con costos", async () => {
    const { llamar } = await preparar();
    const d = await llamar("gastos_por_cuenta", { desde: "2026-01-01", hasta: "2026-03-31", criterio: "gastos_y_costos", por_mes: false, nivel: "auxiliar" });
    expect(d.resumen.total).toBe(970_000);
    expect(d.filas[0]).toEqual({ codigo: "510506", nombre: "Sueldos", valor: 600_000 });
  });
});

describe("impuestos", () => {
  it("separa IVA generado, descontable y retenciones con su base", async () => {
    const { llamar } = await preparar();
    const d = await llamar("impuestos", { desde: "2026-01-01", hasta: "2026-03-31" });
    expect(d.resumen).toMatchObject({
      impuesto_generado: 798_000,
      impuesto_descontable: 57_000,
      saldo_a_pagar: 741_000,
      retenciones_practicadas_por_pagar: 7_500,
      retenciones_que_le_practicaron: 0,
    });
    expect(buscar(d.filas, "impuesto", "IVA 19% ventas")).toMatchObject({ base: 4_200_000, valor: 798_000, uso: "Ventas", tasa: 19 });
    expect(buscar(d.filas, "impuesto", "ReteFte 2,5% compras")).toMatchObject({ base: 300_000, valor: 7_500, naturaleza: "Retención practicada a terceros (por pagar)" });
  });

  it("agrupa por cuenta contable", async () => {
    const { llamar } = await preparar();
    const d = await llamar("impuestos", { desde: "2026-01-01", hasta: "2026-03-31", agrupar_por: "cuenta" });
    expect(d.filas.map((f: Fila) => [f.codigo, f.saldo_neto])).toEqual([
      ["236540", 7_500],
      ["240805", 798_000],
      ["240810", -57_000],
    ]);
  });
});

describe("inventario", () => {
  it("suma existencias internas por producto con valor contable", async () => {
    const { llamar } = await preparar();
    const d = await llamar("inventario");
    expect(d.filas.map((f: Fila) => [f.referencia, f.cantidad, f.reservada, f.disponible, f.valor, f.costo_unitario])).toEqual([
      ["CUA-01", 40, 5, 35, 88_000, 2_200],
      ["RES-03", 4, 0, 4, 60_000, 15_000],
      ["LAP-02", 40, 0, 40, 40_000, 1_000],
    ]);
    expect(d.resumen).toMatchObject({ valor_total: 188_000, valor_es_estimado: false });
  });

  it("estima el valor con el costo si el usuario no puede ver el valor contable", async () => {
    const { llamar } = await preparar({ camposRestringidos: { "stock.quant": ["value"] } });
    const d = await llamar("inventario", { agrupar_por: "categoria" });
    expect(d.filas).toEqual([
      { categoria: "Papelería", productos_unidades: 80, valor: 120_000 },
      { categoria: "Insumos", productos_unidades: 4, valor: 60_000 },
    ]);
    expect(d.resumen.valor_es_estimado).toBe(true);
    expect(d.avisos.join(" ")).toMatch(/Administrador de Inventario/);
  });

  it("filtra por ubicación y producto", async () => {
    const { llamar } = await preparar();
    const d = await llamar("inventario", { agrupar_por: "producto_ubicacion", ubicacion: "WH2", producto: "cuaderno" });
    expect(d.filas).toEqual([
      expect.objectContaining({ referencia: "CUA-01", ubicacion: "WH2/Stock", cantidad: 10, valor: 22_000 }),
    ]);
  });

  it("avisa si el módulo de inventario no está instalado", async () => {
    const datos = datosContables();
    delete datos["stock.quant"];
    const m = montar({ datos });
    const { access_token } = await conectar(m.app, m.mock.clave);
    const r = await herramienta(m.app, access_token, "inventario");
    expect(r.isError).toBe(true);
    expect(r.texto).toBe("El módulo de Inventario no está instalado en esta base de Odoo.");
  });
});

describe("consulta_avanzada", () => {
  it("lee un modelo permitido con filas planas", async () => {
    const { llamar } = await preparar();
    const d = await llamar("consulta_avanzada", {
      modelo: "account.move",
      dominio: [["move_type", "=", "out_invoice"], ["state", "=", "posted"]],
      campos: ["name", "partner_id", "amount_total"],
      orden: "name asc",
      empresa: 1,
    });
    expect(d.filas[0]).toEqual({ id: 100, name: "FEV-0001", partner_id: 10, partner_nombre: "Distribuidora El Sol SAS", amount_total: 1_190_000 });
    expect(d.total_registros).toBe(3);
  });

  it("rechaza modelos fuera de la lista blanca", async () => {
    const { llamarError } = await preparar();
    expect(await llamarError("consulta_avanzada", { modelo: "res.users", campos: ["login"] })).toMatch(/no está permitido/);
    expect(await llamarError("consulta_avanzada", { modelo: "ir.config_parameter", campos: ["value"] })).toMatch(/no está permitido/);
  });

  it("explica cuando el módulo del modelo no está instalado", async () => {
    const { llamarError } = await preparar();
    expect(await llamarError("consulta_avanzada", { modelo: "sale.order", campos: ["name"] })).toMatch(/módulo/);
  });

  it("valida dominio, campos y orden", () => {
    expect(() => validarDominio([["name", "ilike", "x"], "|", ["a", "=", 1], ["b", "=", 2]])).not.toThrow();
    expect(() => validarDominio([["partner_id.vat", "in", ["1", "2"]]])).not.toThrow();
    expect(() => validarDominio([["partner_id", "any", [["vat", "=", "1"]]]])).toThrow(/Operador/);
    expect(() => validarDominio([["name", "DROP", "x"]])).toThrow(/Operador/);
    expect(() => validarDominio([["name; select", "=", "x"]])).toThrow(/campo/);
    expect(() => validarDominio("[]")).toThrow(/lista/);
    expect(() => validarDominio([["a", "="]])).toThrow(/Condición/);
  });

  it("rechaza nombres de campo u orden extraños", async () => {
    const { llamarError } = await preparar();
    expect(await llamarError("consulta_avanzada", { modelo: "res.partner", campos: ["name", "x;y"] })).toMatch(/campo no válido/);
    expect(await llamarError("consulta_avanzada", { modelo: "res.partner", campos: ["name"], orden: "name; drop" })).toMatch(/Orden no válido/);
  });
});

describe("lista de herramientas", () => {
  it("expone las 12 herramientas, todas de solo lectura y con descripción en español", async () => {
    const m = montar({ datos: datosContables() });
    const { access_token } = await conectar(m.app, m.mock.clave);
    const r = await m.app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = (await r.json()) as { result: { tools: { name: string; description: string; annotations: Record<string, boolean> }[] } };
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "balance_de_prueba",
      "balance_general",
      "cartera_por_edades",
      "consulta_avanzada",
      "cuentas_por_pagar",
      "empresas",
      "estado_de_resultados",
      "facturas",
      "gastos_por_cuenta",
      "impuestos",
      "inventario",
      "ventas_por_periodo",
    ]);
    for (const t of result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.description.length).toBeGreaterThan(100);
      expect(t.description).toMatch(/devuelve/i);
    }
  });
});
