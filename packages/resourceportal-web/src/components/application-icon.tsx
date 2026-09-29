import { useEffect, useMemo, useState } from "react";
import { GridIcon, cx } from "./design-system";

type AppLike = Record<string, unknown>;

function value(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function imageProject(image: string) {
  if (!image) return "";
  const withoutDigest = image.split("@", 1)[0];
  const last = withoutDigest.split("/").filter(Boolean).at(-1) ?? "";
  return slug(last.replace(/:[^:]+$/, ""));
}

const ICON_ALIASES: Record<string, string[]> = {
  postgres: ["postgresql"],
  penpotapp: ["penpot"],
  mongo: ["mongodb"],
  homeassistant: ["home-assistant"],
  "home-assistant-core": ["home-assistant"],
  jellyfinserver: ["jellyfin"],
  "linuxserver-plex": ["plex"],
};

function aliasedCandidates(candidate: string) {
  if (!candidate) return [];
  return [...(ICON_ALIASES[candidate] ?? []), candidate];
}

const GENERIC_SERVICE_NAMES = new Set([
  "api",
  "backend",
  "exporter",
  "frontend",
  "server",
  "web",
  "worker",
]);

function serviceFamily(name: string) {
  const parts = slug(name).split("-").filter(Boolean);
  if (parts.length < 2 || !GENERIC_SERVICE_NAMES.has(parts.at(-1) ?? "")) return "";
  return parts.slice(0, -1).join("-");
}


export function applicationIconKey(app: AppLike) {
  const imageCandidate = imageProject(value(app.image));
  const nameCandidate = slug(value(app.name));
  const familyCandidate = serviceFamily(nameCandidate);
  const candidate = GENERIC_SERVICE_NAMES.has(imageCandidate)
    ? familyCandidate || nameCandidate || imageCandidate
    : imageCandidate || familyCandidate || nameCandidate || "application";
  return ICON_ALIASES[candidate]?.[0] ?? candidate;
}

function selfHostedCandidates(app: AppLike) {
  const imageCandidate = imageProject(value(app.image));
  const nameCandidate = slug(value(app.name));
  const familyCandidate = serviceFamily(nameCandidate);
  const candidates = GENERIC_SERVICE_NAMES.has(imageCandidate)
    ? [familyCandidate, nameCandidate, imageCandidate]
    : [imageCandidate, familyCandidate, nameCandidate];
  return Array.from(new Set(candidates.filter(Boolean).flatMap(aliasedCandidates)));
}

function faviconUrl(webUiUrl: string) {
  try {
    return new URL("/favicon.ico", webUiUrl).toString();
  } catch {
    return "";
  }
}

type IconSource = { kind: "selfhst" | "favicon"; url: string };

function sourcesFor(app: AppLike) {
  const sources: IconSource[] = selfHostedCandidates(app).map((candidate) => ({
    kind: "selfhst",
    url: `https://cdn.jsdelivr.net/gh/selfhst/icons/png/${candidate}.png`,
  }));
  const webUiUrl = value(app.webUiUrl);
  const favicon = faviconUrl(webUiUrl);
  if (favicon) sources.push({ kind: "favicon", url: favicon });
  return sources;
}

export function ApplicationIcon({
  app,
  className,
  imageClassName,
}: {
  app: AppLike;
  className?: string;
  imageClassName?: string;
}) {
  const sources = useMemo(
    () => sourcesFor(app),
    [app.image, app.name, app.webUiUrl],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [sources.map((source) => source.url).join("|")]);
  const source = sources[index];

  return (
    <span
      className={cx(
        "relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#F0F5FC] text-[#1769E0]",
        className,
      )}
      data-icon-key={applicationIconKey(app)}
    >
      {source ? (
        <>
          <img
            src={source.url}
            alt=""
            title={source.kind === "selfhst" ? "Icon from selfh.st/icons (CC BY 4.0)" : undefined}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={cx("h-[72%] w-[72%] object-contain", imageClassName)}
            onError={() => setIndex((current) => current + 1)}
          />
          {source.kind === "selfhst" ? (
            <span className="sr-only">Icon source: selfh.st/icons, CC BY 4.0.</span>
          ) : null}
        </>
      ) : (
        <GridIcon size={Math.max(14, 18)} aria-hidden="true" />
      )}
    </span>
  );
}

export function AppGroupIcon({
  apps,
  className,
}: {
  apps: AppLike[];
  className?: string;
}) {
  const uniqueApps = useMemo(() => {
    const seen = new Set<string>();
    const result: AppLike[] = [];
    for (const app of apps) {
      const key = applicationIconKey(app);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(app);
      if (result.length === 4) break;
    }
    return result;
  }, [apps]);

  if (uniqueApps.length === 0) {
    return (
      <span className={cx("flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-xl bg-[#E7F1FF] text-[#1769E0]", className)}>
        <GridIcon size={22} aria-hidden="true" />
      </span>
    );
  }

  const two = uniqueApps.length === 2;
  return (
    <span
      className={cx(
        "grid h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl border border-[#D7E0EC] bg-white p-1",
        uniqueApps.length === 1 ? "grid-cols-1" : "grid-cols-2",
        className,
      )}
      aria-label="Application icons in this App Group"
    >
      {uniqueApps.map((app, index) => (
        <ApplicationIcon
          key={applicationIconKey(app)}
          app={app}
          className={cx(
            "h-full w-full min-h-0 min-w-0 rounded-md bg-[#F5F8FC]",
            uniqueApps.length === 1 && "p-1",
            two && "aspect-auto",
            uniqueApps.length === 3 && index === 2 && "col-span-2 mx-auto w-1/2",
          )}
          imageClassName={uniqueApps.length > 1 ? "h-[78%] w-[78%]" : undefined}
        />
      ))}
    </span>
  );
}