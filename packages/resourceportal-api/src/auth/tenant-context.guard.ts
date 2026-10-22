import { ConfigService } from "@nestjs/config";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MembershipStatus } from "@prisma/client";
import { FastifyRequest } from "fastify";
import { isTenantMcpRequest } from "../mcp/mcp-oauth";
import { PrismaService } from "../prisma/prisma.service";
import { REQUIRED_PERMISSIONS_KEY } from "./auth.constants";
import { NativeLoginModeService } from "./native-login-mode.service";
import { assertTenantProviderPolicy } from "./tenant-provider-policy";

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly nativeMode?: NativeLoginModeService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (isTenantMcpRequest(request)) return true;
    const tenantId = this.getTenantId(request);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!tenantId) return true;

    if (request.serviceIdentity) {
      return this.activateServiceIdentityContext(
        request,
        tenantId,
        requiredPermissions,
      );
    }

    if (!request.user) {
      throw new ForbiddenException("Authenticated user is required");
    }

    const membership = await this.prisma.tenantMembership.findUnique({
      where: {
        userId_tenantId: {
          userId: request.user.id,
          tenantId,
        },
      },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissionBindings: { include: { permission: true } },
              },
            },
          },
        },
        groupMemberships: {
          include: {
            group: {
              include: {
                roles: {
                  include: {
                    role: {
                      include: {
                        permissionBindings: {
                          include: { permission: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!membership || membership.status !== MembershipStatus.Active) {
      throw new ForbiddenException("Active tenant membership is required");
    }

    // Membership does not bypass an incoming IdP requirement. All user
    // credentials (browser sessions and signed bearer tokens) must carry
    // verified provider provenance, including allowPlatformLogin=false.
    await assertTenantProviderPolicy(
      this.prisma,
      tenantId,
      request.user.authenticatedIdpId,
      () => this.nativeMode
        ? this.nativeMode.isNativeOnly()
        : Promise.resolve(this.config?.get<string>("RP_NATIVE_LOGIN_ONLY") === "true"),
    );

    const permissions = [
      ...new Set([
        ...membership.roles.flatMap(({ role }) =>
          role.permissionBindings.map(({ permission }) => permission.id),
        ),
        ...membership.groupMemberships.flatMap(({ group }) =>
          group.roles.flatMap(({ role }) =>
            role.permissionBindings.map(({ permission }) => permission.id),
          ),
        ),
      ]),
    ];

    request.tenantContext = {
      tenantId,
      membershipId: membership.id,
      permissions,
    };

    if (requiredPermissions?.length && permissions.length === 0) {
      throw new ForbiddenException("No tenant permissions assigned");
    }

    return true;
  }

  private async activateServiceIdentityContext(
    request: FastifyRequest,
    tenantId: string,
    requiredPermissions: string[] | undefined,
  ) {
    const serviceIdentity = request.serviceIdentity!;
    if (
      serviceIdentity.tenantId !== tenantId ||
      serviceIdentity.status !== "Active"
    ) {
      throw new ForbiddenException(
        "Service identity does not belong to the requested tenant",
      );
    }

    const roleBindings = await this.prisma.serviceIdentityRole.findMany({
      where: { serviceIdentityId: serviceIdentity.id },
      include: {
        role: {
          include: {
            permissionBindings: { include: { permission: true } },
          },
        },
      },
    });
    const permissions = [
      ...new Set(
        roleBindings.flatMap(({ role }) =>
          role.permissionBindings.map(({ permission }) => permission.id),
        ),
      ),
    ];

    request.tenantContext = {
      tenantId,
      serviceIdentityId: serviceIdentity.id,
      permissions,
    };

    if (requiredPermissions?.length && permissions.length === 0) {
      throw new ForbiddenException("No service identity permissions assigned");
    }

    return true;
  }

  private getTenantId(request: FastifyRequest) {
    return (request.params as { tenantId?: string }).tenantId;
  }
}
