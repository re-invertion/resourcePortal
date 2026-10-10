import { describe, expect, it, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { SingleAppLogsService } from "./single-app-logs.service";

describe("SingleAppLogsService", () => {
  it("resolves the service from the tenant-scoped application instead of caller input", async () => {
    const findFirst = vi.fn().mockResolvedValue({ name: "my-app" });
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "2026-10-10T09:00:00Z first\nsecond", stderr: "" });
    const service = new SingleAppLogsService(
      { singleApp: { findFirst } } as never,
      { run } as never,
    );
    const result = await service.list("tenant-id", "ab-cd", "app-id");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "app-id", appGroupId: "ab-cd", appGroup: { tenantId: "tenant-id" } },
      select: { name: true },
    });
    expect(run).toHaveBeenCalledWith("docker", ["service", "logs", "--timestamps", "--tail", "100", "rp_ab_cd_my_app"], 15_000);
    expect(result.lines).toEqual(["2026-10-10T09:00:00Z first", "second"]);
  });

  it("does not reveal a service or query Docker when the app is outside the tenant", async () => {
    const run = vi.fn();
    const service = new SingleAppLogsService(
      { singleApp: { findFirst: vi.fn().mockResolvedValue(null) } } as never,
      { run } as never,
    );
    await expect(service.list("other-tenant", "ag", "app")).rejects.toBeInstanceOf(NotFoundException);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not expose raw Docker error details to the API client", async () => {
    const service = new SingleAppLogsService(
      { singleApp: { findFirst: vi.fn().mockResolvedValue({ name: "checkout" }) } } as never,
      { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "sensitive host info" }) } as never,
    );
    await expect(service.list("tenant", "group", "app")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("caps the response even if the Docker command returns too much log text", async () => {
    const service = new SingleAppLogsService(
      { singleApp: { findFirst: vi.fn().mockResolvedValue({ name: "checkout" }) } } as never,
      { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "x".repeat(100000), stderr: "" }) } as never,
    );
    const result = await service.list("tenant", "group", "app");
    expect(result.lines.join("\n").length).toBeLessThanOrEqual(65536);
  });
});
