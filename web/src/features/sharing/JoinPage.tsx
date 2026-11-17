// Unirse con un enlace: el proyecto, quién lo comparte y el rol que va a tener la persona.
// Paso 1: sin API. `?estado=normal|sin-sesion|vencido|ya-miembro` muestra cada caso.
import { Link, useLocation, useSearchParams } from 'react-router';
import { Icon, type IconName } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { CURRENT_USER } from '../../lib/mock';

type JoinState = 'normal' | 'sin-sesion' | 'vencido' | 'ya-miembro';

interface Variant {
  eyebrow: string;
  icon: IconName;
  roleTitle: string;
  roleText: string;
  primary: string;
  primaryTo: string;
  secondary?: string;
  footer: string;
}

export function JoinPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const raw = params.get('estado');
  const state: JoinState = raw === 'sin-sesion' || raw === 'vencido' || raw === 'ya-miembro' ? raw : 'normal';
  const back = encodeURIComponent(location.pathname);

  const variants: Record<Exclude<JoinState, 'vencido'>, Variant> = {
    normal: {
      eyebrow: 'Te invitaron a un proyecto',
      icon: 'pencil',
      roleTitle: 'Vas a entrar como Editor',
      roleText: 'Podés editar archivos, subir imágenes y compilar.',
      primary: 'Unirme al proyecto',
      primaryTo: '/proyectos/erosion',
      footer: `Entrás como ${CURRENT_USER.email}.`,
    },
    'sin-sesion': {
      eyebrow: 'Te invitaron a un proyecto',
      icon: 'eye',
      roleTitle: 'Vas a entrar como Lector',
      roleText: 'Podés ver todo, compilar y descargar, sin editar.',
      primary: 'Entrar para unirme',
      primaryTo: `/entrar?modo=entrar&volver=${back}`,
      secondary: `/entrar?volver=${back}`,
      footer: 'Después de entrar te traemos de vuelta a esta página.',
    },
    'ya-miembro': {
      eyebrow: 'Ya sos parte de este proyecto',
      icon: 'check',
      roleTitle: 'Seguís como Editor',
      roleText: 'El enlace era de lector. Cuando ya sos miembro, te quedás con el rol más alto.',
      primary: 'Abrir el proyecto',
      primaryTo: '/proyectos/erosion',
      footer: 'No hiciste ningún cambio en tus permisos.',
    },
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex h-16 items-center px-5 sm:px-8">
        <Link to="/" className="text-text no-underline">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-2 pb-8 sm:items-center sm:pb-24">
        <div className="flex w-full max-w-[480px] flex-col gap-[22px] rounded-2xl border border-border bg-surface px-5 py-6 shadow-pop sm:p-9">
          {state === 'vencido' ? (
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
          ) : (
            <JoinCard variant={variants[state]} />
          )}
        </div>
      </main>
    </div>
  );
}

function JoinCard({ variant }: { variant: Variant }) {
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-semibold tracking-wider text-accent-text uppercase">{variant.eyebrow}</span>
        <h1 className="m-0 font-serif text-[28px] leading-tight font-medium [overflow-wrap:anywhere] sm:text-[34px]">
          Erosión del suelo en laderas andinas
        </h1>
        <span className="text-sm text-muted">De Ana Torres</span>
      </div>
      <div className="flex items-start gap-3.5 rounded-xl border border-border bg-bg p-4">
        <span className="flex size-[38px] flex-none items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Icon name={variant.icon} size={18} strokeWidth={1.9} />
        </span>
        <div className="flex flex-col gap-0.5">
          <strong className="text-[15.5px] font-semibold">{variant.roleTitle}</strong>
          <span className="text-sm leading-normal text-muted">{variant.roleText}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <PrimaryLink to={variant.primaryTo}>{variant.primary}</PrimaryLink>
        {variant.secondary && (
          <Link
            to={variant.secondary}
            className="flex h-12 items-center justify-center rounded-md border-[1.5px] border-border-input text-[15px] font-semibold text-text no-underline hover:bg-surface-2"
          >
            Crear una cuenta
          </Link>
        )}
      </div>
      <p className="m-0 text-center text-[13.5px] leading-normal text-muted">{variant.footer}</p>
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
