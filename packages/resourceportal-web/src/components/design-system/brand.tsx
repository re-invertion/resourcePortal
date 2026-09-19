export function ResourcePortalLogo({ compact = false, tone = "default" }: { compact?: boolean; tone?: "default" | "inverse" }) {
  const inverse = tone === "inverse";
  const src = compact
    ? "/brand/resourceportal-icon-hq.png"
    : inverse
      ? "/brand/resourceportal-wordmark-white-hq.png"
      : "/brand/resourceportal-wordmark-hq.png";

  const imageClass = compact
    ? "h-9 w-9 shrink-0 object-contain"
    : inverse
      ? "h-auto w-[250px] max-w-full object-contain"
      : "h-auto w-[140px] max-w-full object-contain";

  return <span
    className={`inline-flex min-w-0 max-w-full items-center ${inverse ? "text-white" : ""}`}
    aria-label="ResourcePortal"
    data-brand-source="penpot"
  >
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={imageClass}
    />
  </span>;
}