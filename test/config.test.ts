import { describe, expect, it } from "vitest";
import { loadConfig, validarConfig } from "../src/config.js";
import { montar } from "./helpers.js";

const SECRETO = "x".repeat(64);

describe("validarConfig", () => {
  it("exige TOKEN_SECRET largo", () => {
    expect(validarConfig(loadConfig({}), false)).toContainEqual(expect.stringMatching(/TOKEN_SECRET/));
    expect(validarConfig(loadConfig({ TOKEN_SECRET: "corto" }), false)).toContainEqual(expect.stringMatching(/TOKEN_SECRET/));
    expect(validarConfig(loadConfig({ TOKEN_SECRET: SECRETO }), false)).toEqual([]);
  });

  it("en producción exige PUBLIC_BASE_URL https y prohíbe el modo de desarrollo", () => {
    const errores = validarConfig(loadConfig({ TOKEN_SECRET: SECRETO, DEV_ALLOW_PRIVATE_ENV_URL: "true" }), true);
    expect(errores).toContainEqual(expect.stringMatching(/PUBLIC_BASE_URL/));
    expect(errores).toContainEqual(expect.stringMatching(/DEV_ALLOW_PRIVATE_ENV_URL/));
    expect(validarConfig(loadConfig({ TOKEN_SECRET: SECRETO, PUBLIC_BASE_URL: "https://mcp.ejemplo.com" }), true)).toEqual([]);
  });

  it("el modo personal exige credenciales y un código largo", () => {
    const errores = validarConfig(loadConfig({ TOKEN_SECRET: SECRETO, ALLOW_ENV_FALLBACK: "true", MCP_ACCESS_TOKEN: "corto" }), false);
    expect(errores).toContainEqual(expect.stringMatching(/ODOO_URL/));
    expect(errores).toContainEqual(expect.stringMatching(/MCP_ACCESS_TOKEN/));
  });

  it("el modo personal viene apagado por defecto", () => {
    expect(loadConfig({}).allowEnvFallback).toBe(false);
  });
});

describe("protecciones HTTP", () => {
  it("rechaza cuerpos de más de 1 MB", async () => {
    const { app } = montar();
    const r = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(2 * 1024 * 1024) },
      body: "a=" + "x".repeat(2 * 1024 * 1024),
    });
    expect(r.status).toBe(413);
  });

  it("agrega encabezados de seguridad", async () => {
    const { app } = montar();
    const r = await app.request("/health");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
  });
});
