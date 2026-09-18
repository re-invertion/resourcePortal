export function ResourcePortalLogo({ compact = false, tone = "default" }: { compact?: boolean; tone?: "default" | "inverse" }) {
  const inverse = tone === "inverse";
  return <span className={`inline-flex min-w-0 items-center gap-2.5 ${inverse ? "text-white" : ""}`} aria-label="ResourcePortal">
    <svg viewBox="0 0 44 44" className="h-9 w-9 shrink-0" role="img" aria-hidden="true">
      {!inverse ? <defs><linearGradient id="rp-logo-front" x1="5" y1="4" x2="34" y2="38" gradientUnits="userSpaceOnUse"><stop stopColor="#1199ef"/><stop offset="1" stopColor="#1769e0"/></linearGradient><linearGradient id="rp-logo-side" x1="28" y1="9" x2="40" y2="33" gradientUnits="userSpaceOnUse"><stop stopColor="#0a6eb7"/><stop offset="1" stopColor="#064f91"/></linearGradient></defs> : null}
      <path d="M13 8.5 29.5 3v36L13 34.2V28l10.5 3V11L13 14z" fill={inverse ? "#ffffff" : "url(#rp-logo-front)"}/>
      <path d="M29.5 8.1 38 11.5v21L29.5 36z" fill={inverse ? "#d9e8ff" : "url(#rp-logo-side)"}/>
      <path d="M8.6 19.7 15 16l6.3 3.7v7.1L15 30.5l-6.4-3.7z" fill={inverse ? "#122033" : "#fff"} fillOpacity=".96"/>
      <circle cx="8.7" cy="23.2" r="3.1" fill={inverse ? "#ffffff" : "#0d73cf"}/><circle cx="15" cy="16.2" r="3.1" fill={inverse ? "#ffffff" : "#0d73cf"}/><circle cx="15" cy="30.2" r="3.1" fill={inverse ? "#ffffff" : "#0d73cf"}/><path d="m10.8 21.3 2.3-2.9M10.9 25.2l2.1 2.8" stroke={inverse ? "#ffffff" : "#0d73cf"} strokeWidth="2.2" strokeLinecap="round"/>
    </svg>
    {!compact ? <span className={`truncate text-[15px] font-semibold tracking-[-0.02em] ${inverse ? "text-white" : "text-[#0e3f76]"}`}>Resource<span className={`font-normal ${inverse ? "text-white" : "text-[#1769e0]"}`}>Portal</span></span> : null}
  </span>;
}