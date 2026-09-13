import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

const DEFAULT_RESTART_POLICY = {
  condition: "any",
  delaySeconds: 5,
};

function renderRestartPolicy(policy: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries({
      condition: policy.condition,
      delay:
        typeof policy.delaySeconds === "number"
          ? `${policy.delaySeconds}s`
          : undefined,
      max_attempts: policy.maxAttempts,
      window:
        typeof policy.windowSeconds === "number"
          ? `${policy.windowSeconds}s`
          : undefined,
    }).filter((entry) => entry[1] !== undefined),
  );
}

describe("default long-running app restart policy", () => {
  it("restarts after clean or failed exits without a finite attempt limit", () => {
    expect(DEFAULT_RESTART_POLICY).toEqual({
      condition: "any",
      delaySeconds: 5,
    });
    expect(renderRestartPolicy(DEFAULT_RESTART_POLICY)).toEqual({
      condition: "any",
      delay: "5s",
    });
  });

  it("renders the Docker stack restart policy expected by Swarm", () => {
    const stack = stringify({
      services: {
        app: {
          image: "busybox",
          deploy: { restart_policy: renderRestartPolicy(DEFAULT_RESTART_POLICY) },
        },
      },
    });
    expect(stack).toContain("condition: any");
    expect(stack).toContain("delay: 5s");
    expect(stack).not.toContain("max_attempts");
  });
});
