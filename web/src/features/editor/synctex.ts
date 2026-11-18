// SyncTeX en el navegador: lee `output.synctex.gz` y une el código con el PDF en los dos sentidos.
//
// El archivo es texto: un preámbulo (`Input:<tag>:<ruta>`, `Unit`, `Magnification`, offsets) y, por
// página (`{n` … `}n`), las cajas que armó TeX: `[`/`]` vertical, `(`/`)` horizontal, `h`/`v` vacías, y
// puntos sueltos (`x` posición, `k` kern, `g` glue, `$` matemática). Cada registro trae `tag,línea` del
// archivo de origen y la posición en unidades de TeX (sp), con el origen arriba a la izquierda y la y
// hacia abajo, igual que el PDF dibujado en pantalla.
//
// Las cajas de un renglón llevan la línea donde terminó el párrafo; los puntos llevan la línea real de
// cada pedazo. Por eso: código → PDF busca los puntos de la línea y marca el renglón que los contiene;
// PDF → código busca el renglón bajo el clic y, dentro, el punto más cercano.

/** Puntos de TeX (sp) por punto PostScript (bp, la unidad del PDF). */
const SP_PER_BP = 65781.76;

export interface SyncRect {
  /** Página, desde 1. */
  page: number;
  /** En puntos del PDF desde la esquina superior izquierda. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SyncNode {
  tag: number;
  line: number;
  page: number;
  /** Caja horizontal (un renglón o parte), o un punto. */
  box: boolean;
  x: number;
  /** Línea de base. */
  y: number;
  width: number;
  height: number;
  depth: number;
  /** Índice de la caja horizontal que lo contiene, o -1. */
  parent: number;
}

export interface SyncTex {
  /** tag → ruta del proyecto (solo las entradas que son archivos del proyecto). */
  files: Map<number, string>;
  nodes: SyncNode[];
}

const RECORD = /^([[(hvxkg$])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

/**
 * Lee el texto de un .synctex. `projectPaths` son las rutas del proyecto y `mainFile` el documento
 * principal: la primera entrada es siempre ese archivo, y lo que la precede en su ruta es la carpeta
 * donde se compiló (`/work/./`).
 */
export function parseSynctex(text: string, projectPaths: readonly string[], mainFile: string): SyncTex {
  let unit = 1;
  let magnification = 1;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;
  let root: string | null = null;
  const inputs = new Map<number, string>();
  const nodes: SyncNode[] = [];
  const stack: number[] = [];
  const toBp = (value: number) => (value * unit * magnification) / SP_PER_BP;

  for (const line of text.split('\n')) {
    const first = line[0];
    if (first === 'I' && line.startsWith('Input:')) {
      const rest = line.slice(6);
      const colon = rest.indexOf(':');
      const tag = Number(rest.slice(0, colon));
      const path = normalize(rest.slice(colon + 1).trimEnd());
      if (root === null) root = path.endsWith(`/${mainFile}`) ? path.slice(0, path.length - mainFile.length) : '';
      inputs.set(tag, path);
    } else if (first === '{') {
      page = Number(line.slice(1));
      stack.length = 0;
    } else if (first === '}') {
      page = 0;
    } else if (first === ')' || first === ']') {
      stack.pop();
    } else if (page > 0 && first !== undefined && '[(hvxkg$'.includes(first)) {
      const match = RECORD.exec(line);
      if (!match) continue;
      const [, kind, tag, lineNo, x, y, width, height, depth] = match;
      const isHbox = kind === '(' || kind === 'h';
      const parent = stack.at(-1) ?? -1;
      // Las cajas verticales solo cuentan para cerrar el anidamiento: no marcan un renglón.
      if (kind === '[') {
        stack.push(-1);
        continue;
      }
      const index = nodes.length;
      nodes.push({
        tag: Number(tag),
        line: Number(lineNo),
        page,
        box: isHbox,
        x: toBp(Number(x)) + xOffset,
        y: toBp(Number(y)) + yOffset,
        width: isHbox ? toBp(Math.abs(Number(width ?? 0))) : 0,
        height: isHbox ? toBp(Number(height ?? 0)) : 0,
        depth: isHbox ? toBp(Number(depth ?? 0)) : 0,
        parent,
      });
      if (kind === '(') stack.push(index);
    } else if (page === 0) {
      const [key, value] = splitHeader(line);
      if (key === 'Unit') unit = Number(value) || 1;
      else if (key === 'Magnification') magnification = (Number(value) || 1000) / 1000;
      else if (key === 'X Offset') xOffset = toBp(Number(value) || 0);
      else if (key === 'Y Offset') yOffset = toBp(Number(value) || 0);
    }
  }

  const files = new Map<number, string>();
  const known = new Set(projectPaths);
  for (const [tag, path] of inputs) {
    const relative = root && path.startsWith(root) ? path.slice(root.length) : bySuffix(path, projectPaths);
    if (relative && known.has(relative)) files.set(tag, relative);
  }
  return { files, nodes };
}

/** Código → PDF: los renglones de esa línea (o de la más cercana que haya salido en el PDF). */
export function forwardSearch(sync: SyncTex, path: string, line: number): SyncRect[] {
  const tags = new Set([...sync.files].filter(([, file]) => file === path).map(([tag]) => tag));
  if (tags.size === 0) return [];
  // Por línea, los renglones (cajas con ancho) que tienen algo de ella. Hay líneas que solo dejan puntos
  // sueltos entre párrafos (sin renglón que marcar): esas no cuentan.
  const byLine = new Map<number, Set<number>>();
  sync.nodes.forEach((node, index) => {
    if (!tags.has(node.tag) || node.line <= 0) return;
    const box = node.box ? index : node.parent;
    if (box < 0 || (sync.nodes[box]?.width ?? 0) <= 0) return;
    const boxes = byLine.get(node.line) ?? new Set<number>();
    boxes.add(box);
    byLine.set(node.line, boxes);
  });
  // La línea exacta, o la más cercana que tenga renglones (en empate, la de abajo: el texto sigue ahí).
  let best: number | null = null;
  for (const candidate of byLine.keys()) {
    const distance = Math.abs(candidate - line);
    const current = best === null ? Infinity : Math.abs(best - line);
    if (distance < current || (distance === current && best !== null && candidate > best)) best = candidate;
  }
  if (best === null) return [];
  const rects = [...(byLine.get(best) ?? [])].map((index) => rectOf(sync.nodes[index] as SyncNode));
  // Solo la primera página donde aparece: es la que se muestra.
  const page = Math.min(...rects.map((rect) => rect.page));
  return rects.filter((rect) => rect.page === page);
}

/** PDF → código: el archivo y la línea del punto (en puntos del PDF) de una página. */
export function inverseSearch(sync: SyncTex, page: number, x: number, y: number): { path: string; line: number } | null {
  const mapped = (node: SyncNode) => node.page === page && node.line > 0 && sync.files.has(node.tag);
  // El renglón más chico que contiene el punto (con un poco de margen vertical).
  let row = -1;
  let rowArea = Infinity;
  sync.nodes.forEach((node, index) => {
    if (!node.box || node.page !== page) return;
    const inside = x >= node.x && x <= node.x + node.width && y >= node.y - node.height - 2 && y <= node.y + node.depth + 2;
    const area = node.width * (node.height + node.depth);
    if (inside && area < rowArea) {
      row = index;
      rowArea = area;
    }
  });
  // Dentro del renglón, el pedazo más cercano a la izquierda del clic (los de la derecha pesan más); si no
  // tiene pedazos, el renglón mismo; si no hay renglón, lo más cercano de la página.
  const pick = (inRow: number) => {
    let best: SyncNode | null = null;
    let bestScore = Infinity;
    sync.nodes.forEach((node) => {
      if (!mapped(node) || (inRow >= 0 && node.parent !== inRow)) return;
      const dx = node.x <= x ? x - node.x : (node.x - x) * 3;
      const score = inRow >= 0 ? dx : Math.hypot(dx, (node.y - y) * 2);
      if (score < bestScore) {
        best = node;
        bestScore = score;
      }
    });
    return best as SyncNode | null;
  };
  const rowNode = sync.nodes[row];
  const best = (row >= 0 ? pick(row) : null) ?? (rowNode && mapped(rowNode) ? rowNode : null) ?? pick(-1);
  const path = best ? sync.files.get(best.tag) : undefined;
  return best && path ? { path, line: best.line } : null;
}

/** Baja y descomprime el SyncTeX de una compilación. */
export async function loadSynctex(response: Response): Promise<string> {
  if (!response.body) return '';
  const stream = response.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

function rectOf(node: SyncNode): SyncRect {
  return { page: node.page, x: node.x, y: node.y - node.height, width: node.width, height: node.height + node.depth };
}

/** `/work/./cap//intro.tex` → `/work/cap/intro.tex`. */
function normalize(path: string): string {
  return path.replace(/\/(\.\/)+/g, '/').replace(/\/{2,}/g, '/');
}

/** Si no se pudo deducir la carpeta: la ruta del proyecto más larga que termina igual. */
function bySuffix(path: string, projectPaths: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of projectPaths) {
    if ((path === candidate || path.endsWith(`/${candidate}`)) && candidate.length > (best?.length ?? 0)) best = candidate;
  }
  return best;
}

function splitHeader(line: string): [string, string] {
  const colon = line.indexOf(':');
  return colon < 0 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1)];
}
