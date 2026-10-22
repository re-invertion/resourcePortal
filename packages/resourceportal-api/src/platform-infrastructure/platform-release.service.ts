import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { RequestPlatformUpdateDto } from "./dto/request-platform-update.dto";

type GithubRelease = {
  tag_name?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
};

type RollbackCertificate = {
  sourceVersion?: string;
  policy?: string;
  reason?: string;
  targetCommit?: string;
  workflowRunId?: number;
  kind?: string;
  candidateZitadelImage?: string;
  sourceZitadelImage?: string;
  actualDatabaseMigration?: boolean;
  previousImagesRestored?: boolean;
  injectedHealthFailure?: boolean;
  databaseSnapshotVerified?: boolean;
  databaseSnapshotRestored?: boolean;
  restoredSourceSchema?: boolean;
  previousApiReadWriteAfterRollback?: boolean;
  previousApiRuntimeReadyAfterRollback?: boolean;
  zitadelDatabaseRestored?: boolean;
  zitadelSourceRuntimeReadyAfterRollback?: boolean;
  zitadelSourceEventstoreVerified?: boolean;
  candidateZitadelRuntimeReadyBeforeRollback?: boolean;
};
type ReleaseManifest = {
  version?: string;
  images?: { zitadel?: string };
  migrations?: {
    rollbackCertifiedSources?: RollbackCertificate[];
    rollbackPolicy?: string;
    rollbackAssessment?: { reason?: string; sourceVersion?: string; targetCommit?: string };
    rollbackEvidence?: { kind?: string; sourceVersion?: string; workflowRunId?: number };
  };
};

type RollbackReason =
  | "available"
  | "release-feed-unavailable"
  | "manifest-missing"
  | "manifest-unavailable"
  | "manifest-invalid"
  | "policy-disallows-rollback"
  | "source-version-not-verified"
  | "tested-evidence-missing";

export function classifyReleaseRollback(
  manifest: ReleaseManifest,
  releaseVersion: string | null,
  currentVersion: string,
): { rollbackPolicy: string | null; automaticRollbackAvailable: boolean; rollbackReason: RollbackReason } {
  const policy = manifest.migrations?.rollbackPolicy;
  if (!releaseVersion || manifest.version !== releaseVersion ||
      !["none", "image-only", "tested"].includes(policy ?? "")) {
    return { rollbackPolicy: null, automaticRollbackAvailable: false, rollbackReason: "manifest-invalid" };
  }
  if (policy === "none") {
    return { rollbackPolicy: policy, automaticRollbackAvailable: false, rollbackReason: "policy-disallows-rollback" };
  }
  const assessment = manifest.migrations?.rollbackAssessment;
  const certificates = manifest.migrations?.rollbackCertifiedSources;
  if (certificates !== undefined) {
    if (!Array.isArray(certificates) || certificates.length === 0 ||
        !assessment || !/^[a-f0-9]{40}$/.test(assessment.targetCommit ?? "") ||
        new Set(certificates.map((certificate) => certificate.sourceVersion)).size !== certificates.length) {
      return { rollbackPolicy: policy ?? null, automaticRollbackAvailable: false, rollbackReason: "manifest-invalid" };
    }
    const certificate = certificates.find((item) => item.sourceVersion === currentVersion);
    if (!certificate) {
      return { rollbackPolicy: policy ?? null, automaticRollbackAvailable: false, rollbackReason: "source-version-not-verified" };
    }
    const requiredProofFlags: (keyof RollbackCertificate)[] = [
      "actualDatabaseMigration", "previousImagesRestored", "injectedHealthFailure", "databaseSnapshotVerified",
      "databaseSnapshotRestored", "restoredSourceSchema", "previousApiReadWriteAfterRollback",
      "previousApiRuntimeReadyAfterRollback", "zitadelDatabaseRestored",
      "zitadelSourceRuntimeReadyAfterRollback", "zitadelSourceEventstoreVerified",
      "candidateZitadelRuntimeReadyBeforeRollback",
    ];
    const verified = certificate.targetCommit === assessment.targetCommit &&
      certificate.kind === "real-upgrade-and-restore" &&
      Number.isSafeInteger(certificate.workflowRunId) && (certificate.workflowRunId ?? 0) > 0 &&
      certificate.candidateZitadelImage === manifest.images?.zitadel &&
      /^ghcr\.io\/zitadel\/zitadel@sha256:[a-f0-9]{64}$/.test(certificate.sourceZitadelImage ?? "") &&
      requiredProofFlags.every((key) => certificate[key] === true);
    if (!verified ||
        (certificate.policy === "image-only" && certificate.reason !== "no-resourceportal-database-schema-changes") ||
        (certificate.policy === "tested" && certificate.reason !== "verified-recovery-test") ||
        !["tested", "image-only"].includes(certificate.policy ?? "")) {
      return { rollbackPolicy: policy ?? null, automaticRollbackAvailable: false, rollbackReason: "tested-evidence-missing" };
    }
    return { rollbackPolicy: certificate.policy ?? null, automaticRollbackAvailable: true, rollbackReason: "available" };
  }
  if (assessment && (assessment.sourceVersion !== currentVersion ||
      !/^[a-f0-9]{40}$/.test(assessment.targetCommit ?? ""))) {
    return { rollbackPolicy: policy ?? null, automaticRollbackAvailable: false, rollbackReason: "source-version-not-verified" };
  }
  if (policy === "tested" &&
      (assessment?.reason !== "verified-recovery-test" ||
       manifest.migrations?.rollbackEvidence?.kind !== "real-upgrade-and-restore" ||
       manifest.migrations.rollbackEvidence.sourceVersion !== assessment.sourceVersion ||
       !Number.isInteger(manifest.migrations.rollbackEvidence.workflowRunId))) {
    return { rollbackPolicy: policy, automaticRollbackAvailable: false, rollbackReason: "tested-evidence-missing" };
  }
  if (policy === "image-only" && assessment &&
      assessment.reason !== "no-resourceportal-database-schema-changes") {
    return { rollbackPolicy: policy, automaticRollbackAvailable: false, rollbackReason: "manifest-invalid" };
  }
  return { rollbackPolicy: policy ?? null, automaticRollbackAvailable: true, rollbackReason: "available" };
}

@Injectable()
export class PlatformReleaseService {
  constructor(
    private readonly config: ConfigService,
    private readonly operations: OperationsService,
  ) {}

  async status() {
    const currentVersion =
      this.config.get<string>("RESOURCEPORTAL_VERSION")?.trim() || "unknown";
    try {
      const release = await this.latestRelease();
      const latestVersion = normalizeVersion(release.tag_name);
      let rollbackStatus: ReturnType<typeof classifyReleaseRollback> = {
        rollbackPolicy: null,
        automaticRollbackAvailable: false,
        rollbackReason: "manifest-missing",
      };
      const manifestUrl = release.assets?.find(
        (asset) => asset.name === "resourceportal-release-manifest.json",
      )?.browser_download_url;
      if (manifestUrl) {
        try {
          const manifest = await this.fetchJson<ReleaseManifest>(manifestUrl);
          rollbackStatus = classifyReleaseRollback(manifest, latestVersion, currentVersion);
        } catch {
          rollbackStatus = {
            rollbackPolicy: null,
            automaticRollbackAvailable: false,
            rollbackReason: "manifest-unavailable",
          };
        }
      }
      return {
        currentVersion,
        latestVersion,
        updateAvailable:
          currentVersion !== "unknown" &&
          latestVersion !== null &&
          compareVersions(latestVersion, currentVersion) > 0,
        releaseFeedAvailable: true,
        ...rollbackStatus,
      };
    } catch (error) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseFeedAvailable: false,
        rollbackPolicy: null,
        automaticRollbackAvailable: false,
        rollbackReason: "release-feed-unavailable" as const,
        releaseFeedError:
          error instanceof Error ? error.message : "Release feed unavailable",
      };
    }
  }

  async requestUpdate(dto: RequestPlatformUpdateDto, actor: AuthenticatedUser) {
    if (dto.confirmation !== "AKTUALIZUJ") {
      throw new BadRequestException("Explicit update confirmation is required");
    }
    const currentVersion =
      this.config.get<string>("RESOURCEPORTAL_VERSION")?.trim() || "unknown";
    if (currentVersion !== "unknown" && compareVersions(dto.targetVersion, currentVersion) <= 0) {
      throw new BadRequestException("Target version must be newer than the current ResourcePortal version");
    }

    const release = await this.release(dto.targetVersion).catch((error) => {
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "Target release could not be verified",
      );
    });
    const tagVersion = normalizeVersion(release.tag_name);
    if (tagVersion !== dto.targetVersion) {
      throw new BadRequestException("Target release does not match the requested version");
    }
    const manifestUrl = release.assets?.find(
      (asset) => asset.name === "resourceportal-release-manifest.json",
    )?.browser_download_url;
    if (!manifestUrl) {
      throw new ServiceUnavailableException("Target release has no ResourcePortal release manifest");
    }

    return this.operations.enqueue({
      type: "PLATFORM_RELEASE_UPDATE",
      tenantId: null,
      resourceType: "PlatformRelease",
      resourceId: null,
      actor,
      idempotencyKey: `platform-release-update:${dto.targetVersion}`,
      input: {
        targetVersion: dto.targetVersion,
        manifestUrl,
      },
      // Upgrades intentionally restart the worker more than once while
      // quiescing database clients and rolling out source/target services.
      // The executor always inspects the same operation-named updater and
      // never launches a second updater for a reclaimed lease.
      maxAttempts: 10,
    });
  }

  private repository() {
    return (
      this.config.get<string>("RESOURCEPORTAL_RELEASE_REPOSITORY")?.trim() ||
      "re-invertion/resourcePortal"
    );
  }

  private latestRelease() {
    return this.fetchJson<GithubRelease>(
      `https://api.github.com/repos/${this.repository()}/releases/latest`,
    );
  }

  private release(version: string) {
    return this.fetchJson<GithubRelease>(
      `https://api.github.com/repos/${this.repository()}/releases/tags/v${version}`,
    );
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "ResourcePortal",
    };
    const token = this.config.get<string>("RESOURCEPORTAL_GITHUB_TOKEN")?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Release feed returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

function normalizeVersion(tag: string | undefined) {
  if (!tag) return null;
  const value = tag.startsWith("v") ? tag.slice(1) : tag;
  return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
