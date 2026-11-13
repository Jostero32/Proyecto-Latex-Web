export const SERVICE_NAMES = ['web', 'server', 'compiler'] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

export const COMPILE_QUEUE = 'compile';

export * from './compilation';
export * from './project-paths';
