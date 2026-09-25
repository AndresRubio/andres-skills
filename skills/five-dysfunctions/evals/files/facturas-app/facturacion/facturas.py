from dataclasses import dataclass, field
from decimal import Decimal

from .impuestos import calcular_iva, redondear


@dataclass
class Linea:
    concepto: str
    precio_unitario: Decimal
    cantidad: int = 1


@dataclass
class Factura:
    cliente: str
    lineas: list[Linea] = field(default_factory=list)
    descuento: Decimal = Decimal("0")  # descuento comercial en euros


def base_imponible(factura: Factura) -> Decimal:
    return redondear(sum((l.precio_unitario * l.cantidad for l in factura.lineas), Decimal("0")))


def total_factura(factura: Factura) -> dict:
    base = base_imponible(factura)
    iva = calcular_iva(base)
    total = base + iva - factura.descuento
    return {"base": base, "iva": iva, "descuento": factura.descuento, "total": redondear(total)}
