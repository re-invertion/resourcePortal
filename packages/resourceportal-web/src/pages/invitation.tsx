import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { AuthWorkspaceLayout } from "../components/auth-workspace";
import {
  Button,
  Callout,
  Card,
  GridIcon,
  LinkButton,
  LockIcon,
  StatusBadge,
  UsersIcon,
} from "../components/design-system";
import { tenantHref } from "../router/router";
import { toast } from "../components/toast";

type InvitationPreview = {
  tenant: { id: string; name: string; displayName: string };
  roles: Array<{ id: string; name: string }>;
  expiresAt: string;
  status: "Pending" | "Expired";
};

type InvitationUser = {
  id: string;
  email?: string;
  displayName?: string;
};

function defaultNavigate(href: string) {
  window.location.assign(href);
}

export function InvitationPage({
  token,
  user,
  navigate = defaultNavigate,
}: {
  token: string;
  user: InvitationUser | null;
  navigate?: (href: string) => void;
}) {
  const [preview, setPreview] = useState<InvitationPreview>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const returnTo = useMemo(() => `/invitations/${encodeURIComponent(token)}`, [token]);

  useEffect(() => {
    let active = true;
    apiRequest<InvitationPreview>(`/api/invitations/${encodeURIComponent(token)}`)
      .then((value) => {
        if (active) {
          setPreview(value);
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Invitation could not be loaded.");
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  function authHref(mode: "login" | "register") {
    const query = new URLSearchParams({ returnTo });
    if (preview?.tenant.id) query.set("tenantId", preview.tenant.id);
    return `/${mode}?${query.toString()}`;
  }

  async function accept() {
    if (!preview || preview.status === "Expired") return;
    setWorking(true);
    try {
      const membership = await apiRequest<{ tenantId: string }>("/api/invitations/accept", {
        method: "POST",
        body: { token },
      });
      navigate(tenantHref(membership.tenantId || preview.tenant.id, "overview"));
    } catch (cause) {
      toast.errorFrom(cause, "Invitation could not be accepted.");
    } finally {
      setWorking(false);
    }
  }

  const tenantName = preview?.tenant.displayName || preview?.tenant.name || "ResourcePortal tenant";
  const expires = preview?.expiresAt ? new Date(preview.expiresAt).toLocaleString() : undefined;

  return (
    <AuthWorkspaceLayout
      title={<>Join your<br />ResourcePortal workspace.</>}
      description="Use this invitation link to join the tenant with the access prepared for you."
      features={[
        { icon: <GridIcon size={15} />, title: "Tenant-scoped access", description: "The invitation grants access only to the tenant shown here." },
        { icon: <LockIcon size={15} />, title: "Identity verified", description: "You must sign in with the invited ResourcePortal identity before access is granted." },
        { icon: <UsersIcon size={15} />, title: "Role-based permissions", description: "Your permissions come from the roles selected by the tenant administrator." },
      ]}
      headerAction={<a className="text-sm font-medium text-[#526070] hover:text-[#0F56A7] hover:underline" href="/health">System status</a>}
      contentPlacement="center"
      contentWidthClassName="max-w-[560px]"
    >
      <Card className="p-6 sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#1769E0]">Tenant invitation</p>
        <h1 className="mt-3 text-[28px] font-semibold tracking-[-.025em] text-[#172033]">{preview ? `Join ${tenantName}` : "Loading invitation…"}</h1>

        {error ? <div className="mt-5"><Callout tone="danger" title="Invitation unavailable">{error}</Callout></div> : null}

        {preview ? (
          <>
            <div className="mt-6 rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm text-[#172033]">{tenantName}</strong>
                <StatusBadge tone={preview.status === "Expired" ? "danger" : "success"}>{preview.status}</StatusBadge>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-[#718096]">Roles</dt>
                  <dd className="mt-1 font-medium text-[#172033]">{preview.roles.map((role) => role.name).join(", ") || "Assigned by tenant admin"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[#718096]">Expires</dt>
                  <dd className="mt-1 font-medium text-[#172033]">{expires ?? "—"}</dd>
                </div>
              </dl>
            </div>

            {preview.status === "Expired" ? (
              <div className="mt-5"><Callout tone="warning" title="This invitation has expired">Ask the tenant administrator to generate a new invitation link.</Callout></div>
            ) : user ? (
              <>
                <div className="mt-5"><Callout title="Signed in identity">You are signed in as <strong>{user.email ?? user.displayName ?? user.id}</strong>. ResourcePortal will verify that this identity matches the invitation before creating the membership.</Callout></div>
                <Button className="mt-6 w-full" variant="primary" disabled={working} onClick={() => void accept()}>{working ? "Accepting…" : "Accept invitation"}</Button>
              </>
            ) : (
              <>
                <div className="mt-5"><Callout title="Sign in required">Sign in with the account that was invited. After OAuth completes, ResourcePortal will return you to this invitation.</Callout></div>
                <div className="mt-6 grid gap-2.5">
                  <LinkButton className="h-11 w-full justify-center" variant="primary" href={authHref("login")}>Sign in to accept</LinkButton>
                  <LinkButton className="h-11 w-full justify-center" href={authHref("register")}>Create account</LinkButton>
                </div>
              </>
            )}
          </>
        ) : null}
      </Card>
    </AuthWorkspaceLayout>
  );
}
