#!/usr/bin/env bash
# Materializes the generated eval fixtures into evals/files/generated/ (gitignored).
#   generated/session/        short catalogo-api session with planted dysfunctions (eval 1)
#   generated/sesion-ventas/  446-line noisy session with planted dysfunctions (eval 4)
#   generated/long-session-truth.json  raw line numbers of every planted event (graders only)
#   generated/inventario-app/ git repo whose `integracion` branch hides a broken caller (eval 6)
#   generated/tienda-app/     git repo with a pre-existing failure and a policy that forbids the request (eval 8)
#   generated/clientes-app/   git repo whose CSV is short of the promised 500 rows and has 10 bad ones (eval 9)
#   generated/contacts-migrate/ git repo whose HANDOFF.md claims a verification that never passed (eval 10)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/generated"
rm -rf "$out" && mkdir -p "$out"
python3 "$here/make_session.py" "$out/session" > /dev/null
python3 "$here/make_long_session.py" "$out/sesion-ventas" "$out/long-session-truth.json"
(cd "$out" && bash "$here/make_inventario_repo.sh")
bash "$here/make_tienda_repo.sh" "$out"
bash "$here/make_clientes_repo.sh" "$out"
bash "$here/make_handoff_repo.sh" "$out"
echo "fixtures ready in $out"
