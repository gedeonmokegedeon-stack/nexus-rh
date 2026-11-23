import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Response } from 'express';
import { uuidv7 } from '@nexus-rh/crypto-audit';
import { AppModule } from './app.module';
import { isAllowedBrowserOrigin, type AppConfig } from './config/app-config';
import type { NexusRequest } from './common/security';

const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export async function createNexusApiApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bodyParser: false,
    logger: config.nodeEnv === 'test' ? ['error', 'warn'] : ['log', 'warn', 'error'],
  });

  // Limite stricte 8 Mo (permet le téléversement contrôlé de pièces RH <= 5 Mo tout en bloquant les abus DoS)
  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '256kb' });

  const httpAdapter = app.getHttpAdapter().getInstance();
  if (typeof httpAdapter?.disable === 'function') {
    httpAdapter.disable('x-powered-by');
  }

  // En-têtes de sécurité HTTP (D-06), configuration proxy de confiance (D-02) et X-Request-Id
  app.use((req: NexusRequest, res: Response, next: NextFunction) => {
    const incomingId = req.headers['x-request-id'];
    const requestId =
      typeof incomingId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(incomingId)
        ? incomingId
        : uuidv7();

    req.requestId = requestId;
    req.trustedProxyCount = config.security.trustedProxyCount;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (config.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
  });

  app.setGlobalPrefix('api/v1');

  // D-06 : CORS sur liste blanche stricte (jamais de réflexion aveugle `origin: true` avec credentials)
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, isAllowedBrowserOrigin(origin, config));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Nexus-CSRF'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  });

  app.enableShutdownHooks();
  await app.init();
  return app;
}
