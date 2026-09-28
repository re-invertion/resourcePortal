import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  Field,
  MailIcon,
  NumberInput,
  PageHeader,
  Select,
  StatusBadge,
  TextInput,
  Toggle,
} from "../components/design-system";
import { toast } from "../components/toast";
import { StoredSecretInput } from "../components/stored-secret-input";
import { formatDate, text, useApi } from "../hooks/use-api";

type EmailState = {
  enabled?: boolean;
  configured?: boolean;
  host?: string | null;
  port?: number;
  mode?: "STARTTLS" | "TLS" | "PLAIN";
  username?: string | null;
  passwordConfigured?: boolean;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  lastValidatedAt?: string | null;
  lastTestSentAt?: string | null;
  lastError?: string | null;
  zitadelSync?: {
    status?: "Synced" | "Disabled" | "Pending" | "NotConfigured" | "Error";
    providerId?: string | null;
    lastSyncedAt?: string | null;
    error?: string | null;
  };
  updatedAt?: string | null;
};

export function PlatformSettingsPage() {
  const email = useApi<EmailState>("/api/platform/email");
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [mode, setMode] = useState<"STARTTLS" | "TLS" | "PLAIN">("STARTTLS");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("ResourcePortal");
  const [replyTo, setReplyTo] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [working, setWorking] = useState("");

  useEffect(() => {
    const state = email.data;
    if (!state) return;
    setEnabled(state.enabled === true);
    setHost(text(state.host, ""));
    setPort(String(state.port ?? 587));
    setMode(state.mode ?? "STARTTLS");
    setUsername(text(state.username, ""));
    setPassword("");
    setFromEmail(text(state.fromEmail, ""));
    setFromName(text(state.fromName, "ResourcePortal"));
    setReplyTo(text(state.replyTo, ""));
    setTestRecipient((current) => current || text(state.fromEmail, ""));
  }, [email.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setWorking("save");
    try {
      const saved = await apiRequest<EmailState>("/api/platform/email", {
        method: "PATCH",
        body: {
          enabled,
          host: host.trim(),
          port: Number(port),
          mode,
          username: username.trim(),
          password: password || undefined,
          fromEmail: fromEmail.trim() || null,
          fromName: fromName.trim(),
          replyTo: replyTo.trim() || null,
        },
      });
      await email.reload();
      setPassword("");
      if (saved.zitadelSync?.status === "Error") {
        toast.warning(
          "SMTP configuration saved, but ZITADEL synchronization needs attention.",
          saved.zitadelSync.error ?? undefined,
        );
      } else {
        toast.success("SMTP configuration saved and synchronized with ZITADEL.");
      }
    } catch (error) {
      toast.errorFrom(error, "SMTP configuration could not be saved.");
    } finally {
      setWorking("");
    }
  }

  async function validate() {
    setWorking("validate");
    try {
      await apiRequest("/api/platform/email/validate", { method: "POST" });
      await email.reload();
      toast.success("SMTP connection validated.");
    } catch (error) {
      await email.reload();
      toast.errorFrom(error, "SMTP connection validation failed.");
    } finally {
      setWorking("");
    }
  }

  async function sendTest() {
    setWorking("test");
    try {
      await apiRequest("/api/platform/email/test", {
        method: "POST",
        body: { recipient: testRecipient.trim() },
      });
      await email.reload();
      toast.success("Test email sent.", `Delivered to ${testRecipient.trim()}.`);
    } catch (error) {
      await email.reload();
      toast.errorFrom(error, "Test email could not be delivered.");
    } finally {
      setWorking("");
    }
  }

  const hasSyncError = email.data?.zitadelSync?.status === "Error";
  const status = email.data?.enabled
    ? email.data.configured
      ? email.data.lastError || hasSyncError
        ? "Needs attention"
        : "Enabled"
      : "Incomplete"
    : hasSyncError
      ? "Needs attention"
      : "Disabled";
  const tone = status === "Enabled" ? "success" : status === "Needs attention" || status === "Incomplete" ? "warning" : "neutral";

  return <main>
    <PageHeader
      eyebrow="Platform Admin"
      title="Settings"
      description="Platform-wide settings for ResourcePortal services and outbound communication."
    />

    {email.error ? <Callout tone="danger" title="SMTP settings unavailable">
      {email.error instanceof Error ? email.error.message : "The platform email settings API could not be loaded."}
    </Callout> : null}

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><MailIcon size={19}/></span>
            <div>
              <h2 className="font-semibold text-[#172033]">SMTP server</h2>
              <p className="mt-0.5 text-xs text-[#718096]">Used by ResourcePortal and synchronized to ZITADEL for identity email such as verification and password reset messages.</p>
            </div>
          </div>
        </div>

        <form className="space-y-5 p-5" onSubmit={(event) => void save(event)}>
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            disabled={Boolean(working)}
            label="Enable outbound email"
            description="When disabled, ResourcePortal keeps generating invitation links but does not attempt email delivery."
          />

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
            <Field label="SMTP host" required>
              <TextInput aria-label="SMTP host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="smtp.example.com" autoComplete="off" />
            </Field>
            <Field label="Port" required>
              <NumberInput aria-label="SMTP port" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
            </Field>
          </div>

          <Field label="Transport security" required hint="STARTTLS is recommended for port 587. Implicit TLS is commonly used on port 465.">
            <Select aria-label="SMTP transport security" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="STARTTLS">STARTTLS</option>
              <option value="TLS">Implicit TLS</option>
              <option value="PLAIN">Plain SMTP (no TLS)</option>
            </Select>
          </Field>

          {mode === "PLAIN" ? <Callout tone="warning" title="Plain SMTP is not encrypted">
            Credentials and message content may be exposed in transit. Use only on an explicitly trusted private transport.
          </Callout> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" hint="Leave empty when the SMTP server does not require authentication.">
              <TextInput aria-label="SMTP username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </Field>
            <Field
              label="Password"
              hint={email.data?.passwordConfigured ? "A password is configured. Leave blank to keep it." : username ? "Required when SMTP authentication is used." : "Not required without authentication."}
            >
              <StoredSecretInput
                aria-label="SMTP password"
                configured={email.data?.passwordConfigured === true}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder=""
                autoComplete="new-password"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From address" required>
              <TextInput aria-label="SMTP from address" type="email" value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} placeholder="noreply@example.com" />
            </Field>
            <Field label="From name">
              <TextInput aria-label="SMTP from name" value={fromName} onChange={(event) => setFromName(event.target.value)} placeholder="ResourcePortal" />
            </Field>
          </div>

          <Field label="Reply-To address" hint="Optional address for replies. Leave blank to use the From address.">
            <TextInput aria-label="SMTP reply-to address" type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2 border-t border-[#E1E7F0] pt-4">
            <Button variant="primary" type="submit" disabled={Boolean(working) || (enabled && (!host.trim() || !fromEmail.trim() || !port))}>
              {working === "save" ? "Saving…" : "Save SMTP settings"}
            </Button>
            <Button type="button" disabled={Boolean(working) || email.data?.configured !== true} onClick={() => void validate()}>
              {working === "validate" ? "Testing…" : "Test connection"}
            </Button>
          </div>
        </form>
      </Card>

      <div className="space-y-6">
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#172033]">Delivery status</h2>
            <StatusBadge tone={tone}>{status}</StatusBadge>
          </div>
          <dl className="mt-5 grid gap-4 text-sm">
            <div><dt className="text-xs text-[#718096]">Password</dt><dd className="mt-1 font-medium text-[#172033]">{email.data?.passwordConfigured ? "Configured" : "Not configured"}</dd></div>
            <div><dt className="text-xs text-[#718096]">Last connection test</dt><dd className="mt-1 font-medium text-[#172033]">{email.data?.lastValidatedAt ? formatDate(email.data.lastValidatedAt) : "Never"}</dd></div>
            <div><dt className="text-xs text-[#718096]">Last test email</dt><dd className="mt-1 font-medium text-[#172033]">{email.data?.lastTestSentAt ? formatDate(email.data.lastTestSentAt) : "Never"}</dd></div>
            <div><dt className="text-xs text-[#718096]">ZITADEL synchronization</dt><dd className="mt-1 font-medium text-[#172033]">{email.data?.zitadelSync?.status ?? "Unknown"}{email.data?.zitadelSync?.lastSyncedAt ? ` · ${formatDate(email.data.zitadelSync.lastSyncedAt)}` : ""}</dd></div>
          </dl>
          {email.data?.lastError ? <div className="mt-5"><Callout tone="warning" title="Last SMTP error">{email.data.lastError}</Callout></div> : null}
          {email.data?.zitadelSync?.error ? <div className="mt-5"><Callout tone="warning" title="ZITADEL SMTP synchronization">{email.data.zitadelSync.error}</Callout></div> : null}
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-[#172033]">Send test email</h2>
          <p className="mt-1 text-xs leading-5 text-[#718096]">Sends a real message through the saved SMTP configuration.</p>
          <div className="mt-4">
            <Field label="Recipient">
              <TextInput aria-label="SMTP test recipient" type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="admin@example.com" />
            </Field>
          </div>
          <Button className="mt-4" type="button" disabled={Boolean(working) || email.data?.configured !== true || !testRecipient.trim()} onClick={() => void sendTest()}>
            {working === "test" ? "Sending…" : "Send test email"}
          </Button>
        </Card>

        <Callout title="SMTP credentials are write-only">
          The password is encrypted at rest with the platform resource encryption key. The API and Web Console expose only whether a password is configured.
        </Callout>
      </div>
    </div>
  </main>;
}
