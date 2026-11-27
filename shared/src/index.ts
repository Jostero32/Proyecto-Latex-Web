export const SERVICE_NAMES = ['web', 'server', 'compiler'] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

export const COMPILE_QUEUE = 'compile';

export * from './api/auth';
export * from './api/projects';
export * from './compilation';
export * from './env';
export * from './project-paths';

export * from './privacy';
