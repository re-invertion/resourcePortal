import type { ReactNode } from "react";
import { ResourcePortalLogo } from "./design-system";

export type AuthWorkspaceFeatureItem = {
  icon: ReactNode;
  title: string;
  description: ReactNode;
};

export function AuthWorkspaceFeature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="flex min-w-0 items-start gap-3.5">
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white">{icon}</span>
    <div className="min-w-0">
      <strong className="block text-[14px] font-semibold text-white">{title}</strong>
      <p className="mt-1 max-w-[320px] break-words text-[13px] leading-[19px] text-[#C6D5EA]">{children}</p>
    </div>
  </div>;
}

export function AuthWorkspaceLayout({
  title,
  description,
  features,
  headerAction,
  contentPlacement = "center",
  contentWidthClassName = "max-w-[520px]",
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  features: AuthWorkspaceFeatureItem[];
  headerAction?: ReactNode;
  contentPlacement?: "center" | "top";
  contentWidthClassName?: string;
  children: ReactNode;
}) {
  return <main className="rp-auth-workspace m-0 grid min-h-dvh w-full max-w-none grid-cols-1 overflow-x-hidden bg-[#F7F9FC] p-0 lg:grid-cols-[minmax(430px,42vw)_minmax(0,1fr)] xl:grid-cols-[552px_minmax(0,1fr)]">
    <aside
      data-testid="auth-workspace-aside"
      className="relative hidden min-h-dvh min-w-0 overflow-hidden bg-[#122033] px-10 py-10 lg:flex lg:flex-col xl:px-12 xl:py-12"
    >
      <div className="pointer-events-none absolute left-10 top-16 h-[360px] w-[360px] rounded-full bg-[#17365E] opacity-75 blur-[1px]" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-14 -right-16 h-[310px] w-[310px] rounded-full bg-[#18375F] opacity-65" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-white/10" aria-hidden="true" />

      <div className="relative z-10 min-w-0">
        <ResourcePortalLogo tone="inverse" />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-center py-12">
        <div className="min-w-0">
          <h2 className="max-w-[390px] break-words text-[32px] font-semibold leading-[1.25] tracking-[-.025em] text-white xl:text-[34px]">{title}</h2>
          <p className="mt-6 max-w-[370px] break-words text-[14px] leading-[22px] text-[#D9E8FF]">{description}</p>
        </div>
        <div className="mt-12 grid min-w-0 gap-5">
          {features.map((feature) => <AuthWorkspaceFeature key={feature.title} icon={feature.icon} title={feature.title}>{feature.description}</AuthWorkspaceFeature>)}
        </div>
      </div>
    </aside>

    <section
      data-testid="auth-workspace-main"
      className="m-0 min-h-dvh min-w-0 overflow-x-hidden rounded-none border-0 bg-[#F7F9FC] p-0 shadow-none"
    >
      <div className="mx-auto flex min-h-dvh w-full min-w-0 max-w-[1180px] flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8 xl:px-14">
        <header className="flex min-h-10 min-w-0 items-center justify-between gap-4">
          <div className="min-w-0 lg:hidden"><ResourcePortalLogo /></div>
          {headerAction ? <div className="ml-auto shrink-0">{headerAction}</div> : null}
        </header>
        <div className={contentPlacement === "center"
          ? "flex min-w-0 flex-1 items-center py-8 sm:py-10"
          : "min-w-0 flex-1 pb-10 pt-10 sm:pt-14 lg:pt-16"
        }>
          <div className={`mx-auto w-full min-w-0 ${contentWidthClassName}`}>{children}</div>
        </div>
      </div>
    </section>
  </main>;
}