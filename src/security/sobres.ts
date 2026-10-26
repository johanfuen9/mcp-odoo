// "Sobres sellados": datos cifrados y autenticados con AES-256-GCM.
//
// Con esto el servidor no necesita base de datos: el client_id del registro
// dinámico, el código de autorización y los tokens de OAuth llevan adentro,
// cifrados, los datos que hacen falta (incluida la clave API de Odoo). Solo
// este servidor, con TOKEN_SECRET, puede abrirlos. Cada tipo de sobre usa un
// "propósito" distinto como dato asociado, así un código no sirve como token.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type Proposito = "cliente" | "solicitud" | "codigo" | "access" | "refresh";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function derivarLlave(secreto: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secreto, "mcp-odoo", "sobres-v1", 32));
}

export class Sellador {
  private readonly llaves: Buffer[];

  /** `secretos[0]` cifra; todos se intentan para descifrar (rotación de llaves). */
  constructor(secretos: (string | undefined)[]) {
    this.llaves = secretos.filter((s): s is string => !!s).map(derivarLlave);
    if (this.llaves.length === 0) throw new Error("Falta TOKEN_SECRET para cifrar los tokens.");
  }

  sellar(proposito: Proposito, datos: object): string {
    const iv = randomBytes(IV_BYTES);
    const cifrador = createCipheriv("aes-256-gcm", this.llaves[0], iv);
    cifrador.setAAD(Buffer.from(`${VERSION}:${proposito}`));
    const cuerpo = Buffer.concat([cifrador.update(JSON.stringify(datos), "utf8"), cifrador.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cuerpo, cifrador.getAuthTag()]).toString("base64url");
  }

  /** Devuelve los datos o null si el sobre es inválido, fue alterado o es de otro propósito. */
  abrir<T>(proposito: Proposito, sobre: string | undefined | null): T | null {
    if (!sobre || sobre.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(sobre)) return null;
    const bytes = Buffer.from(sobre, "base64url");
    if (bytes.length < 1 + IV_BYTES + TAG_BYTES + 1 || bytes[0] !== VERSION) return null;
    const iv = bytes.subarray(1, 1 + IV_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const cuerpo = bytes.subarray(1 + IV_BYTES, bytes.length - TAG_BYTES);
    for (const llave of this.llaves) {
      try {
        const descifrador = createDecipheriv("aes-256-gcm", llave, iv);
        descifrador.setAAD(Buffer.from(`${VERSION}:${proposito}`));
        descifrador.setAuthTag(tag);
        const texto = Buffer.concat([descifrador.update(cuerpo), descifrador.final()]).toString("utf8");
        return JSON.parse(texto) as T;
      } catch {
        // probar con la siguiente llave
      }
    }
    return null;
  }
}

export function sha256Base64Url(texto: string): string {
  return createHash("sha256").update(texto).digest("base64url");
}

/** Huella corta de un valor sensible, útil para logs y límites de uso. Nunca revela el valor. */
export function huella(texto: string): string {
  return createHash("sha256").update(texto).digest("hex").slice(0, 16);
}

export function igualSeguro(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
