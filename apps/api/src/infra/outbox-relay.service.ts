import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  NexusDatabase,
  type OutboxRelayOptions,
  type OutboxRelayResult,
} from '@nexus-rh/database';
import type { AppConfig } from '../config/app-config';
import {
  APP_CONFIG,
  CACHE_LOCK_PORT,
  MESSAGE_BUS_PORT,
  NEXUS_DB,
  type CacheLockPort,
  type MessageBusPort,
} from './ports';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const RELAY_LOCK_NAME = 'outbox:relay-worker';
const RELAY_LOCK_TTL_SECONDS = 30;

/**
 * Relayeur périodique de l'Outbox transactionnel (`outbox_events` -> RabbitMQ / bus).
 * - Coordonné par verrou distribué (`CACHE_LOCK_PORT`) + `FOR UPDATE SKIP LOCKED` SQL ;
 * - Respecte strictement la RLS de chaque tenant lors de la mise à jour des statuts ;
 * - Applique un recul exponentiel et bascule en `DLQ` après le plafond de tentatives ;
 * - Désactive le minuteur de fond en `NODE_ENV=test` (exposable à la demande via `runOnce`).
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NEXUS_DB) private readonly db: NexusDatabase,
    @Inject(CACHE_LOCK_PORT) private readonly cache: CacheLockPort,
    @Inject(MESSAGE_BUS_PORT) private readonly bus: MessageBusPort,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.nodeEnv === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.logger.warn(
          `Cycle de reprise outbox interrompu : ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(options: OutboxRelayOptions = {}): Promise<OutboxRelayResult> {
    if (this.running) {
      return { scanned: 0, published: 0, rescheduled: 0, deadLettered: 0 };
    }

    const lockToken = await this.cache.acquireLock(RELAY_LOCK_NAME, RELAY_LOCK_TTL_SECONDS);
    if (!lockToken) {
      return { scanned: 0, published: 0, rescheduled: 0, deadLettered: 0 };
    }

    this.running = true;
    try {
      return await this.db.relayPendingOutboxEvents(
        async (msg) => {
          await this.bus.publish({
            eventId: msg.eventId,
            tenantId: msg.tenantId,
            exchange: msg.exchange,
            routingKey: msg.routingKey,
            occurredAt: msg.occurredAt,
            payload: msg.payload,
          });
        },
        options,
      );
    } finally {
      this.running = false;
      await this.cache.releaseLock(RELAY_LOCK_NAME, lockToken).catch(() => undefined);
    }
  }
}
