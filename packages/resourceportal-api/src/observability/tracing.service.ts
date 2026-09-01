import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";

export type ServerSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceparent: string;
  name: string;
  startedAtUnixNano: bigint;
};

type ServerSpanResult = {
  method: string;
  route: string;
  statusCode: number;
};

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

@Injectable()
export class TracingService {
  constructor(private readonly config: ConfigService) {}

  startServerSpan(
    traceparent: string | string[] | undefined,
    name: string,
  ): ServerSpan {
    const header = Array.isArray(traceparent) ? traceparent[0] : traceparent;
    const parsed = header ? traceparentPattern.exec(header.trim()) : null;
    const traceId = parsed?.[1]?.toLowerCase() ?? this.randomHex(16);
    const parentSpanId = parsed?.[2]?.toLowerCase() ?? null;
    const spanId = this.randomHex(8);

    return {
      traceId,
      spanId,
      parentSpanId,
      traceparent: `00-${traceId}-${spanId}-01`,
      name,
      startedAtUnixNano: process.hrtime.bigint(),
    };
  }

  async finishServerSpan(span: ServerSpan, result: ServerSpanResult) {
    const endpoint = this.config.get<string>("OTEL_EXPORTER_OTLP_ENDPOINT");
    if (!endpoint) {
      return;
    }

    const elapsed = process.hrtime.bigint() - span.startedAtUnixNano;
    const endUnixNano = BigInt(Date.now()) * 1_000_000n;
    const startUnixNano = endUnixNano - elapsed;
    const serviceName = this.config.get<string>(
      "OTEL_SERVICE_NAME",
      "resource-portal-api",
    );
    const statusCode = result.statusCode >= 500 ? 2 : 1;
    const attributes = [
      this.stringAttribute("http.request.method", result.method),
      this.stringAttribute("http.route", result.route),
      this.intAttribute("http.response.status_code", result.statusCode),
    ];

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [this.stringAttribute("service.name", serviceName)],
          },
          scopeSpans: [
            {
              scope: { name: "resource-portal-api.http" },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId
                    ? { parentSpanId: span.parentSpanId }
                    : {}),
                  name: span.name,
                  kind: 2,
                  startTimeUnixNano: startUnixNano.toString(),
                  endTimeUnixNano: endUnixNano.toString(),
                  attributes,
                  status: { code: statusCode },
                },
              ],
            },
          ],
        },
      ],
    };

    try {
      await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Trace export must never fail the request path.
    }
  }

  private randomHex(bytes: number) {
    return randomBytes(bytes).toString("hex");
  }

  private stringAttribute(key: string, value: string) {
    return { key, value: { stringValue: value } };
  }

  private intAttribute(key: string, value: number) {
    return { key, value: { intValue: String(value) } };
  }
}
