version: "3.9"

networks:
  rp-control:
    driver: overlay
    attachable: false
  rp-ingress:
    driver: overlay
    attachable: false

secrets:
  rp_database_url:
    external: true
  rp_postgres_password:
    external: true
  zitadel_postgres_password:
    external: true
  zitadel_masterkey:
    external: true
  zitadel_secret_config:
    external: true
  zitadel_init_steps:
    external: true
  rp_encryption_key:
    external: true
  rp_cookie_secret:
    external: true
  rp_internal_worker_token:
    external: true
  rp_oidc_client_secret:
    external: true
    name: __OIDC_SWARM_REF__

volumes: {}

services:
  postgres-rp:
    image: __POSTGRES_IMAGE__
    environment:
      POSTGRES_DB: resource_portal
      POSTGRES_USER: resource_portal
      POSTGRES_PASSWORD_FILE: /run/secrets/rp_postgres_password
      PGDATA: /var/lib/postgresql/data/pgdata
    secrets:
      - rp_postgres_password
    volumes:
      - type: bind
        source: /mnt/resourceportal/platform/databases/resourceportal-postgres
        target: /var/lib/postgresql/data
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
          - node.labels.resourceportal.storage.platform == true
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.platform.postgres-rp-writer == true
      restart_policy:
        condition: on-failure

  postgres-zitadel:
    image: __POSTGRES_IMAGE__
    environment:
      POSTGRES_DB: zitadel
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD_FILE: /run/secrets/zitadel_postgres_password
      PGDATA: /var/lib/postgresql/data/pgdata
    secrets:
      - zitadel_postgres_password
    volumes:
      - type: bind
        source: /mnt/resourceportal/platform/databases/zitadel-postgres
        target: /var/lib/postgresql/data
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
          - node.labels.resourceportal.storage.platform == true
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.platform.postgres-zitadel-writer == true
      restart_policy:
        condition: on-failure

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
    networks:
      - rp-control
      - rp-ingress
    deploy:
      replicas: __ZITADEL_REPLICAS__ # RP_ZITADEL_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.resourceportal.storage.platform == true
      labels:
        - traefik.enable=true
        - traefik.http.routers.resourceportal-zitadel.rule=Host(`__ZITADEL_DOMAIN__`)
        - traefik.http.routers.resourceportal-zitadel.entrypoints=websecure
        - traefik.http.routers.resourceportal-zitadel.tls=true
        - traefik.http.routers.resourceportal-zitadel.tls.certresolver=letsencrypt
        - traefik.http.services.resourceportal-zitadel.loadbalancer.server.port=8080
      restart_policy:
        condition: on-failure

  api:
    image: __API_IMAGE__
    environment:
      NODE_ENV: production
      PORT: "3000"
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
      OIDC_PROVIDER_TYPE: zitadel
      OIDC_REDIRECT_URI: https://__DOMAIN__/api/auth/callback
      OIDC_POST_LOGOUT_REDIRECT_URI: https://__DOMAIN__/api/auth/logout/callback
      PLATFORM_ADMIN_USER_IDS: __PLATFORM_ADMIN_IDS__
      RESOURCE_STORAGE_BASE_PATH: __STORAGE_BASE_PATH__
      RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes
      RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets
      RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform
    secrets:
      - rp_database_url
      - rp_encryption_key
      - rp_cookie_secret
      - rp_internal_worker_token
      - rp_oidc_client_secret
    volumes:
      - type: bind
        source: __STORAGE_BASE_PATH__
        target: __STORAGE_BASE_PATH__
        read_only: false
      - type: bind
        source: /mnt/resourceportal/volumes
        target: /mnt/resourceportal/volumes
        read_only: false
      - type: bind
        source: /mnt/resourceportal/secrets
        target: /mnt/resourceportal/secrets
        read_only: false
      - type: bind
        source: /mnt/resourceportal/platform
        target: /mnt/resourceportal/platform
        read_only: true
    networks:
      - rp-control
      - rp-ingress
    deploy:
      replicas: __API_REPLICAS__ # RP_API_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.storage.secrets == true
      restart_policy:
        condition: on-failure

  deployment-worker:
    image: __API_IMAGE__
    command: ["node", "dist/src/internal/deployment-worker.runner.js"]
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
      RESOURCE_STORAGE_BASE_PATH: __STORAGE_BASE_PATH__
      RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes
      RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets
      RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform
      WORKER_ID: production-deployment-worker
    secrets:
      - rp_database_url
      - rp_encryption_key
      - rp_cookie_secret
      - rp_internal_worker_token
      - rp_oidc_client_secret
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/resourceportal/volumes:/mnt/resourceportal/volumes
      - /mnt/resourceportal/secrets:/mnt/resourceportal/secrets
      - __STORAGE_BASE_PATH__:__STORAGE_BASE_PATH__
    networks:
      - rp-control
    deploy:
      replicas: __DEPLOYMENT_WORKER_REPLICAS__ # RP_DEPLOYMENT_WORKER_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.storage.volumes == true
          - node.labels.resourceportal.storage.secrets == true
      restart_policy:
        condition: on-failure

  operation-worker:
    image: __API_IMAGE__
    user: "0"
    command: ["node", "dist/src/operations/operation-worker.runner.js"]
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
      RESOURCE_STORAGE_BASE_PATH: __STORAGE_BASE_PATH__
      RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes
      RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets
      RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform
      OPERATION_WORKER_ID: production-operation-worker
    secrets:
      - rp_database_url
      - rp_encryption_key
      - rp_cookie_secret
      - rp_internal_worker_token
      - rp_oidc_client_secret
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - __STORAGE_BASE_PATH__:__STORAGE_BASE_PATH__
      - /mnt/resourceportal/volumes:/mnt/resourceportal/volumes
    networks:
      - rp-control
    deploy:
      replicas: __OPERATION_WORKER_REPLICAS__ # RP_OPERATION_WORKER_REPLICAS
      placement:
        constraints:
          - node.role == manager
          - node.labels.resourceportal.storage.authoritative == true
          - node.labels.resourceportal.storage.volumes == true
      restart_policy:
        condition: on-failure

  dr-reconciliation:
    image: __API_IMAGE__
    command: ["node", "dist/src/disaster-recovery/disaster-recovery.runner.js"]
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
    deploy:
      replicas: __WEB_REPLICAS__ # RP_WEB_REPLICAS
      placement:
        constraints:
          - node.role == manager
      labels:
        - traefik.enable=true
        - traefik.http.routers.resourceportal-web.rule=Host(`__DOMAIN__`)
        - traefik.http.routers.resourceportal-web.entrypoints=websecure
        - traefik.http.routers.resourceportal-web.tls=true
        - traefik.http.routers.resourceportal-web.tls.certresolver=letsencrypt
        - traefik.http.services.resourceportal-web.loadbalancer.server.port=5173
      restart_policy:
        condition: on-failure

  traefik:
    image: __TRAEFIK_IMAGE__
    command:
      - --providers.swarm=true
      - --providers.swarm.endpoint=unix:///var/run/docker.sock
      - --providers.swarm.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=__ACME_EMAIL__
      - --certificatesresolvers.letsencrypt.acme.storage=/platform/traefik/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
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
          - node.labels.resourceportal.ingress == true
          - node.labels.resourceportal.storage.platform == true
      restart_policy:
        condition: on-failure

configs:
  zitadel_public_config:
    file: /etc/resourceportal/zitadel-config.yaml
