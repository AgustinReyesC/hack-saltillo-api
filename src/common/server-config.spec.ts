import { CorsOrigin, loadServerConfig } from './server-config.js';

// Lo mismo que hace `cors` con una lista de orígenes: texto exacto o expresión regular.
const allows = (origins: CorsOrigin[], origin: string) =>
  origins.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin),
  );

describe('loadServerConfig', () => {
  const CLOUDFRONT = 'https://d1234abcd.cloudfront.net';

  describe('local', () => {
    const config = loadServerConfig({ NODE_ENV: 'local' });

    it.each([
      'http://localhost:5173',
      'https://localhost:5173',
      'http://127.0.0.1:4173',
      'https://192.168.1.50:5173',
      'https://10.0.0.7:5173',
      'https://172.20.10.2:5173',
    ])('permite %s (laptop o celular en la red local)', (origin) => {
      expect(allows(config.corsOrigins, origin)).toBe(true);
    });

    it.each([
      'https://evil.com',
      'https://localhost.evil.com',
      'https://192.168.1.50.evil.com',
      'https://172.32.0.1:5173',
      CLOUDFRONT,
    ])('rechaza %s', (origin) => {
      expect(allows(config.corsOrigins, origin)).toBe(false);
    });

    it('suma los orígenes de CORS_ORIGINS a los locales', () => {
      const withExtra = loadServerConfig({
        NODE_ENV: 'local',
        CORS_ORIGINS: CLOUDFRONT,
      });
      expect(allows(withExtra.corsOrigins, CLOUDFRONT)).toBe(true);
      expect(allows(withExtra.corsOrigins, 'http://localhost:5173')).toBe(true);
    });

    it('sin certificado deja solo HTTP en el 8000', () => {
      expect(config.httpPort).toBe(8000);
      expect(config.https).toBeNull();
    });
  });

  describe('dev', () => {
    it('solo permite los orígenes de CORS_ORIGINS', () => {
      const config = loadServerConfig({
        NODE_ENV: 'dev',
        CORS_ORIGINS: `${CLOUDFRONT}/, https://admin.example.com`,
      });
      expect(config.corsOrigins).toEqual([
        CLOUDFRONT,
        'https://admin.example.com',
      ]);
      expect(allows(config.corsOrigins, 'http://localhost:5173')).toBe(false);
      expect(allows(config.corsOrigins, 'https://192.168.1.50:5173')).toBe(
        false,
      );
    });

    it('exige CORS_ORIGINS', () => {
      expect(() => loadServerConfig({ NODE_ENV: 'dev' })).toThrow(
        /CORS_ORIGINS es obligatorio/,
      );
    });

    it('rechaza un placeholder sin llenar', () => {
      expect(() =>
        loadServerConfig({ NODE_ENV: 'dev', CORS_ORIGINS: '<cloudfront-url>' }),
      ).toThrow(/origen inválido: "<cloudfront-url>"/);
    });
  });

  it.each([undefined, 'production', 'test'])('rechaza NODE_ENV=%s', (value) => {
    expect(() => loadServerConfig({ NODE_ENV: value })).toThrow(
      /NODE_ENV debe ser local o dev/,
    );
  });

  it('rechaza un origen con ruta', () => {
    expect(() =>
      loadServerConfig({
        NODE_ENV: 'local',
        CORS_ORIGINS: 'https://example.com/app',
      }),
    ).toThrow(/origen inválido/);
  });

  describe('HTTPS', () => {
    const certs = {
      NODE_ENV: 'local',
      HTTPS_KEY_PATH: 'certs/local-key.pem',
      HTTPS_CERT_PATH: 'certs/local-cert.pem',
    };

    it('se activa con llave y certificado, en el 8443 por defecto', () => {
      expect(loadServerConfig(certs).https).toEqual({
        port: 8443,
        keyPath: 'certs/local-key.pem',
        certPath: 'certs/local-cert.pem',
      });
    });

    it('usa HTTPS_PORT si viene', () => {
      expect(
        loadServerConfig({ ...certs, HTTPS_PORT: '9443' }).https?.port,
      ).toBe(9443);
    });

    it('exige llave y certificado juntos', () => {
      expect(() =>
        loadServerConfig({ NODE_ENV: 'local', HTTPS_KEY_PATH: 'key.pem' }),
      ).toThrow(/van juntas/);
    });

    it('no comparte puerto con HTTP', () => {
      expect(() =>
        loadServerConfig({ ...certs, PORT: '8443', HTTPS_PORT: '8443' }),
      ).toThrow(/no pueden ser el mismo/);
    });
  });

  it.each(['abc', '0', '70000', '80.5'])('rechaza PORT=%s', (value) => {
    expect(() => loadServerConfig({ NODE_ENV: 'local', PORT: value })).toThrow(
      /PORT debe ser un puerto válido/,
    );
  });
});
