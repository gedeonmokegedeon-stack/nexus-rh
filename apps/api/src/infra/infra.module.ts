import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { NexusDatabase } from '@nexus-rh/database';
import { type AppConfig } from '../config/app-config';
import {
  APP_CONFIG,
  CACHE_LOCK_PORT,
  MESSAGE_BUS_PORT,
  NEXUS_DB,
  OBJECT_STORAGE_PORT,
  type CacheLockPort,
  type MessageBusPort,
} from './ports';
import {
  RabbitMqBusAdapter,
  RedisCacheLockAdapter,
  S3ObjectStorageAdapter,
  SandboxMemoryCacheLockAdapter,
  SandboxMessageBusAdapter,
  SandboxObjectStorageAdapter,
} from './adapters';
import { OutboxRelayService } from './outbox-relay.service';

@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
    @Inject(MESSAGE_BUS_PORT) private readonly bus: MessageBusPort,
    @Inject(OutboxRelayService) private readonly outboxRelay: OutboxRelayService,
  ) {}

  static register(config: AppConfig) {
    return {
      module: InfraModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: NEXUS_DB,
          useFactory: async (): Promise<NexusDatabase> => {
            const db = await NexusDatabase.connect({
              profile: config.infraProfile,
              connectionString: config.databaseUrl,
              sslMode: config.databaseSslMode,
              sslCaCert: config.databaseSslCaCert,
              pgliteDataDir: config.pgliteDataDir,
            });
            if (config.infraProfile === 'sandbox') {
              await db.runMigrations();
              await db.seedSystemCatalog();
            }
            return db;
          },
        },
        {
          provide: CACHE_LOCK_PORT,
          useFactory: (): CacheLockPort => {
            if (config.infraProfile === 'sandbox') {
              return new SandboxMemoryCacheLockAdapter();
            }
            if (!config.redisUrl) {
              throw new Error('REDIS_URL obligatoire hors mode sandbox.');
            }
            return new RedisCacheLockAdapter(config.redisUrl, config.redisKeyPrefix);
          },
        },
        {
          provide: MESSAGE_BUS_PORT,
          useFactory: async (): Promise<MessageBusPort> => {
            if (config.infraProfile === 'sandbox') {
              return new SandboxMessageBusAdapter();
            }
            if (!config.rabbitmqUrl) {
              throw new Error('RABBITMQ_URL obligatoire hors mode sandbox.');
            }
            return RabbitMqBusAdapter.connect(config.rabbitmqUrl);
          },
        },
        {
          provide: OBJECT_STORAGE_PORT,
          useFactory: () => {
            if (config.infraProfile === 'sandbox') {
              return new SandboxObjectStorageAdapter(
                config.s3.sandboxDir,
                config.security.masterKek,
              );
            }
            return new S3ObjectStorageAdapter(config.s3);
          },
        },
        OutboxRelayService,
      ],
      exports: [
        APP_CONFIG,
        NEXUS_DB,
        CACHE_LOCK_PORT,
        MESSAGE_BUS_PORT,
        OBJECT_STORAGE_PORT,
        OutboxRelayService,
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.outboxRelay.onApplicationShutdown();
    await this.bus.close();
    await this.cache.close();
    await this.db.close();
  }
}
