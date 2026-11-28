/** Metadatos de operaciones; no contiene texto, contraseñas ni tokens. */
export interface MutationAuditEvent {
  id: string;
  actorId: string;
  projectId: string | null;
  resourceId: string | null;
  action: string;
  source: 'http' | 'collab';
  outcome: 'pending' | 'applied' | 'unchanged' | 'denied' | 'failed';
  statusCode: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}
export interface ListMutationAuditResponse { events: MutationAuditEvent[] }
