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

## Output

```bash
rp tenant list
rp tenant list -o json
```

## End-to-End Example

```bash
rp tenant create --name demo --display-name Demo --contact-email demo@example.com
rp app-group create TENANT_ID --name web --runtime-state Running
rp app create TENANT_ID APP_GROUP_ID --name nginx --image nginx:alpine --cpu 0.1 --memory-bytes 134217728 --desired-replicas 1 --runtime-state Running
rp volume create TENANT_ID --name data --size-bytes 1048576
rp volume attach TENANT_ID APP_GROUP_ID APP_ID --volume-id VOLUME_ID --mount-path /data --mode ReadWrite
rp endpoint create TENANT_ID APP_GROUP_ID APP_ID --name web --container-port 80 --protocol-mode HTTP
rp custom-root-domain create TENANT_ID --root-domain example.com
rp domain create TENANT_ID --type Managed --prefix demo --http-endpoint-id ENDPOINT_ID
rp deployment create TENANT_ID APP_GROUP_ID --note "initial deploy"
rp deployment events TENANT_ID APP_GROUP_ID DEPLOYMENT_ID
```

## Command Groups

```text
account
tenant
membership
app-group
app
variable
config
volume
endpoint
domain
custom-root-domain
registry
deployment
audit
```

Useful tenant billing and audit commands:

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
rp audit list TENANT_ID
```

Run help:

```bash
rp --help
rp app --help
```
