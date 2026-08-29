import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CustomRootDomainVerificationStatus,
  DnsStatus,
  DomainType,
  Prisma,
} from "@prisma/client";
import crypto from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCustomRootDomainDto } from "./dto/create-custom-root-domain.dto";
import { CreateDomainDto } from "./dto/create-domain.dto";
import { UpdateCustomRootDomainDto } from "./dto/update-custom-root-domain.dto";
import { UpdateDomainDto } from "./dto/update-domain.dto";
import { mapCustomRootDomain, mapDomain } from "./domains.view";

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async listDomains(tenantId: string) {
    const domains = await this.prisma.domain.findMany({
      where: { tenantId },
      orderBy: { hostname: "asc" },
      include: this.domainIncludes(),
    });

    return domains.map(mapDomain);
  }

  async getDomain(tenantId: string, domainId: string) {
    const domain = await this.findDomainOrThrow(tenantId, domainId);
    return mapDomain(domain);
  }

  async listCustomRootDomains(tenantId: string) {
    const roots = await this.prisma.customRootDomain.findMany({
      where: { tenantId },
      orderBy: { rootDomain: "asc" },
      include: { domains: true },
    });

    return roots.map(mapCustomRootDomain);
  }

  async getCustomRootDomain(tenantId: string, customRootDomainId: string) {
    const root = await this.findCustomRootDomainOrThrow(
      tenantId,
      customRootDomainId,
    );

    return mapCustomRootDomain(root);
  }

  async createCustomRootDomain(
    tenantId: string,
    dto: CreateCustomRootDomainDto,
    actor: AuthenticatedUser,
  ) {
    const rootDomain = dto.rootDomain.toLowerCase();

    try {
      const root = await this.prisma.customRootDomain.create({
        data: {
          tenantId,
          rootDomain,
          verificationToken: this.verificationToken(),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { domains: true },
      });

      return mapCustomRootDomain(root);
    } catch (error) {
      this.handleKnownConflict(error, "Custom root domain already exists");
      throw error;
    }
  }

  async updateCustomRootDomain(
    tenantId: string,
    customRootDomainId: string,
    dto: UpdateCustomRootDomainDto,
    actor: AuthenticatedUser,
  ) {
    await this.findCustomRootDomainOrThrow(tenantId, customRootDomainId);

    const verificationStatus = dto.verificationStatus;
    const root = await this.prisma.customRootDomain.update({
      where: { id: customRootDomainId },
      data: {
        verificationStatus,
        verifiedAt:
          verificationStatus === CustomRootDomainVerificationStatus.Verified
            ? new Date()
            : verificationStatus === undefined
              ? undefined
              : null,
        updatedBy: actor.id,
      },
      include: { domains: true },
    });

    return mapCustomRootDomain(root);
  }

  async validateCustomRootDomain(
    tenantId: string,
    customRootDomainId: string,
    actor: AuthenticatedUser,
  ) {
    await this.findCustomRootDomainOrThrow(tenantId, customRootDomainId);

    const root = await this.prisma.customRootDomain.update({
      where: { id: customRootDomainId },
      data: {
        verificationStatus: CustomRootDomainVerificationStatus.Verified,
        verifiedAt: new Date(),
        updatedBy: actor.id,
      },
      include: { domains: true },
    });

    return mapCustomRootDomain(root);
  }

  async deleteCustomRootDomain(tenantId: string, customRootDomainId: string) {
    const root = await this.findCustomRootDomainOrThrow(
      tenantId,
      customRootDomainId,
    );

    if (root.domains.length > 0) {
      throw new ConflictException("CustomRootDomainInUse");
    }

    await this.prisma.customRootDomain.delete({
      where: { id: customRootDomainId },
    });

    return { deleted: true };
  }

  async createDomain(
    tenantId: string,
    dto: CreateDomainDto,
    actor: AuthenticatedUser,
  ) {
    const hostname = await this.resolveHostname(tenantId, dto);
    const endpointContext = dto.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, dto.httpEndpointId)
      : undefined;

    try {
      const domain = await this.prisma.$transaction(async (tx) => {
        const created = await tx.domain.create({
          data: {
            tenantId,
            type: dto.type,
            prefix: dto.type === DomainType.Managed ? dto.prefix : null,
            customRootDomainId:
              dto.type === DomainType.Custom ? dto.customRootDomainId : null,
            subdomain:
              dto.type === DomainType.Managed ? dto.prefix : dto.subdomain,
            hostname,
            dnsStatus:
              dto.type === DomainType.Managed ? DnsStatus.Valid : DnsStatus.Pending,
            tlsEnabled: dto.tlsEnabled ?? true,
            httpEndpointId: dto.httpEndpointId,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          include: this.domainIncludes(),
        });

        if (endpointContext) {
          await this.markAppGroupDraftChanged(
            tx,
            endpointContext.appGroupId,
            actor.id,
          );
        }

        return created;
      });

      return mapDomain(domain);
    } catch (error) {
      this.handleKnownConflict(error, "Domain already exists");
      throw error;
    }
  }

  async updateDomain(
    tenantId: string,
    domainId: string,
    dto: UpdateDomainDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findDomainOrThrow(tenantId, domainId);
    const nextEndpointContext =
      dto.httpEndpointId === undefined || dto.httpEndpointId === null
        ? undefined
        : await this.findEndpointContextOrThrow(tenantId, dto.httpEndpointId);
    const currentEndpointContext = existing.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, existing.httpEndpointId)
      : undefined;

    const domain = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.domain.update({
        where: { id: domainId },
        data: {
          httpEndpointId:
            dto.httpEndpointId === undefined ? undefined : dto.httpEndpointId,
          tlsEnabled: dto.tlsEnabled,
          updatedBy: actor.id,
        },
        include: this.domainIncludes(),
      });

      const changedAppGroupIds = new Set<string>();
      if (currentEndpointContext) {
        changedAppGroupIds.add(currentEndpointContext.appGroupId);
      }
      if (nextEndpointContext) {
        changedAppGroupIds.add(nextEndpointContext.appGroupId);
      }

      for (const appGroupId of changedAppGroupIds) {
        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
      }

      return updated;
    });

    return mapDomain(domain);
  }

  async deleteDomain(
    tenantId: string,
    domainId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findDomainOrThrow(tenantId, domainId);
    const endpointContext = existing.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, existing.httpEndpointId)
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.domain.delete({
        where: { id: domainId },
      });

      if (endpointContext) {
        await this.markAppGroupDraftChanged(tx, endpointContext.appGroupId, actor.id);
      }
    });

    return { deleted: true };
  }

  async validateDomain(tenantId: string, domainId: string, actor: AuthenticatedUser) {
    await this.findDomainOrThrow(tenantId, domainId);

    const domain = await this.prisma.domain.update({
      where: { id: domainId },
      data: {
        dnsStatus: DnsStatus.Valid,
        updatedBy: actor.id,
      },
      include: this.domainIncludes(),
    });

    return mapDomain(domain);
  }

  private async resolveHostname(tenantId: string, dto: CreateDomainDto) {
    if (dto.type === DomainType.Managed) {
      if (!dto.prefix) {
        throw new BadRequestException("Managed domain requires prefix");
      }

      return `${dto.prefix}.${this.managedBaseDomain()}`;
    }

    if (dto.customRootDomainId || dto.subdomain) {
      if (!dto.customRootDomainId || !dto.subdomain) {
        throw new BadRequestException(
          "Custom root domain requires customRootDomainId and subdomain",
        );
      }

      const root = await this.findCustomRootDomainOrThrow(
        tenantId,
        dto.customRootDomainId,
      );

      if (
        root.verificationStatus !==
        CustomRootDomainVerificationStatus.Verified
      ) {
        throw new ConflictException("CustomRootDomainNotVerified");
      }

      return `${dto.subdomain}.${root.rootDomain}`;
    }

    if (!dto.hostname) {
      throw new BadRequestException("Custom domain requires hostname");
    }

    return dto.hostname.toLowerCase();
  }

  private managedBaseDomain() {
    return this.config.get<string>(
      "MANAGED_DOMAIN_BASE",
      "apps.resource-portal.local",
    );
  }

  private async findDomainOrThrow(tenantId: string, domainId: string) {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, tenantId },
      include: this.domainIncludes(),
    });

    if (!domain) {
      throw new NotFoundException("Domain not found");
    }

    return domain;
  }

  private async findCustomRootDomainOrThrow(
    tenantId: string,
    customRootDomainId: string,
  ) {
    const root = await this.prisma.customRootDomain.findFirst({
      where: { id: customRootDomainId, tenantId },
      include: { domains: true },
    });

    if (!root) {
      throw new NotFoundException("Custom root domain not found");
    }

    return root;
  }

  private async findEndpointContextOrThrow(
    tenantId: string,
    httpEndpointId: string,
  ) {
    const endpoint = await this.prisma.httpEndpoint.findFirst({
      where: {
        id: httpEndpointId,
        singleApp: {
          appGroup: {
            tenantId,
          },
        },
      },
      select: {
        id: true,
        singleApp: {
          select: {
            appGroupId: true,
          },
        },
      },
    });

    if (!endpoint) {
      throw new NotFoundException("HTTP endpoint not found");
    }

    return {
      httpEndpointId: endpoint.id,
      appGroupId: endpoint.singleApp.appGroupId,
    };
  }

  private markAppGroupDraftChanged(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actorId: string,
  ) {
    return tx.appGroup.update({
      where: { id: appGroupId },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: {
          increment: 1,
        },
        updatedBy: actorId,
      },
    });
  }

  private domainIncludes() {
    return {
      customRootDomain: true,
      httpEndpoint: {
        include: {
          singleApp: {
            select: {
              id: true,
              name: true,
              appGroupId: true,
            },
          },
        },
      },
    } satisfies Prisma.DomainInclude;
  }

  private handleKnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }

  private verificationToken() {
    return `rp-domain-verification=${crypto.randomBytes(24).toString("hex")}`;
  }
}
