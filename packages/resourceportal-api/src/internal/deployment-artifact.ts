import { createHash, timingSafeEqual } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function deploymentArtifactSha256(renderedStack: string) {
  return createHash("sha256").update(renderedStack, "utf8").digest("hex");
}

export function isDeploymentArtifactDigest(value: string | null | undefined) {
  return typeof value === "string" && sha256Pattern.test(value);
}

export function deploymentArtifactMatches(
  renderedStack: string,
  expectedSha256: string,
) {
  if (!isDeploymentArtifactDigest(expectedSha256)) return false;
  const actual = Buffer.from(deploymentArtifactSha256(renderedStack), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
