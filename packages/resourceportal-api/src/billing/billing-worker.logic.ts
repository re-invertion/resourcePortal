import { closedMinutePeriod } from "./billing-math";

export function effectiveReplicaCount(input: {
  desiredReplicas: number;
  appGroupRunning: boolean;
  singleAppRunning: boolean;
  billingActive: boolean;
  pendingDeletion: boolean;
}) {
  if (
    !input.appGroupRunning ||
    !input.singleAppRunning ||
    !input.billingActive ||
    input.pendingDeletion
  ) {
    return 0;
  }

  return Math.max(0, input.desiredReplicas);
}

export function billedReplicaCount(actualReplicas: number, effectiveReplicas: number) {
  return Math.max(0, Math.min(actualReplicas, effectiveReplicas));
}

export function reconciliationPeriods(input: {
  now: Date;
  lastCompletedPeriodEnd: Date | null;
  maxPeriods: number;
}) {
  const closed = closedMinutePeriod(input.now);
  const maxPeriods = Math.max(1, input.maxPeriods);

  if (input.lastCompletedPeriodEnd === null) {
    return [closed];
  }

  const periods: Array<{ periodStart: Date; periodEnd: Date }> = [];
  let periodStart = new Date(input.lastCompletedPeriodEnd);

  while (
    periodStart.getTime() < closed.periodEnd.getTime() &&
    periods.length < maxPeriods
  ) {
    const periodEnd = new Date(periodStart.getTime() + 60_000);
    if (periodEnd.getTime() > closed.periodEnd.getTime()) {
      break;
    }
    periods.push({ periodStart: new Date(periodStart), periodEnd });
    periodStart = periodEnd;
  }

  return periods;
}
