// Rutas de la web. Paso 1 de docs/specs/frontend.md: pantallas con datos de ejemplo, sin API.
import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage';
import { EditorPage } from '../features/editor/EditorPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { JoinPage } from '../features/sharing/JoinPage';
import { NotFoundPage } from './NotFoundPage';

export const router = createBrowserRouter([
  { path: '/', element: <ProjectsPage /> },
  { path: '/entrar', element: <LoginPage /> },
  { path: '/proyectos/:id', element: <EditorPage /> },
  { path: '/unirse/:token', element: <JoinPage /> },
  { path: '*', element: <NotFoundPage /> },
]);
