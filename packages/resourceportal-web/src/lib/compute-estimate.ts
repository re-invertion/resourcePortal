export type EstimateRates = {
  available: boolean;
  version?: number;
  effectiveFrom?: string;
  cpuCreditsPerVcpuHour?: string;
  memoryCreditsPerGbHour?: string;
  plnPerCredit?: string;
};

// Indicative only: CPU and RAM for desired running replicas, not a bill.
// The RP billing engine uses decimal GB (1_000_000_000 bytes), not GiB.
export function estimateComputePln(
  rates: EstimateRates | undefined,
  input: { replicas: number; cpu: number; memoryMiB: number; runtimeState: string },
): { hourly: number; monthly: number } | undefined {
  if (!rates?.available) return undefined;
  const cpuRate = Number(rates.cpuCreditsPerVcpuHour);
  const ramRate = Number(rates.memoryCreditsPerGbHour);
  const plnPerCredit = Number(rates.plnPerCredit);
  if (![cpuRate, ramRate, plnPerCredit, input.replicas, input.cpu, input.memoryMiB].every(Number.isFinite)) return undefined;
  if ([cpuRate, ramRate, plnPerCredit, input.replicas, input.cpu, input.memoryMiB].some(n => n < 0)) return undefined;
  const replicas = input.runtimeState === "Stopped" ? 0 : input.replicas;
  const hourly = replicas * (input.cpu * cpuRate + input.memoryMiB * 1048576 / 1_000_000_000 * ramRate) * plnPerCredit;
  return { hourly, monthly: hourly * 730 };
}
