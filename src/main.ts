import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:https';
import { AppModule } from './app.module.js';
import {
  loadServerConfig,
  readHttpsCredentials,
} from './common/server-config.js';
import { MultiServerIoAdapter } from './realtime/multi-server-io.adapter.js';

async function bootstrap() {
  // Antes de crear la app (que conecta a la base): un error de configuración falla de inmediato.
  const config = loadServerConfig(process.env);
  const credentials = config.https && readHttpsCredentials(config.https);
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.corsOrigins });
  // Con Ctrl+C o SIGTERM (ECS) el consumidor termina el mensaje en curso y deja de leer las colas.
  app.enableShutdownHooks();

  // HTTP se queda en PORT (pruebas de contrato y agente). HTTPS es un segundo servidor sobre la
  // misma app de Express: mismas rutas, mismo CORS y, con el adaptador, el mismo WebSocket. El
  // celular lo necesita porque la cámara solo abre en una página segura, y una página segura no
  // puede llamar a `http://` ni a `ws://`.
  const httpsServer = credentials
    ? createServer(credentials, app.getHttpAdapter().getInstance())
    : null;
  app.useWebSocketAdapter(
    new MultiServerIoAdapter(
      app,
      config.corsOrigins,
      httpsServer ? [httpsServer] : [],
    ),
  );

  await app.listen(config.httpPort);
  logger.log(
    `HTTP en el puerto ${config.httpPort} (NODE_ENV=${config.environment})`,
  );

  if (httpsServer && config.https) {
    const { port } = config.https;
    await new Promise<void>((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(port, resolve);
    });
    logger.log(`HTTPS en el puerto ${port}`);
  } else if (config.environment === 'local') {
    logger.warn(
      'HTTPS desactivado: sin HTTPS_KEY_PATH ni HTTPS_CERT_PATH el celular no puede usar la API. ' +
        'Genera el certificado con `npm run cert:local -- <ip-de-la-laptop>`.',
    );
  }
}
await bootstrap();
