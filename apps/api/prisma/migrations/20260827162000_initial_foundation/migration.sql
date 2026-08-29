-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('Pending', 'Active', 'Suspended', 'Deleting');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('Active', 'Suspended', 'Deleting');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('Active', 'Suspended');

-- CreateEnum
CREATE TYPE "AppGroupStatus" AS ENUM ('Ready', 'Error', 'Deleting');

-- CreateEnum
CREATE TYPE "RuntimeState" AS ENUM ('Running', 'Stopped');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('Healthy', 'Degraded', 'Unhealthy', 'Unknown');

-- CreateEnum
CREATE TYPE "DriftStatus" AS ENUM ('InSync', 'Drifted', 'Unknown');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('Pending', 'Deploying', 'Succeeded', 'Failed', 'RollingBack', 'RolledBack', 'RollbackFailed');

-- CreateEnum
CREATE TYPE "DeploymentPhase" AS ENUM ('Validating', 'PreparingArtifacts', 'GeneratingStack', 'ApplyingStack', 'WaitingForRollout', 'RollingBack', 'Cleanup', 'Completed');

-- CreateEnum
CREATE TYPE "VolumeStatus" AS ENUM ('Creating', 'Ready', 'Resizing', 'Deleting', 'Error');

-- CreateEnum
CREATE TYPE "AttachmentMode" AS ENUM ('ReadOnly', 'ReadWrite');

-- CreateEnum
CREATE TYPE "DomainType" AS ENUM ('Managed', 'Custom');

-- CreateEnum
CREATE TYPE "DnsStatus" AS ENUM ('Pending', 'Valid', 'Invalid', 'Error');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('Pending', 'Issuing', 'Active', 'Error');

-- CreateEnum
CREATE TYPE "RegistryTlsMode" AS ENUM ('TLS', 'NoTLS');

-- CreateEnum
CREATE TYPE "RegistryAuthType" AS ENUM ('None', 'UsernamePassword', 'Token');

-- CreateEnum
CREATE TYPE "RegistryValidationStatus" AS ENUM ('Unknown', 'Validating', 'Valid', 'Invalid', 'Error');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "providerType" TEXT NOT NULL,
    "identityProviderId" UUID,
    "issuer" TEXT NOT NULL,
    "externalSubject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "idToken" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'Active',
    "contactEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantMembership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'Active',
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipRole" (
    "membershipId" UUID NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "MembershipRole_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'credits',
    "informationThreshold" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingTransaction" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "balanceBefore" DECIMAL(18,4) NOT NULL,
    "balanceAfter" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "usage" JSONB NOT NULL,
    "cost" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quota" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cpu" DECIMAL(12,4) NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "gpu" INTEGER NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL,
    "maxSingleApps" INTEGER NOT NULL,
    "maxVolumes" INTEGER NOT NULL,
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "AppGroupStatus" NOT NULL DEFAULT 'Ready',
    "runtimeState" "RuntimeState" NOT NULL DEFAULT 'Stopped',
    "health" "HealthState" NOT NULL DEFAULT 'Unknown',
    "driftStatus" "DriftStatus" NOT NULL DEFAULT 'Unknown',
    "currentDeploymentVersion" INTEGER,
    "lastDeploymentAt" TIMESTAMP(3),
    "lastDeploymentBy" TEXT,
    "hasPendingChanges" BOOLEAN NOT NULL DEFAULT false,
    "runtimeDraftRevision" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SingleApp" (
    "id" UUID NOT NULL,
    "appGroupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image" TEXT NOT NULL,
    "registryId" UUID,
    "desiredReplicas" INTEGER NOT NULL DEFAULT 1,
    "runtimeState" "RuntimeState" NOT NULL DEFAULT 'Running',
    "actualReplicas" INTEGER NOT NULL DEFAULT 0,
    "health" "HealthState" NOT NULL DEFAULT 'Unknown',
    "cpu" DECIMAL(12,4) NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "gpu" INTEGER NOT NULL DEFAULT 0,
    "environment" JSONB NOT NULL DEFAULT '{}',
    "healthCheck" JSONB,
    "entrypoint" TEXT,
    "command" TEXT[],
    "workingDir" TEXT,
    "user" TEXT,
    "readOnlyRootFilesystem" BOOLEAN NOT NULL DEFAULT false,
    "stopGracePeriodSeconds" INTEGER NOT NULL DEFAULT 30,
    "restartPolicy" JSONB NOT NULL DEFAULT '{}',
    "updatePolicy" JSONB NOT NULL DEFAULT '{}',
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SingleApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppGroupDeployment" (
    "id" UUID NOT NULL,
    "appGroupId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'Pending',
    "phase" "DeploymentPhase" NOT NULL DEFAULT 'Validating',
    "stackConfig" TEXT,
    "sourceDraftRevision" INTEGER NOT NULL,
    "rollbackTargetVersion" INTEGER,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "correlationId" UUID NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AppGroupDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phase" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" UUID,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Volume" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "usedSizeBytes" BIGINT,
    "status" "VolumeStatus" NOT NULL DEFAULT 'Creating',
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolumeAttachment" (
    "id" UUID NOT NULL,
    "volumeId" UUID NOT NULL,
    "singleAppId" UUID NOT NULL,
    "mountPath" TEXT NOT NULL,
    "mode" "AttachmentMode" NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolumeAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "DomainType" NOT NULL,
    "prefix" TEXT,
    "customRootDomainId" UUID,
    "subdomain" TEXT,
    "hostname" TEXT NOT NULL,
    "dnsStatus" "DnsStatus" NOT NULL DEFAULT 'Pending',
    "tlsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "certificateStatus" "CertificateStatus" NOT NULL DEFAULT 'Pending',
    "certificateIssuer" TEXT,
    "certificateExpiresAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "httpEndpointId" UUID,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomRootDomain" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "rootDomain" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'Pending',
    "verificationMethod" TEXT NOT NULL DEFAULT 'DNS_TXT',
    "verificationToken" TEXT NOT NULL,
    "verificationCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRootDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HttpEndpoint" (
    "id" UUID NOT NULL,
    "singleAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "containerPort" INTEGER NOT NULL,
    "protocolMode" TEXT NOT NULL DEFAULT 'HTTP_REDIRECT_TO_HTTPS',

    CONSTRAINT "HttpEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "host" TEXT NOT NULL,
    "tlsMode" "RegistryTlsMode" NOT NULL DEFAULT 'TLS',
    "authType" "RegistryAuthType" NOT NULL DEFAULT 'None',
    "username" TEXT,
    "credentialData" JSONB,
    "validationStatus" "RegistryValidationStatus" NOT NULL DEFAULT 'Unknown',
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationError" TEXT,
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variable" (
    "id" UUID NOT NULL,
    "appGroupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" UUID NOT NULL,
    "appGroupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "fileName" TEXT,
    "valueVersion" INTEGER NOT NULL DEFAULT 1,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Config" (
    "id" UUID NOT NULL,
    "appGroupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "contentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tenantName" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID,
    "resourceName" TEXT,
    "result" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "changes" JSONB,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_issuer_externalSubject_key" ON "UserIdentity"("issuer", "externalSubject");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_name_key" ON "Tenant"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMembership_userId_tenantId_key" ON "TenantMembership"("userId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_tenantId_key" ON "BillingAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Quota_tenantId_key" ON "Quota"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AppGroup_tenantId_name_key" ON "AppGroup"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SingleApp_appGroupId_name_key" ON "SingleApp"("appGroupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AppGroupDeployment_appGroupId_version_key" ON "AppGroupDeployment"("appGroupId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Volume_tenantId_name_key" ON "Volume"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VolumeAttachment_volumeId_singleAppId_key" ON "VolumeAttachment"("volumeId", "singleAppId");

-- CreateIndex
CREATE UNIQUE INDEX "VolumeAttachment_singleAppId_mountPath_key" ON "VolumeAttachment"("singleAppId", "mountPath");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_tenantId_prefix_key" ON "Domain"("tenantId", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "CustomRootDomain_rootDomain_key" ON "CustomRootDomain"("rootDomain");

-- CreateIndex
CREATE UNIQUE INDEX "HttpEndpoint_singleAppId_name_key" ON "HttpEndpoint"("singleAppId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Registry_tenantId_name_key" ON "Registry"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Variable_appGroupId_name_key" ON "Variable"("appGroupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_appGroupId_name_key" ON "Secret"("appGroupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Config_appGroupId_name_key" ON "Config"("appGroupId", "name");

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "TenantMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quota" ADD CONSTRAINT "Quota_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppGroup" ADD CONSTRAINT "AppGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SingleApp" ADD CONSTRAINT "SingleApp_appGroupId_fkey" FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SingleApp" ADD CONSTRAINT "SingleApp_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "Registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppGroupDeployment" ADD CONSTRAINT "AppGroupDeployment_appGroupId_fkey" FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "AppGroupDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeAttachment" ADD CONSTRAINT "VolumeAttachment_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeAttachment" ADD CONSTRAINT "VolumeAttachment_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_customRootDomainId_fkey" FOREIGN KEY ("customRootDomainId") REFERENCES "CustomRootDomain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_httpEndpointId_fkey" FOREIGN KEY ("httpEndpointId") REFERENCES "HttpEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpEndpoint" ADD CONSTRAINT "HttpEndpoint_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registry" ADD CONSTRAINT "Registry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variable" ADD CONSTRAINT "Variable_appGroupId_fkey" FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_appGroupId_fkey" FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Config" ADD CONSTRAINT "Config_appGroupId_fkey" FOREIGN KEY ("appGroupId") REFERENCES "AppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

