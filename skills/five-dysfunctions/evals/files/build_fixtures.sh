#!/usr/bin/env bash
# Materializes the generated eval fixtures into evals/files/generated/ (gitignored).
#   generated/session/        short catalogo-api session with planted dysfunctions (eval 1)
#   generated/sesion-ventas/  446-line noisy session with planted dysfunctions (eval 4)
#   generated/long-session-truth.json  raw line numbers of every planted event (graders only)
#   generated/inventario-app/ git repo whose `integracion` branch hides a broken caller (eval 6)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/generated"
rm -rf "$out" && mkdir -p "$out"
python3 "$here/make_session.py" "$out/session" > /dev/null
python3 "$here/make_long_session.py" "$out/sesion-ventas" "$out/long-session-truth.json"
(cd "$out" && bash "$here/make_inventario_repo.sh")
echo "fixtures ready in $out"
