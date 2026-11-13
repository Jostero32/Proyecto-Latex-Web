# Imagen de compilación de latexweb: TeX Live 2026 completo + punto de entrada endurecido.
# Ver docs/specs/compilacion.md, sección "Ejecución en Docker".
# Construir con: pnpm --filter @latexweb/compiler image:build
#
# Base fijada por digest: índice multi-arquitectura de texlive/texlive:latest-full (TL2026, 2026-11-01).
# Para actualizar TeX Live: cambiar el digest y subir la versión del tag en apps/compiler/package.json.
FROM texlive/texlive:latest-full@sha256:07e8062637249c4f780ca59f42cc2ed592bc2dc1db4320769406aee3f98aa70e

# openout_any=p: TeX no escribe rutas absolutas, `..` ni dotfiles (verificado con kpsewhich -safe-out-name).
# shell_escape=f: deshabilitado del todo (la imagen base trae `p`, el modo restringido).
# openin_any: desde TL2026 NO tiene efecto (texmf.cnf: "as of 2026, openin_any no longer has any
#   effect"). TeX puede leer cualquier archivo del contenedor; el límite real es el aislamiento
#   del contenedor (solo los montajes del trabajo y sin secretos). Ver docs/specs/compilacion.md.
# PAR_GLOBAL_TEMP: biber es un binario PAR que se descomprime en el primer uso; lo dejamos
#   descomprimido en la imagen para no repetirlo en cada compilación (en ejecución /tmp es un
#   tmpfs vacío y noexec, donde además no podría cargar sus .so).
ENV openout_any=p \
    shell_escape=f \
    HOME=/tmp \
    PAR_GLOBAL_TEMP=/opt/latexweb/biber-par

COPY warmup-fonts.tex warmup-biber.tex /opt/latexweb/warmup/

# - Base de nombres de luaotfload y cachés por fuente (las de warmup-fonts.tex) en TEXMFSYSVAR,
#   que en ejecución es de solo lectura; las cachés de otras fuentes van a TEXMFVAR, en el tmpfs.
# - Caché de fontconfig para que XeTeX encuentre por nombre las fuentes de TeX Live.
# - biber descomprimido y legible por cualquier uid (el contenedor corre sin root). PAR extrae
#   las bibliotecas nativas (.so) recién cuando las carga, y en ejecución $PAR_GLOBAL_TEMP es
#   de solo lectura: por eso se ejecuta biber de forma amplia (bibliografía completa de ejemplo,
#   validación del .bcf con LibXML y conversión a biblatexml) para extraer las que usa en la
#   práctica. Además PAR abre $PAR_GLOBAL_TEMP/inc.lock para escribir en cada ejecución: lo
#   apuntamos al tmpfs.
RUN set -eux; \
    sysvar="$(kpsewhich -var-value TEXMFSYSVAR)"; \
    TEXMFVAR="$sysvar" luaotfload-tool --update --force; \
    cd /opt/latexweb/warmup; \
    TEXMFVAR="$sysvar" lualatex -interaction=nonstopmode warmup-fonts.tex > /dev/null; \
    cp "$(kpsewhich biblatex-examples.bib)" .; \
    pdflatex -interaction=nonstopmode warmup-biber.tex > /dev/null; \
    biber --validate-control warmup-biber; \
    biber --tool --output-format=biblatexml --output-file=warmup.bltxml biblatex-examples.bib; \
    cd /; rm -rf /opt/latexweb/warmup; \
    fc-cache -fs; \
    echo "bibliotecas nativas de biber extraídas: $(ls "$PAR_GLOBAL_TEMP" | grep -c '\.so')"; \
    rm -f "$PAR_GLOBAL_TEMP/inc.lock"; \
    ln -s /tmp/biber-par-inc.lock "$PAR_GLOBAL_TEMP/inc.lock"; \
    chmod -R a+rX "$PAR_GLOBAL_TEMP" "$sysvar"

COPY --chmod=0755 latexweb-compile.sh /usr/local/bin/latexweb-compile.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/latexweb-compile.sh"]
