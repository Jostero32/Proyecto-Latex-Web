// Pistas en español para los mensajes más comunes del log de LaTeX. El mensaje original se muestra
// siempre; la pista solo acompaña. Todo se muestra como texto (nunca como HTML): viene del log.

type Hint = (match: RegExpMatchArray, message: string) => string;

/** Último comando (`\algo`) del mensaje: en "Undefined control sequence" es el que falló. */
function lastCommand(message: string): string | null {
  const commands = message.match(/\\[a-zA-Z@]+/g);
  return commands?.at(-1) ?? null;
}

const IMAGE = /\.(png|jpe?g|pdf|eps|svg|gif)$/i;

const HINTS: [RegExp, Hint][] = [
  [
    /Undefined control sequence/i,
    (_, message) => {
      const command = lastCommand(message.replace(/^.*?Undefined control sequence/i, ''));
      const what = command ? `el comando ${command}` : 'un comando';
      return `LaTeX no reconoce ${what}. Revisá si está bien escrito o si falta cargar con \\usepackage el paquete que lo define.`;
    },
  ],
  [
    /File [`'"]([^'"`]+)\.sty' not found/,
    (m) =>
      `No se encontró el paquete ${m[1]}. Revisá cómo está escrito el nombre. Si es un paquete propio, subí el archivo .sty al proyecto.`,
  ],
  [
    /File [`'"]([^'"`]+)' not found/,
    (m) =>
      IMAGE.test(m[1]!)
        ? `La imagen ${m[1]} no está en esa ruta. Revisá mayúsculas, carpetas y la extensión.`
        : `No se encontró el archivo ${m[1]}. Revisá la ruta y que esté subido al proyecto.`,
  ],
  [/Missing \$ inserted/, () => 'Un símbolo de fórmula quedó fuera de $...$, como _ o ^. Encerralo entre signos $.'],
  [/Missing \} inserted|Extra \}/, () => 'Una llave quedó sin cerrar, o sobra una. Contá las { y } cerca de esa línea.'],
  [/Environment (\S+) undefined/, (m) => `El entorno ${m[1]} no existe o falta cargar su paquete.`],
  [
    /Citation [`'"]([^'"`]+)'.*undefined/,
    (m) => `La clave ${m[1]} no está en el .bib, o falta compilar otra vez. Revisá que esté escrita igual en \\cite y en el .bib.`,
  ],
  [/There were undefined references/, () => 'Algunas referencias todavía no existen. Si recién las agregaste, compilá otra vez.'],
  [
    /Overfull \\hbox/,
    () => 'Una línea se sale del margen derecho. Suele pasar con URLs o palabras largas que LaTeX no sabe cortar.',
  ],
];

export function hintFor(message: string): string | null {
  for (const [pattern, hint] of HINTS) {
    const match = message.match(pattern);
    if (match) return hint(match, message);
  }
  return null;
}
