import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { SwarmCapacityNodeProbeRouter } from "./swarm-capacity-node-probe-router";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const nodeA = "ku2gbq2sm1b2khra543dtyxfg";
const nodeB = "pu2gbq2sm1b2khra543dtyxfh";
const report = (nodeId: string) => ({
  status: "Observed",
  swarmNodeId: nodeId,
  memoryTotalBytes: "67417341952",
  memoryAvailableBytes: "49392123904",
  memoryPsiSomeAvg10: 0,
  memoryPsiFullAvg10: 0,
  containers: [{
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    appId: "11111111-2222-3333-4444-555555555555",
    startedAt: "2026-10-29T20:00:00.000Z",
    memoryCurrentBytes: "2147483648",
    memoryPeakBytes: "2684354560",
    oomEvents: "0",
    memoryPsiSomeAvg10: 0,
    memoryPsiFullAvg10: 0,
  }],
});

function makeRouter(token = "internal_worker_token_1234567890") {
  const config = {
    get: (key: string) =>
      key === "INTERNAL_WORKER_TOKEN"
        ? token
        : key === "RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME"
          ? "rp"
          : undefined,
  };
  return new SwarmCapacityNodeProbeRouter(config as never);
}

describe("authenticated per-node capacity probe routing", () => {
  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "10.0.0.11", family: 4 },
      { address: "10.0.0.12", family: 4 },
    ] as never);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses discovery without the private worker credential", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await makeRouter("").collect()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts one authenticated report per distinct Swarm node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(input.includes(".11:") ? report(nodeA) : report(nodeB)),
            { status: 200 },
          ),
        ),
      ),
    );
    const result = await makeRouter().collect();
    expect(result.map((item) => item.swarmNodeId).sort()).toEqual(
      [nodeA, nodeB].sort(),
    );
  });

  it("drops duplicate node identities and malformed memory reports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input.includes(".11:")
                ? report(nodeA)
                : { ...report(nodeA), memoryAvailableBytes: "999999999999" },
            ),
            { status: 200 },
          ),
        ),
      ),
    );
    expect(await makeRouter().collect()).toEqual([report(nodeA)]);
  });
});
