import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isIP } from "node:net";
import { connect } from "node:tls";

export type ObservedCertificate = {
  hostname: string;
  domains: string[];
  expiresAt: Date;
  issuer?: string;
};

/** Match SAN names without allowing multi-label wildcard expansion. */
export function certificateCoversHostname(domains: string[], hostname: string) {
  const normalizedHostname = hostname.toLowerCase();
  return domains.some((domain) => {
    const normalizedDomain = domain.toLowerCase();
    if (normalizedDomain === normalizedHostname) return true;
    if (!normalizedDomain.startsWith("*.")) return false;
    const suffix = normalizedDomain.slice(1);
    if (!normalizedHostname.endsWith(suffix)) return false;
    const prefix = normalizedHostname.slice(0, -suffix.length);
    return prefix.length > 0 && !prefix.includes(".");
  });
}

@Injectable()
export class TraefikCertificateObserverService {
  constructor(private readonly config: ConfigService) {}

  observe(hostname: string): Promise<ObservedCertificate> {
    // Use the pinned Swarm manager's published port, not public DNS. A public
    // edge/CDN can terminate HTTPS with a different certificate from Traefik.
    const ingressHost = this.config.get<string>("INSTALLER_SWARM_ADVERTISE_ADDR")?.trim();
    if (!ingressHost || isIP(ingressHost) === 0) {
      return Promise.reject(new Error("ManagedIngressAddressUnavailable"));
    }
    const timeoutMs = this.timeoutMs();

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        result:
          | { ok: true; value: ObservedCertificate }
          | { ok: false; error: Error },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (result.ok) {
          resolve(result.value);
        } else {
          reject(result.error);
        }
      };

      const socket = connect(
        {
          host: ingressHost,
          port: 443,
          servername: hostname,
          rejectUnauthorized: true,
        },
        () => {
          try {
            const certificate = socket.getPeerCertificate();
            if (!certificate.valid_to) {
              throw new Error(`No TLS certificate observed for ${hostname}`);
            }

            const expiresAt = new Date(certificate.valid_to);
            if (!Number.isFinite(expiresAt.getTime())) {
              throw new Error(`Invalid TLS certificate expiry for ${hostname}`);
            }

            const domains = this.certificateDomains(
              certificate.subjectaltname,
            );
            const issuer = this.certificateIssuer(certificate.issuer);

            finish({
              ok: true,
              value: {
                hostname,
                domains,
                expiresAt,
                issuer,
              },
            });
          } catch (error) {
            finish({
              ok: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      );

      socket.setTimeout(timeoutMs, () => {
        finish({
          ok: false,
          error: new Error(`TLS observation timed out for ${hostname}`),
        });
      });
      socket.once("error", (error: Error) => {
        finish({ ok: false, error });
      });
    });
  }

  private timeoutMs() {
    const value = this.config.get<string>("TRAEFIK_TLS_OBSERVE_TIMEOUT_MS");
    const parsed = value ? Number.parseInt(value, 10) : 5000;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
  }

  private certificateDomains(subjectAltName: string | undefined) {
    const domains = (subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).trim().toLowerCase())
      .filter(Boolean);

    // Do not invent certificate SAN coverage when the server omits SANs.
    return Array.from(new Set(domains));
  }

  private certificateIssuer(issuer: unknown) {
    if (!issuer || typeof issuer !== "object") {
      return undefined;
    }

    const fields = issuer as { CN?: unknown; O?: unknown };
    if (typeof fields.CN === "string") {
      return fields.CN;
    }

    return typeof fields.O === "string" ? fields.O : undefined;
  }
}
