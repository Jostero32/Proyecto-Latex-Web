// Proyectos: lista, crear, importar, cambiar y borrar. Las mutaciones invalidan la lista.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectListResponse, ProjectResponse, UpdateProjectRequest } from '@latexweb/shared';
import { api } from '../../lib/api';

export const projectsKey = ['projects'] as const;
export const projectKey = (id: string) => ['project', id] as const;

export function useProjects() {
  return useQuery({
    queryKey: projectsKey,
    queryFn: async () => (await api<ProjectListResponse>('/projects')).projects,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKey(id),
    queryFn: async () => (await api<ProjectResponse>(`/projects/${encodeURIComponent(id)}`)).project,
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => (await api<ProjectResponse>('/projects', { method: 'POST', json: { name } })).project,
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}

export function useImportProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name }: { file: File; name?: string }) => {
      const form = new FormData();
      if (name) form.append('name', name);
      form.append('file', file, file.name);
      return (await api<ProjectResponse>('/projects/import', { method: 'POST', form })).project;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}

export function useUpdateProject(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: UpdateProjectRequest) =>
      (await api<ProjectResponse>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', json: changes })).project,
    onSuccess: (project) => {
      client.setQueryData(projectKey(id), project);
      void client.invalidateQueries({ queryKey: projectsKey });
    },
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: projectKey(id) });
      return client.invalidateQueries({ queryKey: projectsKey });
    },
  });
}

/** Descarga directa: el navegador baja el zip con la cookie de sesión. */
export const exportUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}/export`;
