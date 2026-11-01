#!/usr/bin/env node
// Read-only audit of the interrupted v0.2.129 publication. This program does
// NOT publish images, create tags, sign artifacts or change branch protection.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const HEX = /^sha256:[a-f0-9]{64}$/;
export const RECOVERY = Object.freeze({
  sourceSha: "0ae0827bfc2a0971a4ffd37becbe0e61438b32e7",
  version: "v0.2.129",
  previousTag: "v0.2.128",
  apiIndex: "sha256:e05c01256b9bc5c697fe751155503cffef2ade5623d266df0e41064cd1d3e982",
  apiManifest: "sha256:96919a0a3b130935bfc43e6ae68707d293b70d13cac621bba431ce1a689d173d",
  attestation: "sha256:b24e6f6c5e3d0a43ba9dfc1db2ad0329f1cec17754eb77fdb7733e2a56f88f75",
  apiConfig: "sha256:761dec70d4f31f79234cdd83e564c3c2293bb454d237f45131296b580efb4c96",
});

const repo = "re-invertion/resourcePortal";
const registryRepo = "re-invertion/resourceportal-api";
const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

function assert(condition, message) {
  if (!condition) throw new Error("Recovery audit blocked: " + message);
}
async function jsonResponse(fetchImpl, url, options = {}, permittedStatuses = [200]) {
  const response = await fetchImpl(url, options);
  assert(permittedStatuses.includes(response.status), `Unexpected HTTP ${response.status} for ${url}`);
  if (response.status === 404) return { status: 404, body: null, response };
  const bytes = Buffer.from(await response.arrayBuffer());
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Recovery audit blocked: malformed JSON for " + url); }
  return { status: response.status, body, response, bytes };
}

export async function auditInterruptedRelease(fetchImpl = fetch, expected = RECOVERY) {
  const base = "https://api.github.com/repos/" + repo;
  const githubHeaders = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const branch = await jsonResponse(fetchImpl, base + "/branches/main", { headers: githubHeaders });
  const observedMain = branch.body?.commit?.sha;
  assert(observedMain === expected.sourceSha,
    `main drifted: expected ${expected.sourceSha}, observed ${observedMain}`);

  const latest = await jsonResponse(fetchImpl, base + "/releases/latest", { headers: githubHeaders });
  assert(latest.body?.tag_name === expected.previousTag,
    `unexpected published source: ${latest.body?.tag_name}`);
  const release = await jsonResponse(fetchImpl, base + "/releases/tags/" + expected.version,
    { headers: githubHeaders }, [200, 404]);
  assert(release.status === 404,
    "v0.2.129 is already published; inspect its signed assets instead of recovering");

  const tokenResponse = await jsonResponse(fetchImpl,
    "https://ghcr.io/token?scope=repository:" + registryRepo + ":pull&service=ghcr.io");
  const token = tokenResponse.body?.token;
  assert(typeof token === "string" && token.length > 10, "anonymous GHCR pull token unavailable");
  const registryHeaders = { Accept: accept, Authorization: "Bearer " + token };
  const readManifest = async (reference, expectedDigest, repository = registryRepo) => {
    assert(HEX.test(expectedDigest), "invalid expected manifest digest");
    const url = `https://ghcr.io/v2/${repository}/manifests/${reference}`;
    const result = await jsonResponse(fetchImpl, url, { headers: registryHeaders });
    const headerDigest = result.response.headers.get("docker-content-digest");
    assert(headerDigest === expectedDigest,
      `registry digest mismatch at ${reference}: ${headerDigest} vs ${expectedDigest}`);
    const actualDigest = "sha256:" + createHash("sha256").update(result.bytes).digest("hex");
    assert(actualDigest === expectedDigest,
      `registry response bytes do not hash to pinned digest for ${reference}`);
    return result.body;
  };

  const index = await readManifest(expected.version, expected.apiIndex);
  assert(index?.mediaType === "application/vnd.oci.image.index.v1+json",
    "API tag is not the original attested OCI index");
  assert(Array.isArray(index.manifests) && index.manifests.length === 2,
    "API OCI index descriptors changed");
  const [image, evidence] = index.manifests;
  assert(image.digest === expected.apiManifest &&
    image.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    image.platform?.os === "linux" && image.platform?.architecture === "amd64",
    "runnable API image descriptor changed");
  assert(evidence.digest === expected.attestation &&
    evidence.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    evidence.platform?.os === "unknown" &&
    evidence.platform?.architecture === "unknown" &&
    evidence.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" &&
    evidence.annotations?.["vnd.docker.reference.digest"] === expected.apiManifest,
    "BuildKit attestation descriptor changed");

  const runnable = await readManifest(expected.apiManifest, expected.apiManifest);
  assert(runnable?.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    runnable.config?.digest === expected.apiConfig,
    "rollback-tested API config digest differs from original release build");
  const attestedManifest = await readManifest(expected.attestation, expected.attestation);
  assert(attestedManifest?.mediaType === "application/vnd.oci.image.manifest.v1+json",
    "attestation descriptor points to an invalid OCI manifest");

  // A registry 404 is evidence that the other two version tags are absent,
  // not permission to push either of them from this read-only tool.
  const otherImages = {};
  for (const role of ["web", "postgres"]) {
    const imageRepo = "re-invertion/resourceportal-" + role;
    const registryToken = await jsonResponse(fetchImpl,
      `https://ghcr.io/token?scope=repository:${imageRepo}:pull&service=ghcr.io`);
    assert(typeof registryToken.body?.token === "string",
      `cannot authenticate anonymous ${role} pull`);
    const result = await jsonResponse(fetchImpl,
      `https://ghcr.io/v2/${imageRepo}/manifests/${expected.version}`,
      { headers: { Accept: accept, Authorization: "Bearer " + registryToken.body.token } },
      [200, 404]);
    otherImages[role] = result.status === 200 ? "present-unverified" : "absent";
    assert(result.status === 404,
      `unexpected pre-existing ${role} image requires independent verification`);
  }
  return {
    schemaVersion: 1,
    kind: "read-only-release-recovery-audit",
    github: { repository: repo, mainSha: observedMain, latestPublishedTag: latest.body.tag_name,
      interruptedTag: expected.version, signedReleaseExists: false },
    api: { reference: "ghcr.io/" + registryRepo + "@" + expected.apiIndex,
      indexDigest: expected.apiIndex, runnableManifest: expected.apiManifest,
      configDigest: expected.apiConfig, attestationManifest: expected.attestation,
      immutableRegistryProof: true },
    otherImages,
    canPublishFromThisAudit: false,
    recoveryRequires: [
      "signed GitHub Release must originate from main and the approved release.yml OIDC signer",
      "verified mandatory rollback evidence for exact old main SHA",
      "no registry tag rewrites, no manual Git tag and no merge-queue bypass",
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditInterruptedRelease().then((evidence) => {
    console.log(JSON.stringify(evidence, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}