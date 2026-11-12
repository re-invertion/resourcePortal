import { useState } from "react";
import { apiRequest } from "../api/client";
import { Button, Callout, Card, ConfirmActionButton, ErrorState, DataTable, EmptyState, Field, KeyIcon, LockIcon, PageHeader, PlusIcon, Select, StatusText, TextInput, TrashIcon, UsersIcon, statusTone } from "../components/design-system";
import { idOf, items, text, useApi } from "../hooks/use-api";
import { toast } from "../components/toast";
import { capabilityStatus, inviteCapabilities } from "../lib/role-capabilities";
import { AccessTabs } from "../components/tenant-section-tabs";

type R=Record<string,unknown>;
function roleName(role:R){return text(role.displayName,text(role.name,"Role"));}
function roleOptions(roles:R[]){return roles.map(r=><option key={idOf(r)} value={idOf(r)}>{roleName(r)}</option>)}
function invitationLink(token:string){const path=`/invitations/${encodeURIComponent(token)}`;return typeof window==="undefined"?path:new URL(path,window.location.origin).toString();}

/** Effective permissions are for UI affordances only. Every write is still enforced by the tenant-scoped backend guards. */
export function mayManageAccess(
  membership: R | undefined,
  permission: string,
): boolean {
  if (!membership || membership.status !== "Active") return false;
  const direct = items<R>(membership.roles);
  const inherited = items<R>(membership.groups).flatMap(group => items<R>(group.roles));
  return [...direct, ...inherited].some(role => {
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    return permissions.includes("*") || permissions.includes(permission);
  });
}
function memberName(m: R): string {
  const u = (m.user ?? {}) as R;
  return text(u.displayName, text(u.email, text(m.userId, "Member")));
}
function membershipRoleIds(m: R): string[] {
  return items<R>(m.roles).map(idOf);
}

export function TenantAdministrationPage({ tenantId, section, userId }: {
  tenantId: string;
  section?: string;
  userId?: string;
}) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const memberships = useApi<unknown>(`${root}/memberships`);
  const invitations = useApi<unknown>(`${root}/invitations`);
  const rolesQ = useApi<unknown>(`${root}/roles`);
  const groups = useApi<unknown>(`${root}/groups`);
  const oauthApps = useApi<unknown>(root + "/oauth-applications");
  const memberGrants = useApi<unknown>(root + "/membership-app-grants");
  const oauthRows = items<R>(oauthApps.data);
  const memberGrantRows = items<R>(memberGrants.data);
  const roles = items<R>(rolesQ.data);
  const memberRows = items<R>(memberships.data);
  const inviteRows = items<R>(invitations.data);
  const groupRows = items<R>(groups.data);
  const current = memberRows.find(m => m.userId === userId);
  // Permissions are a live server projection. Never present a stale
  // management control while the backing memberships/groups snapshot is
  // refreshing or unavailable after an access mutation.
  const can = (permission: string) =>
    !memberships.loading && !memberships.error &&
    !groups.loading && !groups.error &&
    mayManageAccess(current, permission);
  const refreshEffectiveAccess = async () => {
    await Promise.all([groups.reload(), memberships.reload(), memberGrants.reload()]);
  };
  const [inviteOpen, setInviteOpen] = useState(section === "invite");
  const [invite, setInvite] = useState({
    email: "", roleIds: [] as string[], ssoLogin: true,
    oauthApplicationIds: [] as string[], nativeApplicationKeys: [] as string[],
  });
  const [generatedInvite, setGeneratedInvite] = useState<{email:string;link:string;emailSent:boolean;deliveryAttempted:boolean;deliveryReason:string}>();
  const [groupOpen, setGroupOpen] = useState(false);
  const [group, setGroup] = useState({ name: "", description: "" });
  const [working, setWorking] = useState(false);
  const [editingMembership, setEditingMembership] = useState<R>();
  const [memberRoles, setMemberRoles] = useState<string[]>([]);
  const [memberApps, setMemberApps] = useState<string[]>([]);
  const [memberNative, setMemberNative] = useState<string[]>([]);
  const [memberStatus, setMemberStatus] = useState("Active");
  const [editingGroup, setEditingGroup] = useState<R>();
  const [groupEdit, setGroupEdit] = useState({ name: "", description: "" });
  const [newGroupMember, setNewGroupMember] = useState("");
  const [newGroupRole, setNewGroupRole] = useState("");

  async function action(request: () => Promise<unknown>, reload: () => Promise<unknown>, message: string) {
    setWorking(true);
    try {
      await request();
      await reload();
      toast.success(message);
    } catch (error) {
      toast.errorFrom(error, "The access change could not be completed.");
      throw error;
    } finally {
      setWorking(false);
    }
  }
  async function createInvite() {
    if (!can("membership.invite") || !invite.email.trim() ||
        oauthApps.loading || Boolean(oauthApps.error)) return;
    setWorking(true);
    try {
      const created = await apiRequest<R>(`${root}/invitations`, { method: "POST", body: {
        email: invite.email.trim(),
        roleIds: [...invite.roleIds, ...(invite.ssoLogin ? ["sso-login"] : [])],
        oauthApplicationIds: invite.oauthApplicationIds,
        nativeApplicationKeys: invite.nativeApplicationKeys,
      } });
      const token = text(created.token);
      if (!token) throw new Error("Invitation token was not returned.");
      const delivery = (created.emailDelivery ?? {}) as R;
      setGeneratedInvite({
        email: text(created.email, invite.email), link: invitationLink(token),
        emailSent: delivery.sent === true, deliveryAttempted: delivery.attempted === true,
        deliveryReason: text(delivery.reason, ""),
      });
      await invitations.reload();
      setInviteOpen(false);
      toast.success(delivery.sent === true ? "Invitation email sent." : "Invitation link generated.");
    } catch (error) {
      toast.errorFrom(error, "Invitation could not be created.");
    } finally { setWorking(false); }
  }
  async function regenerateInvite(item: R) {
    if (!can("membership.invite")) return;
    setWorking(true);
    try {
      const updated = await apiRequest<R>(`${root}/invitations/${encodeURIComponent(idOf(item))}/resend`, { method: "POST" });
      const token = text(updated.token);
      if (!token) throw new Error("Invitation token was not returned.");
      const delivery = (updated.emailDelivery ?? {}) as R;
      setGeneratedInvite({
        email: text(updated.email, text(item.email, "Invited user")),
        link: invitationLink(token), emailSent: delivery.sent === true,
        deliveryAttempted: delivery.attempted === true, deliveryReason: text(delivery.reason, ""),
      });
      await invitations.reload();
      toast.success(delivery.sent === true ? "Invitation email resent." : "New invitation link generated.");
    } catch (error) { toast.errorFrom(error, "Invitation could not be regenerated."); }
    finally { setWorking(false); }
  }
  async function copyInvitationLink() {
    if (!generatedInvite) return;
    try { await navigator.clipboard.writeText(generatedInvite.link); toast.success("Invitation link copied."); }
    catch { toast.error("Copy failed. Select the invitation link and copy it manually."); }
  }
  async function createGroup() {
    if (!can("group.create") || !group.name.trim()) return;
    setWorking(true);
    try {
      await apiRequest(`${root}/groups`, { method: "POST", body: { name: group.name.trim(), description: group.description } });
      setGroupOpen(false);
      setGroup({ name: "", description: "" });
      await groups.reload();
      toast.success("Group created.");
    } catch (error) { toast.errorFrom(error, "Group could not be created."); }
    finally { setWorking(false); }
  }
  function beginMember(m: R) {
    setEditingMembership(m);
    if (memberGrants.loading || memberGrants.error) return;
    const grants = memberGrantRows.find(row => row.membershipId === idOf(m));
    if (!grants) return;
    setMemberRoles(membershipRoleIds(m));
    setMemberApps(items<R>(grants.grants).filter(g => g.enabled === true).map(g => text(g.applicationId)));
    setMemberNative(items<R>(grants.nativeGrants).filter(g => g.enabled === true).map(g => text(g.clientKey)));
    setMemberStatus(text(m.status, "Active"));
  }
  async function saveMembership() {
    if (!editingMembership || !can("membership.update") || memberGrants.loading || memberGrants.error ||
        oauthApps.loading || oauthApps.error) return;
    try {
      await action(
        () => apiRequest(`${root}/memberships/${encodeURIComponent(idOf(editingMembership))}`, { method: "PATCH", body: { roleIds: memberRoles, status: memberStatus, oauthApplicationIds: memberApps, nativeApplicationKeys: memberNative } }),
        refreshEffectiveAccess,
        "Membership access saved. Identity grants may need reconciliation.",
      );
      setEditingMembership(undefined);
    } catch { /* Error has already been reported; preserve edits. */ }
  }
  function beginGroup(g: R) {
    setEditingGroup(g);
    setGroupEdit({ name: text(g.name, ""), description: text(g.description, "") });
    setNewGroupMember(""); setNewGroupRole("");
  }
  async function saveGroup() {
    if (!editingGroup || !can("group.update") || !groupEdit.name.trim()) return;
    try {
      await action(
        () => apiRequest(`${root}/groups/${encodeURIComponent(idOf(editingGroup))}`, { method: "PATCH", body: { name: groupEdit.name.trim(), description: groupEdit.description } }),
        groups.reload, "Group updated.",
      );
      setEditingGroup(undefined);
    } catch { /* Preserve current changes. */ }
  }
  async function groupMutation(path: string, method: "POST" | "DELETE", body?: R) {
    if (!editingGroup) return;
    try {
      await action(() => apiRequest(path, { method, ...(body ? { body } : {}) }), refreshEffectiveAccess, "Group access updated.");
      // Keep the selected group detail in sync, including roles and members.
      const refreshed = await apiRequest<unknown>(`${root}/groups`);
      const g = items<R>(refreshed).find(row => idOf(row) === idOf(editingGroup));
      if (g) setEditingGroup(g);
      setNewGroupMember(""); setNewGroupRole("");
    } catch { /* Keep detail open for retry. */ }
  }

  const accessError = memberships.error || invitations.error || rolesQ.error || groups.error;
  const groupPath = editingGroup ? `${root}/groups/${encodeURIComponent(idOf(editingGroup))}` : "";

  return <main>
    <PageHeader eyebrow="Tenant security" title={section === "overview" ? "Access" : "Access management"}
      description="One tenant member, one identity. SSO login, individual applications and ResourcePortal RBAC are independent."
      actions={can("membership.invite") ? <Button variant="primary" onClick={() => setInviteOpen(true)}><PlusIcon size={15}/>Invite user</Button> : undefined}
    />
    <AccessTabs tenantId={tenantId} active={section === "overview" ? "overview" : "administration"} />
    {accessError ? <ErrorState title="Access data could not be loaded" error={accessError} retry={() => void Promise.all([memberships.reload(), invitations.reload(), rolesQ.reload(), groups.reload()])} /> : null}
    {generatedInvite ? <Card className="mb-5 p-5">
      <h2 className="font-semibold">{generatedInvite.emailSent ? "Invitation sent" : "Invitation link ready"}</h2>
      <p className="mt-2 text-sm">{generatedInvite.emailSent ? "Invitation email was sent." : "SMTP delivery is disabled or unavailable. Share this single-use link securely."}</p>
      <code className="mt-4 block break-all rounded-md bg-[#F3F6FA] p-3 text-xs">{generatedInvite.link}</code>
      <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void copyInvitationLink()}>Copy invitation link</Button><Button size="sm" onClick={() => setGeneratedInvite(undefined)}>Done</Button></div>
      <Callout tone="warning" title="Treat this link as a credential">Regenerating an invitation revokes its previous link.</Callout>
    </Card> : null}
    {inviteOpen && can("membership.invite") ? <Card className="mb-5 grid gap-4 p-5 md:grid-cols-2">
      <Field label="Email" required><TextInput type="email" value={invite.email} onChange={e => setInvite({ ...invite, email: e.target.value })} /></Field>
       <label className="flex items-center gap-2 text-sm">
         <input type="checkbox" checked={invite.ssoLogin} onChange={e => setInvite(prev => ({ ...prev, ssoLogin: e.target.checked }))} />
         SSO login (does not grant ResourcePortal permissions)
       </label>
       <fieldset className="md:col-span-2">
         <legend className="text-sm font-semibold">ResourcePortal roles (optional)</legend>
         <div className="mt-2 flex flex-wrap gap-3">{roles.filter(role => idOf(role) !== "sso-login").map(role =>
           <label key={idOf(role)} className="flex items-center gap-2 text-sm">
             <input type="checkbox" checked={invite.roleIds.includes(idOf(role))}
               onChange={e => setInvite(prev => ({ ...prev, roleIds: e.target.checked ?
                 [...prev.roleIds, idOf(role)] : prev.roleIds.filter(id => id !== idOf(role)) }))} />
             {roleName(role)}
           </label>)}</div>
       </fieldset>
       <fieldset className="md:col-span-2">
         <legend className="text-sm font-semibold">Allowed SSO applications</legend>
         <p className="mt-1 text-xs text-[#526070]">Default deny. ResourcePortal Web and CLI are independent clients. Application access is separate from RP RBAC.</p>
         <div className="mt-2 flex flex-wrap gap-3">
           {([{ key: "web", name: "ResourcePortal Web" }, { key: "cli", name: "ResourcePortal CLI" }]).map(client =>
             <label key={client.key} className="flex items-center gap-2 text-sm">
               <input type="checkbox" checked={invite.nativeApplicationKeys.includes(client.key)}
                 onChange={e => setInvite(prev => ({ ...prev, nativeApplicationKeys: e.target.checked ?
                   [...prev.nativeApplicationKeys, client.key] : prev.nativeApplicationKeys.filter(key => key !== client.key) }))} />
               {client.name}
             </label>)}
         </div>
         {oauthApps.loading ? <p className="mt-2 text-xs">Loading OAuth applications…</p> :
          oauthApps.error ? <p role="alert" className="mt-2 text-xs text-red-700">OAuth applications unavailable; invitation disabled.</p> :
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{oauthRows.map(app => <label key={idOf(app)} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={invite.oauthApplicationIds.includes(idOf(app))}
              onChange={e => setInvite(prev => ({ ...prev, oauthApplicationIds: e.target.checked ?
                [...prev.oauthApplicationIds, idOf(app)] : prev.oauthApplicationIds.filter(id => id !== idOf(app)) }))} />
            {text(app.name)}
          </label>)}</div>}
       </fieldset>
      <div className="flex gap-2 md:col-span-2">
         <ConfirmActionButton triggerVariant="primary" confirmVariant="primary"
           disabled={working || !invite.email || oauthApps.loading || Boolean(oauthApps.error)}
           confirmTitle="Confirm invitation"
           confirmDescription={"Invite " + invite.email + " with " + invite.roleIds.length + " RP role(s), " +
             (invite.ssoLogin ? "SSO enabled" : "SSO disabled") + " and " +
             (invite.oauthApplicationIds.length + invite.nativeApplicationKeys.length) + " application grant(s)?"}
           confirmLabel="Send invitation" onConfirm={createInvite}>Create invitation</ConfirmActionButton>
        <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
      </div>
    </Card> : null}
    <div className="grid gap-6 xl:grid-cols-[1.3fr_.7fr]">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] p-4"><h2 className="font-semibold">Memberships</h2><p className="text-xs text-[#718096]">Direct and inherited access are shown separately.</p></div>
        <DataTable embedded loading={memberships.loading} columns={[{ key: "member", label: "Member" }, { key: "status", label: "Status" }, { key: "roles", label: "Direct roles / Groups" }, { key: "actions", label: "" }]}
          rows={memberRows.map(m => ({
            key: idOf(m), cells: {
              member: <div className="max-w-56 min-w-0"><strong className="block truncate">{memberName(m)}</strong><span className="block break-all text-xs text-[#718096]">{text(((m.user ?? {}) as R).email, "")}</span></div>,
              status: <StatusText tone={statusTone(m.status)}>{text(m.status, "Unknown")}</StatusText>,
              roles: <div className="min-w-0 text-xs"><strong className="block">{items<R>(m.roles).map(roleName).join(", ") || "No direct role"}</strong>
                <span className="block text-[#526070]">{(() => {
                   const access = memberGrantRows.find(g => g.membershipId === idOf(m));
                   const apps = items<R>(access?.grants).filter(g => g.enabled === true).map(g => text(g.applicationName));
                   const native = items<R>(access?.nativeGrants).filter(g => g.enabled === true).map(g => g.clientKey === "web" ? "ResourcePortal Web" : "ResourcePortal CLI");
                   return "SSO apps: " + ([...native, ...apps].join(", ") || "none");
                 })()}</span>
                {items<R>(m.groups).map(g => <span key={idOf(g)} className="block text-[#526070]">{text(g.name)} (inherited: {items<R>(g.roles).map(roleName).join(", ") || "none"})</span>)}
              </div>,
              actions: <div className="flex flex-wrap gap-1">
                {can("membership.update") ? <Button size="sm" disabled={memberGrants.loading || Boolean(memberGrants.error)} onClick={() => beginMember(m)}>Edit access</Button> : null}
                {can("membership.remove") ? <ConfirmActionButton size="sm" triggerVariant="ghost" disabled={working} ariaLabel={`Remove membership of ${memberName(m)}`} confirmTitle={`Remove ${memberName(m)} from this tenant?`}
                  confirmDescription="Removes tenant membership and revokes the subject's ResourcePortal tenant grants. The last owner cannot be removed."
                  confirmLabel="Remove access" onConfirm={() => action(() => apiRequest(`${root}/memberships/${encodeURIComponent(idOf(m))}`, { method: "DELETE" }), refreshEffectiveAccess, "Membership removed.")}>
                  <TrashIcon size={14}/>
                </ConfirmActionButton> : null}
              </div>,
            },
          }))}
          empty={<EmptyState icon={<UsersIcon />} title="No memberships" description="Invite a member with independent SSO and RBAC grants." />}
        />
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] p-4"><h2 className="font-semibold">Invitations</h2></div>
        <div className="divide-y divide-[#E1E7F0]">
          {inviteRows.map(i => <div key={idOf(i)} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div><strong className="block text-sm">{text(i.email)}</strong><span className="text-xs text-[#718096]">Pending</span></div>
            <div className="flex gap-1">
              {can("membership.invite") ? <Button size="sm" onClick={() => void regenerateInvite(i)} disabled={working}>Generate new link</Button> : null}
              {can("membership.remove") ? <ConfirmActionButton size="sm" triggerVariant="ghost" ariaLabel={`Delete invitation ${text(i.email)}`} confirmTitle={`Revoke invitation for ${text(i.email)}?`} confirmDescription="The old invitation link becomes invalid."
                confirmLabel="Revoke invitation" onConfirm={() => action(() => apiRequest(`${root}/invitations/${encodeURIComponent(idOf(i))}`, { method: "DELETE" }), invitations.reload, "Invitation revoked.")}><TrashIcon size={14}/></ConfirmActionButton> : null}
            </div>
          </div>)}
          {!inviteRows.length && !invitations.loading ? <EmptyState title="No pending invitations" /> : null}
        </div>
      </Card>
    </div>

    {editingMembership ? <Card className="my-6 p-5">
      <h2 className="font-semibold">Edit access: {memberName(editingMembership)}</h2>
      <p className="mt-1 text-xs text-[#526070]">Changes to membership are audited and validated by the server, including owner protection. Group-inherited roles cannot be removed here.</p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <fieldset><legend className="mb-2 text-sm font-semibold">Direct ResourcePortal roles</legend>
          {roles.map(role => <label key={idOf(role)} className="flex items-start gap-2 py-2 text-sm">
            <input type="checkbox" checked={memberRoles.includes(idOf(role))}
              onChange={e => setMemberRoles(prev => e.target.checked ? [...prev, idOf(role)] : prev.filter(id => id !== idOf(role)))} />
            <span><strong>{roleName(role)}</strong><span className="block max-w-md break-words text-xs text-[#718096]">{Array.isArray(role.permissions) ? role.permissions.join(", ") : "Permissions unavailable"}</span></span>
          </label>)}
        </fieldset>
        <fieldset className="md:col-span-2">
           <legend className="text-sm font-semibold">Allowed SSO applications</legend>
           <p className="mt-1 text-xs text-[#526070]">ResourcePortal Web, CLI and external OAuth clients are independent grants, not RP RBAC.</p>
           <div className="mt-2 flex flex-wrap gap-3">{([{ key: "web", name: "ResourcePortal Web" }, { key: "cli", name: "ResourcePortal CLI" }]).map(client =>
             <label key={client.key} className="flex items-center gap-2 text-sm">
               <input type="checkbox" checked={memberNative.includes(client.key)}
                 onChange={e => setMemberNative(prev => e.target.checked ? [...prev, client.key] : prev.filter(key => key !== client.key))} />
               {client.name}
             </label>)}</div>
           {oauthApps.error ? <p role="alert">OAuth applications unavailable; updates disabled.</p> :
             <div className="mt-3 grid gap-2 sm:grid-cols-2">{oauthRows.map(app =>
               <label key={idOf(app)} className="flex items-center gap-2 text-sm">
                 <input type="checkbox" checked={memberApps.includes(idOf(app))}
                   onChange={e => setMemberApps(prev => e.target.checked ? [...prev, idOf(app)] : prev.filter(id => id !== idOf(app)))} />
                 {text(app.name)}
               </label>)}</div>}
         </fieldset>
         <div><Field label="Membership status"><Select value={memberStatus} onChange={e => setMemberStatus(e.target.value)}><option value="Active">Active</option><option value="Suspended">Suspended</option></Select></Field>
          <p className="mt-2 text-xs text-[#526070]">Suspending access also invalidates associated tenant OIDC grants through the backend.</p>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <ConfirmActionButton triggerVariant="primary" confirmVariant="primary" disabled={working || memberGrants.loading || Boolean(memberGrants.error) || oauthApps.loading || Boolean(oauthApps.error)}
          confirmTitle="Save membership access?" confirmDescription="This changes the selected member's direct roles and/or active status." confirmLabel="Save access" onConfirm={saveMembership}>Save access</ConfirmActionButton>
        <Button onClick={() => setEditingMembership(undefined)}>Cancel</Button>
      </div>
    </Card> : null}

        <div className="mt-6 grid gap-6 xl:grid-cols-2">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E1E7F0] px-4 py-3"><h2 className="font-semibold">Groups</h2>
          {can("group.create") ? <Button size="sm" onClick={() => setGroupOpen(true)}><PlusIcon size={14}/>Create group</Button> : null}
        </div>
        {groupOpen && can("group.create") ? <div className="grid gap-3 border-b border-[#E1E7F0] p-4 sm:grid-cols-2">
          <Field label="Name" required><TextInput value={group.name} onChange={e => setGroup({ ...group, name: e.target.value })}/></Field>
          <Field label="Description"><TextInput value={group.description} onChange={e => setGroup({ ...group, description: e.target.value })}/></Field>
          <div className="flex gap-2 sm:col-span-2"><Button size="sm" variant="primary" disabled={working || !group.name.trim()} onClick={() => void createGroup()}>Create group</Button><Button size="sm" onClick={() => setGroupOpen(false)}>Cancel</Button></div>
        </div> : null}
        <DataTable embedded loading={groups.loading} columns={[{key:"name",label:"Group"}, {key:"roles",label:"Roles / members"}, {key:"actions",label:""}]}
          rows={groupRows.map(g => ({key:idOf(g),cells:{
            name:<div><strong>{text(g.name)}</strong><span className="block text-xs text-[#718096]">{text(g.description,"No description")}</span></div>,
            roles:<span className="text-xs">{items<R>(g.roles).map(roleName).join(", ") || "No roles"} · {items<R>(g.members).length} members</span>,
            actions:<div className="flex gap-2">{can("group.update") || can("group.member.manage") || can("group.role.manage") ? <Button size="sm" onClick={() => beginGroup(g)}>Manage</Button> : null}
              {can("group.delete") ? <ConfirmActionButton size="sm" triggerVariant="ghost" ariaLabel={`Delete ${text(g.name)}`}
                confirmTitle={`Delete group ${text(g.name)}?`} confirmDescription="All inherited permissions through this group will be lost." confirmLabel="Delete group"
                onConfirm={() => action(() => apiRequest(`${root}/groups/${encodeURIComponent(idOf(g))}`, { method: "DELETE" }), refreshEffectiveAccess, "Group deleted.")}><TrashIcon size={14}/></ConfirmActionButton> : null}</div>,
          }}))}
          empty={<EmptyState icon={<UsersIcon />} title="No groups" description="Create a group to assign members and inherited roles."/>}/>
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">Built-in ResourcePortal roles</h2>
        <p className="mt-2 text-xs text-[#526070]">These role definitions are read-only. sso-login has no RP permissions. Operational roles do not grant other OAuth clients.</p>
        <div className="mt-4 divide-y divide-[#E1E7F0]">{roles.map(role => <div key={idOf(role)} className="py-3"><strong className="text-sm">{roleName(role)}</strong><p className="mt-1 break-words text-xs text-[#718096]">{Array.isArray(role.permissions) ? role.permissions.join(", ") : "Permissions unavailable"}</p></div>)}</div>
        <a className="mt-4 inline-block text-sm font-semibold text-[#1769E0] underline" href={`/tenants/${encodeURIComponent(tenantId)}/identity-sso`}>Open tenant Identity &amp; SSO</a>
      </Card>
    </div>

    {editingGroup ? <Card className="mt-6 p-5">
      <h2 className="text-lg font-semibold">Group: {text(editingGroup.name)}</h2>
      <p className="mt-1 text-xs text-[#526070]">Group membership and role assignments affect inherited ResourcePortal permissions. All changes are validated and audited server-side.</p>
      {can("group.update") ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Group name" required><TextInput value={groupEdit.name} onChange={e => setGroupEdit({...groupEdit,name:e.target.value})}/></Field>
        <Field label="Description"><TextInput value={groupEdit.description} onChange={e => setGroupEdit({...groupEdit,description:e.target.value})}/></Field>
        <div className="sm:col-span-2"><ConfirmActionButton size="sm" triggerVariant="primary" confirmVariant="primary" disabled={working || !groupEdit.name.trim()} confirmTitle="Update group details?" confirmDescription="Changes are audited." confirmLabel="Update group" onConfirm={saveGroup}>Save group</ConfirmActionButton></div>
      </div> : null}
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="font-semibold">Members ({items<R>(editingGroup.members).length})</h3>
          <div className="divide-y divide-[#E1E7F0]">{items<R>(editingGroup.members).map(m => <div key={idOf(m)} className="flex items-center justify-between gap-2 py-2">
            <span className="text-sm">{memberName(m)}</span>
            {can("group.member.manage") ? <ConfirmActionButton size="sm" triggerVariant="ghost" ariaLabel={`Remove member ${memberName(m)} from ${text(editingGroup.name)}`} confirmTitle={`Remove ${memberName(m)} from group?`} confirmDescription="Inherited access through this group will be revoked." confirmLabel="Remove member"
              onConfirm={() => groupMutation(`${groupPath}/members/${encodeURIComponent(idOf(m))}`, "DELETE")}>Remove</ConfirmActionButton> : null}
          </div>)}</div>
          {can("group.member.manage") ? <div className="mt-3 flex gap-2"><Select aria-label="Select group member" value={newGroupMember} onChange={e => setNewGroupMember(e.target.value)}><option value="">Select tenant member</option>{memberRows.filter(m => m.status === "Active" && !items<R>(editingGroup.members).some(row => idOf(row) === idOf(m))).map(m => <option key={idOf(m)} value={idOf(m)}>{memberName(m)}</option>)}</Select>
            <Button size="sm" disabled={working || !newGroupMember} onClick={() => void groupMutation(`${groupPath}/members`, "POST", { membershipId: newGroupMember })}>Add</Button></div> : null}
        </div>
        <div>
          <h3 className="font-semibold">Inherited roles ({items<R>(editingGroup.roles).length})</h3>
          <div className="divide-y divide-[#E1E7F0]">{items<R>(editingGroup.roles).map(role => <div key={idOf(role)} className="flex items-center justify-between gap-2 py-2">
            <span className="text-sm">{roleName(role)}</span>
            {can("group.role.manage") ? <ConfirmActionButton size="sm" triggerVariant="ghost" ariaLabel={`Remove role ${roleName(role)} from ${text(editingGroup.name)}`} confirmTitle={`Remove ${roleName(role)} from group?`} confirmDescription="This removes the role from every group member's inherited access." confirmLabel="Remove role"
              onConfirm={() => groupMutation(`${groupPath}/roles/${encodeURIComponent(idOf(role))}`, "DELETE")}>Remove</ConfirmActionButton> : null}
          </div>)}</div>
          {can("group.role.manage") ? <div className="mt-3 flex gap-2"><Select aria-label="Select group role" value={newGroupRole} onChange={e => setNewGroupRole(e.target.value)}><option value="">Select role</option>{roles.filter(r => !items<R>(editingGroup.roles).some(item => idOf(item) === idOf(r))).map(role => <option key={idOf(role)} value={idOf(role)}>{roleName(role)}</option>)}</Select>
            <Button size="sm" disabled={working || !newGroupRole} onClick={() => void groupMutation(`${groupPath}/roles`, "POST", { roleId: newGroupRole })}>Add</Button></div> : null}
        </div>
      </div>
      <div className="mt-5 flex justify-between"><a className="text-sm text-[#0F56A7] underline" href={`/tenants/${encodeURIComponent(tenantId)}/audit`}>Audit history</a><Button onClick={() => setEditingGroup(undefined)}>Close</Button></div>
    </Card> : null}
  </main>;
}

export function TenantCredentialsPage({tenantId}:{tenantId:string}){
 const root=`/api/tenants/${encodeURIComponent(tenantId)}`;const oauth=useApi<unknown>(`${root}/oauth-applications`);const identities=useApi<unknown>(`${root}/service-identities`);const rolesQ=useApi<unknown>(`${root}/roles`);const roles=items<R>(rolesQ.data);const [oauthOpen,setOauthOpen]=useState(false);const [oauthForm,setOauthForm]=useState({name:"",type:"Web",redirectUri:"",logoutUri:""});const [identityOpen,setIdentityOpen]=useState(false);const [identity,setIdentity]=useState({name:"",description:"",roleId:""});const [credential,setCredential]=useState<R>();const [working,setWorking]=useState(false);
 async function createOauth(){setWorking(true);try{const result=await apiRequest<R>(`${root}/oauth-applications`,{method:"POST",body:{name:oauthForm.name,type:oauthForm.type,redirectUris:oauthForm.redirectUri?[oauthForm.redirectUri]:undefined,postLogoutRedirectUris:oauthForm.logoutUri?[oauthForm.logoutUri]:undefined}});setCredential(result);setOauthOpen(false);await oauth.reload();toast.success("OAuth application created.");}catch(c){toast.errorFrom(c,"OAuth application could not be created.");}finally{setWorking(false);}}
 async function createIdentity(){setWorking(true);try{const result=await apiRequest<R>(`${root}/service-identities`,{method:"POST",body:{name:identity.name,description:identity.description||undefined,roleIds:[identity.roleId]}});setCredential(result);setIdentityOpen(false);await identities.reload();toast.success("Service identity created.");}catch(c){toast.errorFrom(c,"Service identity could not be created.");}finally{setWorking(false);}}
 async function rotate(kind:string,item:R){try{const result=await apiRequest<R>(`${root}/${kind}/${encodeURIComponent(idOf(item))}/rotate-credentials`,{method:"POST"});setCredential(result);if(result.persistenceStatus==="Failed"||result.auditStatus==="Failed"){toast.error("Credentials rotated at the identity provider, but ResourcePortal could not complete persistence or audit. Save the one-time secret and follow the recovery warning.");}else{toast.success("Credentials rotated.");}}catch(c){toast.errorFrom(c,"Credential rotation failed.");}}
 const oauthRows=items<R>(oauth.data),identityRows=items<R>(identities.data);return <main><PageHeader eyebrow="Machine access" title="Machine credentials" description="OAuth applications and service identities for automation and integrations." actions={<div className="flex flex-wrap gap-2"><Button onClick={()=>setIdentityOpen(true)}>Create service identity</Button><Button variant="primary" onClick={()=>setOauthOpen(true)}>Create OAuth application</Button></div>}/><AccessTabs tenantId={tenantId} active="credentials"/>{credential?<Card className={`mb-5 p-5 ${credential.persistenceStatus==="Failed"||credential.auditStatus==="Failed"?"border-[#D97706]":"border-[#A9D6B6]"}`}><div className="flex items-start gap-3"><KeyIcon className="mt-0.5 text-[#157F3B]"/><div className="min-w-0 flex-1"><h2 className="font-semibold">Save these credentials now</h2><p className="mt-1 text-sm text-[#5B6678]">Secret values may only be returned once. Store them in an approved secret manager.</p>{credential.persistenceStatus==="Failed"||credential.auditStatus==="Failed"?<div role="alert" className="mt-3 rounded-md border border-[#D97706] bg-[#FFFBEB] p-3 text-sm text-[#92400E]"><strong>Credential rotation needs recovery.</strong><p>Persistence: {text(credential.persistenceStatus,"Unknown")} · Audit: {text(credential.auditStatus,"Unknown")}</p><p>{text(credential.warning,"Contact your platform administrator and reconcile the credential before further use.")}</p></div>:null}<dl className="mt-4 grid gap-3 sm:grid-cols-2">{Object.entries(credential).filter(([key,value])=>typeof value==="string"&&/client|secret|token|credential|password/i.test(key)).map(([key,value])=><div key={key} className="rounded-md bg-[#F5FAF6] p-3"><dt className="text-xs font-medium text-[#5B6678]">{key}</dt><dd className="mt-1 break-all font-mono text-xs">{String(value)}</dd></div>)}</dl><Button className="mt-4" size="sm" onClick={()=>setCredential(undefined)}>I saved the credentials</Button></div></div></Card>:null}{oauthOpen?<Card className="mb-5 grid gap-4 p-5 md:grid-cols-2"><Field label="Name"><TextInput value={oauthForm.name} onChange={e=>setOauthForm({...oauthForm,name:e.target.value})}/></Field><Field label="Application type"><Select value={oauthForm.type} onChange={e=>setOauthForm({...oauthForm,type:e.target.value})}><option>Web</option><option>SPA</option><option>Native</option></Select></Field><Field label="Redirect URI"><TextInput value={oauthForm.redirectUri} onChange={e=>setOauthForm({...oauthForm,redirectUri:e.target.value})}/></Field><Field label="Post-logout redirect URI"><TextInput value={oauthForm.logoutUri} onChange={e=>setOauthForm({...oauthForm,logoutUri:e.target.value})}/></Field><div className="flex gap-2 md:col-span-2"><Button variant="primary" disabled={working||!oauthForm.name} onClick={()=>void createOauth()}>Create OAuth application</Button><Button onClick={()=>setOauthOpen(false)}>Cancel</Button></div></Card>:null}{identityOpen?<Card className="mb-5 grid gap-4 p-5 md:grid-cols-2"><Field label="Name"><TextInput value={identity.name} onChange={e=>setIdentity({...identity,name:e.target.value})}/></Field><Field label="Role"><Select value={identity.roleId} onChange={e=>setIdentity({...identity,roleId:e.target.value})}><option value="">Select role by name</option>{roleOptions(roles)}</Select></Field><div className="md:col-span-2"><Field label="Description"><TextInput value={identity.description} onChange={e=>setIdentity({...identity,description:e.target.value})}/></Field></div><div className="flex gap-2 md:col-span-2"><Button variant="primary" disabled={working||!identity.name||!identity.roleId} onClick={()=>void createIdentity()}>Create service identity</Button><Button onClick={()=>setIdentityOpen(false)}>Cancel</Button></div></Card>:null}<div className="grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><div className="border-b border-[#E1E7F0] px-5 py-4"><h2 className="font-semibold">OAuth applications</h2></div><DataTable embedded loading={oauth.loading} columns={[{key:"name",label:"Application"},{key:"type",label:"Type"},{key:"status",label:"Status"},{key:"actions",label:""}]} rows={oauthRows.map(o=>({key:idOf(o),cells:{name:<strong>{text(o.name)}</strong>,type:text(o.type),status:<StatusText tone={statusTone(o.status)}>{text(o.status,"Active")}</StatusText>,actions:<Button size="sm" variant="ghost" onClick={()=>void rotate("oauth-applications",o)}>Rotate credentials</Button>}}))} empty={<EmptyState icon={<KeyIcon/>} title="No OAuth applications" description="Create an OAuth application for an external integration."/>}/></Card><Card className="overflow-hidden"><div className="border-b border-[#E1E7F0] px-5 py-4"><h2 className="font-semibold">Service identities</h2></div><DataTable embedded loading={identities.loading} columns={[{key:"name",label:"Identity"},{key:"status",label:"Status"},{key:"roles",label:"Roles"},{key:"actions",label:""}]} rows={identityRows.map(i=>({key:idOf(i),cells:{name:<div><strong>{text(i.name)}</strong><span className="block text-xs text-[#718096]">{text(i.description,"No description")}</span></div>,status:<StatusText tone={statusTone(i.status)}>{text(i.status,"Active")}</StatusText>,roles:Array.isArray(i.roles)?(i.roles as R[]).map(roleName).join(", "):"—",actions:<Button size="sm" variant="ghost" onClick={()=>void rotate("service-identities",i)}>Rotate credentials</Button>}}))} empty={<EmptyState icon={<LockIcon/>} title="No service identities" description="Create a service identity for automation that needs tenant permissions."/>}/></Card></div></main>;
}
