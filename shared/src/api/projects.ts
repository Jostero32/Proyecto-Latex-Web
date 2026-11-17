// Contratos de /api/projects, archivos, miembros y enlaces. Ver docs/specs/backend.md.
import type { Engine } from '../compilation';

export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Roles que se pueden asignar a un miembro o a un enlace (dueño hay uno solo: quien creó el proyecto). */
export const ASSIGNABLE_ROLES = ['editor', 'viewer'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const FILE_KINDS = ['text', 'binary'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Fechas en ISO 8601. */
export interface ProjectSummary {
  id: string;
  name: string;
  mainFile: string;
  engine: Engine;
  /** Mi rol en el proyecto. */
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  id: string;
  path: string;
  kind: FileKind;
  size: number;
  updatedAt: string;
}

export interface ProjectMember {
  userId: string;
  email: string;
  name: string | null;
  role: ProjectRole;
}

export interface ShareLink {
  id: string;
  role: AssignableRole;
  createdAt: string;
  expiresAt: string | null;
}

/** Solo en la respuesta de creación: el token no se puede volver a ver. */
export interface CreatedShareLink extends ShareLink {
  token: string;
}

// Respuestas
export interface ProjectResponse { project: ProjectSummary }
export interface ProjectListResponse { projects: ProjectSummary[] }
export interface FileListResponse { files: ProjectFile[] }
export interface FileResponse { file: ProjectFile }
export interface MemberListResponse { members: ProjectMember[] }
export interface ShareLinkListResponse { links: ShareLink[] }
export interface JoinResponse { projectId: string; role: ProjectRole }

// Peticiones
export interface CreateProjectRequest { name: string }
export interface UpdateProjectRequest { name?: string; mainFile?: string; engine?: Engine }
export interface RenameFileRequest { path: string }
export interface UpdateMemberRequest { role: AssignableRole }
export interface CreateShareLinkRequest { role: AssignableRole; expiresInDays?: number }

export type ProjectsErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_request'
  | 'invalid_name'
  | 'invalid_path'
  | 'path_conflict'
  | 'invalid_main_file'
  | 'invalid_engine'
  | 'not_text'
  | 'invalid_zip'
  | 'too_many_files'
  | 'project_too_large'
  | 'document_too_large'
  | 'file_too_large'
  | 'cannot_change_owner'
  | 'invalid_link';
