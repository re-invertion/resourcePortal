import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { RequestPlatformUpdateDto } from "./dto/request-platform-update.dto";

type GithubRelease = {
  tag_name?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
};

type ReleaseManifest = {
  version?: string;
  migrations?: { rollbackPolicy?: string };
};

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
      let rollbackPolicy: string | null = null;
      const manifestUrl = release.assets?.find(
        (asset) => asset.name === "resourceportal-release-manifest.json",
      )?.browser_download_url;
      if (manifestUrl) {
        try {
          const manifest = await this.fetchJson<ReleaseManifest>(manifestUrl);
          rollbackPolicy = manifest.migrations?.rollbackPolicy ?? null;
        } catch {
          rollbackPolicy = null;
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
        rollbackPolicy,
        automaticRollbackAvailable:
          rollbackPolicy === "image-only" || rollbackPolicy === "tested",
      };
    } catch (error) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseFeedAvailable: false,
        rollbackPolicy: null,
        automaticRollbackAvailable: false,
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
      maxAttempts: 3,
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
