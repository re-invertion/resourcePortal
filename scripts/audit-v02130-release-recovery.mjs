#!/usr/bin/env node
// Read-only proof of the v0.2.130 partial publication on exact old main SHA.
// Reuses the audited immutable GHCR/OIDC-source verifier from PR #382.
import { pathToFileURL } from "node:url";
import { auditInterruptedRelease } from "./audit-v02129-release-recovery.mjs";

export const RECOVERY_130 = Object.freeze({
  sourceSha: "98f9e94b2b4bcf55cbf791dc38be4a4a6028cb26",
  version: "v0.2.130",
  previousTag: "v0.2.128",
  apiIndex: "sha256:d3129b935abe2d1a0ecd0b429f0d497eed61899e0587fa604096585ef1fbf80d",
  apiManifest: "sha256:90b9f6f317d0d33295a02393993aacadbfccd862907799f4a3b81ba140319392",
  attestation: "sha256:272d09c4d34ed3611e525abef8b2d9c42554e0c4d231195191d419a49ac799d3",
  apiConfig: "sha256:6a34ad2fdcc8301d4f83734575be30e184184277d5f8bd4f876c0adeb6215a59",
});

export async function audit130(fetchImpl = fetch, githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  return auditInterruptedRelease(fetchImpl, RECOVERY_130, githubToken);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  audit130().then((proof) => console.log(JSON.stringify(proof, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
