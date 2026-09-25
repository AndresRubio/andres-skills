import unittest
from decimal import Decimal

from facturacion.api import resumen_factura


class TestFacturas(unittest.TestCase):
    def test_sin_descuento(self):
        r = resumen_factura({"cliente": "ACME", "lineas": [{"concepto": "Consultoría", "precio": "100.00"}]})
        self.assertEqual(r["total"], "121.00")

    def test_varias_lineas(self):
        r = resumen_factura({"cliente": "ACME", "lineas": [
            {"concepto": "Horas", "precio": "45.50", "cantidad": 3},
            {"concepto": "Licencia", "precio": "19.99"},
        ]})
        self.assertEqual(r["base"], "156.49")
        self.assertEqual(r["total"], "189.35")

    def test_con_descuento(self):
        # El descuento comercial reduce la base imponible (art. 78.Tres.2 LIVA)
        r = resumen_factura({"cliente": "ACME", "lineas": [{"concepto": "Consultoría", "precio": "100.00"}], "descuento": "10"})
        self.assertEqual(r["base"], "90.00")
        self.assertEqual(r["iva"], "18.90")
        self.assertEqual(r["total"], "108.90")
