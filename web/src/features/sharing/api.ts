// Miembros, enlaces para compartir y unirse con un enlace.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignableRole,
  CreateInvitationRequest,
  ShareLink,
  CreatedShareLink,
  CreateShareLinkRequest,
  JoinResponse,
  MemberListResponse,
  ProjectMember,
  ShareLinkListResponse,
  SharePreviewResponse,
} from '@latexweb/shared';
import { api } from '../../lib/api';
import { projectsKey } from '../projects/api';

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const membersKey = (projectId: string) => ['members', projectId] as const;
const linksKey = (projectId: string) => ['share-links', projectId] as const;

export function useMembers(projectId: string, enabled = true) {
  return useQuery({
    queryKey: membersKey(projectId),
    queryFn: async () => (await api<MemberListResponse>(`${base(projectId)}/members`)).members,
    enabled,
  });
}

export function useSetMemberRole(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AssignableRole }) =>
      api<{ member: ProjectMember }>(`${base(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', json: { role } }),
    onSuccess: () => client.invalidateQueries({ queryKey: membersKey(projectId) }),
  });
}

export function useRemoveMember(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api<void>(`${base(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: membersKey(projectId) }),
  });
}

export function useShareLinks(projectId: string, enabled = true) {
  return useQuery({
    queryKey: linksKey(projectId),
    queryFn: async () => (await api<ShareLinkListResponse>(`${base(projectId)}/share-links`)).links,
    enabled,
  });
}

export function useCreateShareLink(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateShareLinkRequest) =>
      (await api<{ link: CreatedShareLink }>(`${base(projectId)}/share-links`, { method: 'POST', json: body })).link,
    onSuccess: () => client.invalidateQueries({ queryKey: linksKey(projectId) }),
  });
}

export function useInvite(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateInvitationRequest) =>
      (await api<{ link: ShareLink }>(`${base(projectId)}/invitations`, { method: 'POST', json: body })).link,
    onSuccess: () => client.invalidateQueries({ queryKey: linksKey(projectId) }),
  });
}

export function useRevokeShareLink(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api<void>(`${base(projectId)}/share-links/${encodeURIComponent(linkId)}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: linksKey(projectId) }),
  });
}

/** Qué proyecto y rol da el enlace, sin unirse (necesita sesión). */
export function useSharePreview(token: string, enabled: boolean) {
  return useQuery({
    queryKey: ['share-preview', token],
    queryFn: async () => (await api<SharePreviewResponse>(`/share/${encodeURIComponent(token)}`)).preview,
    enabled,
  });
}

export function useJoin(token: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<JoinResponse>(`/share/${encodeURIComponent(token)}/join`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: projectsKey }),
  });
}

/** El enlace que se comparte: el token va en la ruta de la web, no en la de la API. */
export const joinUrl = (token: string) => `${window.location.origin}/unirse/${encodeURIComponent(token)}`;
