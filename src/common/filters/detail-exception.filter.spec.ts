import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DetailExceptionFilter } from './detail-exception.filter.js';

describe('DetailExceptionFilter', () => {
  const reply = vi.fn();
  const response = {};
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const filter = new DetailExceptionFilter({
    httpAdapter: { reply },
  } as unknown as HttpAdapterHost);

  beforeEach(() => {
    reply.mockReset();
  });

  it('usa el mensaje de una HttpException', () => {
    filter.catch(new NotFoundException('Part not found'), host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { detail: 'Part not found' },
      HttpStatus.NOT_FOUND,
    );
  });

  it('une los mensajes de validación en un solo texto', () => {
    const exception = new UnprocessableEntityException([
      'quantity must be an integer number',
      'reason should not be empty',
    ]);

    filter.catch(exception, host);

    expect(reply).toHaveBeenCalledWith(
      response,
      {
        detail:
          'quantity must be an integer number; reason should not be empty',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('usa el mensaje por defecto de una HttpException sin argumentos', () => {
    filter.catch(new BadRequestException(), host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { detail: 'Bad Request' },
      HttpStatus.BAD_REQUEST,
    );
  });

  it('usa el texto tal cual cuando la respuesta es un string', () => {
    filter.catch(
      new HttpException('Already resolved', HttpStatus.CONFLICT),
      host,
    );

    expect(reply).toHaveBeenCalledWith(
      response,
      { detail: 'Already resolved' },
      HttpStatus.CONFLICT,
    );
  });

  it('oculta los errores inesperados detrás de un 500', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    filter.catch(new Error('relation "part" does not exist'), host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { detail: 'Internal server error' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });
});
