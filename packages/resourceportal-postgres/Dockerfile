FROM postgres:17-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY packages/resourceportal-postgres/postgres-fence.sh /usr/local/bin/resourceportal-postgres-fence
RUN chmod 0755 /usr/local/bin/resourceportal-postgres-fence
