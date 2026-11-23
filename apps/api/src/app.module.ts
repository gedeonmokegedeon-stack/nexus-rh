import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config/app-config';
import { InfraModule } from './infra/infra.module';
import { AuthGuard } from './common/auth.guard';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter';
import { HealthController } from './modules/health/health.controller';
import { IamController } from './modules/iam/iam.controller';
import { IamService } from './modules/iam/iam.service';
import { TenantsController } from './modules/tenants/tenants.controller';
import { TenantsService } from './modules/tenants/tenants.service';
import { OrganizationController } from './modules/organization/organization.controller';
import { RbacController } from './modules/rbac/rbac.controller';
import { AuditController } from './modules/audit/audit.controller';
import { HrController } from './modules/hr/hr.controller';
import { HrService } from './modules/hr/hr.service';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.register(config)],
      controllers: [
        HealthController,
        IamController,
        TenantsController,
        OrganizationController,
        RbacController,
        AuditController,
        HrController,
      ],
      providers: [
        IamService,
        TenantsService,
        HrService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
      ],
    };
  }
}
