export type CapacityDemand = {
  cpuNano: bigint;
  memoryBytes: bigint;
};

export type CapacitySnapshotSingleApp = {
  runtimeState: string;
  desiredReplicas: number;
  resources: {
    cpu: string;
    memoryBytes: string;
    gpu: number;
  };
};

export type CapacitySnapshot = {
  appGroup: {
    runtimeState: string;
  };
  singleApps: CapacitySnapshotSingleApp[];
};

const NANO_CPUS_PER_CPU = 1_000_000_000n;

function cpuToNanoCpu(cpu: string) {
  const normalized = cpu.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid CPU value: ${cpu}`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > 9 && /[1-9]/.test(fraction.slice(9))) {
    throw new Error(`CPU value has sub-NanoCPU precision: ${cpu}`);
  }

  const fractionalNano = `${fraction.slice(0, 9)}000000000`.slice(0, 9);
  return BigInt(whole) * NANO_CPUS_PER_CPU + BigInt(fractionalNano);
}

export function snapshotDemand(snapshot: CapacitySnapshot): CapacityDemand {
  if (snapshot.appGroup.runtimeState !== "Running") {
    return { cpuNano: 0n, memoryBytes: 0n };
  }

  return snapshot.singleApps.reduce<CapacityDemand>(
    (demand, singleApp) => {
      const replicas =
        singleApp.runtimeState === "Running"
          ? Math.max(0, singleApp.desiredReplicas)
          : 0;
      const replicaCount = BigInt(replicas);

      return {
        cpuNano:
          demand.cpuNano + cpuToNanoCpu(singleApp.resources.cpu) * replicaCount,
        memoryBytes:
          demand.memoryBytes +
          BigInt(singleApp.resources.memoryBytes) * replicaCount,
      };
    },
    { cpuNano: 0n, memoryBytes: 0n },
  );
}

export function projectedCapacityFits(
  supply: CapacityDemand,
  occupied: CapacityDemand,
  requested: CapacityDemand,
):
  | { fits: true }
  | { fits: false; resource: "cpu" | "memory" } {
  if (occupied.cpuNano + requested.cpuNano > supply.cpuNano) {
    return { fits: false, resource: "cpu" };
  }

  if (occupied.memoryBytes + requested.memoryBytes > supply.memoryBytes) {
    return { fits: false, resource: "memory" };
  }

  return { fits: true };
}
