import { Controller, Get, Inject } from '@nestjs/common';
import { NexusDatabase } from '@nexus-rh/database';
import { BIOMETRIC_VENDOR_PRIORITY } from '@nexus-rh/shared-types';
import type { AppConfig } from '../../config/app-config';
import {
  APP_CONFIG,
  CACHE_LOCK_PORT,
  MESSAGE_BUS_PORT,
  NEXUS_DB,
  OBJECT_STORAGE_PORT,
  type CacheLockPort,
  type MessageBusPort,
  type ObjectStoragePort,
} from '../../infra/ports';
import { Public } from '../../common/security';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
    @Inject(MESSAGE_BUS_PORT) private readonly bus: MessageBusPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Public()
  @Get()
  async getHealth() {
    const [dbHealth, cacheHealth, busHealth, storageHealth] = await Promise.all([
      this.db.ping(),
      this.cache.health(),
      this.bus.health(),
      this.storage.health(),
    ]);

    return {
      service: 'nexus-rh-api',
      version: '0.2.0',
      mission: 'M2_CORE_HR',
      status:
        dbHealth.ok && cacheHealth.ok && busHealth.ok && storageHealth.ok ? 'healthy' : 'degraded',
      infraProfile: this.config.infraProfile,
      timestamp: new Date().toISOString(),
      components: {
        database: {
          adapter: this.db.driverKind,
          ok: dbHealth.ok,
          pgVersion: dbHealth.pgVersion,
          forceRlsTablesCount: dbHealth.rlsTablesCount,
          isSandboxFallback: this.db.driverKind === 'pglite',
        },
        cache: cacheHealth,
        messageBus: busHealth,
        objectStorage: storageHealth,
      },
      governance: {
        defaultBiometricStoragePolicy: 'DEVICE_ONLY',
        hardcodedPayrollRates: false,
        biometricConnectors: BIOMETRIC_VENDOR_PRIORITY.map((vendor) => ({
          vendor,
          maturity: 'SPECIFIED' as const,
          operationalOnRealHardware: false,
        })),
      },
    };
  }
}
