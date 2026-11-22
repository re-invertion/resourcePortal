// One deterministic console clock: Europe/Warsaw, with an explicit zone in every exact timestamp.
// Relative text is supplementary; absolute timestamps remain available to assistive technology.
export const CONSOLE_TIME_ZONE = "Europe/Warsaw";

export function exactConsoleDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONSOLE_TIME_ZONE, dateStyle: "medium", timeStyle: "short", hourCycle: "h23",
  }).format(date);
  return `${formatted} (Europe/Warsaw)`;
}

export function relativeConsoleDate(value: unknown, now = Date.now()): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !Number.isFinite(now)) return "—";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [seconds, "second"] :
    abs < 3600 ? [Math.round(seconds / 60), "minute"] :
    abs < 86400 ? [Math.round(seconds / 3600), "hour"] :
    abs < 604800 ? [Math.round(seconds / 86400), "day"] :
    [Math.round(seconds / 604800), "week"];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" }).format(amount, unit);
}
