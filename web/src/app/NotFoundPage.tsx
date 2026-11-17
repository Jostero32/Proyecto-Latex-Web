import { Link } from 'react-router';
import { Logo } from '../components/Logo';

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-bg px-4 text-center">
      <Logo size={28} />
      <h1 className="m-0 font-serif text-4xl font-medium">Esta página no existe</h1>
      <p className="m-0 max-w-[420px] text-[15px] text-muted">Puede que el enlace esté mal escrito o que el proyecto ya no esté.</p>
      <Link to="/" className="flex h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent no-underline">
        Ir a mis proyectos
      </Link>
    </main>
  );
}
