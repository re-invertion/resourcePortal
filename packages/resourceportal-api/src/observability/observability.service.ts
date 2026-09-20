import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

type RequestMetric = {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
};

type RemoteLocationSnapshot = {
  id: string;
  hostname: string;
  status: string;
  health: string;
  maintenance: boolean;
  cpuNano: bigint;
  availableCpuNano: bigint;
  memoryBytes: bigint;
  availableMemoryBytes: bigint;
};

type StorageBackendSnapshot = {
  id: string;
  name: string;
  status: string;
  health: string;
  maintenance: boolean;
  capacityTotal: bigint | null;
  capacityAvailable: bigint | null;
  usedBytes: bigint;
};

@Injectable()
export class ObservabilityService {
  private readonly startedAt = new Date();
  private readonly requestCounts = new Map<string, number>();
  private readonly durationBuckets = new Map<string, number[]>();
  private readonly workerEvents = new Map<string, number>();
  private readonly deploymentOutcomes = new Map<string, number>();
  private readonly deploymentDurationBuckets = new Map<string, number[]>();
  private readonly remoteLocations = new Map<string, RemoteLocationSnapshot>();
  private readonly storageBackends = new Map<string, StorageBackendSnapshot>();
  private readonly buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  private readonly deploymentBucketsSeconds = [1, 5, 10, 30, 60, 120, 300, 600, 1800];

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  recordRequest(metric: RequestMetric) {
    const labels = this.labels(metric.method, metric.route, metric.statusCode);
    this.requestCounts.set(labels, (this.requestCounts.get(labels) ?? 0) + 1);

    const existing = this.durationBuckets.get(labels) ?? this.buckets.map(() => 0);
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (metric.durationMs <= this.buckets[index]) existing[index] += 1;
    }
    this.durationBuckets.set(labels, existing);
  }

  recordWorkerEvent(event: string, workerId: string) {
    const labels = `event="${escapeLabel(event)}",worker_id="${escapeLabel(workerId)}"`;
    this.workerEvents.set(labels, (this.workerEvents.get(labels) ?? 0) + 1);
  }

  recordDeploymentOutcome(status: string, workerId: string, durationMs: number) {
    const labels = `status="${escapeLabel(status)}",worker_id="${escapeLabel(workerId)}"`;
    this.deploymentOutcomes.set(labels, (this.deploymentOutcomes.get(labels) ?? 0) + 1);

    const durationSeconds = durationMs / 1000;
    const existing =
      this.deploymentDurationBuckets.get(labels) ??
      this.deploymentBucketsSeconds.map(() => 0);
    for (let index = 0; index < this.deploymentBucketsSeconds.length; index += 1) {
      if (durationSeconds <= this.deploymentBucketsSeconds[index]) existing[index] += 1;
    }
    this.deploymentDurationBuckets.set(labels, existing);
  }

  recordRemoteLocationSnapshot(snapshot: RemoteLocationSnapshot) {
    this.remoteLocations.set(snapshot.id, snapshot);
  }

  removeRemoteLocationSnapshot(id: string) {
    this.remoteLocations.delete(id);
  }

  recordStorageBackendSnapshot(snapshot: StorageBackendSnapshot) {
    this.storageBackends.set(snapshot.id, snapshot);
  }

  removeStorageBackendSnapshot(id: string) {
    this.storageBackends.delete(id);
  }

  async renderPrometheusMetrics() {
    const lines = [
      "# HELP resource_portal_up Resource Portal process health.",
      "# TYPE resource_portal_up gauge",
      "resource_portal_up 1",
      "# HELP resource_portal_process_started_at_seconds Unix timestamp for process start.",
      "# TYPE resource_portal_process_started_at_seconds gauge",
      `resource_portal_process_started_at_seconds ${Math.floor(this.startedAt.getTime() / 1000)}`,
      "# HELP resource_portal_http_requests_total Total HTTP requests handled by the API process.",
      "# TYPE resource_portal_http_requests_total counter",
    ];

    for (const [labels, count] of this.requestCounts.entries()) {
      lines.push(`resource_portal_http_requests_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE resource_portal_http_request_duration_ms histogram",
    );
    for (const [labels, counts] of this.durationBuckets.entries()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        lines.push(
          `resource_portal_http_request_duration_ms_bucket{${labels},le="${this.buckets[index]}"} ${counts[index]}`,
        );
      }
      const total = this.requestCounts.get(labels) ?? 0;
      lines.push(
        `resource_portal_http_request_duration_ms_bucket{${labels},le="+Inf"} ${total}`,
        `resource_portal_http_request_duration_ms_count{${labels}} ${total}`,
      );
    }

    lines.push(
      "# HELP resource_portal_worker_events_total Process-local worker lifecycle events.",
      "# TYPE resource_portal_worker_events_total counter",
    );
    for (const [labels, count] of this.workerEvents.entries()) {
      lines.push(`resource_portal_worker_events_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_deployments_total Process-local deployment outcomes.",
      "# TYPE resource_portal_deployments_total counter",
    );
    for (const [labels, count] of this.deploymentOutcomes.entries()) {
      lines.push(`resource_portal_deployments_total{${labels}} ${count}`);
    }

    lines.push(
      "# HELP resource_portal_deployment_duration_seconds End-to-end worker deployment processing duration.",
      "# TYPE resource_portal_deployment_duration_seconds histogram",
    );
    for (const [labels, counts] of this.deploymentDurationBuckets.entries()) {
      for (let index = 0; index < this.deploymentBucketsSeconds.length; index += 1) {
        lines.push(
          `resource_portal_deployment_duration_seconds_bucket{${labels},le="${this.deploymentBucketsSeconds[index]}"} ${counts[index]}`,
        );
      }
      const total = this.deploymentOutcomes.get(labels) ?? 0;
      lines.push(
        `resource_portal_deployment_duration_seconds_bucket{${labels},le="+Inf"} ${total}`,
        `resource_portal_deployment_duration_seconds_count{${labels}} ${total}`,
      );
    }

    if (this.prisma) {
      try {
        await this.renderDatabaseMetrics(lines);
        lines.push(
          "# HELP resource_portal_observability_database_query_success Whether shared observability state was read from PostgreSQL.",
          "# TYPE resource_portal_observability_database_query_success gauge",
          "resource_portal_observability_database_query_success 1",
        );
      } catch {
        this.renderRemoteLocationMetrics(lines, this.remoteLocations.values());
        this.renderStorageBackendMetrics(lines, this.storageBackends.values());
        lines.push(
          "# HELP resource_portal_observability_database_query_success Whether shared observability state was read from PostgreSQL.",
          "# TYPE resource_portal_observability_database_query_success gauge",
          "resource_portal_observability_database_query_success 0",
        );
      }
    } else {
      this.renderRemoteLocationMetrics(lines, this.remoteLocations.values());
      this.renderStorageBackendMetrics(lines, this.storageBackends.values());
    }

    return `${lines.join("\n")}\n`;
  }

  private async renderDatabaseMetrics(lines: string[]) {
    if (!this.prisma) return;
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.workerStaleMs());
    const [
      operationGroups,
      retryCount,
      driftGroups,
      workers,
      reconciliations,
      remoteLocations,
      storageBackends,
      volumeUsage,
      oldestPending,
    ] = await Promise.all([
      this.prisma.operation.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.operationEvent.count({ where: { event: "RetryScheduled" } }),
      this.prisma.appGroup.groupBy({ by: ["driftStatus"], _count: { _all: true } }),
      this.prisma.workerRuntimeState.findMany({ orderBy: { workerId: "asc" } }),
      this.prisma.workerReconciliationState.findMany({
        orderBy: [{ workerId: "asc" }, { key: "asc" }],
      }),
      this.prisma.remoteLocation.findMany({ orderBy: { id: "asc" } }),
      this.prisma.storageBackend.findMany({ orderBy: { id: "asc" } }),
      this.prisma.volume.groupBy({
        by: ["storageBackendId"],
        _sum: { usedSizeBytes: true },
      }),
      this.prisma.operation.findFirst({
        where: { status: "Pending" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

    lines.push(
      "# HELP resource_portal_operations Current durable Operations by status.",
      "# TYPE resource_portal_operations gauge",
    );
    for (const group of operationGroups) {
      lines.push(
        `resource_portal_operations{status="${escapeLabel(group.status)}"} ${group._count._all}`,
      );
    }
    lines.push(
      "# HELP resource_portal_operation_retry_events_total Durable retry events recorded by the Operation engine.",
      "# TYPE resource_portal_operation_retry_events_total counter",
      `resource_portal_operation_retry_events_total ${retryCount}`,
      "# HELP resource_portal_operation_oldest_pending_age_seconds Age of the oldest pending Operation.",
      "# TYPE resource_portal_operation_oldest_pending_age_seconds gauge",
      `resource_portal_operation_oldest_pending_age_seconds ${oldestPending ? Math.max(0, (now.getTime() - oldestPending.createdAt.getTime()) / 1000) : 0}`,
      "# HELP resource_portal_app_groups_drift Current App Groups grouped by persisted drift status.",
      "# TYPE resource_portal_app_groups_drift gauge",
    );
    for (const group of driftGroups) {
      lines.push(
        `resource_portal_app_groups_drift{status="${escapeLabel(group.driftStatus)}"} ${group._count._all}`,
      );
    }

    let activeWorkers = 0;
    let staleWorkers = 0;
    lines.push(
      "# HELP resource_portal_worker_up Durable Worker heartbeat health.",
      "# TYPE resource_portal_worker_up gauge",
      "# HELP resource_portal_worker_last_heartbeat_timestamp_seconds Last durable Worker heartbeat timestamp.",
      "# TYPE resource_portal_worker_last_heartbeat_timestamp_seconds gauge",
    );
    for (const worker of workers) {
      const healthy =
        worker.status === "Running" &&
        worker.heartbeatAt.getTime() >= staleBefore.getTime();
      if (healthy) activeWorkers += 1;
      else if (worker.status === "Running") staleWorkers += 1;
      const labels = `worker_id="${escapeLabel(worker.workerId)}",status="${escapeLabel(worker.status)}"`;
      lines.push(
        `resource_portal_worker_up{${labels}} ${healthy ? 1 : 0}`,
        `resource_portal_worker_last_heartbeat_timestamp_seconds{${labels}} ${worker.heartbeatAt.getTime() / 1000}`,
      );
    }
    lines.push(
      "# HELP resource_portal_workers_active Number of Workers with a fresh heartbeat.",
      "# TYPE resource_portal_workers_active gauge",
      `resource_portal_workers_active ${activeWorkers}`,
      "# HELP resource_portal_workers_stale Number of Running Workers with a stale heartbeat.",
      "# TYPE resource_portal_workers_stale gauge",
      `resource_portal_workers_stale ${staleWorkers}`,
      "# HELP resource_portal_worker_reconciliation_healthy Whether the latest reconciliation result is healthy.",
      "# TYPE resource_portal_worker_reconciliation_healthy gauge",
      "# HELP resource_portal_worker_reconciliation_success_total Durable reconciliation successes.",
      "# TYPE resource_portal_worker_reconciliation_success_total counter",
      "# HELP resource_portal_worker_reconciliation_failure_total Durable reconciliation failures.",
      "# TYPE resource_portal_worker_reconciliation_failure_total counter",
      "# HELP resource_portal_worker_reconciliation_last_duration_seconds Duration of the latest reconciliation.",
      "# TYPE resource_portal_worker_reconciliation_last_duration_seconds gauge",
    );
    for (const reconciliation of reconciliations) {
      const healthy =
        reconciliation.lastFailureAt === null ||
        (reconciliation.lastSuccessAt !== null &&
          reconciliation.lastSuccessAt >= reconciliation.lastFailureAt);
      const labels = `worker_id="${escapeLabel(reconciliation.workerId)}",reconciliation="${escapeLabel(reconciliation.key)}"`;
      lines.push(
        `resource_portal_worker_reconciliation_healthy{${labels}} ${healthy ? 1 : 0}`,
        `resource_portal_worker_reconciliation_success_total{${labels}} ${reconciliation.successCount}`,
        `resource_portal_worker_reconciliation_failure_total{${labels}} ${reconciliation.failureCount}`,
        `resource_portal_worker_reconciliation_last_duration_seconds{${labels}} ${(reconciliation.lastDurationMs ?? 0) / 1000}`,
      );
    }

    const usedByBackend = new Map(
      volumeUsage.map((row) => [row.storageBackendId, row._sum.usedSizeBytes ?? 0n]),
    );
    this.renderRemoteLocationMetrics(
      lines,
      remoteLocations.map((row) => ({ ...row })),
    );
    this.renderStorageBackendMetrics(
      lines,
      storageBackends.map((row) => ({
        ...row,
        usedBytes: usedByBackend.get(row.id) ?? 0n,
      })),
    );
  }

  private renderRemoteLocationMetrics(
    lines: string[],
    snapshots: Iterable<RemoteLocationSnapshot>,
  ) {
    lines.push(
      "# HELP resource_portal_remote_location_cpu_nano Total CPU capacity of a RemoteLocation in nano CPUs.",
      "# TYPE resource_portal_remote_location_cpu_nano gauge",
      "# HELP resource_portal_remote_location_available_cpu_nano Scheduler-available CPU capacity of a RemoteLocation in nano CPUs.",
      "# TYPE resource_portal_remote_location_available_cpu_nano gauge",
      "# HELP resource_portal_remote_location_memory_bytes Total memory capacity of a RemoteLocation.",
      "# TYPE resource_portal_remote_location_memory_bytes gauge",
      "# HELP resource_portal_remote_location_available_memory_bytes Scheduler-available memory capacity of a RemoteLocation.",
      "# TYPE resource_portal_remote_location_available_memory_bytes gauge",
    );
    for (const snapshot of snapshots) {
      const labels = remoteLocationLabels(snapshot);
      lines.push(
        `resource_portal_remote_location_cpu_nano{${labels}} ${snapshot.cpuNano.toString()}`,
        `resource_portal_remote_location_available_cpu_nano{${labels}} ${snapshot.availableCpuNano.toString()}`,
        `resource_portal_remote_location_memory_bytes{${labels}} ${snapshot.memoryBytes.toString()}`,
        `resource_portal_remote_location_available_memory_bytes{${labels}} ${snapshot.availableMemoryBytes.toString()}`,
      );
    }
  }

  private renderStorageBackendMetrics(
    lines: string[],
    snapshots: Iterable<StorageBackendSnapshot>,
  ) {
    lines.push(
      "# HELP resource_portal_storage_backend_capacity_total_bytes Total physical capacity reported by a StorageBackend.",
      "# TYPE resource_portal_storage_backend_capacity_total_bytes gauge",
      "# HELP resource_portal_storage_backend_capacity_available_bytes Available physical capacity reported by a StorageBackend.",
      "# TYPE resource_portal_storage_backend_capacity_available_bytes gauge",
      "# HELP resource_portal_storage_backend_used_bytes Logical used bytes measured for Volumes on a StorageBackend.",
      "# TYPE resource_portal_storage_backend_used_bytes gauge",
    );
    for (const snapshot of snapshots) {
      const labels = storageBackendLabels(snapshot);
      if (snapshot.capacityTotal !== null) {
        lines.push(
          `resource_portal_storage_backend_capacity_total_bytes{${labels}} ${snapshot.capacityTotal.toString()}`,
        );
      }
      if (snapshot.capacityAvailable !== null) {
        lines.push(
          `resource_portal_storage_backend_capacity_available_bytes{${labels}} ${snapshot.capacityAvailable.toString()}`,
        );
      }
      lines.push(
        `resource_portal_storage_backend_used_bytes{${labels}} ${snapshot.usedBytes.toString()}`,
      );
    }
  }

  private workerStaleMs() {
    const raw = Number.parseInt(
      this.config?.get<string>("WORKER_HEALTH_STALE_SECONDS", "30") ?? "30",
      10,
    );
    return (Number.isFinite(raw) && raw > 0 ? raw : 30) * 1000;
  }

  private labels(method: string, route: string, statusCode: number) {
    return [
      `method="${escapeLabel(method)}"`,
      `route="${escapeLabel(route)}"`,
      `status_code="${statusCode}"`,
    ].join(",");
  }
}

function remoteLocationLabels(snapshot: RemoteLocationSnapshot) {
  return [
    `remote_location_id="${escapeLabel(snapshot.id)}"`,
    `hostname="${escapeLabel(snapshot.hostname)}"`,
    `status="${escapeLabel(snapshot.status)}"`,
    `health="${escapeLabel(snapshot.health)}"`,
    `maintenance="${snapshot.maintenance}"`,
  ].join(",");
}

function storageBackendLabels(snapshot: StorageBackendSnapshot) {
  return [
    `storage_backend_id="${escapeLabel(snapshot.id)}"`,
    `name="${escapeLabel(snapshot.name)}"`,
    `status="${escapeLabel(snapshot.status)}"`,
    `health="${escapeLabel(snapshot.health)}"`,
    `maintenance="${snapshot.maintenance}"`,
  ].join(",");
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
