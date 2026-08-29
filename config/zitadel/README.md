Local ZITADEL configuration for Resource Portal.

The real files below are intentionally ignored by git because they contain
local secrets generated or chosen for the development instance:

- `zitadel-secrets.yaml`
- `zitadel-init-steps.yaml`
- `../../var/zitadel/admin.pat`

Use the `.example.yaml` files as templates for a fresh local setup. The
`FirstInstance.PatPath` setting writes the bootstrap PAT to
`var/zitadel/admin.pat` only during first instance creation. If ZITADEL was
initialized before this setting existed, create a PAT manually in the Console
or recreate only the local ZITADEL database volume before running:

```bash
npm run zitadel:bootstrap
```
