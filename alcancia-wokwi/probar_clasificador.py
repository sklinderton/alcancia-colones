"""Mide cuánto ruido de la balanza tolera clasificar() de sketch.ino."""
import random

PESOS = {10: 2.43, 25: 4.30, 50: 5.54, 100: 8.30, 500: 10.50}
TOLERANCIA_GRAMOS = 0.50
INTENTOS = 100_000


def clasificar(peso):
    for valor, peso_oficial in PESOS.items():
        if abs(peso - peso_oficial) <= TOLERANCIA_GRAMOS:
            return valor
    return None


def main():
    random.seed(1)
    print("ruido_g  correctas  devueltas  mal_contadas")
    for desviacion in (0.05, 0.10, 0.15, 0.20, 0.30, 0.40):
        correctas = devueltas = mal_contadas = 0
        for valor, peso in PESOS.items():
            for _ in range(INTENTOS):
                resultado = clasificar(random.gauss(peso, desviacion))
                if resultado == valor:
                    correctas += 1
                elif resultado is None:
                    devueltas += 1
                else:
                    mal_contadas += 1
        total = INTENTOS * len(PESOS)
        print(f"{desviacion:.2f}     {correctas / total:8.3%}  {devueltas / total:8.3%}  {mal_contadas / total:8.4%}")

    print("\nCasos límite")
    for nombre, peso in (("dos de 25", 8.60), ("dos de 10", 4.86), ("objeto 7 g", 7.00), ("10 + 25", 6.73), ("vacío", 0.0)):
        print(f"{nombre:12} {peso:5.2f} g -> {clasificar(peso)}")


if __name__ == "__main__":
    main()
