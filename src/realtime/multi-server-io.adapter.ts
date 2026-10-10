import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server as HttpsServer } from 'node:https';
import type { Server, ServerOptions } from 'socket.io';
import type { CorsOrigin } from '../common/server-config.js';

// Un solo servidor de socket.io para todos los gateways, atendido en el servidor HTTP de Nest y en
// los servidores extra (HTTPS, para el celular). Cada servidor tiene su engine.io, pero los sockets
// son los mismos: un `emit` llega a la UI sin importar por cuál se conectó. El CORS de los
// WebSocket se fija aquí, con los mismos orígenes que el de HTTP.
export class MultiServerIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: CorsOrigin[],
    private readonly extraServers: HttpsServer[] = [],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Nest tipa `options` como completo, pero pasa solo lo del decorador; socket.io acepta parcial.
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins },
    } as ServerOptions);
    // Un gateway con puerto propio no comparte el servidor HTTP: tampoco los extra.
    if (port === 0) {
      for (const extra of this.extraServers) {
        server.attach(extra);
      }
    }
    return server;
  }
}
