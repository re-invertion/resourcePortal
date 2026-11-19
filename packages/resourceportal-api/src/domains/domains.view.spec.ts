import { describe, expect, it } from "vitest";
import { mapDomain } from "./domains.view";

function domain(protocolMode?: string) {
  const now = new Date("2026-08-30T18:30:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    type: "Managed",
    prefix: "app",
    customRootDomainId: null,
    subdomain: "app",
    hostname: "app.example.com",
    dnsStatus: "Valid",
    tlsEnabled: true,
    certificateStatus: "Active",
    certificateIssuer: "LetsEncrypt",
    certificateExpiresAt: new Date("2026-11-30T00:00:00.000Z"),
    httpEndpointId: protocolMode
      ? "33333333-3333-4333-8333-333333333333"
      : null,
    httpEndpoint: protocolMode
      ? {
          id: "33333333-3333-4333-8333-333333333333",
          name: "public",
          containerPort: 8080,
          protocolMode,
          singleApp: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "web",
            appGroupId: "55555555-5555-4555-8555-555555555555",
          },
        }
      : null,
    createdBy: "66666666-6666-4666-8666-666666666666",
    updatedBy: "66666666-6666-4666-8666-666666666666",
    createdAt: now,
    updatedAt: now,
  } as unknown as Parameters<typeof mapDomain>[0];
}

describe("mapDomain TLS semantics", () => {
  it("reports TLS disabled and clears stale certificate metadata for HTTP", () => {
    const result = mapDomain(domain("HTTP"));

    expect(result.tlsEnabled).toBe(false);
    expect(result.certificateStatus).toBe("Pending");
    expect(result.certificateExpiresAt).toBeNull();
  });

  it("reports TLS enabled for every TLS-requiring protocol mode", () => {
    expect(mapDomain(domain("HTTPS")).tlsEnabled).toBe(true);
    expect(mapDomain(domain("HTTP_AND_HTTPS")).tlsEnabled).toBe(true);
    expect(mapDomain(domain("HTTP_REDIRECT_TO_HTTPS")).tlsEnabled).toBe(true);
  });

  it("reports TLS disabled and clears stale certificate metadata when unassigned", () => {
    const result = mapDomain(domain());

    expect(result.tlsEnabled).toBe(false);
    expect(result.certificateStatus).toBe("Pending");
    expect(result.certificateExpiresAt).toBeNull();
  });
});

describe("#394 ingress intent mirrors stopped-app reconciliation", () => {
  function route(input: {
    app?: string; group?: string; deployed?: number | null;
    pending?: boolean; pendingDeletion?: boolean;
  }) {
    const d = domain("HTTPS");
    const ep = d.httpEndpoint!;
    return mapDomain({
      ...d,
      httpEndpoint: {
        ...ep,
        singleApp: {
          ...ep.singleApp,
          runtimeState: input.app ?? "Running",
          pendingDeletion: input.pendingDeletion ?? false,
          appGroup: {
            tenantId: d.tenantId,
            runtimeState: input.group ?? "Running",
            currentDeploymentVersion: input.deployed === undefined ? 2 : input.deployed,
            hasPendingChanges: input.pending ?? false,
          },
        },
      },
    }).ingress;
  }
  it("does not claim a router exists when app group or application is stopped", () => {
    expect(route({group:"Stopped"}).intentStatus).toBe("AppGroupStopped");
    expect(route({app:"Stopped"}).intentStatus).toBe("ApplicationStopped");
    expect(route({pendingDeletion:true}).intentStatus).toBe("ApplicationPendingDeletion");
  });
  it("distinguishes deployment required from eligible but unobserved route", () => {
    expect(route({deployed:null}).intentStatus).toBe("NeverDeployed");
    expect(route({pending:true}).intentStatus).toBe("PendingDeployment");
    expect(route({}).intentStatus).toBe("RouteEligibleNotObserved");
    expect(route({}).observedRouter).toBe("NotChecked");
  });
  it("does not falsely claim an ingress router when app-group status is missing", () => {
    expect(mapDomain(domain("HTTPS")).ingress.intentStatus).toBe("Unknown");
  });
});


describe("#394 deployment preflight keeps publication, runtime state, and actual observation separate", () => {
  const routed = (changes: Record<string, unknown> = {}) => {
    const d = domain("HTTPS");
    const endpoint = d.httpEndpoint!;
    return mapDomain({
      ...d, ...changes,
      httpEndpoint: {
        ...endpoint,
        singleApp: {
          ...endpoint.singleApp,
          runtimeState: "Running", pendingDeletion: false,
          appGroup: { tenantId: d.tenantId, runtimeState: "Running", currentDeploymentVersion: 3, hasPendingChanges: false },
        },
      },
    }).ingress.preflight;
  };

  it("exposes readiness without claiming a live router has been observed", () => {
    expect(routed()).toEqual({readyForRuntimeInspection:true, deploymentRequired:false, blockers:[], liveRouterVerified:false});
  });

  it("requires a real deployment before treating configuration as up-to-date", () => {
    const d = domain("HTTPS");
    const endpoint = d.httpEndpoint!;
    for (const changes of [{currentDeploymentVersion:null,hasPendingChanges:false},{currentDeploymentVersion:3,hasPendingChanges:true}]) {
      const preflight = mapDomain({...d,httpEndpoint:{...endpoint,singleApp:{...endpoint.singleApp,runtimeState:"Running",pendingDeletion:false,appGroup:{tenantId:d.tenantId,runtimeState:"Running",...changes}}}}).ingress.preflight;
      expect(preflight.readyForRuntimeInspection).toBe(false);
      expect(preflight.deploymentRequired).toBe(true);
    }
  });

  it("blocks a stopped service or stopped group and a pending-deletion app", () => {
    const d = domain("HTTPS"); const endpoint=d.httpEndpoint!;
    for (const [appState, groupState, pendingDeletion, blocker] of [
      ["Stopped","Running",false,"ApplicationStopped"],
      ["Running","Stopped",false,"AppGroupStopped"],
      ["Running","Running",true,"ApplicationPendingDeletion"],
    ] as const) {
      const preflight=mapDomain({...d,httpEndpoint:{...endpoint,singleApp:{...endpoint.singleApp,runtimeState:appState,pendingDeletion,appGroup:{tenantId:d.tenantId,runtimeState:groupState,currentDeploymentVersion:3,hasPendingChanges:false}}}}).ingress.preflight;
      expect(preflight.readyForRuntimeInspection).toBe(false);
      expect(preflight.blockers).toContain(blocker);
    }
  });

  it("rejects invalid DNS, TLS Error and tenant-mismatched App Group without leaking routes", () => {
    const d=domain("HTTPS");const endpoint=d.httpEndpoint!;
    const invalid=mapDomain({...d,dnsStatus:"Invalid",httpEndpoint:{...endpoint,singleApp:{...endpoint.singleApp,runtimeState:"Running",appGroup:{tenantId:d.tenantId,runtimeState:"Running",currentDeploymentVersion:3,hasPendingChanges:false}}}}).ingress.preflight;
    expect(invalid.blockers).toContain("DnsNotValid");
    const tls=routed({certificateStatus:"Error"});
    expect(tls.blockers).toContain("TlsCertificateError");
    const foreign=mapDomain({...d,httpEndpoint:{...endpoint,singleApp:{...endpoint.singleApp,runtimeState:"Running",appGroup:{tenantId:"another-tenant",runtimeState:"Running",currentDeploymentVersion:3,hasPendingChanges:false}}}}).ingress.preflight;
    expect(foreign.blockers).toContain("AppGroupTenantUnknown");
    expect(foreign.readyForRuntimeInspection).toBe(false);
  });
});
