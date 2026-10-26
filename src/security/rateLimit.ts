// Límite básico de peticiones por minuto (ventana fija, en memoria).
// Claude se conecta desde pocas IPs de Anthropic que comparten todos sus
// usuarios, por eso la llave combina la IP con una huella del token cuando la
// petición trae uno: así un usuario no agota el cupo de los demás.

export class LimitadorPorMinuto {
  private readonly ventanas = new Map<string, { inicio: number; cuenta: number }>();
  private ultimaLimpieza = Date.now();

  constructor(
    private readonly maximo: number,
    private readonly ahora: () => number = Date.now,
  ) {}

  /** Registra una petición. Devuelve los segundos a esperar, o 0 si se permite. */
  consumir(llave: string): number {
    const t = this.ahora();
    this.limpiar(t);
    const v = this.ventanas.get(llave);
    if (!v || t - v.inicio >= 60_000) {
      this.ventanas.set(llave, { inicio: t, cuenta: 1 });
      return 0;
    }
    v.cuenta += 1;
    if (v.cuenta > this.maximo) return Math.ceil((v.inicio + 60_000 - t) / 1000);
    return 0;
  }

  private limpiar(t: number): void {
    if (t - this.ultimaLimpieza < 60_000) return;
    this.ultimaLimpieza = t;
    for (const [llave, v] of this.ventanas) {
      if (t - v.inicio >= 60_000) this.ventanas.delete(llave);
    }
  }
}

/**
 * IP del cliente detrás de `saltos` proxies de confianza (Traefik en Coolify = 1;
 * con Cloudflare delante = 2). Toma la IP que agregó el proxy más externo de confianza.
 */
export function ipCliente(xForwardedFor: string | undefined, ipSocket: string | undefined, saltos: number): string {
  if (saltos > 0 && xForwardedFor) {
    const ips = xForwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = ips[Math.max(0, ips.length - saltos)];
    if (ip) return ip;
  }
  return ipSocket ?? "desconocida";
}
