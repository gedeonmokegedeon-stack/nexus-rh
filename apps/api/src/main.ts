import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from './config/app-config';
import { createNexusApiApp } from './app.factory';

async function bootstrap(): Promise<void> {
  const logger = new Logger('NexusRH-API');
  const config = loadAppConfig();
  const app = await createNexusApiApp(config);

  await app.listen(config.port, config.host);
  logger.log(
    `NEXUS RH API démarrée sur http://${config.host}:${config.port}/api/v1 [profil=${config.infraProfile}]`,
  );
}

bootstrap().catch((err) => {
  console.error('[FATAL] Échec du démarrage de NEXUS RH API :', err);
  process.exit(1);
});
