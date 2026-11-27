// Sesión: quién soy (`/auth/me`), entrar, crear cuenta y salir.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthProvidersResponse, AuthResponse, LoginRequest, PublicUser, RegisterRequest } from '@latexweb/shared';
import { api, isApiError } from '../../lib/api';

export const meKey = ['me'] as const;

export function useAuthProviders() {
  return useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => api<AuthProvidersResponse>('/auth/providers'),
    staleTime: 5 * 60_000,
  });
}

export function googleLoginUrl(returnPath: string, link = false): string {
  const query = new URLSearchParams({ volver: returnPath });
  if (link) query.set('link', '1');
  return `/api/auth/google?${query}`;
}

/** El usuario de la sesión, o null si no hay sesión. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<PublicUser | null> => {
      try {
        return (await api<AuthResponse>('/auth/me')).user;
      } catch (error) {
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });
}

/** El usuario de la sesión: solo dentro de las rutas protegidas por RequireAuth. */
export function useCurrentUser(): PublicUser {
  const { data } = useMe();
  if (!data) throw new Error('useCurrentUser fuera de RequireAuth');
  return data;
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<AuthResponse>('/auth/login', { method: 'POST', json: body }),
    // Otra cuenta: nada de la caché anterior sirve.
    onSuccess: ({ user }) => {
      client.clear();
      client.setQueryData(meKey, user);
    },
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) => api<AuthResponse>('/auth/register', { method: 'POST', json: body }),
    onSuccess: ({ user }) => {
      client.clear();
      client.setQueryData(meKey, user);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      client.clear();
      client.setQueryData(meKey, null);
    },
  });
}
