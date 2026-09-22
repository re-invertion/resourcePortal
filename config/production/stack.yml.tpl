version: "3.9"

networks:
  rp-control:
    driver: overlay
    attachable: false
  rp-ingress:
    driver: overlay
    attachable: false
  rp-web-api:
    driver: overlay
    attachable: false

  host:
    external: true
    name: host

secrets:
  rp_database_url:
    external: true
  rp_postgres_password:
    external: true
  zitadel_postgres_password:
    external: true
  zitadel_masterkey:
    external: true
    name: __ZITADEL_KEY_SWARM_REF__
  zitadel_secret_config:
    external: true
  zitadel_init_steps:
    external: true
  rp_encryption_key:
    external: true
  rp_cookie_secret:
    external: true
    name: __COOKIE_SWARM_REF__
  rp_internal_worker_token:
    external: true
    name: __WORKER_SWARM_REF__
  rp_oidc_client_secret:
    external: true
    name: __OIDC_SWARM_REF__
  rp_zitadel_management_token:
    external: true
    name: __ZITADEL_MANAGEMENT_SWARM_REF__

volumes: {}

services:
  postgres-rp:
    image: __POSTGRES_IMAGE__
    entrypoint: ["/usr/local/bin/resourceportal-postgres-fence"]
    command: ["postgres"]
    environment:
      RP_POSTGRES_FENCE_NAME: resourceportal-postgres
      RP_POSTGRES_FENCE_ROOT: /mnt/resourceportal/platform/fencing
      POSTGRES_DB: resource_portal
      POSTGRES_USER: resource_portal
      POSTGRES_PASSWORD_FILE: /run/secrets/rp_postgres_password
      PGDATA: /var/lib/postgresql/data/pgdata
    secrets:
      - rp_postgres_password
    configs:
      - source: postgres_fence_script
        target: /usr/local/bin/resourceportal-postgres-fence
        mode: 0555
    volumes:
      - type: bind
        source: /mnt/resourceportal/platform/databases/resourceportal-postgres
        target: /var/lib/postgresql/data
      - type: bind
        source: /mnt/resourceportal/platform/fencing
        target: /mnt/resourceportal/platform/fencing
    networks:
      - rp-control
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U resource_portal -d resource_portal"]
      interval: 10s
      timeout: 5s
      retries: 12
    deploy:
      replicas: __POSTGRES_RP_REPLICAS__ # RP_POSTGRES_RP_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.platform == true
      restart_policy:
        condition: any

  postgres-zitadel:
    image: __POSTGRES_IMAGE__
    entrypoint: ["/usr/local/bin/resourceportal-postgres-fence"]
    command: ["postgres"]
    environment:
      RP_POSTGRES_FENCE_NAME: zitadel-postgres
      RP_POSTGRES_FENCE_ROOT: /mnt/resourceportal/platform/fencing
      POSTGRES_DB: zitadel
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/zitadel_postgres_password
      PGDATA: /var/lib/postgresql/data/pgdata
    secrets:
      - zitadel_postgres_password
    configs:
      - source: postgres_fence_script
        target: /usr/local/bin/resourceportal-postgres-fence
        mode: 0555
    volumes:
      - type: bind
        source: /mnt/resourceportal/platform/databases/zitadel-postgres
        target: /var/lib/postgresql/data
      - type: bind
        source: /mnt/resourceportal/platform/fencing
        target: /mnt/resourceportal/platform/fencing
    networks:
      - rp-control
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d zitadel"]
      interval: 10s
      timeout: 5s
      retries: 12
    deploy:
      replicas: __POSTGRES_ZITADEL_REPLICAS__ # RP_POSTGRES_ZITADEL_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.platform == true
      restart_policy:
        condition: any

  zitadel:
    image: __ZITADEL_IMAGE__
    command:
      - start-from-init
      - --config
      - /etc/zitadel/config.yaml
      - --config
      - /run/secrets/zitadel_secret_config
      - --steps
      - /run/secrets/zitadel_init_steps
      - --masterkeyFile
      - /run/secrets/zitadel_masterkey
      - --tlsMode
      - disabled
    secrets:
      - zitadel_postgres_password
      - zitadel_masterkey
      - zitadel_secret_config
      - zitadel_init_steps
    configs:
      - source: zitadel_public_config
        target: /etc/zitadel/config.yaml
    volumes:
      - type: bind
        source: /mnt/resourceportal/platform/zitadel-bootstrap
        target: /zitadel/bootstrap
    networks:
      - rp-control
      - rp-ingress
    deploy:
      replicas: __ZITADEL_REPLICAS__ # RP_ZITADEL_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.platform == true
      labels:
        - traefik.enable=true
        - traefik.swarm.network=resourceportal-control-plane_rp-ingress
        - traefik.http.routers.resourceportal-zitadel.rule=Host(`__ZITADEL_DOMAIN__`)
        - traefik.http.routers.resourceportal-zitadel.entrypoints=websecure
        - traefik.http.routers.resourceportal-zitadel.tls=true
        - traefik.http.routers.resourceportal-zitadel.tls.certresolver=__ACME_CERT_RESOLVER__
        - traefik.http.routers.resourceportal-zitadel.tls.domains[0].main=__ZITADEL_DOMAIN__
        - traefik.http.routers.resourceportal-zitadel.tls.domains[0].sans=__DOMAIN__
        - traefik.http.services.resourceportal-zitadel.loadbalancer.server.port=8080
      restart_policy:
        condition: any

  api:
    image: __API_IMAGE__
    command:
      - sh
      - -ec
      - |
        if [ -n "$${RP_OIDC_EXTRA_CA_B64:-}" ]; then
          ca=/tmp/resourceportal-oidc-extra-ca.pem
          printf '%s' "$$RP_OIDC_EXTRA_CA_B64" | base64 -d >"$$ca"
          chmod 0600 "$$ca"
          export NODE_EXTRA_CA_CERTS="$$ca"
        fi
        exec node dist/src/main.js
    environment:
      NODE_ENV: production
      PORT: "3000"
      AUTH_MODE: zitadel
      AUTH_COOKIE_SECURE: "true"
      API_TRUST_PROXY_HOPS: "1"
      API_RATE_LIMIT_MAX: "300"
      API_RATE_LIMIT_WINDOW_SECONDS: "60"
      WORKER_HEALTH_STALE_SECONDS: "30"
      DATABASE_URL_FILE: /run/secrets/rp_database_url
      RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key
      AUTH_COOKIE_SECRET_FILE: /run/secrets/rp_cookie_secret
      INTERNAL_WORKER_TOKEN_FILE: /run/secrets/rp_internal_worker_token
      OIDC_CLIENT_SECRET_FILE: /run/secrets/rp_oidc_client_secret
      ZITADEL_MANAGEMENT_TOKEN_FILE: /run/secrets/rp_zitadel_management_token
      ZITADEL_ORGANIZATION_ID: __ZITADEL_ORGANIZATION_ID__
      ZITADEL_PROJECT_ID: __ZITADEL_PROJECT_ID__
      OIDC_ISSUER_URL: https://__ZITADEL_DOMAIN__
      OIDC_CLIENT_ID: __OIDC_CLIENT_ID__
      OIDC_CLI_CLIENT_ID: __OIDC_CLI_CLIENT_ID__
      OIDC_AUDIENCE: __OIDC_CLIENT_ID__
      OIDC_PROVIDER_TYPE: zitadel
      RP_OIDC_EXTRA_CA_B64: "__OIDC_EXTRA_CA_B64__"
      OIDC_REDIRECT_URI: https://__DOMAIN__/api/auth/callback
      OIDC_POST_LOGOUT_REDIRECT_URI: https://__DOMAIN__/api/auth/logout/callback
      PLATFORM_ADMIN_USER_IDS: __PLATFORM_ADMIN_IDS__
      MANAGED_DOMAIN_BASE: __MANAGED_DOMAIN_BASE__
      RESOURCEPORTAL_PUBLIC_HOSTNAME: __DOMAIN__
      RESOURCEPORTAL_INTERNAL_NETWORK_CIDRS: __CLUSTER_CIDR__
    secrets:
      - rp_database_url
      - rp_encryption_key
      - rp_cookie_secret
      - rp_internal_worker_token
      - rp_oidc_client_secret
      - rp_zitadel_management_token
    networks:
      - rp-control
      - rp-web-api
    deploy:
      replicas: __API_REPLICAS__ # RP_API_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.control-plane == true
      restart_policy:
        condition: any

  worker:
    image: __API_IMAGE__
    user: "0"
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SYS_ADMIN
    command: ["node", "dist/src/worker.runner.js"]
    environment:
      NODE_ENV: production
      DATABASE_URL_FILE: /run/secrets/rp_database_url
      RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key
      RESOURCE_STORAGE_BASE_PATH: __STORAGE_BASE_PATH__
      RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes
      RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets
      RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform
      MANAGED_DOMAIN_BASE: __MANAGED_DOMAIN_BASE__
      RESOURCEPORTAL_PUBLIC_HOSTNAME: __DOMAIN__
      RESOURCEPORTAL_INTERNAL_NETWORK_CIDRS: __CLUSTER_CIDR__
      TRAEFIK_CERT_RESOLVER: __ACME_CERT_RESOLVER__
      TRAEFIK_SERVICE_NAME: resourceportal-control-plane_traefik
      INSTALLER_SWARM_MANAGER_ENDPOINT: __SWARM_ADVERTISE_ADDR__:2377
      INSTALLER_STORAGE_SERVER_ADDRESS: __STORAGE_SERVER_ADDRESS__
      INSTALLER_VERSION: __RELEASE_VERSION__
      INSTALLER_SWARM_ADVERTISE_ADDR: __SWARM_ADVERTISE_ADDR__
      INSTALLER_CLUSTER_CIDR: __CLUSTER_CIDR__
      WORKER_ID: production-worker
      WORKER_HEARTBEAT_INTERVAL_MS: "10000"
      WORKER_HEALTH_STALE_SECONDS: "30"
    secrets:
      - rp_database_url
      - rp_encryption_key
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - __STORAGE_DEVICE__:__STORAGE_DEVICE__
      - __STORAGE_BASE_PATH__:__STORAGE_BASE_PATH__
      - /mnt/resourceportal/volumes:/mnt/resourceportal/volumes
      - /mnt/resourceportal/secrets:/mnt/resourceportal/secrets:ro
      - /mnt/resourceportal/platform:/mnt/resourceportal/platform
    networks:
      - rp-control
    deploy:
      replicas: __WORKER_REPLICAS__ # RP_WORKER_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.control-plane == true
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.storage.volumes == true
      restart_policy:
        condition: any

  dr-reconciliation:
    image: __API_IMAGE__
    command:
      - sh
      - -ec
      - |
        if [ -n "$${RP_OIDC_EXTRA_CA_B64:-}" ]; then
          ca=/tmp/resourceportal-oidc-extra-ca.pem
          printf '%s' "$$RP_OIDC_EXTRA_CA_B64" | base64 -d >"$$ca"
          chmod 0600 "$$ca"
          export NODE_EXTRA_CA_CERTS="$$ca"
        fi
        exec node dist/src/disaster-recovery/disaster-recovery.runner.js
    environment:
      NODE_ENV: production
      AUTH_MODE: zitadel
      AUTH_COOKIE_SECURE: "true"
      DATABASE_URL_FILE: /run/secrets/rp_database_url
      RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key
      AUTH_COOKIE_SECRET_FILE: /run/secrets/rp_cookie_secret
      INTERNAL_WORKER_TOKEN_FILE: /run/secrets/rp_internal_worker_token
      OIDC_CLIENT_SECRET_FILE: /run/secrets/rp_oidc_client_secret
      OIDC_ISSUER_URL: https://__ZITADEL_DOMAIN__
      OIDC_CLIENT_ID: __OIDC_CLIENT_ID__
      OIDC_AUDIENCE: __OIDC_CLIENT_ID__
    secrets:
      - rp_database_url
      - rp_encryption_key
      - rp_cookie_secret
      - rp_internal_worker_token
      - rp_oidc_client_secret
    networks:
      - rp-control
    deploy:
      replicas: __DR_RECONCILIATION_REPLICAS__ # RP_DR_RECONCILIATION_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.platform == true

  web:
    image: __WEB_IMAGE__
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "5173"
      RESOURCE_PORTAL_API_ORIGIN: http://api:3000
    networks:
      - rp-ingress
      - rp-web-api
    deploy:
      replicas: __WEB_REPLICAS__ # RP_WEB_REPLICAS
      placement:
        constraints:
          - node.role == manager
      labels:
        - traefik.enable=true
        - traefik.swarm.network=resourceportal-control-plane_rp-ingress
        - traefik.http.routers.resourceportal-web.rule=Host(`__DOMAIN__`)
        - traefik.http.routers.resourceportal-web.entrypoints=websecure
        - traefik.http.routers.resourceportal-web.tls=true
        - traefik.http.routers.resourceportal-web.tls.certresolver=__ACME_CERT_RESOLVER__
        - traefik.http.routers.resourceportal-web.tls.domains[0].main=__ZITADEL_DOMAIN__
        - traefik.http.routers.resourceportal-web.tls.domains[0].sans=__DOMAIN__
        - traefik.http.services.resourceportal-web.loadbalancer.server.port=5173
        - traefik.http.middlewares.rp-legacy-portal.redirectregex.regex=^https?://__LEGACY_DOMAIN_REGEX__/(.*)
        - traefik.http.middlewares.rp-legacy-portal.redirectregex.replacement=https://__DOMAIN__/$${1}
        - traefik.http.middlewares.rp-legacy-portal.redirectregex.permanent=true
        - traefik.http.routers.rp-legacy-portal-http.rule=Host(`__LEGACY_DOMAIN__`)
        - traefik.http.routers.rp-legacy-portal-http.entrypoints=web
        - traefik.http.routers.rp-legacy-portal-http.middlewares=rp-legacy-portal
        - traefik.http.routers.rp-legacy-portal-http.service=resourceportal-web
        - traefik.http.routers.rp-legacy-portal-https.rule=Host(`__LEGACY_DOMAIN__`)
        - traefik.http.routers.rp-legacy-portal-https.entrypoints=websecure
        - traefik.http.routers.rp-legacy-portal-https.tls=true
        - traefik.http.routers.rp-legacy-portal-https.tls.certresolver=__ACME_CERT_RESOLVER__
        - traefik.http.routers.rp-legacy-portal-https.middlewares=rp-legacy-portal
        - traefik.http.routers.rp-legacy-portal-https.service=resourceportal-web
        - traefik.http.middlewares.rp-legacy-auth.redirectregex.regex=^https?://__LEGACY_ZITADEL_DOMAIN_REGEX__/(.*)
        - traefik.http.middlewares.rp-legacy-auth.redirectregex.replacement=https://__ZITADEL_DOMAIN__/$${1}
        - traefik.http.middlewares.rp-legacy-auth.redirectregex.permanent=true
        - traefik.http.routers.rp-legacy-auth-http.rule=Host(`__LEGACY_ZITADEL_DOMAIN__`)
        - traefik.http.routers.rp-legacy-auth-http.entrypoints=web
        - traefik.http.routers.rp-legacy-auth-http.middlewares=rp-legacy-auth
        - traefik.http.routers.rp-legacy-auth-http.service=resourceportal-web
        - traefik.http.routers.rp-legacy-auth-https.rule=Host(`__LEGACY_ZITADEL_DOMAIN__`)
        - traefik.http.routers.rp-legacy-auth-https.entrypoints=websecure
        - traefik.http.routers.rp-legacy-auth-https.tls=true
        - traefik.http.routers.rp-legacy-auth-https.tls.certresolver=__ACME_CERT_RESOLVER__
        - traefik.http.routers.rp-legacy-auth-https.middlewares=rp-legacy-auth
        - traefik.http.routers.rp-legacy-auth-https.service=resourceportal-web
      restart_policy:
        condition: any

  egress-guard:
    image: __API_IMAGE__
    user: "0"
    cap_add:
      - NET_ADMIN
      - NET_RAW
    command: ["node", "dist/src/network-egress/egress-guard.runner.js"]
    environment:
      NODE_ENV: production
      EGRESS_GUARD_RECONCILE_INTERVAL_MS: "2000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - host
    deploy:
      mode: global
      restart_policy:
        condition: any
        delay: 2s

  traefik:
    image: __TRAEFIK_IMAGE__
    command:
      - --providers.swarm=true
      - --providers.swarm.endpoint=unix:///var/run/docker.sock
      - --providers.swarm.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.forwardedheaders.insecure=false
      - --entrypoints.websecure.address=:443
      - --entrypoints.websecure.forwardedheaders.insecure=false
      - --certificatesresolvers.__ACME_CERT_RESOLVER__.acme.email=__ACME_EMAIL__
      - --certificatesresolvers.__ACME_CERT_RESOLVER__.acme.caserver=__ACME_CA_SERVER__
      - --certificatesresolvers.__ACME_CERT_RESOLVER__.acme.storage=__ACME_STORAGE__
      - --certificatesresolvers.__ACME_CERT_RESOLVER__.acme.httpchallenge=true
      - --certificatesresolvers.__ACME_CERT_RESOLVER__.acme.httpchallenge.entrypoint=web
    ports:
      - target: 80
        published: 80
        protocol: tcp
        mode: ingress
      - target: 443
        published: 443
        protocol: tcp
        mode: ingress
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /mnt/resourceportal/platform/traefik:/platform/traefik
    networks:
      - rp-ingress
    deploy:
      replicas: __TRAEFIK_REPLICAS__ # RP_TRAEFIK_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.rp.node.ingress == true
          - node.labels.rp.node.storage == true
          - node.labels.resourceportal.storage.platform == true
      restart_policy:
        condition: any

configs:
  postgres_fence_script:
    file: /etc/resourceportal/postgres-fence.sh
  zitadel_public_config:
    file: /etc/resourceportal/zitadel-config.yaml
