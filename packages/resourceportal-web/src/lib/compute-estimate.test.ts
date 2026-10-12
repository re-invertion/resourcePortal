import { expect, it } from "vitest";
import { estimateComputePln } from "./compute-estimate";

const rates = {
  available: true, cpuCreditsPerVcpuHour: "100", memoryCreditsPerGbHour: "25", plnPerCredit: "0.01",
};
it("estimates hour and 730-hour month using the same decimal GB convention as backend billing", () => {
  const result = estimateComputePln(rates, { replicas: 2, cpu: 1, memoryMiB: 1024, runtimeState: "Running" });
  const expected = 2 * (100 + 25 * (1024 * 1048576 / 1_000_000_000)) * 0.01;
  expect(result?.hourly).toBeCloseTo(expected);
  expect(result?.monthly).toBeCloseTo(expected * 730);
});
it("does not fabricate prices when there is no active price list or invalid rates", () => {
  expect(estimateComputePln({ available: false }, { replicas: 1, cpu: 1, memoryMiB: 512, runtimeState: "Running" })).toBeUndefined();
  expect(estimateComputePln({ available: true, cpuCreditsPerVcpuHour: "?", memoryCreditsPerGbHour: "1", plnPerCredit: "0.01" }, { replicas: 1, cpu: 1, memoryMiB: 512, runtimeState: "Running" })).toBeUndefined();
});
it("assumes no compute billing when the desired state is Stopped", () => {
  expect(estimateComputePln(rates, { replicas: 8, cpu: 2, memoryMiB: 1024, runtimeState: "Stopped" })).toEqual({ hourly: 0, monthly: 0 });
});
