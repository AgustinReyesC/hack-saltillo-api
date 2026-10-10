import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

const INT32_MAX = 2_147_483_647;

// El contrato responde 404 (no 400) cuando un id de la ruta no es un entero válido.
@Injectable()
export class IntIdPipe implements PipeTransform<string, number> {
  constructor(
    private readonly resource = 'Resource',
    private readonly max = INT32_MAX,
  ) {}

  transform(value: string): number {
    const id = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(id) || id < 1 || id > this.max) {
      throw new NotFoundException(`${this.resource} not found`);
    }
    return id;
  }
}
