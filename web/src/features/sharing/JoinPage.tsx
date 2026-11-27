// Unirse con un enlace. Con sesión: el proyecto, quién lo comparte y el rol que va a tener la persona
// (GET /share/:token, sin unirse), y el botón Unirme. Sin sesión: pide entrar y vuelve acá.
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { higherRole, type ProjectRole, type SharePreview } from '@latexweb/shared';
import { FullScreenLoading } from '../../app/RequireAuth';
import { Button } from '../../components/Button';
import { Icon, type IconName } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { Notice } from '../../components/Notice';
import { ROLE_LABELS } from '../../components/RoleBadge';
import { errorMessage, isApiError } from '../../lib/api';
import { googleLoginUrl, useAuthProviders, useMe } from '../auth/api';
import { useJoin, useSharePreview } from './api';

const CAN_DO: Record<ProjectRole, string> = {
  owner: 'Podés hacer todo, también compartir y borrar.',
  editor: 'Podés editar archivos, subir imágenes y compilar.',
  viewer: 'Podés ver todo, compilar y descargar, sin editar.',
};
const ROLE_ICON: Record<ProjectRole, IconName> = { owner: 'crown', editor: 'pencil', viewer: 'eye' };

export function JoinPage() {
  const { token = '' } = useParams();
  const location = useLocation();
  const me = useMe();
  const providers = useAuthProviders();
  const preview = useSharePreview(token, Boolean(me.data));
  const back = encodeURIComponent(location.pathname);

  if (me.isPending || (me.data && preview.isPending)) return <FullScreenLoading />;

  let content;
  if (!me.data) {
    content = <SignedOut back={back} />;
  } else if (preview.isError) {
    content = isApiError(preview.error, 'invalid_link') ? <Expired />
      : isApiError(preview.error, 'invitation_email_mismatch') || isApiError(preview.error, 'google_verification_required')
        ? <><Notice tone="error" title="Verifica la cuenta invitada">{errorMessage(preview.error)} Sesión actual: {me.data.email}.</Notice>
          {providers.data?.google && <a className="text-accent-text underline" href={googleLoginUrl(location.pathname, isApiError(preview.error, 'google_verification_required'))}>
            {isApiError(preview.error, 'google_verification_required') ? 'Vincular mi cuenta Google' : 'Entrar con otra cuenta Google'}
          </a>}</>
        : <Notice tone="error" alert title="No pudimos abrir el enlace">{errorMessage(preview.error)}</Notice>;
  } else if (preview.data) {
    content = <Preview token={token} preview={preview.data} email={me.data.email} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex h-16 items-center px-5 sm:px-8">
        <Link to="/" className="text-text no-underline">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-2 pb-8 sm:items-center sm:pb-24">
        <div className="flex w-full max-w-[480px] flex-col gap-[22px] rounded-2xl border border-border bg-surface px-5 py-6 shadow-pop sm:p-9">{content}</div>
      </main>
    </div>
  );
}

function Preview({ token, preview, email }: { token: string; preview: SharePreview; email: string }) {
  const join = useJoin(token);
  const navigate = useNavigate();
  const member = preview.currentRole !== null;
  const role = member ? higherRole(preview.currentRole!, preview.role) : preview.role;
  const open = () => navigate(`/proyectos/${preview.projectId}`);
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-semibold tracking-wider text-accent-text uppercase">
          {member ? 'Ya sos parte de este proyecto' : 'Te invitaron a un proyecto'}
        </span>
        <h1 className="m-0 font-serif text-[28px] leading-tight font-medium [overflow-wrap:anywhere] sm:text-[34px]">{preview.projectName}</h1>
        {preview.ownerName && <span className="text-sm text-muted">De {preview.ownerName}</span>}
      </div>
      <div className="flex items-start gap-3.5 rounded-xl border border-border bg-bg p-4">
        <span className="flex size-[38px] flex-none items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Icon name={member && role === preview.currentRole ? 'check' : ROLE_ICON[role]} size={18} strokeWidth={1.9} />
        </span>
        <div className="flex flex-col gap-0.5">
          <strong className="text-[15.5px] font-semibold">
            {member ? (role === preview.currentRole ? `Seguís como ${ROLE_LABELS[role]}` : `Pasás a ${ROLE_LABELS[role]}`) : `Vas a entrar como ${ROLE_LABELS[role]}`}
          </strong>
          <span className="text-sm leading-normal text-muted">
            {member && role === preview.currentRole
              ? `El enlace es de ${ROLE_LABELS[preview.role].toLowerCase()}. Cuando ya sos miembro, te quedás con el rol más alto.`
              : CAN_DO[role]}
          </span>
        </div>
      </div>
      {join.isError && (
        <Notice tone="error" alert title="No pudimos unirte">
          {errorMessage(join.error)}
        </Notice>
      )}
      <Button
        variant="primary"
        size="lg"
        disabled={join.isPending}
        onClick={() => join.mutate(undefined, { onSuccess: open })}
      >
        {member && role === preview.currentRole ? 'Abrir el proyecto' : join.isPending ? 'Uniéndote…' : 'Unirme al proyecto'}
      </Button>
      <p className="m-0 text-center text-[13.5px] leading-normal text-muted">Entrás como {email}.</p>
    </>
  );
}

function SignedOut({ back }: { back: string }) {
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-semibold tracking-wider text-accent-text uppercase">Te invitaron a un proyecto</span>
        <h1 className="m-0 font-serif text-[28px] leading-tight font-medium sm:text-[34px]">Entrá para ver cuál es y unirte</h1>
        <p className="m-0 text-[15px] leading-relaxed text-muted">Entra con la cuenta Google del correo al que enviaron la invitación. Otra cuenta no podrá aceptarla.</p>
      </div>
      <div className="flex flex-col gap-2.5">
        <PrimaryLink to={`/entrar?modo=entrar&volver=${back}`}>Entrar para unirme</PrimaryLink>
        <Link
          to={`/entrar?volver=${back}`}
          className="flex h-12 items-center justify-center rounded-md border-[1.5px] border-border-input text-[15px] font-semibold text-text no-underline hover:bg-surface-2"
        >
          Crear una cuenta
        </Link>
      </div>
      <p className="m-0 text-center text-[13.5px] leading-normal text-muted">Después de entrar te traemos de vuelta a esta página.</p>
    </>
  );
}

function Expired() {
  return (
    <>
      <div className="flex flex-col items-start gap-3.5">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon name="linkOff" size={22} />
        </span>
        <h1 className="m-0 font-serif text-[28px] leading-tight font-medium sm:text-[34px]">Este enlace ya no funciona</h1>
        <p className="m-0 text-[15px] leading-relaxed text-muted">
          Puede que haya vencido o que lo hayan revocado. Pedile un enlace nuevo a quien te lo compartió.
        </p>
      </div>
      <PrimaryLink to="/">Ir a mis proyectos</PrimaryLink>
      <p className="m-0 text-center text-[13.5px] text-muted">Si ya eras miembro, el proyecto sigue en tu lista.</p>
    </>
  );
}

function PrimaryLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="flex h-12 items-center justify-center rounded-md bg-accent text-[15px] font-semibold text-on-accent no-underline hover:brightness-110">
      {children}
    </Link>
  );
}
