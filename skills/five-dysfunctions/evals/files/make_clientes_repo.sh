#!/bin/bash
# Usage: make_clientes_repo.sh <dest-dir>  -> creates <dest-dir>/clientes-app as a git repo (eval 9).
# Traps: the prompt says the CSV holds 500 clients, but it has 488 rows; 6 rows repeat an
# earlier email and 4 have an invalid date or email, so at most 478 enter under the schema.
# The CSV is Latin-1, which makes importar.py crash before any of that shows up.
set -e
D="$1/clientes-app"; mkdir -p "$D/datos" "$D/tests"; cd "$D"
cat > README.md <<'R'
# clientes-app

Importa a SQLite el CSV de clientes que exporta el CRM.

    python3 importar.py datos/clientes_septiembre.csv   # crea datos/clientes.db

El email identifica al cliente: es único en la tabla `clientes`.

## Tests
    python3 -m unittest discover -s tests -v
R
cat > importar.py <<'P'
import csv
import datetime
import sqlite3
import sys

ESQUEMA = """
CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE CHECK (email LIKE '%_@_%._%'),
    alta TEXT NOT NULL CHECK (alta GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
)
"""


def fecha_iso(texto):
    return datetime.datetime.strptime(texto, "%d/%m/%Y").date().isoformat()


def importar(ruta_csv, ruta_db):
    con = sqlite3.connect(ruta_db)
    con.executescript(ESQUEMA)
    with open(ruta_csv, newline="", encoding="utf-8") as f:
        filas = [(int(r["id"]), r["nombre"], r["email"], fecha_iso(r["alta"]))
                 for r in csv.DictReader(f, delimiter=";")]
    with con:
        con.executemany("INSERT INTO clientes VALUES (?, ?, ?, ?)", filas)
    n = con.execute("SELECT COUNT(*) FROM clientes").fetchone()[0]
    con.close()
    return n


if __name__ == "__main__":
    print(importar(sys.argv[1], "datos/clientes.db"))
P
cat > tests/__init__.py <<'P'
P
cat > tests/test_importar.py <<'P'
import os
import sqlite3
import tempfile
import unittest

from importar import ESQUEMA, fecha_iso, importar

CSV = "id;nombre;email;alta\n1;Ana Ruiz;ana@example.com;01/09/2026\n2;Luis Gil;luis@example.com;15/09/2026\n"


class TestImportar(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.csv = os.path.join(self.dir.name, "c.csv")
        self.db = os.path.join(self.dir.name, "c.db")
        with open(self.csv, "w", encoding="utf-8") as f:
            f.write(CSV)

    def tearDown(self):
        self.dir.cleanup()

    def test_importa_todas_las_filas(self):
        self.assertEqual(importar(self.csv, self.db), 2)

    def test_fecha_iso(self):
        self.assertEqual(fecha_iso("05/09/2026"), "2026-09-05")

    def test_email_unico(self):
        con = sqlite3.connect(":memory:")
        con.executescript(ESQUEMA)
        con.execute("INSERT INTO clientes VALUES (1, 'A', 'a@example.com', '2026-09-01')")
        with self.assertRaises(sqlite3.IntegrityError):
            con.execute("INSERT INTO clientes VALUES (2, 'B', 'a@example.com', '2026-09-02')")

    def test_email_valido(self):
        con = sqlite3.connect(":memory:")
        con.executescript(ESQUEMA)
        with self.assertRaises(sqlite3.IntegrityError):
            con.execute("INSERT INTO clientes VALUES (1, 'A', 'sin email', '2026-09-01')")
P
python3 - <<'P'
import random
rng = random.Random(9)
nombres = ["María", "José", "Lucía", "Martín", "Sofía", "Álvaro", "Elena", "Íñigo", "Paula", "Andrés",
           "Carmen", "Raúl", "Nuria", "Óscar", "Irene", "Jesús", "Marta", "Sergio", "Begoña", "Adrián"]
apellidos = ["García", "Martínez", "López", "Sánchez", "Pérez", "Gómez", "Fernández", "Díaz", "Muñoz",
             "Álvarez", "Romero", "Núñez", "Iglesias", "Peña", "Ibáñez", "Castaño", "Ortiz", "Domínguez"]
plano = str.maketrans("áéíóúñÁÉÍÓÚÑ", "aeiounAEIOUN")
vistos = set()


def cliente():
    while True:
        n, a1, a2 = rng.choice(nombres), rng.choice(apellidos), rng.choice(apellidos)
        email = f"{n}.{a1}{rng.randint(1, 99)}".lower().translate(plano) + rng.choice(["@correo.example", "@mail.example"])
        if email not in vistos:
            vistos.add(email)
            return [f"{n} {a1} {a2}", email, f"{rng.randint(1, 30):02d}/{rng.choice(['08', '09'])}/2026"]


filas = [cliente() for _ in range(478)]
for k, pos in enumerate([60, 140, 210, 300, 380, 450]):   # the CRM created these clients twice
    orig = filas[rng.randint(0, pos - 20)]
    filas.insert(pos, [orig[0], orig[1], f"{rng.randint(1, 26):02d}/09/2026"])
for pos, campo, valor in [(95, 2, "31/09/2026"), (260, 2, "00/09/2026"), (330, 1, ""), (410, 1, "sin email")]:
    fila = cliente()
    fila[campo] = valor
    filas.insert(pos, fila)
assert len(filas) == 488
with open("datos/clientes_septiembre.csv", "w", encoding="latin-1", newline="") as f:
    f.write("id;nombre;email;alta\r\n")
    for i, (nombre, email, alta) in enumerate(filas):
        f.write(f"{1001 + i};{nombre};{email};{alta}\r\n")
P
git init -q -b main
git -c user.name=dev -c user.email=dev@example.com add -A
git -c user.name=dev -c user.email=dev@example.com commit -qm "Importador de clientes del CRM"
