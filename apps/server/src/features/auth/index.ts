// API pública de la funcionalidad de auth. Desde afuera se importa solo este archivo.
export { authRoutes, type AuthDeps } from './routes';
export { createRequireUser, registerAuthHooks, SESSION_COOKIE } from './guard';
export { createAuthService, type AuthService, type PublicUser } from './service';
