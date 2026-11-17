// Rutas de la web. Mis proyectos y el editor exigen sesión; unirse decide adentro (sin sesión, pide entrar).
import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage';
import { EditorPage } from '../features/editor/EditorPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { JoinPage } from '../features/sharing/JoinPage';
import { NotFoundPage } from './NotFoundPage';
import { RequireAuth } from './RequireAuth';

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <RequireAuth>
        <ProjectsPage />
      </RequireAuth>
    ),
  },
  { path: '/entrar', element: <LoginPage /> },
  {
    path: '/proyectos/:id',
    element: (
      <RequireAuth>
        <EditorPage />
      </RequireAuth>
    ),
  },
  { path: '/unirse/:token', element: <JoinPage /> },
  { path: '*', element: <NotFoundPage /> },
]);
