// Menú de la cuenta: quién está conectado, tema y cerrar sesión.
import { useNavigate } from 'react-router';
import { useTheme } from '../app/theme';
import { CURRENT_USER } from '../lib/mock';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Menu } from './Menu';

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  const name = CURRENT_USER.name ?? CURRENT_USER.email;
  return (
    <Menu
      width={250}
      heading={
        <span className="flex flex-col">
          <span className="font-semibold text-text">{name}</span>
          <span className="truncate">{CURRENT_USER.email}</span>
        </span>
      }
      items={[
        { label: 'Tema claro', icon: 'sun', checked: preference === 'claro', onSelect: () => setPreference('claro'), separated: true },
        { label: 'Tema oscuro', icon: 'moon', checked: preference === 'oscuro', onSelect: () => setPreference('oscuro') },
        { label: 'Como el sistema', icon: 'monitor', checked: preference === 'sistema', onSelect: () => setPreference('sistema') },
        { label: 'Cerrar sesión', icon: 'logout', onSelect: () => navigate('/entrar'), separated: true },
      ]}
      trigger={(props) => (
        <button
          type="button"
          aria-label={`Cuenta de ${name}`}
          className="flex h-11 items-center gap-2.5 rounded-full border border-border bg-surface pr-2 pl-1 text-text hover:bg-surface-2"
          {...props}
        >
          <Avatar name={CURRENT_USER.name} email={CURRENT_USER.email} color={CURRENT_USER.color} size={34} />
          {!compact && <span className="hidden text-sm font-medium sm:inline">{name}</span>}
          <Icon name="chevDown" size={16} />
        </button>
      )}
    />
  );
}
