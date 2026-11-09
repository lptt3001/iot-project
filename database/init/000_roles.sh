#!/bin/sh
(
set -eu
# Secrets go through environment and psql quoting, never process arguments.
export DB_APP_PASSWORD="$(tr -d '\r\n' < /run/secrets/db_app_password)"
export DB_INGEST_PASSWORD="$(tr -d '\r\n' < /run/secrets/db_ingest_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password DB_APP_PASSWORD
\getenv ingest_password DB_INGEST_PASSWORD
SELECT format('CREATE ROLE iot_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE iot_ingest LOGIN PASSWORD %L', :'ingest_password') \gexec
REVOKE ALL ON DATABASE iot FROM PUBLIC;
GRANT CONNECT ON DATABASE iot TO iot_app, iot_ingest;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
unset DB_APP_PASSWORD DB_INGEST_PASSWORD
)
