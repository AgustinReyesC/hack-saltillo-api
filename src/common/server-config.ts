import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnvironment = 'local' | 'dev';

// Lo que aceptan `cors` (HTTP) y socket.io (WebSocket).
export type CorsOrigin = string | RegExp;

export interface HttpsSettings {
  port: number;
  keyPath: string;
  certPath: string;
}

export interface ServerConfig {
  environment: AppEnvironment;
  httpPort: number;
  // null = solo HTTP (en dev el TLS lo puede terminar el balanceador delante de ECS).
  https: HttpsSettings | null;
  corsOrigins: CorsOrigin[];
}

const ENVIRONMENTS: readonly AppEnvironment[] = ['local', 'dev'];

// Las pruebas de contrato y el agente llaman por HTTP al 8000.
const DEFAULT_HTTP_PORT = 8000;
const DEFAULT_HTTPS_PORT = 8443;

// En local la UI se abre en la laptop (localhost) o en el celular con la IP de la laptop en la red
// local, que cambia con el DHCP: se aceptan esos orígenes en cualquier puerto.
const LOCAL_ORIGINS: RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
  /^https?:\/\/(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?$/,
];

// Un origen es esquema + host + puerto opcional, sin ruta: `https://d1234.cloudfront.net`.
const ORIGIN_RE = /^https?:\/\/[^/\s]+$/;

// Lee la configuración del servidor de `process.env`. Falla al arrancar si algo está mal escrito,
// en lugar de dejar la UI sin CORS sin decir por qué.
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const environment = env.NODE_ENV as AppEnvironment;
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `NODE_ENV debe ser ${ENVIRONMENTS.join(' o ')}; llegó "${env.NODE_ENV ?? ''}"`,
    );
  }

  const origins = parseOrigins(env.CORS_ORIGINS);
  if (environment === 'dev' && origins.length === 0) {
    throw new Error(
      'CORS_ORIGINS es obligatorio en dev: el dominio de CloudFront de la UI',
    );
  }

  const httpPort = parsePort(env.PORT, DEFAULT_HTTP_PORT, 'PORT');
  const https = parseHttps(env);
  if (https && https.port === httpPort) {
    throw new Error(`HTTPS_PORT y PORT no pueden ser el mismo (${httpPort})`);
  }

  return {
    environment,
    httpPort,
    https,
    corsOrigins:
      environment === 'local' ? [...origins, ...LOCAL_ORIGINS] : origins,
  };
}

// Lee la llave y el certificado. Las rutas relativas parten de la raíz del repo (donde corre npm).
export function readHttpsCredentials(settings: HttpsSettings): {
  key: Buffer;
  cert: Buffer;
} {
  return {
    key: readPem('HTTPS_KEY_PATH', settings.keyPath),
    cert: readPem('HTTPS_CERT_PATH', settings.certPath),
  };
}

function readPem(variable: string, path: string): Buffer {
  try {
    return readFileSync(resolve(path));
  } catch (error) {
    throw new Error(
      `No se pudo leer ${variable}=${path}: ${(error as Error).message}. ` +
        'En local se genera con `npm run cert:local -- <ip-de-la-laptop>`.',
    );
  }
}

function parseOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
  const invalid = origins.find((origin) => !ORIGIN_RE.test(origin));
  if (invalid !== undefined) {
    throw new Error(
      `CORS_ORIGINS tiene un origen inválido: "${invalid}" (formato https://dominio[:puerto])`,
    );
  }
  return origins;
}

function parseHttps(env: NodeJS.ProcessEnv): HttpsSettings | null {
  const keyPath = env.HTTPS_KEY_PATH?.trim() ?? '';
  const certPath = env.HTTPS_CERT_PATH?.trim() ?? '';
  if (!keyPath && !certPath) {
    return null;
  }
  if (!keyPath || !certPath) {
    throw new Error(
      'HTTPS_KEY_PATH y HTTPS_CERT_PATH van juntas: llena las dos o deja las dos vacías',
    );
  }
  return {
    port: parsePort(env.HTTPS_PORT, DEFAULT_HTTPS_PORT, 'HTTPS_PORT'),
    keyPath,
    certPath,
  };
}

function parsePort(
  value: string | undefined,
  fallback: number,
  variable: string,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variable} debe ser un puerto válido; llegó "${value}"`);
  }
  return port;
}
