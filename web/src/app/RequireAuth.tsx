// Rutas privadas: sin sesión, a /entrar?volver=<esta ruta>; después de entrar se vuelve.
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button } from '../components/Button';
import { LogoMark } from '../components/Logo';
import { useMe } from '../features/auth/api';
import { errorMessage } from '../lib/api';

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullScreenLoading />;
  if (me.isError) return <FullScreenError message={errorMessage(me.error)} onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to={`/entrar?volver=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

export function FullScreenLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg" aria-busy="true" aria-label="Cargando">
      <span className="animate-pulse">
        <LogoMark size={36} />
      </span>
    </div>
  );
}

export function FullScreenError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 text-center">
      <LogoMark size={36} />
      <p className="m-0 max-w-[420px] text-[15px] text-muted">{message}</p>
      <Button icon="sync" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

/** Solo un destino interno: `volver` viene de la URL y no puede mandar a otro sitio. */
export function safeReturnPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}
