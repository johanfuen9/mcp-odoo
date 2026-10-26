import { describe, expect, it } from "vitest";
import { esIpBloqueada, normalizarUrlOdoo, UrlNoPermitidaError, validarUrlOdoo } from "../src/security/ssrf.js";

const resolverA = (...ips: string[]) => async () => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("esIpBloqueada", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // metadatos AWS/GCP/Azure
    "100.100.100.200", // metadatos Alibaba
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // metadatos AWS IPv6
    "::ffff:127.0.0.1", // IPv4 mapeada
    "::ffff:7f00:1", // IPv4 mapeada en hexadecimal
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe", // NAT64 hacia 169.254.169.254
    "2002:7f00:0001::", // 6to4 hacia 127.0.0.1
    "no-es-ip",
  ])("bloquea %s", (ip) => {
    expect(esIpBloqueada(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "34.120.10.5", "172.32.0.1", "2607:f8b0:4004:800::200e", "::ffff:8.8.8.8"])("permite %s", (ip) => {
    expect(esIpBloqueada(ip)).toBe(false);
  });
});

describe("normalizarUrlOdoo", () => {
  it("agrega https:// y deja solo el origen", () => {
    expect(normalizarUrlOdoo("empresa.odoo.com/odoo/action-123?x=1").toString()).toBe("https://empresa.odoo.com/");
  });

  it("conserva puertos no estándar (Odoo instalado en servidores propios)", () => {
    expect(normalizarUrlOdoo("https://erp.cliente.co:8443").origin).toBe("https://erp.cliente.co:8443");
  });

  it.each([
    ["http://empresa.odoo.com", /https/],
    ["ftp://empresa.odoo.com", /https/],
    ["file:///etc/passwd", /https/],
    ["https://usuario:clave@empresa.odoo.com", /usuario/],
    ["https://localhost", /interno/],
    ["https://odoo.localhost", /interno/],
    ["https://metadata.google.internal", /interno/],
    ["https://servidor.local", /interno/],
    ["https://127.0.0.1", /privada/],
    ["https://[::1]", /privada/],
    ["https://169.254.169.254", /privada/],
    ["https://10.1.2.3:8069", /privada/],
    ["https://odoo", /dominio público/], // nombre interno de Docker
    ["https://2130706433", /privada|dominio/], // 127.0.0.1 en decimal
    ["https://0x7f000001", /privada|dominio/],
    ["", /Falta/],
  ])("rechaza %s", (url, mensaje) => {
    expect(() => normalizarUrlOdoo(url)).toThrow(UrlNoPermitidaError);
    expect(() => normalizarUrlOdoo(url)).toThrow(mensaje);
  });

  it("en modo desarrollo permite http e IPs privadas (solo para la URL del .env)", () => {
    expect(normalizarUrlOdoo("http://127.0.0.1:8069", { permitirPrivadas: true }).origin).toBe("http://127.0.0.1:8069");
  });
});

describe("validarUrlOdoo (resolución DNS)", () => {
  it("acepta un dominio que resuelve a IPs públicas", async () => {
    const url = await validarUrlOdoo("https://empresa.odoo.com", {}, resolverA("34.120.10.5"));
    expect(url.origin).toBe("https://empresa.odoo.com");
  });

  it("rechaza un dominio que resuelve a una IP privada (DNS rebinding / registro interno)", async () => {
    await expect(validarUrlOdoo("https://trampa.ejemplo.com", {}, resolverA("34.120.10.5", "10.0.0.8"))).rejects.toThrow(/privada/);
  });

  it("rechaza un dominio que resuelve a los metadatos de la nube", async () => {
    await expect(validarUrlOdoo("https://meta.ejemplo.com", {}, resolverA("169.254.169.254"))).rejects.toThrow(/privada/);
  });

  it("rechaza un dominio que no existe", async () => {
    const falla = async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(validarUrlOdoo("https://no-existe.ejemplo.com", {}, falla)).rejects.toThrow(/No se encontró/);
  });
});
