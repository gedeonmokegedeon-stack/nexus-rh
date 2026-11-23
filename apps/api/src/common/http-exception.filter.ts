import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { PasswordHasherOverloadedError } from '@nexus-rh/crypto-audit';
import type { NexusRequest } from './security';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<NexusRequest>();
    const requestId = req.requestId ?? 'unknown';

    if (exception instanceof PasswordHasherOverloadedError) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: exception.code,
        message: exception.message,
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        requestId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const payload =
        typeof raw === 'string'
          ? { code: 'HTTP_ERROR', message: raw }
          : (raw as Record<string, unknown>);

      res.status(status).json({
        ...payload,
        statusCode: status,
        requestId,
      });
      return;
    }

    // Ne jamais divulguer les détails internes SQL ou stack traces au client
    this.logger.error(
      `[${requestId}] Erreur interne sur ${req.method} ${req.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Une erreur interne est survenue. Veuillez réessayer.',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      requestId,
    });
  }
}
