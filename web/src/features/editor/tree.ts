// Árbol de carpetas a partir de las rutas planas de los archivos del proyecto (el server no guarda
// carpetas: existen mientras tengan algún archivo). Carpetas primero, después archivos, por nombre.
import type { ProjectFile } from '@latexweb/shared';
import type { IconName } from '../../components/Icon';

export interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  type: 'file';
  name: string;
  path: string;
  file: ProjectFile;
}

export type TreeNode = FolderNode | FileNode;

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

export function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let folder = root;
    parts.slice(0, -1).forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let next = folder.children.find((child): child is FolderNode => child.type === 'folder' && child.name === part);
      if (!next) {
        next = { type: 'folder', name: part, path, children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({ type: 'file', name: parts.at(-1)!, path: file.path, file });
  }
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1));
  for (const node of nodes) if (node.type === 'folder') sortTree(node.children);
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|eps)$/i;

export function fileIcon(path: string): IconName {
  if (/\.(tex|sty|cls)$/i.test(path)) return 'tex';
  if (/\.bib$/i.test(path)) return 'bib';
  if (IMAGE.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  return 'file';
}

export const isImage = (path: string) => IMAGE.test(path);

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
