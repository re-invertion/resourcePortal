import { describe, expect, it, vi } from "vitest";
import {
  buildYupSchema,
  type PreviewYupRuntime,
  type YupChain,
} from "./form-contracts";

type TestChain = YupChain & { kind: string };

function chain(kind: string): TestChain {
  const value: TestChain = {
    kind,
    integer: () => value,
    min: () => value,
    max: () => value,
    trim: () => value,
    matches: () => value,
    required: () => value,
    nullable: () => value,
    oneOf: () => value,
    of: () => value,
    email: () => value,
    url: () => value,
  };
  return value;
}

describe("buildYupSchema", () => {
  it("keeps structured object fields as object schemas", () => {
    let rootShape: Record<string, unknown> | undefined;
    const object = vi.fn((shape?: Record<string, unknown>) => {
      if (shape) rootShape = shape;
      return chain("object");
    });
    const yup: PreviewYupRuntime = {
      object,
      number: () => chain("number"),
      string: () => chain("string"),
      boolean: () => chain("boolean"),
      array: () => chain("array"),
      mixed: () => chain("mixed"),
    };

    buildYupSchema(
      { environment: {}, restartPolicy: {} },
      yup,
      undefined,
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? "object"
          : "text",
      (key) => key,
    );

    expect((rootShape?.environment as TestChain).kind).toBe("object");
    expect((rootShape?.restartPolicy as TestChain).kind).toBe("object");
  });
});
