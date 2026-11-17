// Archivos de un proyecto: árbol, contenido, subir, renombrar o mover y borrar.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileListResponse, FileResponse } from '@latexweb/shared';
import { api } from '../../lib/api';
import { projectKey, projectsKey } from '../projects/api';

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/files`;
export const filesKey = (projectId: string) => ['files', projectId] as const;

/** Ruta de la API del contenido: texto, imagen inline o descarga. */
export const fileUrl = (projectId: string, fileId: string) => `/api${base(projectId)}/${encodeURIComponent(fileId)}`;

export function useFiles(projectId: string) {
  return useQuery({
    queryKey: filesKey(projectId),
    queryFn: async () => (await api<FileListResponse>(base(projectId))).files,
  });
}

export interface Upload {
  /** Ruta en el proyecto: el server la valida (normalizeProjectPath). */
  path: string;
  data: Blob;
}

export function useUploadFiles(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (uploads: Upload[]) => {
      const form = new FormData();
      for (const upload of uploads) form.append('file', upload.data, upload.path);
      return (await api<FileListResponse>(base(projectId), { method: 'POST', form })).files;
    },
    onSuccess: () => invalidate(client, projectId),
  });
}

export function useRenameFile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, path }: { fileId: string; path: string }) =>
      (await api<FileResponse>(`${base(projectId)}/${encodeURIComponent(fileId)}`, { method: 'PATCH', json: { path } })).file,
    onSuccess: () => invalidate(client, projectId),
  });
}

export function useDeleteFile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api<void>(`${base(projectId)}/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(client, projectId),
  });
}

/** El árbol cambió: también puede haber cambiado el documento principal o la fecha del proyecto. */
function invalidate(client: ReturnType<typeof useQueryClient>, projectId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: filesKey(projectId) }),
    client.invalidateQueries({ queryKey: projectKey(projectId) }),
    client.invalidateQueries({ queryKey: projectsKey }),
  ]);
}
