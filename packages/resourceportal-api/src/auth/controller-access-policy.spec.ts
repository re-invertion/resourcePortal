import "reflect-metadata";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  RequestMethod,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AppGroupsController } from "../app-groups/app-groups.controller";
import { AuditController } from "../audit/audit.controller";
import { DomainsController } from "../domains/domains.controller";
import { HealthController } from "../health/health.controller";
import { AuthSessionMaintenanceController } from "../internal/auth-session-maintenance.controller";
import { DeploymentWorkerController } from "../internal/deployment-worker.controller";
import { InternalAuthGuard } from "../internal/internal-auth.guard";
import { ObservabilityController } from "../observability/observability.controller";
import { RegistriesController } from "../registries/registries.controller";
import { TenantsController } from "../tenants/tenants.controller";
import { UsersController } from "../users/users.controller";
import { VolumesController } from "../volumes/volumes.controller";
import {
  IS_AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from "./auth.constants";
import { AuthController } from "./auth.controller";

const controllers = [
  AppGroupsController,
  AuditController,
  AuthController,
  AuthSessionMaintenanceController,
  DeploymentWorkerController,
  DomainsController,
  HealthController,
  ObservabilityController,
  RegistriesController,
  TenantsController,
  UsersController,
  VolumesController,
];

type ControllerClass = (typeof controllers)[number];

describe("controller access policy", () => {
  it("requires every route to declare an explicit access model", () => {
    const violations = controllers.flatMap((controller) =>
      getControllerRoutes(controller)
        .filter((route) => !hasExplicitAccessModel(controller, route.handler))
        .map((route) => `${controller.name}.${route.methodName}`),
    );

    expect(violations).toEqual([]);
  });
});

function getControllerRoutes(controller: ControllerClass) {
  const prototype = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(prototype)
    .filter((methodName) => methodName !== "constructor")
    .map((methodName) => ({
      handler: prototype[methodName],
      methodName,
    }))
    .filter(
      (route): route is { handler: (...args: unknown[]) => unknown; methodName: string } =>
        typeof route.handler === "function" &&
        Reflect.getMetadata(PATH_METADATA, route.handler) !== undefined &&
        Reflect.getMetadata(METHOD_METADATA, route.handler) !== undefined,
    )
    .map((route) => ({
      ...route,
      httpMethod: RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, route.handler) as RequestMethod
      ],
    }));
}

function hasExplicitAccessModel(
  controller: ControllerClass,
  handler: (...args: unknown[]) => unknown,
) {
  return (
    hasMetadata(IS_PUBLIC_KEY, controller, handler) ||
    hasMetadata(IS_AUTHENTICATED_KEY, controller, handler) ||
    hasRequiredPermissions(controller, handler) ||
    hasInternalGuard(controller, handler)
  );
}

function hasMetadata(
  metadataKey: string,
  controller: ControllerClass,
  handler: (...args: unknown[]) => unknown,
) {
  return (
    Reflect.getMetadata(metadataKey, handler) === true ||
    Reflect.getMetadata(metadataKey, controller) === true
  );
}

function hasRequiredPermissions(
  controller: ControllerClass,
  handler: (...args: unknown[]) => unknown,
) {
  const permissions =
    (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) as
      | string[]
      | undefined) ??
    (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, controller) as
      | string[]
      | undefined);

  return Array.isArray(permissions) && permissions.length > 0;
}

function hasInternalGuard(
  controller: ControllerClass,
  handler: (...args: unknown[]) => unknown,
) {
  return (
    getGuards(handler).includes(InternalAuthGuard) ||
    getGuards(controller).includes(InternalAuthGuard)
  );
}

function getGuards(target: object) {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}
