import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CONSENT_TYPES,
  CONTRACT_TYPES,
  DOCUMENT_CATEGORIES,
  DRC_PROFESSIONAL_CATEGORIES,
  EMPLOYEE_STATUSES,
  IDENTITY_DOCUMENT_TYPES,
  MOBILE_MONEY_OPERATORS,
  createContractSchema,
  createDependentSchema,
  createEmployeeSchema,
  createJobPositionSchema,
  deleteEmployeeDocumentSchema,
  issueBadgeSchema,
  recordEmployeeConsentSchema,
  revokeBadgeSchema,
  rotateBadgePinSchema,
  updateContractStatusSchema,
  updateEmployeeSchema,
  uploadEmployeeDocumentSchema,
  verifyQrPinSchema,
  withdrawEmployeeConsentSchema,
} from '@nexus-rh/shared-types';
import { z } from 'zod';
import {
  CurrentPrincipal,
  ReqMeta,
  RequirePermissions,
  validateWithZod,
  type AuthenticatedPrincipal,
  type RequestMeta,
} from '../../common/security';
import { HrService } from './hr.service';

const uuidParamSchema = z.string().uuid('Identifiant UUID invalide.');

@Controller()
export class HrController {
  constructor(@Inject(HrService) private readonly hrService: HrService) {}

  // Référentiels RH RDC (catégories professionnelles, types de contrats, pièces, consentements)
  @RequirePermissions('employees.read')
  @Get('reference/hr-rdc')
  getHrReference() {
    return {
      professionalCategories: DRC_PROFESSIONAL_CATEGORIES,
      identityDocumentTypes: IDENTITY_DOCUMENT_TYPES,
      mobileMoneyOperators: MOBILE_MONEY_OPERATORS,
      contractTypes: CONTRACT_TYPES,
      documentCategories: DOCUMENT_CATEGORIES,
      consentTypes: CONSENT_TYPES,
    };
  }

  // 1. Postes & Catégories professionnelles RDC
  @RequirePermissions('employees.read')
  @Get('job-positions')
  async listJobPositions(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { jobPositions: await this.hrService.listJobPositions(principal) };
  }

  @RequirePermissions('employees.manage')
  @Post('job-positions')
  async createJobPosition(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createJobPositionSchema, body);
    return { jobPosition: await this.hrService.createJobPosition(principal, input, meta) };
  }

  // 2. Dossiers Employés RDC
  @RequirePermissions('employees.read')
  @Get('employees')
  async listEmployees(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('siteId') siteId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const validSiteId = siteId ? validateWithZod(uuidParamSchema, siteId) : undefined;
    const validStatus = status
      ? validateWithZod(z.enum(EMPLOYEE_STATUSES), status)
      : undefined;
    const list = await this.hrService.listEmployees(principal, {
      siteId: validSiteId,
      status: validStatus,
      search,
    });
    return { employees: list };
  }

  @RequirePermissions('employees.manage')
  @Post('employees')
  async createEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(createEmployeeSchema, body);
    return { employee: await this.hrService.createEmployee(principal, input, meta) };
  }

  @RequirePermissions('employees.read')
  @Get('employees/:id')
  async getEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { employee: await this.hrService.getEmployee(principal, employeeId) };
  }

  @RequirePermissions('employees.manage')
  @Patch('employees/:id')
  async updateEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(updateEmployeeSchema, body);
    return { employee: await this.hrService.updateEmployee(principal, employeeId, input, meta) };
  }

  @RequirePermissions('employees.pii.read')
  @Get('employees/:id/sensitive')
  async revealSensitiveData(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return {
      sensitive: await this.hrService.revealEmployeeSensitiveData(principal, employeeId, meta),
    };
  }

  // 3. Ayants droit RDC
  @RequirePermissions('employees.read')
  @Get('employees/:id/dependents')
  async listDependents(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { dependents: await this.hrService.listDependents(principal, employeeId) };
  }

  @RequirePermissions('employees.manage')
  @Post('employees/:id/dependents')
  async addDependent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(createDependentSchema, body);
    return this.hrService.addDependent(principal, employeeId, input, meta);
  }

  @RequirePermissions('employees.manage')
  @Delete('employees/:id/dependents/:dependentId')
  async archiveDependent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('dependentId') dependentId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validDepId = validateWithZod(uuidParamSchema, dependentId);
    return this.hrService.archiveDependent(principal, validEmpId, validDepId, meta);
  }

  // 4. Contrats de travail RDC
  @RequirePermissions('contracts.read')
  @Get('employees/:id/contracts')
  async listContracts(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { contracts: await this.hrService.listContracts(principal, employeeId, meta) };
  }

  @RequirePermissions('contracts.manage')
  @Post('employees/:id/contracts')
  async createContract(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(createContractSchema, body);
    return this.hrService.createContract(principal, employeeId, input, meta);
  }

  @RequirePermissions('contracts.manage')
  @Patch('employees/:id/contracts/:contractId/status')
  async updateContractStatus(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validContractId = validateWithZod(uuidParamSchema, contractId);
    const input = validateWithZod(updateContractStatusSchema, body);
    return {
      contract: await this.hrService.updateContractStatus(
        principal,
        validEmpId,
        validContractId,
        input,
        meta,
      ),
    };
  }

  // 5. Badges QR + Code PIN Argon2id
  @RequirePermissions('employees.read')
  @Get('employees/:id/badges')
  async listBadges(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { badges: await this.hrService.listBadges(principal, employeeId) };
  }

  @RequirePermissions('employees.badges.manage')
  @Post('employees/:id/badges')
  async issueBadge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(issueBadgeSchema, body);
    return this.hrService.issueBadge(principal, employeeId, input, meta);
  }

  @RequirePermissions('employees.badges.manage')
  @Patch('employees/:id/badges/:badgeId/pin')
  async rotateBadgePin(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('badgeId') badgeId: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validBadgeId = validateWithZod(uuidParamSchema, badgeId);
    const input = validateWithZod(rotateBadgePinSchema, body);
    return {
      badge: await this.hrService.rotateBadgePin(
        principal,
        validEmpId,
        validBadgeId,
        input,
        meta,
      ),
    };
  }

  @RequirePermissions('employees.badges.manage')
  @Patch('employees/:id/badges/:badgeId/revoke')
  async revokeBadge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('badgeId') badgeId: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validBadgeId = validateWithZod(uuidParamSchema, badgeId);
    const input = validateWithZod(revokeBadgeSchema, body);
    return {
      badge: await this.hrService.revokeBadge(principal, validEmpId, validBadgeId, input, meta),
    };
  }

  @RequirePermissions('employees.badges.verify')
  @Post('badges/verify-qr-pin')
  @HttpCode(200)
  async verifyQrPin(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const input = validateWithZod(verifyQrPinSchema, body);
    return this.hrService.verifyQrPin(principal, input, meta);
  }

  // 6. Coffre Documentaire S3
  @RequirePermissions('employees.documents.read')
  @Get('employees/:id/documents')
  async listDocuments(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { documents: await this.hrService.listDocuments(principal, employeeId) };
  }

  @RequirePermissions('employees.documents.manage')
  @Post('employees/:id/documents')
  async uploadDocument(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(uploadEmployeeDocumentSchema, body);
    return { document: await this.hrService.uploadDocument(principal, employeeId, input, meta) };
  }

  @RequirePermissions('employees.documents.read')
  @Get('employees/:id/documents/:documentId/download')
  async downloadDocument(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validDocId = validateWithZod(uuidParamSchema, documentId);
    return this.hrService.downloadDocument(principal, validEmpId, validDocId, meta);
  }

  @RequirePermissions('employees.documents.manage')
  @Delete('employees/:id/documents/:documentId')
  async deleteDocument(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validDocId = validateWithZod(uuidParamSchema, documentId);
    const input = validateWithZod(deleteEmployeeDocumentSchema, body);
    return this.hrService.deleteDocument(principal, validEmpId, validDocId, input, meta);
  }

  // 7. Registre légal des consentements RDC
  @RequirePermissions('employees.consents.read')
  @Get('employees/:id/consents')
  async listConsents(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    return { consents: await this.hrService.listConsents(principal, employeeId) };
  }

  @RequirePermissions('biometrics.consent.manage')
  @Post('employees/:id/consents')
  async recordConsent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const employeeId = validateWithZod(uuidParamSchema, id);
    const input = validateWithZod(recordEmployeeConsentSchema, body);
    return this.hrService.recordConsent(principal, employeeId, input, meta);
  }

  @RequirePermissions('biometrics.consent.manage')
  @Post('employees/:id/consents/:consentId/withdraw')
  @HttpCode(200)
  async withdrawConsent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('consentId') consentId: string,
    @Body() body: unknown,
    @ReqMeta() meta: RequestMeta,
  ) {
    const validEmpId = validateWithZod(uuidParamSchema, id);
    const validConsentId = validateWithZod(uuidParamSchema, consentId);
    const input = validateWithZod(withdrawEmployeeConsentSchema, body);
    return this.hrService.withdrawConsent(principal, validEmpId, validConsentId, input, meta);
  }
}
