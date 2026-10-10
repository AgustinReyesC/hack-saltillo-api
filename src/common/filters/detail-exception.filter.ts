import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { BaseWsExceptionFilter } from '@nestjs/websockets';

// El contrato responde todos los errores como {"detail": "<mensaje>"}. Los errores de los
// gateways de WebSocket se dejan al filtro de socket.io (emite `exception` al cliente).
@Catch()
export class DetailExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DetailExceptionFilter.name);
  private readonly wsFilter = new BaseWsExceptionFilter();

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'ws') {
      this.wsFilter.catch(exception, host);
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const response = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      httpAdapter.reply(
        response,
        { detail: toDetail(exception) },
        exception.getStatus(),
      );
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    httpAdapter.reply(
      response,
      { detail: 'Internal server error' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

// Nest guarda el mensaje como texto o, en errores de validación, como lista de textos.
function toDetail(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const { message } = body as { message?: unknown };
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  if (typeof message === 'string') {
    return message;
  }
  return exception.message;
}
