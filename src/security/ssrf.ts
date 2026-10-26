// Protección contra SSRF: la URL de Odoo la escribe el usuario, así que antes de
// llamarla hay que asegurarse de que no apunte a la red interna del servidor,
// a localhost ni a los servicios de metadatos de la nube.
//
// Se valida dos veces:
//   1. validarUrlOdoo(): normaliza la URL y resuelve el DNS antes de llamar, para
//      dar un mensaje claro al usuario.
//   2. lookupSeguro(): se usa como `lookup` del socket, de modo que la IP a la que
//      realmente se conecta también se valida (evita DNS rebinding).

import dns from "node:dns";
import net from "node:net";

export class UrlNoPermitidaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "UrlNoPermitidaError";
  }
}

const bloqueadasV4 = new net.BlockList();
for (const [red, prefijo] of [
  ["0.0.0.0", 8], // "esta" red
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT (incluye metadatos de Alibaba 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (metadatos AWS/GCP/Azure 169.254.169.254)
  ["172.16.0.0", 12], // privada
  ["192.0.0.0", 24], // IETF
  ["192.0.2.0", 24], // documentación
  ["192.88.99.0", 24], // relay 6to4
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentación
  ["203.0.113.0", 24], // documentación
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada + broadcast
] as const) {
  bloqueadasV4.addSubnet(red, prefijo, "ipv4");
}

const bloqueadasV6 = new net.BlockList();
for (const [red, prefijo] of [
  ["::", 128], // no especificada
  ["::1", 128], // loopback
  ["100::", 64], // descarte
  ["2001:db8::", 32], // documentación
  ["fc00::", 7], // ULA (incluye fd00:ec2::254, metadatos AWS por IPv6)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (obsoleta)
  ["ff00::", 8], // multicast
] as const) {
  bloqueadasV6.addSubnet(red, prefijo, "ipv6");
}

/** Expande una IPv6 a sus 8 grupos de 16 bits. */
function gruposV6(ip: string): number[] | null {
  let texto = ip.toLowerCase();
  // IPv4 incrustada al final (p. ej. ::ffff:127.0.0.1)
  const v4 = texto.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    texto = texto.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [cabeza, cola] = texto.split("::");
  const a = cabeza ? cabeza.split(":") : [];
  const b = cola !== undefined && cola !== "" ? cola.split(":") : [];
  const faltan = texto.includes("::") ? 8 - a.length - b.length : 0;
  const grupos = [...a, ...Array(faltan).fill("0"), ...b].map((g) => Number.parseInt(g, 16));
  return grupos.length === 8 && grupos.every((g) => Number.isFinite(g)) ? grupos : null;
}

function v4DesdeGrupos(alto: number, bajo: number): string {
  return `${alto >> 8}.${alto & 0xff}.${bajo >> 8}.${bajo & 0xff}`;
}

/** true si la IP no es una dirección pública de internet. */
export function esIpBloqueada(ip: string): boolean {
  const tipo = net.isIP(ip);
  if (tipo === 4) return bloqueadasV4.check(ip, "ipv4");
  if (tipo !== 6) return true; // no es una IP válida: se bloquea por precaución

  const g = gruposV6(ip);
  if (!g) return true;
  // IPv4 mapeada (::ffff:a.b.c.d) o compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: y ::1
    return esIpBloqueada(v4DesdeGrupos(g[6], g[7]));
  }
  // NAT64 (64:ff9b::a.b.c.d)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return esIpBloqueada(v4DesdeGrupos(g[6], g[7]));
  }
  // 6to4 (2002:aabb:ccdd::)
  if (g[0] === 0x2002) return esIpBloqueada(v4DesdeGrupos(g[1], g[2]));
  return bloqueadasV6.check(ip, "ipv6");
}

const SUFIJOS_BLOQUEADOS = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet"];
const NOMBRES_BLOQUEADOS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

export interface OpcionesUrl {
  /** Solo para la URL del .env en desarrollo: permite http:// e IPs privadas. */
  permitirPrivadas?: boolean;
}

/**
 * Normaliza la URL de Odoo (deja solo protocolo + host + puerto) y valida su forma.
 * No resuelve DNS; para eso está validarUrlOdoo().
 */
export function normalizarUrlOdoo(cruda: string, opciones: OpcionesUrl = {}): URL {
  let texto = (cruda ?? "").trim();
  if (!texto) throw new UrlNoPermitidaError("Falta la URL de Odoo.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) texto = `https://${texto}`;

  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    throw new UrlNoPermitidaError(`La URL de Odoo no es válida: "${cruda}".`);
  }

  const esHttp = url.protocol === "http:";
  if (url.protocol !== "https:" && !(esHttp && opciones.permitirPrivadas)) {
    throw new UrlNoPermitidaError("La URL de Odoo debe empezar por https://.");
  }
  if (url.username || url.password) {
    throw new UrlNoPermitidaError("La URL de Odoo no puede incluir usuario ni contraseña.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new UrlNoPermitidaError("La URL de Odoo no tiene dominio.");

  if (!opciones.permitirPrivadas) {
    if (NOMBRES_BLOQUEADOS.has(host) || SUFIJOS_BLOQUEADOS.some((s) => host.endsWith(s))) {
      throw new UrlNoPermitidaError("La URL de Odoo apunta a un servidor interno y no está permitida.");
    }
    if (net.isIP(host)) {
      if (esIpBloqueada(host)) {
        throw new UrlNoPermitidaError("La URL de Odoo apunta a una IP privada o reservada y no está permitida.");
      }
    } else if (!host.includes(".")) {
      throw new UrlNoPermitidaError("La URL de Odoo debe ser un dominio público, por ejemplo https://empresa.odoo.com.");
    } else if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) {
      // formas raras de escribir una IP (octal, hexadecimal, abreviada)
      throw new UrlNoPermitidaError("La URL de Odoo no es un dominio válido.");
    }
  }

  return new URL(url.origin);
}

export type Resolutor = (host: string) => Promise<{ address: string; family: number }[]>;

const resolutorSistema: Resolutor = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Normaliza la URL y resuelve el DNS: todas las IPs a las que apunta el dominio
 * deben ser públicas.
 */
export async function validarUrlOdoo(
  cruda: string,
  opciones: OpcionesUrl = {},
  resolver: Resolutor = resolutorSistema,
): Promise<URL> {
  const url = normalizarUrlOdoo(cruda, opciones);
  if (opciones.permitirPrivadas) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url; // ya validada en normalizarUrlOdoo

  let direcciones: { address: string }[];
  try {
    direcciones = await resolver(host);
  } catch {
    throw new UrlNoPermitidaError(`No se encontró el dominio ${host}. Revisa la URL de Odoo.`);
  }
  if (direcciones.length === 0) {
    throw new UrlNoPermitidaError(`No se encontró el dominio ${host}. Revisa la URL de Odoo.`);
  }
  if (direcciones.some((d) => esIpBloqueada(d.address))) {
    throw new UrlNoPermitidaError("La URL de Odoo resuelve a una IP privada o reservada y no está permitida.");
  }
  return url;
}

type CallbackLookup = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Reemplazo de dns.lookup para el socket: resuelve igual que el sistema, pero
 * falla si alguna IP resultante es privada o reservada.
 */
export function lookupSeguro(hostname: string, options: dns.LookupOptions, callback: CallbackLookup): void {
  dns.lookup(hostname, { ...options, all: true }, (err, direcciones) => {
    if (err) return callback(err, []);
    if (direcciones.some((d) => esIpBloqueada(d.address))) {
      const e: NodeJS.ErrnoException = new UrlNoPermitidaError(
        "La URL de Odoo resuelve a una IP privada o reservada y no está permitida.",
      );
      e.code = "ESSRFBLOCKED";
      return callback(e, []);
    }
    if (options.all) return callback(null, direcciones);
    const primera = direcciones[0];
    callback(null, primera.address, primera.family);
  });
}
