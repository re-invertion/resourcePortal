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
  // The original failed workflow was rerun at 2026-11-02 08:22 UTC.
  // Docker rebuilt different bits and retagged v0.2.129. Both registry
  // digests are independently present; this known second attempt is *not*
  // an official release and never becomes the rollback source.
  rerun: Object.freeze({
    apiIndex: "sha256:6747f5d34930c37f99a261dfd8ac323a1a0e2eab72f70debe85b70c5a6d4e49b",
    apiManifest: "sha256:7723396ff47f8b7a8ef1d974ae61d87f389c42db50441a52614e288e0b6906aa",
    attestation: "sha256:1862433af75b0a2b668b4a65fa8c05fb14c30688bda8f5bbedf3b8ebc58e2f34",
    apiConfig: "sha256:602aee11f75a0f87e2b7413e989bb0b66bca56b0c06b68c0781fd104fd7acbdd",
  }),
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

  // Read the mutable orphan tag as evidence, never as a release source.
  // Attempt 2 of the old workflow changed the tag to a second, known OCI
  // index. The first index must still be pullable by its immutable digest.
  const tagUrl = "https://ghcr.io/v2/" + registryRepo + "/manifests/" + expected.version;
  const tagResult = await jsonResponse(fetchImpl, tagUrl, { headers: registryHeaders });
  const observedTagDigest = tagResult.response.headers.get("docker-content-digest");
  assert(HEX.test(observedTagDigest), "orphan API tag has no valid digest");
  assert("sha256:" + createHash("sha256").update(tagResult.bytes).digest("hex") === observedTagDigest,
    "registry response bytes do not hash to pinned digest for orphan tag");
  const knownTagDigest = observedTagDigest === expected.apiIndex ||
    (expected.rerun && observedTagDigest === expected.rerun.apiIndex);
  assert(knownTagDigest,
    "registry digest mismatch at " + expected.version +
      ": unknown tag contents " + observedTagDigest);

  const verifyKnownImage = async (spec, title) => {
    const index = await readManifest(spec.apiIndex, spec.apiIndex);
    assert(index?.mediaType === "application/vnd.oci.image.index.v1+json",
      title + " is not an attested OCI index");
    assert(Array.isArray(index.manifests) && index.manifests.length === 2,
      title + " OCI index descriptors changed");
    const [image, evidence] = index.manifests;
    assert(image.digest === spec.apiManifest &&
      image.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
      image.platform?.os === "linux" && image.platform?.architecture === "amd64",
      title + " runnable API image descriptor changed");
    assert(evidence.digest === spec.attestation &&
      evidence.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
      evidence.platform?.os === "unknown" &&
      evidence.platform?.architecture === "unknown" &&
      evidence.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" &&
      evidence.annotations?.["vnd.docker.reference.digest"] === spec.apiManifest,
      title + " BuildKit attestation descriptor changed");

    const runnable = await readManifest(spec.apiManifest, spec.apiManifest);
    assert(runnable?.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
      runnable.config?.digest === spec.apiConfig,
      title + " rollback-tested API config digest differs from workflow logs");
    const attestedManifest = await readManifest(spec.attestation, spec.attestation);
    assert(attestedManifest?.mediaType === "application/vnd.oci.image.manifest.v1+json",
      title + " attestation descriptor points to an invalid OCI manifest");
  };

  await verifyKnownImage(expected, "original failed attempt");
  // The mutable tag is evidence, never a selector for which immutable proof
  // is required. When attempt 2 is pinned, prove BOTH attempts on every run,
  // even if an operator moves the tag back to attempt 1.
  if (expected.rerun) {
    await verifyKnownImage(expected.rerun, "failed rerun attempt 2");
  }

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
      observedOrphanTagDigest: observedTagDigest,
      orphanTagRewrittenByFailedRerun: observedTagDigest !== expected.apiIndex,
      verifiedRerunIndexDigest: observedTagDigest === expected.apiIndex ? null : expected.rerun.apiIndex,
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