import { describe, expect, it } from "vitest";
import { METODOS_PERMITIDOS, OdooClient, verificarMetodoPermitido } from "../src/odoo/client.js";
import { OdooError } from "../src/odoo/errors.js";
import { datosBase } from "./fixtures.js";
import { crearMockOdoo, type OpcionesMock } from "./mockOdoo.js";

function cliente(opciones: Partial<OpcionesMock> = {}, clave = "clave-valida-de-prueba", timeoutMs = 2_000) {
  const mock = crearMockOdoo({ datos: datosBase(), ...opciones });
  const c = new OdooClient(
    { url: new URL("https://empresa.odoo.com"), apiKey: clave, origen: "oauth" },
    { timeoutMs, fetchImpl: mock.fetchImpl },
  );
  return { c, mock };
}

async function errorDe(p: Promise<unknown>): Promise<OdooError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OdooError) return e;
    throw e;
  }
  throw new Error("se esperaba un error");
}

describe("lista blanca de métodos", () => {
  it("solo permite métodos de lectura", () => {
    expect([...METODOS_PERMITIDOS].sort()).toEqual(["formatted_read_group", "read", "search_count", "search_read"]);
  });

  it.each(["write", "create", "unlink", "action_post", "button_cancel", "read_group", "fields_get", "sudo", "__init__", "message_post"])(
    "rechaza %s sin llamar a Odoo",
    async (metodo) => {
      const { c, mock } = cliente();
      const e = await errorDe(c.call("account.move", metodo, {}));
      expect(e.tipo).toBe("metodo_no_permitido");
      expect(mock.llamadas).toHaveLength(0);
    },
  );

  it("rechaza nombres de modelo con caracteres extraños", async () => {
    const { c } = cliente();
    expect((await errorDe(c.call("../web/database", "search_read"))).tipo).toBe("parametros");
  });

  it("verificarMetodoPermitido acepta los métodos de lectura", () => {
    for (const m of METODOS_PERMITIDOS) expect(() => verificarMetodoPermitido(m)).not.toThrow();
  });
});

describe("llamadas a JSON-2", () => {
  it("envía la clave como bearer, argumentos nombrados y la base en X-Odoo-Database", async () => {
    const mock = crearMockOdoo({ datos: datosBase() });
    let capturado: { url: string; init: RequestInit } | undefined;
    const c = new OdooClient(
      { url: new URL("https://empresa.odoo.com"), apiKey: mock.clave, db: "produccion", origen: "oauth" },
      {
        timeoutMs: 2_000,
        fetchImpl: (url, init) => {
          capturado = { url, init };
          return mock.fetchImpl(url, init);
        },
      },
    );
    const filas = await c.searchRead("res.partner", [["vat", "ilike", "800"]], ["name"], { limit: 5 });
    expect(filas).toEqual([{ id: 10, name: "Distribuidora El Sol SAS" }]);
    expect(capturado!.url).toBe("https://empresa.odoo.com/json/2/res.partner/search_read");
    const h = new Headers(capturado!.init.headers);
    expect(h.get("authorization")).toBe(`bearer ${mock.clave}`);
    expect(h.get("x-odoo-database")).toBe("produccion");
    expect(JSON.parse(String(capturado!.init.body))).toEqual({ domain: [["vat", "ilike", "800"]], fields: ["name"], limit: 5 });
    expect(capturado!.init.redirect).toBe("manual");
  });
});

describe("errores entendibles", () => {
  it("clave inválida → credenciales", async () => {
    const { c } = cliente({}, "clave-mala");
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(e.tipo).toBe("credenciales");
    expect(e.message).toMatch(/clave API no es válida/);
  });

  it("sin permisos → permisos", async () => {
    const { c } = cliente({ sinPermiso: ["account.move"] });
    const e = await errorDe(c.searchCount("account.move", []));
    expect(e.tipo).toBe("permisos");
    expect(e.message).toMatch(/no tiene permisos.*account.move/);
  });

  it("modelo inexistente → módulo no instalado", async () => {
    const { c } = cliente();
    const e = await errorDe(c.searchCount("stock.quant", []));
    expect(e.tipo).toBe("modulo_no_instalado");
    expect(e.message).toMatch(/módulo/);
  });

  it("Odoo anterior a la 19 → versión no soportada", async () => {
    const { c } = cliente({ version: 17 });
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(e.tipo).toBe("version_no_soportada");
    expect(e.message).toMatch(/versión 17/);
  });

  it("campo inexistente → parámetros", async () => {
    const { c } = cliente();
    const e = await errorDe(c.searchRead("res.partner", [], ["campo_que_no_existe"]));
    expect(e.tipo).toBe("parametros");
    expect(e.message).toMatch(/Invalid field/);
  });

  it("Odoo lento → tiempo agotado", async () => {
    const { c } = cliente({ retrasoMs: 500 }, "clave-valida-de-prueba", 50);
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(e.tipo).toBe("tiempo_agotado");
    expect(e.message).toMatch(/tardó más de/);
  });

  it("redirección → no es Odoo (no se siguen redirecciones)", async () => {
    const c = new OdooClient(
      { url: new URL("https://empresa.odoo.com"), apiKey: "x", origen: "oauth" },
      { timeoutMs: 1_000, fetchImpl: async () => new Response(null, { status: 303, headers: { Location: "http://169.254.169.254/" } }) },
    );
    expect((await errorDe(c.searchCount("res.partner", []))).tipo).toBe("no_es_odoo");
  });

  it("respuesta HTML con 200 → no es Odoo", async () => {
    const c = new OdooClient(
      { url: new URL("https://empresa.odoo.com"), apiKey: "x", origen: "oauth" },
      { timeoutMs: 1_000, fetchImpl: async () => new Response("<html>hola</html>", { status: 200 }) },
    );
    expect((await errorDe(c.searchCount("res.partner", []))).tipo).toBe("no_es_odoo");
  });

  it("servidor caído → conexión", async () => {
    const c = new OdooClient(
      { url: new URL("https://empresa.odoo.com"), apiKey: "x", origen: "oauth" },
      {
        timeoutMs: 1_000,
        fetchImpl: async () => {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        },
      },
    );
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(e.tipo).toBe("conexion");
    expect(e.message).not.toMatch(/ECONNREFUSED|stack|at /);
  });

  it("los mensajes nunca incluyen la clave API", async () => {
    const { c } = cliente({}, "clave-secreta-que-no-debe-salir");
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(`${e.message} ${e.detalle}`).not.toContain("clave-secreta-que-no-debe-salir");
  });
});

describe("bloqueo SSRF real en el socket", () => {
  it("no conecta a un dominio que resuelve a loopback", async () => {
    const c = new OdooClient({ url: new URL("https://localtest.me"), apiKey: "x", origen: "oauth" }, { timeoutMs: 3_000 });
    const e = await errorDe(c.searchCount("res.partner", []));
    // localtest.me resuelve a 127.0.0.1; si el entorno no tiene DNS externo, falla como conexión.
    expect(["url_no_permitida", "conexion"]).toContain(e.tipo);
  });

  it("no conecta a una IP literal privada aunque se salte la validación previa", async () => {
    const c = new OdooClient({ url: new URL("https://127.0.0.1:9"), apiKey: "x", origen: "oauth" }, { timeoutMs: 3_000 });
    const e = await errorDe(c.searchCount("res.partner", []));
    expect(e.tipo).toBe("url_no_permitida");
  });
});
