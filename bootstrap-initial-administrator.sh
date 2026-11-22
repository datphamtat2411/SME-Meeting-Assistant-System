#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/services/api"

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 EMAIL DISPLAY_NAME [DISPLAY_NAME_WORD ...]" >&2
  exit 64
fi

email="$1"
shift
display_name="$*"

if [[ -z "$display_name" ]]; then
  echo "DISPLAY_NAME must not be blank" >&2
  exit 64
fi

# This command deliberately starts the dedicated non-web entry point.  It
# queues the normal single-use setup invitation; it never accepts a password
# and never prints or returns the raw setup token.
arguments="--app.initial-administrator-bootstrap.enabled=true"
arguments+=" --app.initial-administrator-bootstrap.confirmation=I_UNDERSTAND_INITIAL_ADMINISTRATOR_BOOTSTRAP"
arguments+=" --app.initial-administrator-bootstrap.email=${email}"
arguments+=" --app.initial-administrator-bootstrap.display-name=\"${display_name}\""
# The dedicated command is non-web. Keep the normal HTTP auth transport
# completely out of this context; ordinary Core retains its configured value.
arguments+=" --app.auth.transport.enabled=false"
arguments+=" --app.media.outbox.enabled=false"
arguments+=" --app.email.delivery.worker-enabled=false"
arguments+=" --app.transport.ai.probe=false"

# module_env gives inherited APP_* values precedence over the canonical file.
# Explicitly disable the normal HTTP transport in this non-web process so
# servlet-only authentication beans cannot be requested during bootstrap.
export APP_AUTH_TRANSPORT_ENABLED=false

exec python3 "$ROOT/scripts/module_env.py" core \
  --api-file "$ROOT/services/api/.env" \
  --postgres-file "$ROOT/infra/local/postgres/.env" \
  -- ./mvnw spring-boot:run \
  "-Dspring-boot.run.main-class=com.sme.meetingassistant.api.userorganization.bootstrap.InitialAdministratorBootstrapApplication" \
  "-Dspring-boot.run.arguments=${arguments}"
