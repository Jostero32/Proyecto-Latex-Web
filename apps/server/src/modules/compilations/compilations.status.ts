// Traducción del job de BullMQ a la respuesta de estado y a la disponibilidad de los artefactos.
// Funciones puras. Ver docs/specs/compilacion.md, "Estados y resultado" y "Endpoints".
import type { ArtifactKind, CompilationErrorCode, CompilationStatusResponse } from '@latexweb/shared';
import type { JobSnapshot } from './compilations.queue';

export function buildStatusResponse(id: string, job: JobSnapshot, ttlSeconds: number): CompilationStatusResponse {
  const response: CompilationStatusResponse = {
    id,
    status: job.state === 'completed' ? (job.result?.outcome ?? 'failed') : job.state,
    engine: job.data.engine,
    mainFile: job.data.mainFile,
    createdAt: new Date(job.createdAt).toISOString(),
  };
  if (job.finishedAt !== undefined) {
    response.finishedAt = new Date(job.finishedAt).toISOString();
    response.expiresAt = new Date(job.finishedAt + ttlSeconds * 1000).toISOString();
  }
  const result = job.state === 'completed' ? job.result : undefined;
  if (result) {
    response.durationMs = result.durationMs;
    response.exitCode = result.exitCode;
    response.pdfMissingReason = result.pdfMissingReason;
    if (result.hasPdf) response.pdfUrl = `/compilations/${id}/pdf`;
    if (result.hasLog) response.logUrl = `/compilations/${id}/log`;
  }
  return response;
}

/** Códigos con los que puede fallar una descarga antes de mirar el disco. */
export type ArtifactErrorCode = Extract<
  CompilationErrorCode,
  'not_ready' | 'artifact_not_available' | 'pdf_too_large' | 'expired'
>;

export type ArtifactAvailability =
  | { available: true }
  | { available: false; statusCode: 404 | 409 | 410; code: ArtifactErrorCode };

/**
 * Si se puede intentar servir el artefacto según el estado del job (no mira el disco: si el
 * archivo ya no está, la ruta responde 410).
 */
export function artifactAvailability(
  job: JobSnapshot,
  kind: ArtifactKind,
  ttlSeconds: number,
  now: number = Date.now(),
): ArtifactAvailability {
  if (job.state === 'queued' || job.state === 'running') return { available: false, statusCode: 409, code: 'not_ready' };
  // Un fallo de infraestructura no deja artefactos.
  if (job.state === 'failed' || !job.result) return { available: false, statusCode: 404, code: 'artifact_not_available' };

  if (job.finishedAt !== undefined && now > job.finishedAt + ttlSeconds * 1000) {
    return { available: false, statusCode: 410, code: 'expired' };
  }
  if (kind === 'pdf' && !job.result.hasPdf) {
    return {
      available: false,
      statusCode: 404,
      code: job.result.pdfMissingReason === 'too_large' ? 'pdf_too_large' : 'artifact_not_available',
    };
  }
  if (kind === 'log' && !job.result.hasLog) return { available: false, statusCode: 404, code: 'artifact_not_available' };
  return { available: true };
}
