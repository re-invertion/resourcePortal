import { expect, it } from "vitest";
import { buildTopologyGraph, type Topology } from "./tenant-networking-graph";

it("uses effective runtime state when the group is stopped, retaining the configured state separately", () => {
  const topology: Topology = {
    networks: [],
    gates: [],
    appGroups: [{
      id: "group-1", name: "showcase", hasPendingChanges: false, effectiveRuntimeState: "Stopped",
      singleApps: [{
        id: "app-1", name: "web", runtimeState: "Running", networkAttachments: [],
      }],
    }],
  };
  const graph = buildTopologyGraph(topology, {
    query: "", focusNetworkId: "", showApplications: true, showGates: true, status: "all",
  });
  const app = graph.nodes.find(node => node.id === "app:app-1");
  expect(app?.data).toMatchObject({ runtimeState: "Stopped", desiredRuntimeState: "Running" });
});
