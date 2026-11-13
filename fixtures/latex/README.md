# Fixtures LaTeX

Proyectos de ejemplo para probar el worker de compilación (`apps/compiler`). Cada carpeta es un proyecto
completo con `main.tex` como documento principal. Todos se compilaron con latexmk y generan PDF sin errores.

| Carpeta | Motor | Qué prueba | Resultado esperado |
|---|---|---|---|
| `articulo-simple` | pdfLaTeX | Caso base: `article`, babel en español, UTF-8, `amsmath`, `hyperref`. Las referencias cruzadas (`\ref`, `\eqref`) exigen una **segunda pasada**. | PDF de 1 página, sin `??` ni warnings de referencias sin definir |
| `con-bibliografia` | pdfLaTeX + **biber** | biblatex con `referencias.bib`. latexmk tiene que detectar que hace falta biber y volver a compilar. | PDF con 3 entradas en la bibliografía y citas resueltas (sin `[knuth1984]` en negrita) |
| `con-imagenes` | pdfLaTeX | `\includegraphics` de un **PNG** (raster) y un **PDF** (vectorial) dentro de `figuras/`, resueltos con `\graphicspath` y sin extensión explícita. Prueba que los archivos binarios del proyecto llegan al sandbox. | PDF de 1 página con las 2 figuras |
| `beamer` | pdfLaTeX | Clase `beamer` con el tema Madrid, overlays (`\item<2->`), bloques y columnas. | PDF de **5 páginas**: título + 3 pasos del overlay + columnas |
| `xelatex-fuentes` | **XeLaTeX** | `fontspec` y `unicode-math` con fuentes OpenType de TeX Live (TeX Gyre Pagella/Heros, Latin Modern Mono/Math), cargadas por nombre de archivo. Con pdfLaTeX falla. | PDF de 1 página con Unicode directo (`€`, `α`, `≤`) |
| `malicioso` | pdfLaTeX | Intentos de escapar del sandbox (ver abajo). | Compila, y **todos** los intentos dan `BLOQUEADO` |

## Elección del motor

El motor no se puede deducir solo del `.tex`. `xelatex-fuentes` lo declara con el comentario mágico
`% !TEX program = xelatex`, que es la convención de TeXShop, TeXstudio y Overleaf. El worker tiene que
elegir el motor según la configuración del proyecto o ese comentario, **nunca** a partir de un `latexmkrc`
del proyecto.

## `malicioso`

El documento compila siempre y, por cada intento de ataque, escribe una línea en el log:

```
LATEXWEB-SANDBOX: <intento>=BLOQUEADO
LATEXWEB-SANDBOX: <intento>=VULNERABLE
LATEXWEB-SANDBOX-INFO: <dato>=...        (informativo, no se evalúa)
...
LATEXWEB-SANDBOX: FIN
```

Un test de seguridad debe comprobar que aparece `FIN` (el documento se procesó entero), que las 5
claves de la tabla aparecen con `=BLOQUEADO` y que no hay **ninguna** línea con `=VULNERABLE`.

| Intento | Vector | Cómo se bloquea |
|---|---|---|
| `shell-escape-nivel` | Lee `\pdfshellescape`: 0 deshabilitado, 1 completo, 2 restringido. CLAUDE.md prohíbe incluso el modo restringido. | `-no-shell-escape` y `shell_escape=f` |
| `write18-ejecucion` | `\write18{echo PWNED > pwned-write18.txt}` | `-no-shell-escape` |
| `write18-etc-passwd` | `\write18{cat /etc/passwd > passwd-robado.txt}` | `-no-shell-escape` |
| `canario-entorno` | Lee `/proc/self/environ` y busca `LATEXWEB_CANARY`. El test de integración define esa variable en el entorno del **worker**: si aparece en el proceso de TeX, el contenedor está recibiendo el entorno del worker (y con él, cualquier secreto). | `docker run` solo pasa las variables de una lista blanca (`--env NOMBRE=valor`), nunca `--env-file` ni el entorno heredado |
| `latexmkrc-perl` | El archivo `latexmkrc` de la carpeta es **código Perl** que latexmk ejecuta si lo encuentra en el proyecto. Crea `pwned-latexmkrc.txt`. Funciona aunque shell-escape esté deshabilitado. | `latexmk -norc` (y el script de entrada rechaza `-r` y `-e`) |

Además, `LATEXWEB-SANDBOX-INFO: lectura-etc-passwd=LEIDO (...)` muestra que TeX **puede leer
cualquier archivo del contenedor**. Es lo esperado: desde TeX Live 2026, `openin_any` no tiene
efecto (`texmf.cnf`: "as of 2026, openin_any no longer has any effect"). El límite de seguridad es el
contenedor: sin red, con la raíz de solo lectura, sin secretos y montando solo `/in` y `/out` del
trabajo, así que no hay nada del host ni de otros trabajos que leer.

### Comprobado

- **MiKTeX en Windows** (al crear los fixtures): con `latexmk -norc -pdf -no-shell-escape` todo da
  `BLOQUEADO`. Para validar los detectores se probó el caso inseguro: sin `-norc`, `latexmkrc-perl` da
  `VULNERABLE`; con `-shell-escape`, los tres primeros dan `VULNERABLE`.
- **Imagen `latexweb-texlive:tl2026-1`** (paso 2 de `docs/specs/compilacion.md`): con los flags de
  `docker run` de la spec, las 5 claves dan `BLOQUEADO`. Reenviando la variable al contenedor
  (`--env LATEXWEB_CANARY`), `canario-entorno` da `VULNERABLE`.

### Ojo al manipular este fixture

No corras `latexmk` sin `-norc` dentro de `malicioso/`, porque ejecutaría el `latexmkrc`. Si aparecen
`pwned-*.txt` o `passwd-robado.txt` en esta carpeta, bórralos: no forman parte del fixture.
