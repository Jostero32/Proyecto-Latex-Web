// Rutas de la web. Mis proyectos y el editor exigen sesión; unirse decide adentro (sin sesión, pide entrar).
import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router';
import { PrivacyPage, PrivacyAcceptancePage } from '../features/auth/PrivacyPage';
import { LoginPage } from '../features/auth/LoginPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { JoinPage } from '../features/sharing/JoinPage';
import { NotFoundPage } from './NotFoundPage';
import { FullScreenLoading, RequireAuth } from './RequireAuth';

// El editor trae CodeMirror y Yjs: va en su propio chunk, que se baja al abrir un proyecto.
const EditorPage = lazy(() => import('../features/editor/EditorPage').then((module) => ({ default: module.EditorPage })));

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
  { path: '/privacidad', element: <PrivacyPage /> },
  { path: '/privacidad/aceptar', element: <PrivacyAcceptancePage /> },
  {
    path: '/proyectos/:id',
    element: (
      <RequireAuth>
        <Suspense fallback={<FullScreenLoading />}>
          <EditorPage />
        </Suspense>
      </RequireAuth>
    ),
  },
  { path: '/unirse/:token', element: <JoinPage /> },
  { path: '*', element: <NotFoundPage /> },
]);
