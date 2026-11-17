// Tema claro u oscuro: la preferencia se guarda en localStorage y `data-theme` en <html> elige los
// tokens de index.css. index.html aplica la misma lógica antes de pintar.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePreference = 'claro' | 'oscuro' | 'sistema';

const STORAGE_KEY = 'pliego.tema';

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'claro' || value === 'oscuro') return value;
  } catch {
    // Sin acceso a localStorage (modo privado): se usa el tema del sistema.
  }
  return 'sistema';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = preference === 'oscuro' || (preference === 'sistema' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'sistema') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // La preferencia vale solo para esta pestaña.
    }
  };

  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme fuera de ThemeProvider');
  return value;
}
