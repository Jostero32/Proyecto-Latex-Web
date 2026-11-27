// Entrar y crear cuenta. Dos columnas en escritorio (marca e ilustración, formulario); en el celular,
// solo el formulario. La regla de la contraseña (10 a 256 caracteres) se ve antes de equivocarse.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { PASSWORD_MAX_LENGTH as PASSWORD_MAX, PASSWORD_MIN_LENGTH as PASSWORD_MIN } from '@latexweb/shared';
import { safeReturnPath } from '../../app/RequireAuth';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Logo } from '../../components/Logo';
import { Notice } from '../../components/Notice';
import { errorMessage, isApiError } from '../../lib/api';
import { googleLoginUrl, useAuthProviders, useLogin, useMe, useRegister } from './api';

const TAGLINE = 'Escribí con LaTeX en el navegador, junto a tu equipo, sin instalar nada.';
const WEAK = `Tiene que tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`;

type Mode = 'entrar' | 'crear';

interface FormError {
  title: string;
  text: string;
  field?: 'name' | 'email' | 'password';
  fieldText?: string;
}

const GOOGLE_ERRORS: Record<string, FormError> = {
  google_cancelled: { title: 'No se completó el inicio con Google', text: 'Cancelaste la autorización. Podés volver a intentarlo.' },
  google_expired: { title: 'La solicitud de Google venció', text: 'Volvé a iniciar el proceso desde este navegador.' },
  google_failed: { title: 'No pudimos entrar con Google', text: 'Volvé a intentar. También podés usar email y contraseña.' },
  google_unavailable: { title: 'Google no está disponible', text: 'Por ahora podés entrar con email y contraseña.' },
  google_link_required: { title: 'Primero entrá con tu contraseña', text: 'Ese email ya tiene una cuenta. Entrá y elegí Vincular Google en el menú de tu cuenta.' },
  google_account_conflict: { title: 'No se pudo vincular esa cuenta', text: 'Elegí la cuenta de Google con el mismo email de Pliego. Una cuenta de Google solo puede vincularse una vez.' },
};

function describe(error: unknown): FormError {
  if (isApiError(error, 'email_taken')) {
    return { title: 'Ese email ya tiene una cuenta', text: 'Si es tuyo, entrá con tu contraseña.', field: 'email', fieldText: 'Ya hay una cuenta con este email.' };
  }
  if (isApiError(error, 'invalid_credentials')) {
    return { title: 'El email o la contraseña no coinciden', text: 'Revisalos e intentá de nuevo. Las mayúsculas cuentan.', field: 'password' };
  }
  if (isApiError(error, 'invalid_email')) {
    return { title: 'Revisá el email', text: 'No parece una dirección válida.', field: 'email', fieldText: 'No parece una dirección válida.' };
  }
  if (isApiError(error, 'weak_password')) return { title: 'La contraseña no sirve', text: WEAK, field: 'password' };
  if (isApiError(error, 'invalid_name')) {
    const text = 'Tiene caracteres que no se permiten o es demasiado largo.';
    return { title: 'Revisá el nombre', text, field: 'name', fieldText: text };
  }
  return { title: 'No pudimos seguir', text: errorMessage(error) };
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const login = useLogin();
  const register = useRegister();
  const providers = useAuthProviders();
  const googleError = GOOGLE_ERRORS[params.get('oauth_error') ?? ''];
  const [mode, setMode] = useState<Mode>(params.get('modo') === 'entrar' ? 'entrar' : 'crear');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<FormError | null>(googleError ?? null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const creating = mode === 'crear';
  const back = safeReturnPath(params.get('volver'));
  const pending = login.isPending || register.isPending;

  // Pasado el tiempo del límite de intentos, se vuelve a habilitar.
  useEffect(() => {
    if (!blockedUntil) return;
    const timer = setTimeout(() => setBlockedUntil(null), Math.max(0, blockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [blockedUntil]);

  if (me.data) {
    if (!googleError) return <Navigate to={back} replace />;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-bg p-6">
        <div className="w-full max-w-[420px]">
          <Notice tone="error" alert title={googleError.title}>{googleError.text}</Notice>
        </div>
        <Button onClick={() => navigate(back, { replace: true })}>Volver a mis proyectos</Button>
      </main>
    );
  }

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blockedUntil || pending) return;
    if (creating && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
      setError({ title: 'La contraseña no sirve', text: WEAK, field: 'password' });
      return;
    }
    setError(null);
    const options = {
      onSuccess: () => navigate(back, { replace: true }),
      onError: (failure: unknown) => {
        if (isApiError(failure, 'rate_limited')) {
          const seconds = failure.retryAfter ?? 15 * 60;
          setBlockedUntil(Date.now() + seconds * 1000);
          setError({ title: 'Demasiados intentos seguidos', text: `Por seguridad, pausamos la entrada. Reintentá en ${Math.ceil(seconds / 60)} minutos.` });
          return;
        }
        setError(describe(failure));
      },
    };
    if (creating) register.mutate({ email, password, ...(name.trim() ? { name: name.trim() } : {}) }, options);
    else login.mutate({ email, password }, options);
  };

  const submitLabel = blockedUntil
    ? 'Esperá para reintentar'
    : pending
      ? creating
        ? 'Creando la cuenta…'
        : 'Entrando…'
      : creating
        ? 'Crear cuenta'
        : 'Entrar';

  return (
    <div className="flex min-h-screen flex-wrap bg-bg">
      <aside className="relative hidden min-w-0 flex-[1_1_560px] flex-col justify-between gap-12 overflow-hidden bg-surface-2 px-16 py-12 lg:flex">
        <Logo size={28} />
        <div className="flex max-w-[520px] flex-col gap-5">
          <p className="m-0 font-serif text-[46px] leading-[1.08] tracking-tight text-balance">{TAGLINE}</p>
          <p className="m-0 text-[17px] leading-relaxed text-muted">
            Para estudiantes, investigadores y docentes. Si nunca usaste LaTeX, cada proyecto nuevo arranca con una plantilla
            lista para escribir.
          </p>
        </div>
        <PaperIllustration />
      </aside>

      <main className="flex min-w-0 flex-[1_1_480px] items-center justify-center px-6 py-8 sm:px-16 sm:py-12">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <div className="flex flex-col gap-3.5 lg:hidden">
            <Logo size={24} />
            <p className="m-0 text-[15px] leading-normal text-muted">{TAGLINE}</p>
          </div>

          <div className="flex flex-col gap-2">
            <h1 className="m-0 font-serif text-3xl leading-tight font-medium tracking-tight sm:text-[38px]">
              {creating ? 'Creá tu cuenta' : 'Qué bueno verte de nuevo'}
            </h1>
            <p className="m-0 text-[15px] text-muted">
              {creating ? 'Solo necesitás un email y una contraseña.' : 'Entrá para seguir con tus proyectos.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
            {(['entrar', 'crear'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => switchMode(value)}
                className={`h-[38px] rounded-md text-sm font-semibold ${mode === value ? 'bg-surface text-text shadow-sm' : 'text-muted'}`}
              >
                {value === 'entrar' ? 'Entrar' : 'Crear cuenta'}
              </button>
            ))}
          </div>

          {error && (
            <Notice tone="error" alert title={error.title} icon={blockedUntil ? 'clock' : undefined}>
              {error.text}
            </Notice>
          )}

          {providers.data?.google && (
            <>
              <Button variant="secondary" size="lg" disabled={pending || blockedUntil !== null}
                onClick={() => window.location.assign(googleLoginUrl(back))}>
                Continuar con Google
              </Button>
              <p className="m-0 text-center text-[13px] text-muted">O usá tu email y contraseña</p>
            </>
          )}

          <form onSubmit={submit} className="flex flex-col gap-[18px]">
            {creating && (
              <TextField
                label="Nombre"
                labelNote="(opcional)"
                autoComplete="name"
                placeholder="Cómo te ven tus colaboradores"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={error?.field === 'name' ? error.fieldText : null}
              />
            )}
            <TextField
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={error?.field === 'email' ? error.fieldText : null}
            />
            <div className="flex flex-col gap-2">
              <TextField
                label="Contraseña"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete={creating ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                invalid={error?.field === 'password'}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    className="flex h-9 items-center gap-1.5 rounded px-2.5 text-[13px] font-semibold text-muted hover:text-text"
                  >
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                    {showPassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                }
              />
              {creating && <PasswordRule length={password.length} />}
            </div>
            <Button type="submit" variant="primary" size="lg" disabled={blockedUntil !== null || pending} className="mt-1">
              {submitLabel}
            </Button>
          </form>

          <p className="m-0 text-center text-sm text-muted">
            {creating ? '¿Ya tenés cuenta?' : '¿Todavía no tenés cuenta?'}{' '}
            <button
              type="button"
              onClick={() => switchMode(creating ? 'entrar' : 'crear')}
              className="font-semibold text-accent-text underline underline-offset-[3px]"
            >
              {creating ? 'Entrá' : 'Creá una'}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}

/** Barra de 10 marcas y el texto de la regla: gris mientras falta, verde al cumplirla, rojo si se pasa. */
function PasswordRule({ length }: { length: number }) {
  const ok = length >= PASSWORD_MIN && length <= PASSWORD_MAX;
  const tooLong = length > PASSWORD_MAX;
  const color = tooLong ? 'text-error' : ok ? 'text-success' : 'text-muted';
  const text = tooLong
    ? `Máximo ${PASSWORD_MAX} caracteres. Tiene ${length}.`
    : ok
      ? `Entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres. Listo, tiene ${length}.`
      : `Entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres. Llevás ${length} de ${PASSWORD_MIN}.`;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-10 gap-[3px]" aria-hidden="true">
        {Array.from({ length: PASSWORD_MIN }, (_, index) => (
          <span
            key={index}
            className={`h-1 rounded-sm ${index < Math.min(length, PASSWORD_MIN) ? (tooLong ? 'bg-error' : ok ? 'bg-success' : 'bg-accent') : 'bg-border'}`}
          />
        ))}
      </div>
      <span aria-live="polite" className={`flex items-center gap-1.5 text-[13px] ${color}`}>
        <Icon name={tooLong ? 'error' : ok ? 'check' : 'info'} size={14} strokeWidth={2.2} />
        {text}
      </span>
    </div>
  );
}

/** Ilustración: una hoja con la fórmula y el código con el cursor de Lucía. Decorativa. */
function PaperIllustration() {
  return (
    <div className="relative h-[250px]" aria-hidden="true">
      <div className="absolute top-0 left-0 flex h-[240px] w-[360px] flex-col gap-2 rounded bg-white px-[34px] py-[30px] font-paper text-[#1b1a17] shadow-pop">
        <p className="m-0 text-base font-semibold">1&nbsp;&nbsp;&nbsp;Introducción</p>
        <p className="m-0 text-justify text-[12.5px] leading-normal">
          La erosión hídrica depende de la lluvia, el suelo, la pendiente y la cobertura [3]. La pérdida anual se estima como
        </p>
        <p className="my-1 text-center text-sm italic">A = R · K · LS · C · P</p>
        <span className="h-[7px] w-[90%] rounded-sm bg-[#eceae4]" />
        <span className="h-[7px] w-[74%] rounded-sm bg-[#eceae4]" />
      </div>
      <div className="absolute top-[130px] left-[210px] flex flex-col rounded-[10px] border border-border bg-surface px-4 py-3 font-mono text-[13px] leading-[22px] shadow-pop">
        <span>
          <span className="text-accent">\section</span>
          <span className="text-faint">{'{'}</span>Introducción<span className="text-faint">{'}'}</span>
        </span>
        <span className="flex items-center">
          <span className="text-math">A = R \cdot K</span>
          <span className="ml-px h-[17px] w-0.5 bg-[#C2410C]" />
          <span className="ml-0.5 rounded-[0_4px_4px_4px] bg-[#C2410C] px-1.5 font-sans text-[11px] font-semibold text-white">Lucía</span>
        </span>
      </div>
    </div>
  );
}
