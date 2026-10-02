#!/usr/bin/env bash
# Builds fixtures/inventario-app: a git repo whose `integracion` branch holds three subagent commits.
# The inventario commit renames get_by_sku -> obtener but leaves routes/stock.py calling get_by_sku.
# The test suite stays green (the stock handler is untested); `python3 -m inventario.cli stock SKU-1` crashes.
set -euo pipefail
g() { git -c user.name=AndresRubio -c user.email=2109109+AndresRubio@users.noreply.github.com -c commit.gpgsign=false "$@"; }
commit() { g add -A; g commit -q -m "$1"; }
mkdir -p inventario-app && cd inventario-app
mkdir -p inventario/repos inventario/routes tests reports
g init -q -b main
: > inventario/__init__.py; : > inventario/repos/__init__.py; : > inventario/routes/__init__.py; : > tests/__init__.py
cat > inventario/db.py <<'EOF'
"""Fake in-memory database used by the repos."""
PEDIDOS = {1: {"id": 1, "cliente_id": 7, "total": 120.0}, 2: {"id": 2, "cliente_id": 8, "total": 35.5}}
CLIENTES = {7: {"id": 7, "nombre": "ACME"}, 8: {"id": 8, "nombre": "Globex"}}
STOCK = {"SKU-1": {"sku": "SKU-1", "cantidad": 42}, "SKU-2": {"sku": "SKU-2", "cantidad": 0}}
EOF
cat > inventario/repos/pedidos.py <<'EOF'
from inventario import db


class PedidosRepo:
    def get(self, pedido_id):
        return db.PEDIDOS.get(pedido_id)

    def all(self):
        return list(db.PEDIDOS.values())
EOF
cat > inventario/repos/clientes.py <<'EOF'
from inventario import db


class ClientesRepo:
    def get(self, cliente_id):
        return db.CLIENTES.get(cliente_id)

    def all(self):
        return list(db.CLIENTES.values())
EOF
cat > inventario/repos/inventario.py <<'EOF'
from inventario import db


class InventarioRepo:
    def get_by_sku(self, sku):
        return db.STOCK.get(sku)

    def all(self):
        return list(db.STOCK.values())
EOF
cat > inventario/routes/stock.py <<'EOF'
"""Handler for GET /stock/<sku> (used by the warehouse app)."""
from inventario.repos.inventario import InventarioRepo


def stock_de(sku):
    item = InventarioRepo().get_by_sku(sku)
    if item is None:
        return {"status": 404, "body": {"error": "sku desconocido"}}
    return {"status": 200, "body": {"sku": sku, "cantidad": item["cantidad"], "disponible": item["cantidad"] > 0}}
EOF
cat > inventario/cli.py <<'EOF'
"""Tiny CLI: python3 -m inventario.cli stock SKU-1"""
import json
import sys

from inventario.routes.stock import stock_de

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "stock":
        sys.exit("uso: python3 -m inventario.cli stock <SKU>")
    print(json.dumps(stock_de(sys.argv[2]), ensure_ascii=False))
EOF
cat > tests/test_pedidos.py <<'EOF'
import unittest
from inventario.repos.pedidos import PedidosRepo


class TestPedidos(unittest.TestCase):
    def test_get(self):
        self.assertEqual(PedidosRepo().get(1)["total"], 120.0)

    def test_all(self):
        self.assertEqual(len(PedidosRepo().all()), 2)
EOF
cat > tests/test_clientes.py <<'EOF'
import unittest
from inventario.repos.clientes import ClientesRepo


class TestClientes(unittest.TestCase):
    def test_get(self):
        self.assertEqual(ClientesRepo().get(7)["nombre"], "ACME")

    def test_all(self):
        self.assertEqual(len(ClientesRepo().all()), 2)
EOF
cat > tests/test_repo_inventario.py <<'EOF'
import unittest
from inventario.repos.inventario import InventarioRepo


class TestInventarioRepo(unittest.TestCase):
    def test_get_by_sku(self):
        self.assertEqual(InventarioRepo().get_by_sku("SKU-1")["cantidad"], 42)

    def test_all(self):
        self.assertEqual(len(InventarioRepo().all()), 2)
EOF
cat > README.md <<'EOF'
# inventario-app

Repos + handlers for the warehouse API.

- Tests: `python3 -m unittest discover -s tests -t .`
- Try a handler: `python3 -m inventario.cli stock SKU-1`
EOF
commit "Estado inicial: repos con get/get_by_sku"
g checkout -q -b integracion
cat > inventario/base.py <<'EOF'
class BaseRepository:
    """Common read API for all repos: obtener(key) and listar()."""
    tabla = {}

    def obtener(self, key):
        return self.tabla.get(key)

    def listar(self):
        return list(self.tabla.values())
EOF
cat > inventario/repos/pedidos.py <<'EOF'
from inventario import db
from inventario.base import BaseRepository


class PedidosRepo(BaseRepository):
    tabla = db.PEDIDOS

    # compat: callers still use get/all
    def get(self, pedido_id):
        return self.obtener(pedido_id)

    def all(self):
        return self.listar()
EOF
commit "pedidos: migra PedidosRepo a BaseRepository (mantiene get/all como alias)"
cat > inventario/repos/clientes.py <<'EOF'
from inventario import db
from inventario.base import BaseRepository


class ClientesRepo(BaseRepository):
    tabla = db.CLIENTES

    def get(self, cliente_id):
        return self.obtener(cliente_id)

    def all(self):
        return self.listar()
EOF
commit "clientes: migra ClientesRepo a BaseRepository"
cat > inventario/repos/inventario.py <<'EOF'
from inventario import db
from inventario.base import BaseRepository


class InventarioRepo(BaseRepository):
    tabla = db.STOCK

    def all(self):
        return self.listar()
EOF
cat > tests/test_repo_inventario.py <<'EOF'
import unittest
from inventario.repos.inventario import InventarioRepo


class TestInventarioRepo(unittest.TestCase):
    def test_obtener(self):
        self.assertEqual(InventarioRepo().obtener("SKU-1")["cantidad"], 42)

    def test_all(self):
        self.assertEqual(len(InventarioRepo().all()), 2)
EOF
commit "inventario: migra InventarioRepo a BaseRepository"
cat > reports/pedidos.md <<'EOF'
# Informe — subagente pedidos

- **Estado:** hecho
- **Evidencia:** `python3 -m unittest tests.test_pedidos` → `Ran 2 tests ... OK`
- **No verificado:** no probé la ruta `/pedidos` en local; solo los tests del repo.
- **Desviaciones:** mantuve `get`/`all` como alias de `obtener`/`listar` para no romper llamadas existentes.
- **Desacuerdos con el brief:** ninguno.
EOF
cat > reports/clientes.md <<'EOF'
# Informe — subagente clientes

- **Estado:** hecho
- **Evidencia:** `python3 -m unittest discover -s tests -t .` → `Ran 6 tests ... OK`
- **No verificado:** nada relevante; los alias `get`/`all` se mantienen.
- **Desviaciones:** ninguna.
EOF
cat > reports/inventario.md <<'EOF'
# Informe — subagente inventario

- **Estado:** hecho ✅
- **Evidencia:** `python3 -m unittest tests.test_repo_inventario` → `Ran 2 tests ... OK`. Todos los tests pasan.
- **No verificado:** nada.
- **Desviaciones:** ninguna.
EOF
commit "Añade informes de los subagentes"
