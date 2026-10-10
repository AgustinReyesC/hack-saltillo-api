import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  let service: HealthService;
  const dataSource = { query: vi.fn() };

  beforeEach(async () => {
    dataSource.query.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthService, { provide: DataSource, useValue: dataSource }],
    }).compile();

    service = module.get(HealthService);
  });

  it('devuelve los eventos pendientes y sin publicar', async () => {
    dataSource.query.mockResolvedValue([
      { pending_events: 2, unpublished_events: 5 },
    ]);

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      pending_events: 2,
      unpublished_events: 5,
    });
  });

  it('responde 503 si la base no contesta', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dataSource.query.mockRejectedValue(new Error('connection refused'));

    await expect(service.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
