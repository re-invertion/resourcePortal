import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  BillingIcon,
  Callout,
  Card,
  DeployIcon,
  FileIcon,
  GlobeIcon,
  GridIcon,
  HelpIcon,
  KeyIcon,
  LinkButton,
  NetworkIcon,
  RegistryIcon,
  SettingsIcon,
  UsersIcon,
  VolumeIcon,
} from "../components/design-system";
import { tenantHref } from "../router/router";

type HelpSection = {
  id: string;
  label: string;
};

const sections: HelpSection[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "mental-model", label: "How ResourcePortal is organized" },
  { id: "create-application", label: "Create an application" },
  { id: "app-group-yaml", label: "Import from YAML" },
  { id: "registry", label: "Private image registries" },
  { id: "volume", label: "Persistent storage" },
  { id: "private-networking", label: "Private Networks & Gate" },
  { id: "domain", label: "Domains & HTTP routing" },
  { id: "tenant-access", label: "Invite tenant users" },
  { id: "credentials", label: "Credentials & secrets" },
  { id: "tenant-mcp", label: "Tenant MCP" },
  { id: "deploy", label: "Deploy & restart" },
  { id: "billing", label: "Billing & vouchers" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

function TableOfContents() {
  const [active, setActive] = useState(sections[0].id);

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => Boolean(element));

    if (!elements.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top));
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -65% 0px", threshold: [0, 0.05, 0.25] },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return <nav aria-label="Help topics" className="min-w-0">
    <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8A96A8]">On this page</p>
    <div className="mt-2 space-y-0.5">
      {sections.map((section) => <a
        key={section.id}
        href={`#${section.id}`}
        onClick={() => setActive(section.id)}
        aria-current={active === section.id ? "location" : undefined}
        className={`relative block rounded-md px-3 py-2 text-[13px] leading-5 transition ${
          active === section.id
            ? "bg-[#E7F1FF] font-semibold text-[#0F56A7] before:absolute before:left-0 before:top-2 before:h-5 before:w-[3px] before:rounded-full before:bg-[#1769E0]"
            : "font-medium text-[#526070] hover:bg-[#EEF3F9] hover:text-[#172033]"
        }`}
      >
        {section.label}
      </a>)}
    </div>
  </nav>;
}

function SectionHeader({
  icon,
  eyebrow,
  title,
  description,
}: {
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return <div className="flex min-w-0 gap-3">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">{icon}</span>
    <div className="min-w-0">
      {eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#1769E0]">{eyebrow}</p> : null}
      <h2 className={`${eyebrow ? "mt-0.5" : ""} text-[20px] font-semibold tracking-[-0.015em] text-[#172033]`}>{title}</h2>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-6 text-[#5B6678]">{description}</p>
    </div>
  </div>;
}

function StepList({ children }: { children: ReactNode[] }) {
  return <ol className="mt-4 space-y-3">
    {children.map((child, index) => <li key={index} className="flex min-w-0 gap-3 text-[13px] leading-6 text-[#42526B]">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#F0F5FC] text-[11px] font-semibold text-[#1769E0]">{index + 1}</span>
      <div className="min-w-0 flex-1">{child}</div>
    </li>)}
  </ol>;
}

function InfoBox({ title, children, tone = "neutral" }: { title: string; children: ReactNode; tone?: "neutral" | "blue" }) {
  return <div className={`mt-5 rounded-lg border px-4 py-3 ${
    tone === "blue" ? "border-[#C9DCF5] bg-[#F6F9FE]" : "border-[#E1E7F0] bg-[#F8FAFD]"
  }`}>
    <strong className="block text-[12px] font-semibold text-[#172033]">{title}</strong>
    <div className="mt-1 text-[12px] leading-5 text-[#5B6678]">{children}</div>
  </div>;
}

function HelpArticle({
  id,
  icon,
  eyebrow,
  title,
  description,
  children,
}: {
  id: string;
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <article id={id} className="scroll-mt-24 border-b border-[#E1E7F0] py-9 first:pt-0 last:border-b-0 last:pb-0">
    <SectionHeader icon={icon} eyebrow={eyebrow} title={title} description={description} />
    <div className="mt-6 pl-0 text-[13px] text-[#42526B] sm:pl-[52px]">{children}</div>
  </article>;
}

function Paragraph({ children }: { children: ReactNode }) {
  return <p className="max-w-3xl leading-6 text-[#42526B]">{children}</p>;
}

function Subheading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-6 text-[14px] font-semibold text-[#172033]">{children}</h3>;
}

export function TenantHelpPage({ tenantId }: { tenantId: string }) {
  return <main>
    <header className="mb-7">
      <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#1769E0]">User help</p>
      <h1 className="mt-1 text-[32px] font-semibold leading-[40px] tracking-[-0.025em] text-[#172033]">Help & getting started</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5B6678]">
        Learn the everyday ResourcePortal workflow: create applications, connect storage and domains, deploy changes, understand billing and diagnose common problems.
      </p>
    </header>

    <Callout title="This guide is for tenant users">
      This documentation explains the features you use to run workloads inside a tenant. Administrative platform and infrastructure procedures are intentionally not included.
    </Callout>

    <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="hidden min-w-0 lg:block">
        <div className="sticky top-[82px] max-h-[calc(100vh-110px)] overflow-y-auto pr-2">
          <TableOfContents />
        </div>
      </aside>

      <div className="min-w-0">
        <div className="mb-7 rounded-lg border border-[#D7E0EC] bg-white p-4 lg:hidden">
          <TableOfContents />
        </div>

        <Card className="min-w-0 overflow-hidden p-6 sm:p-7">
          <HelpArticle
            id="getting-started"
            icon={<HelpIcon />}
            eyebrow="Start here"
            title="Getting started"
            description="The fastest way to become productive is to understand the normal path from an empty tenant to a reachable application."
          >
            <Paragraph>
              Most work in ResourcePortal follows the same sequence: create an <strong>App Group</strong>, add an <strong>Application</strong>, connect anything the application needs such as a registry or volume, configure networking, and then deploy the resulting configuration.
            </Paragraph>

            <Subheading>A typical first deployment</Subheading>
            <StepList>
              <span>Open <strong>Applications</strong> and create an App Group for the service or project you are deploying.</span>
              <span>Inside the App Group, create an Application and enter its container image.</span>
              <span>If the image is private, configure a Registry before the first deployment.</span>
              <span>Add environment variables, secrets, storage and compute settings required by the application.</span>
              <span>Add a Domain or other networking configuration if the workload must be reachable over HTTP.</span>
              <span>Review the application and use <strong>Deploy changes</strong> to apply the desired configuration.</span>
            </StepList>

            <InfoBox title="Quick links" tone="blue">
              <div className="flex flex-wrap gap-2">
                <LinkButton href={tenantHref(tenantId, "applications")}>Open Applications</LinkButton>
                <LinkButton href={tenantHref(tenantId, "applications", "new")}>Create App Group</LinkButton>
                <LinkButton href={tenantHref(tenantId, "storage-networking")}>Storage & Networking</LinkButton>
              </div>
            </InfoBox>
          </HelpArticle>

          <HelpArticle
            id="mental-model"
            icon={<GridIcon />}
            title="How ResourcePortal is organized"
            description="Understanding the relationship between the main resource types makes the rest of the interface much easier to navigate."
          >
            <Subheading>Tenant</Subheading>
            <Paragraph>
              A Tenant is your isolated workspace. Applications, storage, domains, credentials, billing and activity shown in the interface belong to the currently selected tenant.
            </Paragraph>

            <Subheading>App Group</Subheading>
            <Paragraph>
              An App Group groups applications that belong together operationally. A typical App Group may represent a project, service stack or environment. For example, one App Group can contain a web frontend, API and background worker that are managed together.
            </Paragraph>

            <Subheading>Application</Subheading>
            <Paragraph>
              An Application is a deployable container workload. It has a container image, compute resources, environment configuration, optional storage and networking. Changes made in the editor describe the desired configuration; deploying applies that configuration to the runtime.
            </Paragraph>

            <Subheading>Volume, Registry and Domain</Subheading>
            <Paragraph>
              A <strong>Volume</strong> provides persistent data storage. A <strong>Registry</strong> gives ResourcePortal access to container images, especially private ones. A <strong>Domain</strong> represents a hostname that can route incoming HTTP traffic to an application.
            </Paragraph>

            <InfoBox title="A useful rule of thumb">
              Create shared tenant resources such as registries, volumes and domains first when you already know the application will depend on them. Then attach or reference them from the application configuration.
            </InfoBox>
          </HelpArticle>

          <HelpArticle
            id="create-application"
            icon={<GridIcon />}
            title="Create and deploy an application"
            description="Applications live inside an App Group. Creating the group first gives related workloads a clear place to live and keeps their configuration easier to understand."
          >
            <Subheading>Before you begin</Subheading>
            <Paragraph>
              You should know the container image you want to run and, at minimum, which port or service the application exposes. If the image comes from a private registry, add the registry credentials before deploying.
            </Paragraph>

            <Subheading>Create the App Group and application</Subheading>
            <StepList>
              <span>Open <strong>Applications</strong> and select <strong>Create App Group</strong>. Give the group a name that describes the service or project rather than an individual container.</span>
              <span>Open the newly created App Group, go to <strong>Apps</strong> and choose <strong>Create application</strong>.</span>
              <span>Enter the application name and container image. Keep application names short and meaningful because they appear throughout Activity, billing and networking views.</span>
              <span>Configure environment variables and secret values required by the container. Avoid placing passwords or tokens in ordinary text fields.</span>
              <span>Attach persistent volumes only when the application really needs durable state. Configure the mount path expected by the container.</span>
              <span>Select CPU and memory appropriate for the workload. You can adjust them later if the application requires more resources.</span>
              <span>Review the summary, create the application and use <strong>Deploy changes</strong> when the configuration is ready.</span>
            </StepList>

            <Subheading>After deployment</Subheading>
            <Paragraph>
              Watch the application status and the tenant Activity page. A successful create operation does not always mean the workload is healthy: the image can still fail to start because of a wrong command, missing environment variable, unavailable image or invalid runtime configuration.
            </Paragraph>

            <InfoBox title="Deploy changes vs Restart">
              <strong>Deploy changes</strong> applies a changed desired configuration such as a new image, environment variable, volume or domain. <strong>Restart</strong> starts the current configuration again without intentionally changing it.
            </InfoBox>

            <div className="mt-5 flex flex-wrap gap-2">
              <LinkButton href={tenantHref(tenantId, "applications")}>Open Applications</LinkButton>
              <LinkButton href={tenantHref(tenantId, "applications", "new")}>Create App Group</LinkButton>
            </div>
          </HelpArticle>

          <HelpArticle
            id="app-group-yaml"
            icon={<FileIcon />}
            title="Import an App Group from YAML"
            description="A versioned YAML manifest lets you describe an App Group and its applications in a repeatable, reviewable format before ResourcePortal creates anything."
          >
            <Paragraph>
              Open <strong>Applications → Import YAML</strong> and select a <code>.yml</code> or <code>.yaml</code> file. ResourcePortal first validates the manifest without changing the tenant. It checks the file structure, your permissions, tenant quota, App Group name conflicts and references to existing registries, volumes and domains. Only a valid manifest can be created.
            </Paragraph>

            <Subheading>Manifest structure</Subheading>
            <Paragraph>
              Use <code>apiVersion: resourceportal.io/v1alpha1</code> and <code>kind: AppGroup</code>. The App Group name is stored in <code>metadata.name</code>. The <code>spec</code> section can contain applications, variables, secrets and config files. Existing tenant resources are referenced by stable names instead of installation-specific IDs: use the registry name, volume name and domain hostname.
            </Paragraph>

            <div className="mt-4 overflow-x-auto rounded-lg border border-[#D7E0EC] bg-[#111827] p-4 text-[12px] leading-5 text-[#E5E7EB]">
              <pre><code>{`apiVersion: resourceportal.io/v1alpha1
kind: AppGroup
metadata:
  name: commerce-prod
  description: Commerce workload
spec:
  runtimeState: Stopped
  variables:
    - name: LOG_LEVEL
      value: info
  secrets:
    - name: API_TOKEN
      type: Text
      value: replace-before-import
  configs:
    - name: nginx-conf
      content: |
        server {
          listen 80;
          location / { return 200 "ok"; }
        }
  apps:
    - name: web
      image: nginx:1.27
      desiredReplicas: 2
      resources:
        cpu: 0.5
        memoryBytes: 536870912
      environment:
        NODE_ENV: production
      variables:
        - source: LOG_LEVEL
          targetName: LOG_LEVEL
      secrets:
        - source: API_TOKEN
          targetName: API_TOKEN
      configs:
        - source: nginx-conf
          targetPath: /etc/nginx/conf.d/default.conf
      volumes:
        - source: app-data
          mountPath: /var/lib/app
          mode: ReadWrite
      httpEndpoints:
        - name: web
          containerPort: 80
          protocolMode: HTTP_REDIRECT_TO_HTTPS
          domains:
            - app.example.com`}</code></pre>
            </div>

            <Subheading>References and validation</Subheading>
            <StepList>
              <span><strong>App Group and application names</strong> use lowercase letters, numbers and single hyphens.</span>
              <span><strong>resources.cpu</strong> and <strong>resources.memoryBytes</strong> are required for every application. Memory must be at least 134217728 bytes (128 MiB).</span>
              <span><strong>registry</strong>, volume <strong>source</strong> and domain hostnames must already exist in the current tenant when they are referenced.</span>
              <span>Variables, secrets and configs declared at App Group level can be attached to applications by their <strong>source</strong> name.</span>
              <span>Binary secret values use Base64. Text secrets are plain text in the YAML file and are encrypted when ResourcePortal imports them.</span>
              <span>The manifest file can be at most <strong>512 KB</strong>. Unknown fields are rejected so spelling mistakes do not silently change the intended configuration.</span>
            </StepList>

            <InfoBox title="Treat manifests containing secrets as sensitive">
              The validation preview never returns secret values, but the YAML file itself can contain them. Avoid committing manifests with real passwords, tokens or private keys to source control. Prefer placeholders and a controlled process for supplying production secret values.
            </InfoBox>

            <InfoBox title="Import creates desired configuration, not a runtime deployment">
              ResourcePortal applies a valid manifest atomically: if any create or attachment step fails, the import is rolled back. After a manifest containing applications is imported, review the App Group and use <strong>Deploy changes</strong> to apply the desired configuration to the runtime.
            </InfoBox>

            <InfoBox title="Private application connectivity">
              Use <strong>Storage & Networking → Networking</strong> to connect applications to tenant Networks. Applications in the same deployed App Group also share the App Group network automatically. Attach a ResourcePortalGate when selected tenant Networks must be reachable from a local LAN.
            </InfoBox>

            <div className="mt-5 flex flex-wrap gap-2">
              <LinkButton href={tenantHref(tenantId, "applications", "import")}>Import YAML</LinkButton>
              <LinkButton href={tenantHref(tenantId, "applications")}>Open Applications</LinkButton>
            </div>
          </HelpArticle>

          <HelpArticle
            id="registry"
            icon={<RegistryIcon />}
            title="Use a private container registry"
            description="A registry entry allows ResourcePortal to authenticate when it needs to pull a container image that is not publicly accessible."
          >
            <Subheading>When you need a registry</Subheading>
            <Paragraph>
              Public images can usually be pulled without additional credentials. Private images from services such as an organization registry require an authenticated registry configuration. If the registry cannot be reached or the credentials are incorrect, application deployment may fail before the container starts.
            </Paragraph>

            <Subheading>Configure the registry</Subheading>
            <StepList>
              <span>Open <strong>Storage & Networking → Registries</strong>.</span>
              <span>Create the registry entry using the registry host and the credentials required to pull images.</span>
              <span>Return to the target application and use the correct fully qualified image name, including the registry host, repository and image tag.</span>
              <span>Deploy the application and monitor Activity for image-pull or authentication failures.</span>
            </StepList>

            <InfoBox title="If an image cannot be pulled">
              Verify the registry hostname, image repository and tag first. Then confirm that the configured credential has permission to pull that repository. Repeatedly restarting an application will not fix invalid registry credentials.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "registries")}>Open Registries</LinkButton></div>
          </HelpArticle>

          <HelpArticle
            id="volume"
            icon={<VolumeIcon />}
            title="Add persistent storage"
            description="Volumes keep application data outside the lifecycle of an individual container so it can survive restarts and redeployments."
          >
            <Subheading>When to use a volume</Subheading>
            <Paragraph>
              Use persistent storage for files the application must keep between container replacements, such as uploaded files, application state or durable data that the workload stores locally. Temporary caches and disposable build artifacts usually do not need a persistent volume.
            </Paragraph>

            <Subheading>Create and attach a volume</Subheading>
            <StepList>
              <span>Open <strong>Storage & Networking → Volumes</strong> and create a volume with enough capacity for the expected data.</span>
              <span>Open the application and edit its Storage settings.</span>
              <span>Attach the volume and enter the mount path the application expects inside the container.</span>
              <span>Deploy the changed application configuration.</span>
              <span>After deployment, confirm the application starts successfully and can read or write the mounted path.</span>
            </StepList>

            <InfoBox title="Important">
              A volume is persistent tenant storage, not a backup. If the data is important, the application or surrounding operational process should still have an appropriate backup strategy.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "volumes")}>Open Volumes</LinkButton></div>
          </HelpArticle>


          <HelpArticle
            id="private-networking"
            icon={<NetworkIcon />}
            title="Connect applications with private Networks"
            description="Tenant Networks provide private connectivity across applications and App Groups. ResourcePortalGate can route selected Networks into a local LAN through WireGuard."
          >
            <Subheading>Connect applications</Subheading>
            <StepList>
              <span>Open <strong>Storage & Networking → Networking</strong> and create a Network. ResourcePortal assigns a private CIDR automatically unless you choose a compatible custom private CIDR.</span>
              <span>On the topology canvas, drag from an application to the Network. The application receives a stable private address from that Network.</span>
              <span>Deploy every affected App Group. A topology connection is desired state until its App Group deployment applies the additional Swarm Network attachment.</span>
              <span>Applications connected to the same Network can communicate over that private Network. Networks can include applications from different App Groups in the same tenant.</span>
            </StepList>

            <Subheading>Expose a Network to your LAN with ResourcePortalGate</Subheading>
            <StepList>
              <span>Create a <strong>ResourcePortalGate</strong> on the Networking page and copy the one-time installation command.</span>
              <span>Run the installer on a Linux host in the LAN that should act as the VPN router. The installer creates a systemd service and a WireGuard identity locally.</span>
              <span>Wait until the Gate appears as <strong>Ready</strong> and reports a LAN address.</span>
              <span>Connect the Gate node to one or more Network nodes. Each Gate→Network edge means that Network is routed through the encrypted Gate tunnel.</span>
              <span>If the Gate host is not the LAN default router, add a static route on your LAN router for each RP Network CIDR using the Gate LAN address as the next hop. The Networking page shows the exact route plan.</span>
            </StepList>

            <InfoBox title="V1 uses IP addresses, not DNS">
              ResourcePortalGate v1 does not provide private DNS or service discovery. Connect to the stable private IP shown on the application→Network edge. DNS can be added later without changing the Network/Gate routing model.
            </InfoBox>

            <InfoBox title="Direction of access">
              Gate v1 is designed for <strong>LAN → ResourcePortal Network</strong> access. Connecting a Gate does not automatically allow applications in ResourcePortal to initiate connections to the entire LAN.
            </InfoBox>

            <div className="mt-5">
              <LinkButton href={tenantHref(tenantId, "networking")}>Open Networking</LinkButton>
            </div>
          </HelpArticle>

          <HelpArticle
            id="domain"
            icon={<GlobeIcon />}
            title="Add a domain to an application"
            description="Domains connect an external hostname to an application and let ResourcePortal route incoming HTTP traffic to the correct workload."
          >
            <Subheading>What a domain needs</Subheading>
            <Paragraph>
              The hostname must resolve through DNS to the ingress expected by your ResourcePortal environment. ResourcePortal then needs to know which application and application port should receive the traffic.
            </Paragraph>

            <Subheading>Configure a domain</Subheading>
            <StepList>
              <span>Open <strong>Storage & Networking → Domains</strong> and create the hostname you want to use.</span>
              <span>Make sure the public DNS record points to the ingress address provided for your ResourcePortal environment.</span>
              <span>Open the target application and go to its Networking settings.</span>
              <span>Attach the domain and select the application port that serves HTTP traffic.</span>
              <span>Deploy the networking change and allow time for routing and certificate setup to become ready.</span>
            </StepList>

            <Subheading>If the domain does not work</Subheading>
            <Paragraph>
              Check the Domain status first. If DNS points somewhere else, ResourcePortal cannot correct that from inside the application. If DNS is correct but routing is not ready, review Activity and the application networking configuration. Confirm that the container actually listens on the port selected in the route.
            </Paragraph>

            <InfoBox title="TLS and certificates">
              A hostname may need time before HTTPS is fully ready. Do not repeatedly delete and recreate a domain while certificate or routing setup is still in progress; first check its current status and Activity.
            </InfoBox>

            <div className="mt-5 flex flex-wrap gap-2">
              <LinkButton href={tenantHref(tenantId, "domains")}>Open Domains</LinkButton>
              <LinkButton href={tenantHref(tenantId, "storage-networking")}>Storage & Networking</LinkButton>
            </div>
          </HelpArticle>

          <HelpArticle
            id="tenant-access"
            icon={<UsersIcon />}
            title="Invite a user to the tenant"
            description="Tenant administrators can create a one-time invitation link and share it manually with the person who should join the tenant."
          >
            <Subheading>Generate an invitation link</Subheading>
            <StepList>
              <span>Open <strong>Access management</strong> and choose <strong>Invite user</strong>.</span>
              <span>Enter the user's email address and select the role that should be granted after acceptance.</span>
              <span>Choose <strong>Generate invitation link</strong> and copy the link shown by ResourcePortal.</span>
              <span>Share the link with the intended user through an appropriate channel. ResourcePortal does not send invitation email yet.</span>
              <span>The user opens the link, signs in or creates an account through ResourcePortal OAuth, then accepts the invitation.</span>
            </StepList>

            <Subheading>Generate a new link</Subheading>
            <Paragraph>
              A pending invitation does not expose its original token again. Use <strong>Generate new link</strong> when you need another copy. ResourcePortal rotates the invitation token, so the previous link stops working.
            </Paragraph>

            <InfoBox title="Invitation links are credentials">
              Anyone who receives the link still has to authenticate as the invited email address, but the link itself should be handled as sensitive access material until it is accepted, revoked or expires.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "administration")}>Open Access management</LinkButton></div>
          </HelpArticle>

          <HelpArticle
            id="credentials"
            icon={<KeyIcon />}
            title="Work with credentials and secrets"
            description="Credentials and secret values should be treated differently from ordinary application configuration because they may contain passwords, API tokens or other sensitive material."
          >
            <Subheading>Keep secrets out of ordinary fields</Subheading>
            <Paragraph>
              Do not place passwords, access tokens or private keys in resource names, descriptions or other fields that are intended to be visible. Use the credential and secret mechanisms provided by the tenant and application configuration instead.
            </Paragraph>

            <Subheading>Updating a secret used by an application</Subheading>
            <StepList>
              <span>Open <strong>Credentials</strong> and make sure the required tenant credential exists and is valid.</span>
              <span>Open the application configuration and update the secret or credential reference used by the workload.</span>
              <span>Deploy the application changes so the running workload receives the new configuration.</span>
              <span>If authentication still fails, inspect Activity and the application configuration rather than copying the secret itself into logs or descriptions.</span>
            </StepList>

            <InfoBox title="Security practice">
              Treat credentials as values that should be rotated when compromised and shared only with workloads or users that need them.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "credentials")}>Open Credentials</LinkButton></div>
          </HelpArticle>

          <HelpArticle
            id="tenant-mcp"
            icon={<SettingsIcon />}
            title="Connect an MCP client to your tenant"
            description="Tenant administrators can expose ResourcePortal tenant operations through Model Context Protocol (MCP) without creating a second authorization model."
          >
            <Subheading>Enable MCP and choose who may connect</Subheading>
            <StepList>
              <span>Open <strong>Settings</strong> in the tenant navigation.</span>
              <span>Enable <strong>Model Context Protocol (MCP)</strong>. MCP is disabled by default for every tenant.</span>
              <span>Choose whether all active tenant members may connect or select specific memberships.</span>
              <span>Save the settings, then copy the <strong>MCP server URL</strong> from the connection section.</span>
              <span>In OpenAI/ChatGPT, add a remote MCP server and paste that URL. You do not need to create or paste a Client ID or Client Secret.</span>
              <span>When OpenAI asks to connect the account, complete OAuth sign-in with the same ResourcePortal identity system used for normal login.</span>
            </StepList>

            <Subheading>Access through MCP does not bypass tenant roles</Subheading>
            <Paragraph>
              The MCP allow-list controls who may enter through the MCP endpoint. It does not grant additional ResourcePortal permissions. Each tool call runs as the authenticated user and passes through the same tenant membership, role, group, billing and platform safety checks as the equivalent API operation.
            </Paragraph>

            <Subheading>OAuth discovery</Subheading>
            <Paragraph>
              ResourcePortal uses the official MCP Streamable HTTP transport and publishes protected-resource metadata for each tenant MCP endpoint. OpenAI can discover the ResourcePortal identity issuer and requested scopes automatically. Tool descriptors advertise OAuth security schemes, and protected tool calls return the standard MCP authentication challenge when account linking is required. Browser session cookies and service identities are not accepted as MCP credentials.
            </Paragraph>

            <InfoBox title="Automatic OAuth client registration">
              ResourcePortal v0.2.10+ automatically enables the ZITADEL Dynamic Client Registration mode required by MCP account linking. A correctly installed platform advertises the registration endpoint in OIDC discovery, so OpenAI/ChatGPT can register its client automatically. If Tenant Settings shows that automatic registration is unavailable, the platform installer or identity bootstrap needs repair; do not work around it by creating a tenant OAuth application manually.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "settings")}>Open Tenant Settings</LinkButton></div>
          </HelpArticle>

          <HelpArticle
            id="deploy"
            icon={<DeployIcon />}
            title="Deploy, restart and check changes"
            description="Deploy and Restart solve different problems. Choosing the correct action makes application behavior easier to understand and troubleshooting less confusing."
          >
            <Subheading>Use Deploy changes when configuration changed</Subheading>
            <Paragraph>
              Use Deploy changes after modifying the image, environment, compute resources, storage, secrets or networking. The deployment operation applies the desired configuration to the runtime.
            </Paragraph>

            <Subheading>Use Restart when configuration is already correct</Subheading>
            <Paragraph>
              Restart is useful when you want a fresh application process without intentionally changing its desired configuration. For example, you may restart a workload after a transient dependency failure or when the application itself needs to reinitialize.
            </Paragraph>

            <Subheading>Follow the operation</Subheading>
            <StepList>
              <span>Trigger Deploy changes or Restart from the application or App Group.</span>
              <span>Watch the visible status instead of immediately repeating the action.</span>
              <span>Open <strong>Activity</strong> to see the recent operation in tenant context.</span>
              <span>Use <strong>Operations</strong> when you need more detail about a pending or failed background operation.</span>
              <span>Fix the underlying configuration before retrying a failed deployment.</span>
            </StepList>

            <div className="mt-5 flex flex-wrap gap-2">
              <LinkButton href={tenantHref(tenantId, "applications")}>Open Applications</LinkButton>
              <LinkButton href={tenantHref(tenantId, "activity")}>Open Activity</LinkButton>
              <LinkButton href={tenantHref(tenantId, "operations")}>Open Operations</LinkButton>
            </div>
          </HelpArticle>

          <HelpArticle
            id="billing"
            icon={<BillingIcon />}
            title="Credits, usage and vouchers"
            description="Billing shows the tenant balance, resource quota, account transactions and workload usage that contributes to billing."
          >
            <Subheading>Balance and quota</Subheading>
            <Paragraph>
              The balance is the amount of tenant credit currently available. Quota cards show the resource limits assigned to the tenant, such as CPU, memory and persistent storage. Quota describes what the tenant is allowed to allocate; usage describes what workloads are actually consuming or being billed for over time.
            </Paragraph>

            <Subheading>Usage charts</Subheading>
            <Paragraph>
              Billing uses one interactive usage chart above the transaction list. Choose 24 hours, 7 days, 30 days or the full history, then switch between Credits and Replicas. Credits compares the amount actually charged with theoretical cost; Replicas compares average billed replicas with desired replicas. You can hide either series to focus on one signal. Longer periods are aggregated into larger time buckets so the chart remains readable without dropping the selected history.
            </Paragraph>

            <Subheading>Transactions</Subheading>
            <Paragraph>
              Transactions record changes to the balance, for example voucher redemption or an operator correction. They are account events, while Usage represents workload consumption over time.
            </Paragraph>

            <Subheading>Redeem a voucher</Subheading>
            <StepList>
              <span>Open <strong>Billing</strong> and locate Redeem voucher.</span>
              <span>Enter the complete RPV voucher code you received.</span>
              <span>Redeem it once. A successful redemption adds its value to the tenant balance and appears in Transactions.</span>
              <span>If redemption fails, verify the code and do not assume that repeatedly submitting it will create additional credit.</span>
            </StepList>

            <InfoBox title="How tenant funding works">
              Tenant users cannot arbitrarily create credit. The normal tenant-facing funding method is a voucher issued by the platform operator.
            </InfoBox>

            <div className="mt-5"><LinkButton href={tenantHref(tenantId, "billing")}>Open Billing</LinkButton></div>
          </HelpArticle>

          <HelpArticle
            id="troubleshooting"
            icon={<ActivityIcon />}
            title="Troubleshoot a failed operation"
            description="When something fails, use the resource status and operation history to identify the failed layer instead of repeatedly retrying the same action."
          >
            <Subheading>A good troubleshooting order</Subheading>
            <StepList>
              <span>Open the affected application, domain, volume or other resource and read its current status.</span>
              <span>Open <strong>Activity</strong> and look for an event at the time the problem started.</span>
              <span>Open <strong>Operations</strong> if a deploy, restart or background action is failed or still pending.</span>
              <span>Check configuration relevant to the failure: image and registry for image-pull problems, mount paths for storage problems, and domain/port settings for networking problems.</span>
              <span>Correct the underlying configuration before retrying the operation.</span>
            </StepList>

            <Subheading>When to check System status</Subheading>
            <Paragraph>
              The public System status page describes the health of ResourcePortal itself, not the health of your individual application. Use it when multiple unrelated actions fail, the portal cannot reach a required dependency, or ResourcePortal appears unavailable as a whole.
            </Paragraph>

            <InfoBox title="Application problem vs platform problem">
              If one application fails while the rest of ResourcePortal works, start with that application's configuration and Activity. If many unrelated tenant operations fail at the same time, System status becomes more relevant.
            </InfoBox>

            <div className="mt-5 flex flex-wrap gap-2">
              <LinkButton href={tenantHref(tenantId, "activity")}>Open Activity</LinkButton>
              <LinkButton href={tenantHref(tenantId, "operations")}>Open Operations</LinkButton>
              <LinkButton href="/health">System status</LinkButton>
            </div>
          </HelpArticle>
        </Card>
      </div>
    </div>
  </main>;
}
