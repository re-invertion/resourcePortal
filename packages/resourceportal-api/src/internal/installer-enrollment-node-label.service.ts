import { Injectable } from "@nestjs/common";
import { StorageCommandRunnerService } from "../storage-backends/storage-command-runner.service";
import { InstallerEnrollmentBundleRole } from "./installer-enrollment.service";
import {
  LEGACY_STORAGE_NODE_LABELS,
  RESOURCEPORTAL_NODE_LABELS,
} from "./node-labels";

@Injectable()
export class InstallerEnrollmentNodeLabelService {
  constructor(private readonly runner: StorageCommandRunnerService) {}

  async apply(
    nodeId: string,
    role: InstallerEnrollmentBundleRole,
    controlPlane: boolean,
    ingress: boolean,
  ) {
    const inspected = await this.runner.run("docker", [
      "node",
      "inspect",
      nodeId,
      "--format",
      "{{.Spec.Role}}",
    ]);
    if (inspected.exitCode !== 0 || inspected.stdout !== role) {
      throw new Error("Joined Docker node role does not match enrollment role");
    }

    const labels = [
      `${RESOURCEPORTAL_NODE_LABELS.storage}=true`,
      `${RESOURCEPORTAL_NODE_LABELS.tenantWorkloads}=true`,
      `${LEGACY_STORAGE_NODE_LABELS.volumes}=true`,
      "resourceportal.tenant-workloads=true",
    ];
    if (role === "manager") {
      labels.push(
        `${LEGACY_STORAGE_NODE_LABELS.secrets}=true`,
        `${LEGACY_STORAGE_NODE_LABELS.platform}=true`,
      );
      if (controlPlane) {
        labels.push(
          `${RESOURCEPORTAL_NODE_LABELS.controlPlane}=true`,
          "resourceportal.control-plane=true",
        );
      }
      if (ingress) {
        labels.push(
          `${RESOURCEPORTAL_NODE_LABELS.ingress}=true`,
          "resourceportal.ingress=true",
        );
      }
    } else if (controlPlane || ingress) {
      throw new Error("Worker enrollment cannot opt into control-plane or ingress");
    }

    const args = ["node", "update"];
    for (const label of labels) args.push("--label-add", label);
    args.push(nodeId);
    const updated = await this.runner.run("docker", args);
    if (updated.exitCode !== 0) {
      throw new Error(`Failed to apply ResourcePortal node labels: ${updated.stderr}`);
    }
  }
}
