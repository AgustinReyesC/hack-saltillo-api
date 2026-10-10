import { Test, TestingModule } from '@nestjs/testing';
import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

// Ruta solo de prueba para comprobar el ValidationPipe global (aún no hay rutas con cuerpo).
class ProbeDto {
  @IsInt()
  @Min(1)
  quantity: number;
}

@Controller('probe')
class ProbeController {
  @Post()
  create(@Body() body: ProbeDto): ProbeDto {
    return body;
  }
}

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health responde el estado de la base', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({
      status: 'ok',
      database: 'up',
      pending_events: expect.any(Number),
      unpublished_events: expect.any(Number),
    });
  });

  it('una ruta inexistente responde 404 con {detail}', async () => {
    const res = await request(app.getHttpServer())
      .get('/no-existe')
      .expect(404);

    expect(res.body).toEqual({ detail: 'Cannot GET /no-existe' });
  });

  it('un cuerpo inválido responde 422 con {detail}', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .send({ quantity: 0 })
      .expect(422);

    expect(res.body).toEqual({ detail: expect.any(String) });
    expect(res.body.detail).toContain('quantity');
  });

  it('un cuerpo válido pasa y se le quitan los campos no declarados', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .send({ quantity: 3, extra: 'x' })
      .expect(201);

    expect(res.body).toEqual({ quantity: 3 });
  });
});
