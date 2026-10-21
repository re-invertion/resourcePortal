import { describe, expect, it } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

describe("deployment mount path safety", () => {
  const validate = (volumes: string[], configs: string[], secrets: string[] = []) => {
    const service = Object.create(DeploymentExecutionService.prototype) as {
      validateMountPaths(snapshot: unknown): { success: boolean; errorCode: string } | null;
      validationFailure(errorCode: string, message: string): { success: boolean; errorCode: string; message: string };
    };
    service.validationFailure = (errorCode, message) => ({ success: false, errorCode, message });
    return service.validateMountPaths({
      singleApps: [{
        name: "demo",
        volumes: volumes.map((mountPath) => ({ mountPath })),
        configs: configs.map((targetPath) => ({ targetPath })),
        secrets: secrets.map((targetName) => ({ targetName, id: targetName })),
      }],
    });
  };

  it("rejects Docker Config nested under a persistent Volume", () => {
    expect(validate(["/config"], ["/config/configuration.yaml"])?.errorCode).toBe("OverlappingMountPaths");
  });
  it("rejects equal targets", () => {
    expect(validate(["/data"], ["/data"])?.errorCode).toBe("OverlappingMountPaths");
  });
  it("rejects volume hiding secrets mounted by filename", () => {
    expect(validate(["/run/secrets"], [], ["db_password"])?.errorCode).toBe("OverlappingMountPaths");
  });
  it("rejects a volume at the exact effective secret path", () => {
    expect(validate(["/run/secrets/db_password"], [], ["db_password"])?.errorCode).toBe("OverlappingMountPaths");
  });
  it("accepts unrelated volumes with secrets", () => {
    expect(validate(["/data"], [], ["db_password"])).toBeNull();
  });
  it("accepts distinct mounts", () => {
    expect(validate(["/data"], ["/etc/app/config.yaml"])).toBeNull();
  });
  it("does not reject sibling names with the same prefix", () => {
    expect(validate(["/config"], ["/configuration.yaml"])).toBeNull();
  });
});
