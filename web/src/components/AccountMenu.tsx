// Menú de la cuenta: quién está conectado, tema y cerrar sesión.
import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '../app/theme';
import { googleLoginUrl, useAuthProviders, useCurrentUser, useLogout } from '../features/auth/api';
import { Avatar, colorFor } from './Avatar';
import { Icon } from './Icon';
import { Menu } from './Menu';

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const logout = useLogout();
  const providers = useAuthProviders();
  const location = useLocation();
  const name = user.name ?? user.email;
  return (
    <Menu
      width={250}
      heading={
        <span className="flex flex-col">
          <span className="truncate font-semibold text-text">{name}</span>
          {user.name && <span className="truncate">{user.email}</span>}
        </span>
      }
      items={[
        ...(providers.data?.google ? [{
          label: 'Vincular Google',
          onSelect: () => window.location.assign(googleLoginUrl(location.pathname + location.search, true)),
        }] : []),
        { label: 'Tema claro', icon: 'sun', checked: preference === 'claro', onSelect: () => setPreference('claro'), separated: true },
        { label: 'Tema oscuro', icon: 'moon', checked: preference === 'oscuro', onSelect: () => setPreference('oscuro') },
        { label: 'Como el sistema', icon: 'monitor', checked: preference === 'sistema', onSelect: () => setPreference('sistema') },
        {
          label: 'Cerrar sesión',
          icon: 'logout',
          separated: true,
          onSelect: () => logout.mutate(undefined, { onSettled: () => navigate('/entrar?modo=entrar', { replace: true }) }),
        },
      ]}
      trigger={(props) => (
        <button
          type="button"
          aria-label={`Cuenta de ${name}`}
          className="flex h-11 items-center gap-2.5 rounded-full border border-border bg-surface pr-2 pl-1 text-text hover:bg-surface-2"
          {...props}
        >
          <Avatar name={user.name} email={user.email} color={colorFor(user.id)} size={34} />
          {!compact && <span className="hidden max-w-[180px] truncate text-sm font-medium sm:inline">{name}</span>}
          <Icon name="chevDown" size={16} />
        </button>
      )}
    />
  );
}
