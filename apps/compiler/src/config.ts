// Configuración de apps/compiler. Único lugar donde se lee process.env (ver CLAUDE.md).

export interface CompilerConfig {
  redisUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompilerConfig {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  };
}
