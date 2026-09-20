import { describe, expect, it } from "vitest";
import {
  APP_GROUP_MANIFEST_API_VERSION,
  parseAppGroupManifest,
  redactedManifestPreview,
} from "./app-group-manifest";

const validManifest = `
apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: commerce-prod
  description: Commerce stack
spec:
  runtimeState: Stopped
  variables:
    - name: LOG_LEVEL
      value: info
  secrets:
    - name: API_TOKEN
      type: Text
      value: super-secret
  configs:
    - name: nginx-conf
      content: |
        server { listen 80; }
  apps:
    - name: web
      image: registry.example.com/team/web:1.0
      registry: production
      desiredReplicas: 2
      resources:
        cpu: 0.5
        memoryBytes: 536870912
      variables:
        - source: LOG_LEVEL
      secrets:
        - source: API_TOKEN
      configs:
        - source: nginx-conf
          targetPath: /etc/nginx/conf.d/default.conf
      volumes:
        - source: app-data
          mountPath: /var/lib/app
      httpEndpoints:
        - name: web
          containerPort: 80
          domains:
            - app.example.com
`;

describe("App Group YAML manifest", () => {
  it("parses and normalizes the versioned v1alpha1 format", () => {
    const result = parseAppGroupManifest(validManifest);

    expect(result.errors).toEqual([]);
    expect(result.manifest?.apiVersion).toBe(APP_GROUP_MANIFEST_API_VERSION);
    expect(result.manifest?.metadata.name).toBe("commerce-prod");
    expect(result.manifest?.spec.apps[0]).toMatchObject({
      name: "web",
      desiredReplicas: 2,
      runtimeState: "Running",
      resources: { cpu: 0.5, memoryBytes: 536870912, gpu: 0 },
      readOnlyRootFilesystem: false,
      stopGracePeriodSeconds: 30,
    });
    expect(result.manifest?.spec.apps[0].volumes[0].mode).toBe("ReadWrite");
    expect(result.manifest?.spec.apps[0].httpEndpoints[0].protocolMode).toBe(
      "HTTP_REDIRECT_TO_HTTPS",
    );
    expect(result.manifest?.spec.apps[0].variables[0].targetName).toBe("LOG_LEVEL");
  });

  it("rejects unknown fields and references to App Group resources that are not declared", () => {
    const result = parseAppGroupManifest(`
apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: demo
  unexpected: true
spec:
  apps:
    - name: api
      image: nginx:latest
      resources:
        cpu: 0.25
        memoryBytes: 134217728
      secrets:
        - source: MISSING_SECRET
`);

    expect(result.manifest).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.metadata.unexpected", code: "UnknownField" }),
      expect.objectContaining({ code: "UnknownSecret" }),
    ]));
  });

  it("validates binary secrets, duplicate resource names and safe config paths", () => {
    const result = parseAppGroupManifest(`
apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: demo
spec:
  secrets:
    - name: cert
      type: Binary
      value: not_base64!
    - name: cert
      type: Text
      value: duplicate
  configs:
    - name: app-config
      content: ok
  apps:
    - name: api
      image: nginx:latest
      resources:
        cpu: 0.25
        memoryBytes: 134217728
      configs:
        - source: app-config
          targetPath: /etc/../passwd
`);

    expect(result.manifest).toBeUndefined();
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "InvalidBase64" }),
      expect.objectContaining({ code: "DuplicateValue" }),
      expect.objectContaining({ code: "InvalidTargetPath" }),
    ]));
  });

  it("redacts secret values from the validation preview", () => {
    const result = parseAppGroupManifest(validManifest);
    expect(result.manifest).toBeDefined();

    const preview = redactedManifestPreview(result.manifest!);
    expect(preview.spec.secrets[0].value).toBe("<redacted>");
    expect(JSON.stringify(preview)).not.toContain("super-secret");
  });
});
