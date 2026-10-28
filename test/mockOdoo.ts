// Odoo 19 simulado para pruebas: implementa POST /json/2/<modelo>/<metodo> para
// search_read, search_count, read y formatted_read_group sobre datos en memoria,
// con evaluación básica de dominios. Las respuestas de error imitan las de
// odoo/http.py (Json2Dispatcher) y addons/rpc/controllers/json2.py.

import http from "node:http";

export type Registro = Record<string, unknown> & { id: number };
export type Datos = Record<string, Registro[]>;

export interface OpcionesMock {
  datos: Datos;
  clave?: string;
  /** Simula un Odoo anterior a la 19 (sin /json/2). */
  version?: number;
  /** Modelos que devuelven 403 (sin permisos). */
  sinPermiso?: string[];
  /** Retraso artificial en ms. */
  retrasoMs?: number;
  /** Campos que devuelven 403 al leerlos (p. ej. stock.quant.value sin ser administrador). */
  camposRestringidos?: Record<string, string[]>;
}

export interface LlamadaRegistrada {
  modelo: string;
  metodo: string;
  cuerpo: Record<string, unknown>;
}

// ── Dominios ────────────────────────────────────────────────────────────────

function valorRuta(datos: Datos, modelo: string, reg: Registro, ruta: string): unknown {
  const [campo, ...resto] = ruta.split(".");
  const valor = reg[campo];
  if (!resto.length) return Array.isArray(valor) && valor.length === 2 && typeof valor[0] === "number" ? valor[0] : valor;
  if (!Array.isArray(valor) || typeof valor[0] !== "number") return undefined;
  const comodelo = RELACIONES[`${modelo}.${campo}`];
  const relacionado = datos[comodelo]?.find((r) => r.id === valor[0]);
  return relacionado ? valorRuta(datos, comodelo, relacionado, resto.join(".")) : undefined;
}

const RELACIONES: Record<string, string> = {
  "account.move.partner_id": "res.partner",
  "account.move.line.partner_id": "res.partner",
  "account.move.line.account_id": "account.account",
  "account.move.line.move_id": "account.move",
  "stock.quant.product_id": "product.product",
  "stock.quant.location_id": "stock.location",
  "account.move.line.tax_line_id": "account.tax",
};

function cumpleHoja(datos: Datos, modelo: string, reg: Registro, hoja: unknown[]): boolean {
  const [ruta, op, valor] = hoja as [string, string, unknown];
  const actual = valorRuta(datos, modelo, reg, ruta);
  switch (op) {
    case "=":
      return valor === false ? actual === false || actual === undefined || actual === null : actual === valor;
    case "!=":
      return actual !== valor;
    case "in":
      return (valor as unknown[]).includes(actual);
    case "not in":
      return !(valor as unknown[]).includes(actual);
    case ">=":
      return actual !== false && (actual as string | number) >= (valor as string | number);
    case "<=":
      return actual !== false && (actual as string | number) <= (valor as string | number);
    case ">":
      return actual !== false && (actual as string | number) > (valor as string | number);
    case "<":
      return actual !== false && (actual as string | number) < (valor as string | number);
    case "ilike":
      return typeof actual === "string" && actual.toLowerCase().includes(String(valor).toLowerCase());
    case "=like":
    case "=ilike": {
      const patron = new RegExp(`^${String(valor).replace(/%/g, ".*").replace(/_/g, ".")}$`, op === "=ilike" ? "i" : "");
      return typeof actual === "string" && patron.test(actual);
    }
    default:
      throw new Error(`Invalid leaf ${JSON.stringify(hoja)}`);
  }
}

export function evaluarDominio(datos: Datos, modelo: string, reg: Registro, dominio: unknown[]): boolean {
  // Notación polaca: '&' y '|' binarios, '!' unario; '&' implícito entre términos.
  let i = 0;
  const termino = (): boolean => {
    const t = dominio[i++];
    if (t === "&") return termino() && termino();
    if (t === "|") {
      const a = termino();
      const b = termino();
      return a || b;
    }
    if (t === "!") return !termino();
    return cumpleHoja(datos, modelo, reg, t as unknown[]);
  };
  let resultado = true;
  while (i < dominio.length) resultado = termino() && resultado;
  return resultado;
}

// ── Agrupación (formatted_read_group) ───────────────────────────────────────

function claveGrupo(reg: Registro, spec: string): unknown {
  const [campo, granularidad] = spec.split(":");
  const valor = reg[campo];
  if (!granularidad) return valor ?? false;
  if (!valor) return false;
  const fecha = String(valor);
  if (granularidad === "month") return [`${fecha.slice(0, 7)}-01`, fecha.slice(0, 7)];
  if (granularidad === "year") return [`${fecha.slice(0, 4)}-01-01`, fecha.slice(0, 4)];
  if (granularidad === "day") return [fecha, fecha];
  throw new Error(`${granularidad} isn't a valid granularity`);
}

function agrupar(registros: Registro[], groupby: string[], aggregates: string[]): Record<string, unknown>[] {
  const grupos = new Map<string, { claves: unknown[]; regs: Registro[] }>();
  for (const r of registros) {
    const claves = groupby.map((g) => claveGrupo(r, g));
    const k = JSON.stringify(claves);
    if (!grupos.has(k)) grupos.set(k, { claves, regs: [] });
    grupos.get(k)!.regs.push(r);
  }
  if (groupby.length === 0 && grupos.size === 0) grupos.set("[]", { claves: [], regs: [] });
  return [...grupos.values()].map(({ claves, regs }) => {
    const fila: Record<string, unknown> = { __extra_domain: [] };
    groupby.forEach((g, i) => (fila[g] = claves[i]));
    for (const agg of aggregates) {
      if (agg === "__count") {
        fila.__count = regs.length;
        continue;
      }
      const [campo, fn] = agg.split(":");
      const valores = regs.map((r) => Number(r[campo] ?? 0));
      fila[agg] =
        fn === "sum"
          ? valores.reduce((a, b) => a + b, 0)
          : fn === "max"
            ? Math.max(...valores)
            : fn === "min"
              ? Math.min(...valores)
              : null;
    }
    return fila;
  });
}

function ordenar(registros: Registro[], orden?: string): Registro[] {
  if (!orden) return registros;
  const criterios = orden.split(",").map((s) => {
    const [campo, dir] = s.trim().split(/\s+/);
    return { campo, desc: dir?.toLowerCase() === "desc" };
  });
  return [...registros].sort((a, b) => {
    for (const { campo, desc } of criterios) {
      const va = Array.isArray(a[campo]) ? (a[campo] as unknown[])[1] : a[campo];
      const vb = Array.isArray(b[campo]) ? (b[campo] as unknown[])[1] : b[campo];
      if (va === vb) continue;
      const cmp = String(va ?? "") < String(vb ?? "") ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

function filtrarEmpresa(registros: Registro[], context: Record<string, unknown> | undefined): Registro[] {
  const permitidas = context?.allowed_company_ids as number[] | undefined;
  if (!permitidas) return registros;
  return registros.filter((r) => {
    const c = r.company_id;
    return !Array.isArray(c) || permitidas.includes(c[0] as number);
  });
}

function proyectar(reg: Registro, campos: string[] | undefined, modelo: string): Record<string, unknown> {
  if (!campos || campos.length === 0) return { ...reg };
  const salida: Record<string, unknown> = { id: reg.id };
  for (const c of campos) {
    if (!(c in reg)) throw new Error(`Invalid field '${c}' on model '${modelo}'`);
    salida[c] = reg[c];
  }
  return salida;
}

// ── Manejador ───────────────────────────────────────────────────────────────

const json = (status: number, cuerpo: unknown) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "Content-Type": "application/json" } });

const errorOdoo = (status: number, name: string, message: string) =>
  json(status, { name, message, arguments: [message], context: {}, debug: "Traceback (simulado)" });

export function crearMockOdoo(opciones: OpcionesMock) {
  const clave = opciones.clave ?? "clave-valida-de-prueba";
  const llamadas: LlamadaRegistrada[] = [];

  async function manejar(url: string, init: RequestInit): Promise<Response> {
    if (opciones.retrasoMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opciones.retrasoMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
        });
      });
    }
    const u = new URL(url);
    if (u.pathname === "/web/version") {
      const v = opciones.version ?? 19;
      return json(200, { version: `${v}.0`, version_info: [v, 0, 0, "final", 0, ""] });
    }
    const m = u.pathname.match(/^\/json\/2\/([^/]+)\/([^/]+)$/);
    if (!m || (opciones.version ?? 19) < 19) {
      return new Response("<html><body>404 Not Found</body></html>", { status: 404, headers: { "Content-Type": "text/html" } });
    }
    const [, modelo, metodo] = m;
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `bearer ${clave}`) {
      return errorOdoo(401, "odoo.exceptions.AccessDenied", "Access Denied");
    }
    const cuerpo = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    llamadas.push({ modelo, metodo, cuerpo });

    const tabla = opciones.datos[modelo];
    if (!tabla) return errorOdoo(404, "werkzeug.exceptions.NotFound", `the model '${modelo}' does not exist`);
    if (opciones.sinPermiso?.includes(modelo)) {
      return errorOdoo(403, "odoo.exceptions.AccessError", `You are not allowed to access '${modelo}' records.`);
    }

    const restringidos = opciones.camposRestringidos?.[modelo] ?? [];
    const pedidos = (cuerpo.fields as string[] | undefined) ?? [];
    const prohibido = pedidos.find((c) => restringidos.includes(c));
    if (prohibido) {
      return errorOdoo(403, "odoo.exceptions.AccessError", `You do not have enough rights to access the field "${prohibido}" on ${modelo}.`);
    }

    const context = cuerpo.context as Record<string, unknown> | undefined;
    try {
      const base = filtrarEmpresa(tabla, context);
      const dominio = (cuerpo.domain as unknown[]) ?? [];
      switch (metodo) {
        case "search_read": {
          let regs = ordenar(base.filter((r) => evaluarDominio(opciones.datos, modelo, r, dominio)), cuerpo.order as string);
          regs = regs.slice((cuerpo.offset as number) ?? 0);
          if (cuerpo.limit) regs = regs.slice(0, cuerpo.limit as number);
          return json(200, regs.map((r) => proyectar(r, cuerpo.fields as string[], modelo)));
        }
        case "search_count":
          return json(200, base.filter((r) => evaluarDominio(opciones.datos, modelo, r, dominio)).length);
        case "read": {
          const ids = (cuerpo.ids as number[]) ?? [];
          return json(200, base.filter((r) => ids.includes(r.id)).map((r) => proyectar(r, cuerpo.fields as string[], modelo)));
        }
        case "formatted_read_group": {
          const regs = base.filter((r) => evaluarDominio(opciones.datos, modelo, r, dominio));
          return json(200, agrupar(regs, (cuerpo.groupby as string[]) ?? [], (cuerpo.aggregates as string[]) ?? []));
        }
        default:
          return errorOdoo(404, "werkzeug.exceptions.NotFound", `The method '${metodo}' does not exist on the model '${modelo}'`);
      }
    } catch (err) {
      return errorOdoo(500, "builtins.ValueError", (err as Error).message);
    }
  }

  const fetchImpl = (url: string, init: RequestInit) => manejar(url, init);

  /** Levanta el mock como servidor HTTP real (para MCP Inspector). */
  function escuchar(puerto: number): Promise<http.Server> {
    const servidor = http.createServer(async (req, res) => {
      const partes: Buffer[] = [];
      for await (const p of req) partes.push(p as Buffer);
      const resp = await manejar(`http://127.0.0.1:${puerto}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(partes).toString("utf8"),
      });
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      res.end(await resp.text());
    });
    return new Promise((resolve) => servidor.listen(puerto, "127.0.0.1", () => resolve(servidor)));
  }

  return { fetchImpl, llamadas, escuchar, clave };
}
