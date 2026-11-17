#!/bin/sh
# Punto de entrada del contenedor de compilación de latexweb.
# Ver docs/specs/compilacion.md, sección "Ejecución en Docker".
#
# Uso (lo arma el worker; ver apps/compiler/src/docker-args.ts):
#   latexweb-compile.sh -norc -no-shell-escape -interaction=nonstopmode -file-line-error \
#                       -jobname=output <-pdf|-pdfxe|-pdflua> <mainFile>
#
# - /in   proyecto del usuario (solo lectura)
# - /work tmpfs de tamaño fijo donde se compila
# - /out  destino de output.pdf y output.log
#
# Código de salida: el de latexmk (0 ok, 12 error de LaTeX…), 124 si se agotó
# LATEXWEB_TIMEOUT, 137 si hubo que matarlo con KILL, 2 si los argumentos son inválidos.
set -eu

# Defensa en profundidad: estos valores también están en la imagen y en el docker run.
# (openin_any no se fija: desde TL2026 no tiene efecto; ver el Dockerfile.)
export openout_any=p shell_escape=f

fail() {
  echo "latexweb-compile: $*" >&2
  exit 2
}

timeout_s="${LATEXWEB_TIMEOUT:-60}"
case "$timeout_s" in
  '' | *[!0-9]*) fail "LATEXWEB_TIMEOUT inválido: '$timeout_s'" ;;
esac

[ "$#" -ge 1 ] || fail "falta el documento principal"

# Solo se aceptan exactamente las opciones que arma el worker. Nunca -e, -r ni
# nada que habilite shell-escape o cambie los comandos que latexmk ejecuta.
engine=''
main=''
while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  case "$arg" in
    -norc | -no-shell-escape | -interaction=nonstopmode | -file-line-error | -jobname=output) ;;
    -pdf | -pdfxe | -pdflua)
      [ -z "$engine" ] || fail "motor repetido: $arg"
      engine="$arg"
      ;;
    -*) fail "opción no permitida: $arg" ;;
    *)
      [ "$#" -eq 0 ] || fail "el documento principal debe ser el último argumento"
      main="$arg"
      ;;
  esac
done

[ -n "$engine" ] || fail "falta el motor (-pdf, -pdfxe o -pdflua)"
[ -n "$main" ] || fail "falta el documento principal"

# Mismo criterio que isValidMainFile (packages/shared/src/project-paths.ts): ASCII sin
# metacaracteres de shell, ningún segmento empieza con '-' o '.', y termina en .tex.
case "$main" in
  *[!A-Za-z0-9._/-]* | -* | */-* | .* | */.* | /* | *//* | */) fail "documento principal inválido: '$main'" ;;
  *.tex) ;;
  *) fail "el documento principal debe terminar en .tex: '$main'" ;;
esac

cp -R /in/. /work/
cd /work

# luaotfload solo busca su base de nombres de fuentes en TEXMFVAR (aquí, el tmpfs vacío) y si no
# la encuentra la regenera, lo que cuesta ~5 s por compilación. Copiamos la precalculada en la
# imagen (~700 KB); queda escribible por si luaotfload necesita actualizarla.
if [ "$engine" = -pdflua ]; then
  names_dir=luatex-cache/generic/names
  mkdir -p "$(kpsewhich -var-value TEXMFVAR)/$names_dir"
  cp "$(kpsewhich -var-value TEXMFSYSVAR)/$names_dir"/* "$(kpsewhich -var-value TEXMFVAR)/$names_dir/"
fi

# /out (montaje del host o del volumen) sin escritura mientras compila: openout_any=p solo frena a
# TeX, no a Lua (io.open de lualatex) ni a biber. Quitarle el permiso al propio dueño impide crear
# archivos ahí; ninguna herramienta de la compilación puede devolverlo (no hay chmod en Lua, sin
# shell-escape no se ejecutan comandos, y el contenedor no tiene capacidades). En un bind mount de
# Docker Desktop en Windows chmod puede no tener efecto: ahí el límite es --ulimit fsize.
chmod 0500 /out 2>/dev/null || echo "latexweb-compile: aviso: no se pudo quitar la escritura de /out" >&2

status=0
timeout -k 5 "$timeout_s" \
  latexmk -norc -no-shell-escape -interaction=nonstopmode -file-line-error -jobname=output \
  "$engine" "$main" || status=$?

chmod 0700 /out 2>/dev/null || true
# Se publican solo archivos regulares (nunca symlinks) aunque la compilación haya fallado,
# para que el usuario pueda leer el log.
for artifact in output.pdf output.log; do
  if [ -f "$artifact" ] && [ ! -L "$artifact" ]; then
    cp "$artifact" "/out/$artifact"
  fi
done

exit "$status"
