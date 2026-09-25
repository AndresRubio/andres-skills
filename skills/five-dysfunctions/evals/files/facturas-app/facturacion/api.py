"""Capa que usa el endpoint GET /facturas/{id}/total."""
from decimal import Decimal

from .facturas import Factura, Linea, total_factura


def resumen_factura(datos: dict) -> dict:
    factura = Factura(
        cliente=datos["cliente"],
        lineas=[Linea(l["concepto"], Decimal(str(l["precio"])), l.get("cantidad", 1)) for l in datos["lineas"]],
        descuento=Decimal(str(datos.get("descuento", 0))),
    )
    r = total_factura(factura)
    return {k: str(v) for k, v in r.items()}
