/**
 * Environment configuration.
 *
 * Values are read once at startup and validated eagerly so that a
 * misconfigured environment fails immediately with a clear message rather
 * than surfacing as an obscure runtime error on the first request.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optionalPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Environment variable "${name}" must be a valid port number, got "${raw}".`);
  }
  return parsed;
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    port: optionalPort("PORT", 4000),
  };
}
