import { useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { hasAcceptedPrivacy, PRIVACY_NOTICE } from '@latexweb/shared';
import { FullScreenError, FullScreenLoading, safeReturnPath } from '../../app/RequireAuth';
import { Button } from '../../components/Button';
import { Logo } from '../../components/Logo';
import { Notice } from '../../components/Notice';
import { errorMessage } from '../../lib/api';
import { useAcceptPrivacy, useLogout, useMe } from './api';

export const privacyAcceptanceUrl = (back: string) => `/privacidad/aceptar?volver=${encodeURIComponent(back)}`;

function PrivacyDocument() {
  return (
    <article aria-label="Contenido del aviso" className="flex flex-col gap-5 text-[15px] leading-relaxed">
      <p className="m-0 text-sm text-muted">Versión {PRIVACY_NOTICE.version} · Responsable: {PRIVACY_NOTICE.controller}</p>
      {PRIVACY_NOTICE.sections.map((section) => <section key={section.title}>
        <h2 className="mb-1 text-lg font-semibold">{section.title}</h2>
        <p className="m-0">{section.text}</p>
      </section>)}
      <p className="m-0">Contacto: <a className="text-accent-text underline" href={`mailto:${PRIVACY_NOTICE.contact}`}>{PRIVACY_NOTICE.contact}</a>.</p>
      <p className="m-0 text-sm text-muted">Consulta también la <a className="text-accent-text underline" href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">política de privacidad de Google</a>.</p>
    </article>
  );
}

export function PrivacyPage() {
  return <PrivacyLayout><PrivacyDocument /><Link to="/entrar" className="text-accent-text underline">Volver a Pliego</Link></PrivacyLayout>;
}

function PrivacyLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-bg px-5 py-8 text-text">
    <div className="mx-auto flex max-w-3xl flex-col gap-7 rounded-2xl border border-border bg-surface p-5 sm:p-9">
      <Link to="/" className="w-fit text-text"><Logo /></Link>
      <h1 className="m-0 font-serif text-3xl">{PRIVACY_NOTICE.title}</h1>
      {children}
    </div>
  </main>;
}

export function PrivacyAcceptancePage() {
  const me = useMe();
  const accept = useAcceptPrivacy();
  const logout = useLogout();
  const [params] = useSearchParams();
  const [checked, setChecked] = useState(false);
  const back = safeReturnPath(params.get('volver'));
  if (me.isPending) return <FullScreenLoading />;
  if (me.isError) return <FullScreenError message={errorMessage(me.error)} onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to={`/entrar?volver=${encodeURIComponent(privacyAcceptanceUrl(back))}`} replace />;
  if (hasAcceptedPrivacy(me.data)) return <Navigate to={back.startsWith('/privacidad/aceptar') ? '/' : back} replace />;
  return <PrivacyLayout>
    <Notice tone="info" title="Antes de continuar">Sesión: {me.data.email}. Lee el aviso y decide si autorizas el tratamiento descrito para usar Pliego.</Notice>
    <PrivacyDocument />
    <form className="flex flex-col gap-5 border-t border-border pt-5" onSubmit={(event) => {
      event.preventDefault();
      if (checked && !accept.isPending) accept.mutate({ accepted: true, version: PRIVACY_NOTICE.version });
    }}>
      <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
        <input type="checkbox" required checked={checked} onChange={(event) => setChecked(event.target.checked)}
          className="mt-1 size-5 flex-none accent-accent" disabled={accept.isPending} />
        <span>He leído el aviso de privacidad y autorizo a {PRIVACY_NOTICE.controller} a tratar mis datos personales para las finalidades descritas de funcionamiento de Pliego.</span>
      </label>
      {accept.isError && <Notice tone="error" alert title="No se pudo guardar la aceptación">{errorMessage(accept.error)}</Notice>}
      {logout.isError && <Notice tone="error" alert title="No se pudo cerrar la sesión">{errorMessage(logout.error)}</Notice>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={!checked || accept.isPending || logout.isPending}>{accept.isPending ? 'Guardando…' : 'Aceptar y continuar'}</Button>
        <Button disabled={accept.isPending || logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => window.location.assign('/entrar') })}>No aceptar y cerrar sesión</Button>
      </div>
      <p className="m-0 text-sm text-muted">Guardamos la versión aceptada y la fecha. Puedes solicitar retirar tu autorización en <a className="text-accent-text underline" href={`mailto:${PRIVACY_NOTICE.contact}`}>{PRIVACY_NOTICE.contact}</a>.</p>
    </form>
  </PrivacyLayout>;
}
