import { readFileSync, writeFileSync } from "node:fs";

const path = "packages/resourceportal-api/src/internal/deployment-worker.service.ts";
let source = readFileSync(path, "utf8");

if (source.includes("private readonly capacityAdmission: CapacityDeploymentAdmissionService")) {
  process.exit(0);
}

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) {
    throw new Error(`Stage 15 worker patch could not find ${label}`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Stage 15 worker patch found duplicate ${label}`);
  }
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceOnce(
  `import { stringify } from "yaml";\nimport { PrismaService } from "../prisma/prisma.service";`,
  `import { stringify } from "yaml";\nimport { CapacityDeploymentAdmissionService } from "../capacity/capacity-deployment-admission.service";\nimport { PrismaService } from "../prisma/prisma.service";`,
  "capacity admission import",
);

replaceOnce(
  `  constructor(\n    private readonly prisma: PrismaService,\n    private readonly stackApplyService: StackApplyService,`,
  `  constructor(\n    private readonly prisma: PrismaService,\n    private readonly capacityAdmission: CapacityDeploymentAdmissionService,\n    private readonly stackApplyService: StackApplyService,`,
  "capacity admission constructor dependency",
);

replaceOnce(
  `    if (dto.phase === DeploymentPhase.PreparingArtifacts) {\n      const validation = await this.validateDeploymentSnapshot(deployment);\n\n      if (!validation.success) {\n        return this.failDeploymentWithPhase(deployment.id, {\n          phase: DeploymentPhase.Validating,\n          errorCode: validation.errorCode,\n          errorMessage: validation.message,\n        });\n      }\n    }\n\n    const completed = dto.phase === DeploymentPhase.Completed;`,
  `    if (dto.phase === DeploymentPhase.PreparingArtifacts) {\n      const validation = await this.validateDeploymentSnapshot(deployment);\n\n      if (!validation.success) {\n        return this.failDeploymentWithPhase(deployment.id, {\n          phase: DeploymentPhase.Validating,\n          errorCode: validation.errorCode,\n          errorMessage: validation.message,\n        });\n      }\n\n      const snapshot = this.parseStackConfig(deployment.stackConfig);\n      const admission = await this.capacityAdmission.admitAndAdvance(\n        deployment,\n        snapshot,\n        dto.message,\n      );\n\n      if (!admission.success) {\n        return this.failDeploymentWithPhase(deployment.id, {\n          phase: DeploymentPhase.Validating,\n          errorCode: admission.errorCode,\n          errorMessage: admission.message,\n        });\n      }\n\n      return this.provisionArtifacts(admission.deployment.id, dto.workerId);\n    }\n\n    const completed = dto.phase === DeploymentPhase.Completed;`,
  "PreparingArtifacts capacity admission branch",
);

replaceOnce(
  `\n    if (dto.phase === DeploymentPhase.PreparingArtifacts) {\n      return this.provisionArtifacts(updated.id, dto.workerId);\n    }\n\n    if (dto.phase === DeploymentPhase.ApplyingStack) {`,
  `\n    if (dto.phase === DeploymentPhase.ApplyingStack) {`,
  "legacy PreparingArtifacts post-update branch",
);

writeFileSync(path, source);
