Resource Portal CLI exposes Resource Portal operations through `rp` and `resourceportal`.

The CLI uses `@resource-portal/sdk`, so all operations go through the public HTTP API.

## Auth

Production bearer token:

```bash
rp login --api-url https://resource-portal.example.com/api --token "$RESOURCE_PORTAL_TOKEN"
```

Local dev mode:

```bash
rp login --api-url http://localhost:3000/api --dev-user-id USER_UUID
```

You can also avoid persisted config:

```bash
RESOURCE_PORTAL_API_URL=http://localhost:3000/api RESOURCE_PORTAL_DEV_USER_ID=USER_UUID rp tenant list
```

## Correlation and request IDs

All legacy and compatibility commands can propagate observability identifiers:

```bash
rp operation list TENANT_ID --correlation-id workflow-123 --request-id request-123
```

The same defaults can be provided with `RESOURCE_PORTAL_CORRELATION_ID` and `RESOURCE_PORTAL_REQUEST_ID`.

## Output

```bash
rp tenant list
rp tenant list -o json
```

Raw text endpoints such as `metrics show` and `audit export` are printed as text. JSON API responses retain table or JSON output behavior.

## End-to-End Example

```bash
rp tenant create --name demo --display-name Demo --contact-email demo@example.com
rp app-group create TENANT_ID --name web --runtime-state Running
rp app-group stack-preview TENANT_ID APP_GROUP_ID
rp app create TENANT_ID APP_GROUP_ID --name nginx --image nginx:alpine --cpu 0.1 --memory-bytes 134217728 --desired-replicas 1 --runtime-state Running
rp volume create TENANT_ID --name data --size-bytes 1048576
rp volume attach TENANT_ID APP_GROUP_ID APP_ID --volume-id VOLUME_ID --mount-path /data --mode ReadWrite
rp endpoint create TENANT_ID APP_GROUP_ID APP_ID --name web --container-port 80 --protocol-mode HTTP
rp secret create TENANT_ID APP_GROUP_ID --name api-key --type Text --value "$API_KEY"
rp secret attach TENANT_ID APP_GROUP_ID APP_ID --secret-id SECRET_ID --target-name api-key
rp custom-root-domain create TENANT_ID --root-domain example.com
rp domain create TENANT_ID --type Managed --prefix demo --http-endpoint-id ENDPOINT_ID
rp deployment create TENANT_ID APP_GROUP_ID --note "initial deploy"
rp deployment events TENANT_ID APP_GROUP_ID DEPLOYMENT_ID
```

## Command Groups

Existing command groups remain supported:

```text
account
tenant
membership
invitation
identity-provider
group
app-group
app
variable
config
secret
volume
endpoint
domain
custom-root-domain
registry
deployment
audit
```

The compatibility sync adds:

```text
platform-billing
swarm
remote-location
storage-backend
operation
platform-maintenance
oauth-application
platform-oauth-application
service-identity
platform-service-identity
platform-identity-provider
metrics
```

Representative commands:

```bash
rp platform-billing price-list-list
rp platform-billing voucher-list
rp platform-billing payment --tenant-id TENANT_ID --amount-credits 25 --reference manual-credit
rp platform-billing refund --tenant-id TENANT_ID --amount-credits 10 --reason correction
rp platform-billing correction --tenant-id TENANT_ID --amount-credits -2 --reason adjustment

rp swarm show
rp swarm reconcile
rp remote-location list
rp remote-location maintenance REMOTE_LOCATION_ID --enabled true

rp storage-backend list
rp storage-backend validate STORAGE_BACKEND_ID
rp storage-backend maintenance STORAGE_BACKEND_ID --enabled false

rp operation list TENANT_ID
rp operation show TENANT_ID OPERATION_ID
rp operation events TENANT_ID OPERATION_ID
rp operation retry TENANT_ID OPERATION_ID

rp platform-maintenance show
rp platform-maintenance set --enabled true --reason upgrade

rp oauth-application list TENANT_ID
rp oauth-application create TENANT_ID --name web --type Web --redirect-uris https://app.example.com/callback
rp oauth-application rotate-credentials TENANT_ID APPLICATION_ID

rp platform-oauth-application list
rp platform-oauth-application rotate-credentials APPLICATION_ID

rp service-identity list TENANT_ID
rp service-identity create TENANT_ID --name deployer --role-ids ROLE_ID
rp service-identity rotate-credentials TENANT_ID SERVICE_IDENTITY_ID

rp platform-service-identity list
rp platform-service-identity rotate-credentials SERVICE_IDENTITY_ID

rp platform-identity-provider list
rp platform-identity-provider create --name "Company OIDC" --protocol OIDC --issuer https://login.example.com --client-id CLIENT_ID --client-secret CLIENT_SECRET --scopes profile --scopes email

rp audit list TENANT_ID --action DEPLOY --limit 25
rp audit export TENANT_ID --format csv --from 2026-08-01T00:00:00Z --to 2026-09-01T00:00:00Z
rp metrics show
```

Mutation commands added by the compatibility sync accept DTO properties as kebab-case flags. Repeated flags become arrays. For complex or exact request bodies, `--body-json` accepts the complete JSON object.

Useful existing tenant commands include:

```bash
rp tenant billing TENANT_ID
rp tenant billing-transactions TENANT_ID
rp tenant usage-records TENANT_ID
rp tenant billing-top-up TENANT_ID --amount 25 --reference manual-credit
rp tenant auth-policy TENANT_ID
rp tenant auth-policy-update TENANT_ID --require-tenant-identity-provider true
rp invitation create TENANT_ID --email user@example.com --role-id viewer
rp invitation accept --token TOKEN
rp group create TENANT_ID --name operators
rp group role-add TENANT_ID GROUP_ID --role-id resource-admin
rp group member-add TENANT_ID GROUP_ID --membership-id MEMBERSHIP_ID
rp identity-provider list TENANT_ID
rp identity-provider create TENANT_ID --name "Company OIDC" --protocol OIDC --issuer https://login.example.com --client-id CLIENT_ID --client-secret CLIENT_SECRET --scope profile --scope email
rp identity-provider create TENANT_ID --name "Company SAML" --protocol SAML --metadata-url https://login.example.com/metadata
rp app-group discard-changes TENANT_ID APP_GROUP_ID
rp app-group delete TENANT_ID APP_GROUP_ID
rp secret update TENANT_ID APP_GROUP_ID SECRET_ID --value "$NEW_API_KEY"
rp secret detach TENANT_ID APP_GROUP_ID APP_ID ATTACHMENT_ID
```

Secret values are write-only. Use UTF-8 text with `--type Text`, or Base64 with
`--type Binary`. Attached secrets are mounted at `/run/secrets/<target-name>`
after the next deployment.

## Scope boundary

The CLI exposes the public Resource Portal management API. Internal worker endpoints are intentionally excluded, including `/internal/*` and `/users` guarded by `InternalAuthGuard`.

Run help:

```bash
rp --help
rp operation --help
rp app --help
```
