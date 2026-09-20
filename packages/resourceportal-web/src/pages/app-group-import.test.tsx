import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportAppGroupPage } from "./app-group-import";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ImportAppGroupPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a YAML file, validates it first and only then offers creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      valid: true,
      errors: [],
      warnings: [],
      summary: {
        appGroupName: "commerce-prod",
        runtimeState: "Stopped",
        apps: 2,
        variables: 1,
        secrets: 1,
        configs: 1,
        httpEndpoints: 1,
        domainAttachments: 1,
        volumeAttachments: 1,
        registries: [],
        volumes: ["app-data"],
        domains: ["app.example.com"],
        requiredPermissions: ["appgroup.create", "singleapp.create"],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ImportAppGroupPage tenantId="t1" />);

    expect(screen.queryByRole("button", { name: /create app group/i })).toBeNull();

    const file = new File(
      ["apiVersion: resourceportal.io/v1alpha1\nkind: AppGroup\nmetadata:\n  name: commerce-prod\n"],
      "commerce.yml",
      { type: "text/yaml" },
    );
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue(
        "apiVersion: resourceportal.io/v1alpha1\nkind: AppGroup\nmetadata:\n  name: commerce-prod\n",
      ),
    });

    fireEvent.change(screen.getByLabelText("YAML manifest file"), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/ready to validate/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Validate manifest" }));

    expect(await screen.findByText("Manifest is valid")).toBeTruthy();
    expect(screen.getByText("commerce-prod")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create app group/i })).toBeTruthy();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tenants/t1/app-groups/import/validate",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("renders backend validation issues instead of allowing apply", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      valid: false,
      errors: [{
        path: "$.metadata.name",
        code: "AppGroupAlreadyExists",
        message: "App Group already exists",
      }],
      warnings: [],
    })));

    render(<ImportAppGroupPage tenantId="t1" />);
    const file = new File(["content"], "demo.yaml", { type: "text/yaml" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue("content"),
    });

    fireEvent.change(screen.getByLabelText("YAML manifest file"), {
      target: { files: [file] },
    });
    await screen.findByText(/ready to validate/i);
    fireEvent.click(screen.getByRole("button", { name: "Validate manifest" }));

    expect(await screen.findByText("Manifest cannot be applied")).toBeTruthy();
    expect(screen.getByText(/App Group already exists/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create app group/i })).toBeNull();
  });
});
