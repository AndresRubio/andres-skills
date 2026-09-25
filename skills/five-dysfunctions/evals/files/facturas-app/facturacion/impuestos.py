from decimal import Decimal, ROUND_HALF_UP

IVA_GENERAL = Decimal("0.21")
IVA_REDUCIDO = Decimal("0.10")


def redondear(importe: Decimal) -> Decimal:
    """Redondeo a céntimos, mitad hacia arriba (criterio AEAT)."""
    return importe.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calcular_iva(base: Decimal, tipo: Decimal = IVA_GENERAL) -> Decimal:
    return redondear(base * tipo)
