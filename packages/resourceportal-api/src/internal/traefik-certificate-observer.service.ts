import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect } from "node:tls";

export type ObservedCertificate = {
  hostname: string;
  domains: string[];
  expiresAt: Date;
  issuer?: string;
};

@Injectable()
export class TraefikCertificateObserverService {
  constructor(private readonly config: ConfigService) {}

  observe(hostname: string): Promise<ObservedCertificate> {
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
          host: hostname,
          port: 443,
          servername: hostname,
          rejectUnauthorized: false,
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
              hostname,
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

  private certificateDomains(subjectAltName: string | undefined, hostname: string) {
    const domains = (subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).trim().toLowerCase())
      .filter(Boolean);

    return domains.length > 0 ? Array.from(new Set(domains)) : [hostname];
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
