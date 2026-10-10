import { UsePipes, ValidationPipe } from '@nestjs/common';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import { PartsQueryDto } from './dto/parts-query.dto.js';
import { PartsService } from './parts.service.js';

// La UI pide los productos por WebSocket; la respuesta llega en el ack del mensaje. El CORS lo fija
// `MultiServerIoAdapter` en main.ts.
@WebSocketGateway()
export class PartsGateway {
  constructor(private readonly partsService: PartsService) {}

  @SubscribeMessage('parts:list')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) =>
        new WsException(
          errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join('; '),
        ),
    }),
  )
  listParts(@MessageBody() query: PartsQueryDto) {
    return this.partsService.list(query ?? {});
  }
}
