import { NotFoundException } from '@nestjs/common';
import { IntIdPipe } from './int-id.pipe.js';

describe('IntIdPipe', () => {
  const pipe = new IntIdPipe('Part');

  it('convierte un id entero', () => {
    expect(pipe.transform('305')).toBe(305);
  });

  it.each(['abc', '1.5', '-3', '0', '', '2147483648'])(
    'responde 404 con %j',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(
        new NotFoundException('Part not found'),
      );
    },
  );

  it('acepta un tope mayor para ids BIGSERIAL', () => {
    const bigPipe = new IntIdPipe('Receipt', Number.MAX_SAFE_INTEGER);
    expect(bigPipe.transform('2147483648')).toBe(2147483648);
  });
});
