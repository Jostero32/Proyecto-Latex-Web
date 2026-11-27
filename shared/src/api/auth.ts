// Contratos de /api/auth. Ver docs/specs/auth.md.

/** El usuario como lo ve la API (sin hash de contraseña). Fechas en ISO 8601. */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export type AuthErrorCode = 'invalid_email' | 'weak_password' | 'invalid_name' | 'email_taken' | 'invalid_credentials'
  | 'google_link_required' | 'google_account_conflict';

export interface AuthProvidersResponse { google: boolean; emailInvitations: boolean }

export interface RegisterRequest { email: string; password: string; name?: string }
export interface LoginRequest { email: string; password: string }
export interface AuthResponse { user: PublicUser }
