import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type TenantSearchKind =
  "appGroup" | "application" | "volume" | "registry" | "domain";

export type TenantSearchResult = {
  kind: TenantSearchKind;
  id: string;
  label: string;
  description: string;
  keywords: string;
  appGroupId?: string;
};

@Injectable()
export class TenantSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: {
    tenantId: string;
    query: string | undefined;
    limit?: string | number;
    permissions: string[];
  }) {
    const query = input.query?.trim() ?? "";
    const limit = this.normalizeLimit(input.limit);
    if (query.length < 2) return { items: [] as TenantSearchResult[] };

    const permissions = new Set(input.permissions);
    const can = (permission: string) =>
      permissions.has("*") || permissions.has(permission);
    const textFilter = (fields: string[]) =>
      fields.map((field) => ({
        [field]: { contains: query, mode: Prisma.QueryMode.insensitive },
      }));
    const perType = Math.min(Math.max(limit, 10), 50);

    const [groups, apps, volumes, registries, domains] = await Promise.all([
      can("appgroup.read")
        ? this.prisma.appGroup.findMany({
            where: {
              tenantId: input.tenantId,
              OR: textFilter(["name", "description"]),
            },
            select: {
              id: true,
              name: true,
              description: true,
              runtimeState: true,
              health: true,
            },
            take: perType,
          })
        : Promise.resolve([]),
      can("singleapp.read")
        ? this.prisma.singleApp.findMany({
            where: {
              pendingDeletion: false,
              appGroup: { tenantId: input.tenantId },
              OR: textFilter(["name", "description", "image"]),
            },
            select: {
              id: true,
              name: true,
              description: true,
              image: true,
              runtimeState: true,
              health: true,
              appGroup: { select: { id: true, name: true } },
            },
            take: perType,
          })
        : Promise.resolve([]),
      can("volume.read")
        ? this.prisma.volume.findMany({
            where: {
              tenantId: input.tenantId,
              OR: textFilter(["name", "description"]),
            },
            select: { id: true, name: true, description: true, status: true },
            take: perType,
          })
        : Promise.resolve([]),
      can("registry.read")
        ? this.prisma.registry.findMany({
            where: {
              tenantId: input.tenantId,
              OR: textFilter(["name", "description", "host"]),
            },
            select: {
              id: true,
              name: true,
              description: true,
              host: true,
              validationStatus: true,
            },
            take: perType,
          })
        : Promise.resolve([]),
      can("domain.read")
        ? this.prisma.domain.findMany({
            where: {
              tenantId: input.tenantId,
              OR: textFilter(["hostname", "prefix", "subdomain"]),
            },
            select: {
              id: true,
              hostname: true,
              type: true,
              dnsStatus: true,
              certificateStatus: true,
            },
            take: perType,
          })
        : Promise.resolve([]),
    ]);

    const items: TenantSearchResult[] = [
      ...groups.map((group) => ({
        kind: "appGroup" as const,
        id: group.id,
        label: group.name,
        description: group.description ?? "App Group",
        keywords: `${group.runtimeState} ${group.health}`,
      })),
      ...apps.map((app) => ({
        kind: "application" as const,
        id: app.id,
        appGroupId: app.appGroup.id,
        label: app.name,
        description: `Application in ${app.appGroup.name}`,
        keywords: `${app.image} ${app.runtimeState} ${app.health} ${app.appGroup.name} ${app.description ?? ""}`,
      })),
      ...volumes.map((volume) => ({
        kind: "volume" as const,
        id: volume.id,
        label: volume.name,
        description: volume.description ?? "Persistent volume",
        keywords: `storage disk persistent ${volume.status}`,
      })),
      ...registries.map((registry) => ({
        kind: "registry" as const,
        id: registry.id,
        label: registry.name,
        description: registry.description ?? registry.host,
        keywords: `docker image container ${registry.host} ${registry.validationStatus}`,
      })),
      ...domains.map((domain) => ({
        kind: "domain" as const,
        id: domain.id,
        label: domain.hostname,
        description: "Domain",
        keywords: `dns hostname tls ${domain.type} ${domain.dnsStatus} ${domain.certificateStatus}`,
      })),
    ];

    return {
      items: items
        .map((item) => ({ item, score: this.score(item, query) }))
        .sort(
          (a, b) =>
            b.score - a.score || a.item.label.localeCompare(b.item.label),
        )
        .slice(0, limit)
        .map(({ item }) => item),
    };
  }

  private normalizeLimit(limit: string | number | undefined) {
    const parsed = Number(limit ?? 20);
    if (!Number.isFinite(parsed)) return 20;
    return Math.min(Math.max(Math.trunc(parsed), 1), 50);
  }

  private score(item: TenantSearchResult, query: string) {
    const q = query.toLowerCase();
    const label = item.label.toLowerCase();
    const haystack = `${item.description} ${item.keywords}`.toLowerCase();
    if (label === q) return 100;
    if (label.startsWith(q)) return 80;
    if (label.includes(q)) return 60;
    if (haystack.includes(q)) return 30;
    return 1;
  }
}
