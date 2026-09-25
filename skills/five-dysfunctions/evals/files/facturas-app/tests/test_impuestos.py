import unittest
from decimal import Decimal

from facturacion.impuestos import calcular_iva, redondear


class TestImpuestos(unittest.TestCase):
    def test_iva_general(self):
        self.assertEqual(calcular_iva(Decimal("100")), Decimal("21.00"))

    def test_redondeo_mitad_arriba(self):
        self.assertEqual(redondear(Decimal("1.005")), Decimal("1.01"))
        self.assertEqual(redondear(Decimal("1.004")), Decimal("1.00"))

    def test_iva_con_centimos(self):
        self.assertEqual(calcular_iva(Decimal("19.99")), Decimal("4.20"))
