// Configuración de apps/server. Único lugar donde se lee process.env (ver CLAUDE.md).

export interface ServerConfig {
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    // Solo localhost: en esta etapa el servidor no se expone fuera de la máquina.
    host: '127.0.0.1',
    port: Number(env.SERVER_PORT ?? 3000),
  };
}
