import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../src/security/sobres.js";
import { BASE, CALLBACK, conectar, montar, rpc, VERIFICADOR } from "./helpers.js";

async function registrar(app: ReturnType<typeof montar>["app"], uris = [CALLBACK]) {
  return app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: uris, client_name: "Claude" }),
  });
}

async function pedirCodigo(app: ReturnType<typeof montar>["app"], clientId: string, clave: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: sha256Base64Url(VERIFICADOR),
    code_challenge_method: "S256",
    state: "xyz",
  });
  const html = await (await app.request(`/authorize?${q}`)).text();
  const solicitud = html.match(/name="solicitud" value="([^"]+)"/)![1];
  return app.request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ solicitud, odoo_url: "empresa.odoo.com", odoo_api_key: clave, accion: "conectar" }).toString(),
  });
}

describe("descubrimiento OAuth", () => {
  it("el endpoint MCP responde 401 con resource_metadata cuando no hay token", async () => {
    const { app } = montar();
    const r = await rpc(app, undefined, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("publica los metadatos del recurso y del servidor de autorización", async () => {
    const { app } = montar();
    const recurso = (await (await app.request("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(recurso.resource).toBe(`${BASE}/mcp`);
    expect(recurso.authorization_servers).toEqual([BASE]);
    const as = (await (await app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("/health responde sin autenticación", async () => {
    const { app } = montar();
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok" });
  });
});

describe("registro dinámico", () => {
  it("acepta el callback de claude.ai y loopback (Claude Code / MCP Inspector)", async () => {
    const { app } = montar();
    expect((await registrar(app)).status).toBe(201);
    expect((await registrar(app, ["http://localhost:6274/oauth/callback"])).status).toBe(201);
  });

  it("rechaza redirecciones a dominios no permitidos", async () => {
    const { app } = montar();
    const r = await registrar(app, ["https://atacante.example/callback"]);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });
});

describe("flujo completo", () => {
  it("conecta con la clave de Odoo y usa el token en /mcp", async () => {
    const { app, mock } = montar();
    const { access_token, refresh_token } = await conectar(app, mock.clave);
    expect(access_token).toBeTruthy();
    expect(refresh_token).toBeTruthy();
    // El token no contiene la clave en claro.
    expect(Buffer.from(access_token, "base64url").toString("latin1")).not.toContain(mock.clave);

    const lista = await rpc(app, access_token, "tools/list");
    expect(lista.status).toBe(200);
    const { result } = (await lista.json()) as { result: { tools: { name: string; annotations: Record<string, boolean> }[] } };
    const nombres = result.tools.map((t) => t.name);
    expect(nombres).toEqual(expect.arrayContaining(["facturas", "empresas"]));
    for (const t of result.tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("devuelve a claude.ai con code, state e iss", async () => {
    const { app, mock } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const r = await pedirCodigo(app, client_id, mock.clave);
    expect(r.status).toBe(302);
    const destino = new URL(r.headers.get("location")!);
    expect(destino.origin + destino.pathname).toBe(CALLBACK);
    expect(destino.searchParams.get("state")).toBe("xyz");
    expect(destino.searchParams.get("iss")).toBe(BASE);
    expect(destino.searchParams.get("code")).toBeTruthy();
  });

  it("muestra el error de Odoo en la pantalla si la clave es inválida, sin redirigir", async () => {
    const { app } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const r = await pedirCodigo(app, client_id, "clave-equivocada");
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("La clave API no es válida");
    expect(html).toContain("plan Custom");
    expect(html).not.toContain("clave-equivocada");
  });

  it("rechaza una URL de Odoo interna en la pantalla de conexión", async () => {
    const { app } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: CALLBACK,
      code_challenge: sha256Base64Url(VERIFICADOR),
      code_challenge_method: "S256",
    });
    const solicitud = (await (await app.request(`/authorize?${q}`)).text()).match(/name="solicitud" value="([^"]+)"/)![1];
    const r = await app.request("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ solicitud, odoo_url: "https://169.254.169.254", odoo_api_key: "x" }).toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("IP privada o reservada");
  });

  it("exige PKCE S256", async () => {
    const { app } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CALLBACK, state: "s" });
    const r = await app.request(`/authorize?${q}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("error=invalid_request");
  });

  it("no acepta una redirect_uri distinta de la registrada", async () => {
    const { app } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://claude.com/api/mcp/auth_callback",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    expect((await app.request(`/authorize?${q}`)).status).toBe(400);
  });

  it("el code_verifier incorrecto y el código reutilizado fallan", async () => {
    const { app, mock } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const code = new URL((await pedirCodigo(app, client_id, mock.clave)).headers.get("location")!).searchParams.get("code")!;
    const canjear = (verificador: string) =>
      app.request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: CALLBACK, code_verifier: verificador }).toString(),
      });
    const malo = await canjear("otro-verificador-que-no-corresponde-0123456789abcdef");
    expect(malo.status).toBe(400);
    expect(await malo.json()).toMatchObject({ error: "invalid_grant" });
    expect((await canjear(VERIFICADOR)).status).toBe(200);
    const repetido = await canjear(VERIFICADOR);
    expect(repetido.status).toBe(400);
    expect(await repetido.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("renueva con refresh_token y obliga a reconectar si la clave de Odoo dejó de servir", async () => {
    const { app, mock } = montar();
    const { client_id, refresh_token } = await conectar(app, mock.clave);
    const renovar = () =>
      app.request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id }).toString(),
      });
    const ok = await renovar();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty("access_token");

    // Mismo token de refresco contra un Odoo donde la clave ya no es válida.
    const otro = montar({ clave: "clave-nueva" });
    const r = await otro.app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id }).toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rechaza tokens alterados, vencidos o firmados con otro secreto", async () => {
    const { app, mock } = montar();
    const { access_token } = await conectar(app, mock.clave);
    const alterado = access_token.slice(0, -4) + (access_token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await rpc(app, alterado, "tools/list")).status).toBe(401);
    const otroServidor = montar({}, { TOKEN_SECRET: "otro-secreto-distinto-de-al-menos-32-caracteres" });
    expect((await rpc(otroServidor.app, access_token, "tools/list")).status).toBe(401);
    const vencido = montar({}, { ACCESS_TOKEN_TTL_SECONDS: "1" });
    const t = await conectar(vencido.app, vencido.mock.clave);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await rpc(vencido.app, t.access_token, "tools/list")).status).toBe(401);
  });

  it("acepta tokens del secreto anterior durante la rotación", async () => {
    const viejo = montar({}, { TOKEN_SECRET: "secreto-viejo-de-al-menos-32-caracteres-xxxx" });
    const { access_token } = await conectar(viejo.app, viejo.mock.clave);
    const nuevo = montar(
      {},
      { TOKEN_SECRET: "secreto-nuevo-de-al-menos-32-caracteres-xxxx", TOKEN_SECRET_PREVIOUS: "secreto-viejo-de-al-menos-32-caracteres-xxxx" },
    );
    expect((await rpc(nuevo.app, access_token, "tools/list")).status).toBe(200);
  });
});

describe("modo personal (credenciales del entorno)", () => {
  const entorno = {
    ALLOW_ENV_FALLBACK: "true",
    ODOO_URL: "https://empresa.odoo.com",
    ODOO_API_KEY: "clave-valida-de-prueba",
    MCP_ACCESS_TOKEN: "codigo-personal-de-al-menos-24-caracteres",
  };

  it("acepta MCP_ACCESS_TOKEN como bearer cuando está activo", async () => {
    const { app } = montar({}, entorno);
    expect((await rpc(app, entorno.MCP_ACCESS_TOKEN, "tools/list")).status).toBe(200);
  });

  it("lo rechaza cuando ALLOW_ENV_FALLBACK=false", async () => {
    const { app } = montar({}, { ...entorno, ALLOW_ENV_FALLBACK: "false" });
    expect((await rpc(app, entorno.MCP_ACCESS_TOKEN, "tools/list")).status).toBe(401);
  });

  it("no muestra la opción en la pantalla de conexión si está apagado", async () => {
    const { app } = montar();
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CALLBACK, code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    expect(await (await app.request(`/authorize?${q}`)).text()).not.toContain("codigo_personal");
  });
});

describe("límite de peticiones", () => {
  it("bloquea intentos repetidos en la pantalla de conexión", async () => {
    const { app } = montar({}, { RATE_LIMIT_LOGIN_PER_MINUTE: "3" });
    const { client_id } = (await (await registrar(app)).json()) as { client_id: string };
    const estados: number[] = [];
    for (let i = 0; i < 5; i++) estados.push((await pedirCodigo(app, client_id, "clave-mala")).status);
    expect(estados.slice(-1)[0]).toBe(429);
  });

  it("limita /mcp por IP y token", async () => {
    const { app, mock } = montar({}, { RATE_LIMIT_PER_MINUTE: "3" });
    const { access_token } = await conectar(app, mock.clave);
    const estados: number[] = [];
    for (let i = 0; i < 5; i++) estados.push((await rpc(app, access_token, "tools/list")).status);
    expect(estados).toEqual([200, 200, 200, 429, 429]);
  });
});

describe("logs", () => {
  it("nunca registran la clave API ni el token", async () => {
    const { app, mock, logs } = montar();
    const { access_token } = await conectar(app, mock.clave);
    await rpc(app, access_token, "tools/call", { name: "facturas", arguments: {} });
    const texto = JSON.stringify(logs);
    expect(texto).not.toContain(mock.clave);
    expect(texto).not.toContain(access_token);
  });
});
