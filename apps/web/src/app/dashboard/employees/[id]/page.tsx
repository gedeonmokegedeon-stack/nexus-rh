'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileLock2,
  FileSignature,
  HeartHandshake,
  KeyRound,
  Lock,
  QrCode,
  Scale,
  ShieldAlert,
  Trash2,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import {
  CONSENT_METHOD_LABELS,
  CONSENT_TYPE_LABELS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DEPENDENT_RELATION_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  EMPLOYEE_STATUS_LABELS,
  type EmployeeBadgeItem,
  type EmployeeConsentItem,
  type EmployeeDependentItem,
  type EmployeeDocumentItem,
  type EmployeeItem,
  type EmployeeSensitiveData,
  type EmploymentContractItem,
  IDENTITY_DOC_LABELS,
  type JobPositionItem,
  MARITAL_STATUS_LABELS,
  MOBILE_MONEY_LABELS,
  PAYMENT_METHOD_LABELS,
  type SiteOption,
  formatBytes,
  formatEmployeeFullName,
} from '@/lib/hr-types';

type DossierTab = 'profile' | 'dependents' | 'contracts' | 'badges' | 'documents' | 'consents';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function EmployeeDossierPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const { me, hasPermission } = useAuth();

  const [tab, setTab] = useState<DossierTab>('profile');
  const [employee, setEmployee] = useState<EmployeeItem | null>(null);
  const [sensitive, setSensitive] = useState<EmployeeSensitiveData | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [positions, setPositions] = useState<JobPositionItem[]>([]);
  const [dependents, setDependents] = useState<EmployeeDependentItem[]>([]);
  const [contracts, setContracts] = useState<EmploymentContractItem[]>([]);
  const [contractAdvisories, setContractAdvisories] = useState<string[]>([]);
  const [badges, setBadges] = useState<EmployeeBadgeItem[]>([]);
  const [documents, setDocuments] = useState<EmployeeDocumentItem[]>([]);
  const [consents, setConsents] = useState<EmployeeConsentItem[]>([]);

  // Jeton QR affiché UNE SEULE FOIS lors de l'émission
  const [issuedQrOnce, setIssuedQrOnce] = useState<{
    badgeCode: string;
    payload: string;
    dataUrl: string;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Permissions granulaires
  const canUpdateEmp = hasPermission('employees.update');
  const canReadPii = hasPermission('employees.pii.read');
  const canReadContracts = hasPermission('contracts.read');
  const canManageContracts = hasPermission('contracts.manage');
  const canManageSalary = hasPermission('employees.salary.manage');
  const canManageBadges = hasPermission('employees.badges.manage');
  const canReadDocs = hasPermission('employees.documents.read');
  const canManageDocs = hasPermission('employees.documents.manage');
  const canReadConsents = hasPermission('employees.consents.read');
  const canManageConsents = hasPermission('employees.consents.manage');

  // Formulaires par onglet
  const [statusForm, setStatusForm] = useState({
    status: 'ACTIVE',
    terminationDate: '',
    terminationReason: '',
  });

  const [depForm, setDepForm] = useState({
    fullName: '',
    relationship: 'CHILD_LEGITIMATE',
    birthDate: '',
    isTaxDependent: true,
    notes: '',
  });

  const [contractForm, setContractForm] = useState({
    contractNumber: '',
    contractType: 'CDI' as EmploymentContractItem['contractType'],
    siteId: '',
    jobPositionId: '',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    probationEndDate: '',
    cddRenewalCount: 0,
    weeklyHours: 45,
    payCurrency: 'CDF' as 'CDF' | 'USD',
    payFrequency: 'MONTHLY' as 'MONTHLY' | 'DAILY',
    baseSalary: '',
    hiringPlace: '',
    onemVisaRef: '',
    signedDocumentId: '',
    status: 'ACTIVE' as 'DRAFT' | 'ACTIVE',
  });

  const [badgeIssueForm, setBadgeIssueForm] = useState({
    pin: '',
    expiresAt: '',
    replaceReason: '',
  });
  const [pinRotateTarget, setPinRotateTarget] = useState<string | null>(null);
  const [pinRotateForm, setPinRotateForm] = useState({ newPin: '', reason: '' });

  const [docForm, setDocForm] = useState({
    category: 'IDENTITY_DOC',
    title: '',
    retentionUntil: '',
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // STRICTEMENT NON PRÉ-COCHÉ (Ordonnance-Loi RDC n° 23/010)
  const [consentForm, setConsentForm] = useState({
    consentType: 'HR_DATA_PROCESSING',
    decision: '' as '' | 'GRANTED' | 'REFUSED',
    policyVersion: 'RDC-2026.1',
    collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
    noticeSummary: '',
    alternativeQrPinOffered: false,
    signedDocumentId: '',
  });

  const loadDossier = useCallback(async () => {
    if (!employeeId || !me?.activeTenant) return;
    setLoading(true);
    setError(null);
    try {
      const [empRes, depRes, badgeRes, siteRes, posRes, ctrRes, docRes, conRes] = await Promise.all(
        [
          api.get<{ employee: EmployeeItem }>(`/employees/${employeeId}`),
          api.get<{ dependents: EmployeeDependentItem[] }>(`/employees/${employeeId}/dependents`),
          api.get<{ badges: EmployeeBadgeItem[] }>(`/employees/${employeeId}/badges`),
          hasPermission('organization.sites.read')
            ? api.get<{ sites: SiteOption[] }>('/sites').catch(() => ({ sites: [] }))
            : Promise.resolve({ sites: [] }),
          api
            .get<{ jobPositions: JobPositionItem[] }>('/job-positions')
            .catch(() => ({ jobPositions: [] })),
          canReadContracts
            ? api
                .get<{ contracts: EmploymentContractItem[] }>(`/employees/${employeeId}/contracts`)
                .catch(() => ({ contracts: [] }))
            : Promise.resolve({ contracts: [] }),
          canReadDocs
            ? api
                .get<{ documents: EmployeeDocumentItem[] }>(`/employees/${employeeId}/documents`)
                .catch(() => ({ documents: [] }))
            : Promise.resolve({ documents: [] }),
          canReadConsents
            ? api
                .get<{ consents: EmployeeConsentItem[] }>(`/employees/${employeeId}/consents`)
                .catch(() => ({ consents: [] }))
            : Promise.resolve({ consents: [] }),
        ],
      );

      setEmployee(empRes.employee);
      setStatusForm({
        status: empRes.employee.status,
        terminationDate: empRes.employee.terminationDate ?? new Date().toISOString().slice(0, 10),
        terminationReason: empRes.employee.terminationReason ?? '',
      });
      setDependents(depRes.dependents);
      setBadges(badgeRes.badges);
      setSites(siteRes.sites);
      setPositions(posRes.jobPositions);
      setContracts(ctrRes.contracts);
      setDocuments(docRes.documents);
      setConsents(conRes.consents);

      const primarySite = siteRes.sites.find((s) => s.id === empRes.employee.primarySiteId);
      setContractForm((prev) => ({
        ...prev,
        siteId: prev.siteId || empRes.employee.primarySiteId,
        jobPositionId: prev.jobPositionId || empRes.employee.jobPositionId || '',
        hiringPlace: prev.hiringPlace || primarySite?.city || empRes.employee.city || '',
        payCurrency:
          me.activeTenant?.defaultCurrency === 'USD' ? 'USD' : ('CDF' as 'CDF' | 'USD'),
      }));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Impossible de charger le dossier de cet employé.',
      );
    } finally {
      setLoading(false);
    }
  }, [employeeId, me?.activeTenant, hasPermission, canReadContracts, canReadDocs, canReadConsents]);

  useEffect(() => {
    void loadDossier();
  }, [loadDossier]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
        Chargement sécurisé du dossier individuel…
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Link
          href="/dashboard/employees"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Retour au répertoire
        </Link>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
          {error ?? 'Dossier employé introuvable ou hors de votre périmètre d’autorisation.'}
        </div>
      </div>
    );
  }

  const primarySite = sites.find((s) => s.id === employee.primarySiteId);
  const currentPosition = positions.find((p) => p.id === employee.jobPositionId);
  const tenantIsDeviceOnly =
    (me?.activeTenant?.biometricStoragePolicy ?? 'DEVICE_ONLY') === 'DEVICE_ONLY' ||
    !me?.activeTenant?.centralTemplateStorageEnabled;

  // --- Handlers ---

  async function handleToggleSensitive() {
    if (sensitive) {
      setSensitive(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<{ sensitive: EmployeeSensitiveData }>(
        `/employees/${employeeId}/sensitive`,
      );
      setSensitive(res.sensitive);
      setNotice(
        'Identifiants chiffrés révélés temporairement — cet accès a été consigné dans la chaîne d’audit SHA-256.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Accès refusé aux identifiants sensibles.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateStatus(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { status: statusForm.status };
      if (statusForm.status === 'TERMINATED') {
        payload.terminationDate = statusForm.terminationDate;
        payload.terminationReason = statusForm.terminationReason.trim();
      }
      await api.patch(`/employees/${employeeId}`, payload);
      setNotice('Statut administratif du dossier mis à jour et audité.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la mise à jour du statut.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAddDependent(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/employees/${employeeId}/dependents`, {
        fullName: depForm.fullName.trim(),
        relationship: depForm.relationship,
        birthDate: depForm.birthDate || null,
        isTaxDependent: depForm.isTaxDependent,
        notes: depForm.notes.trim() || null,
      });
      setDepForm({
        fullName: '',
        relationship: 'CHILD_LEGITIMATE',
        birthDate: '',
        isTaxDependent: true,
        notes: '',
      });
      setNotice('Ayant droit enregistré et nombre de personnes à charge recalculé.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de l’ajout de l’ayant droit.');
    } finally {
      setBusy(false);
    }
  }

  async function handleArchiveDependent(depId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/employees/${employeeId}/dependents/${depId}`);
      setNotice('Ayant droit archivé et charge fiscale mise à jour.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible d’archiver cet ayant droit.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateContract(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setContractAdvisories([]);
    try {
      const res = await api.post<{
        contract: EmploymentContractItem;
        complianceAdvisories: string[];
      }>(`/employees/${employeeId}/contracts`, {
        contractNumber: contractForm.contractNumber.trim(),
        contractType: contractForm.contractType,
        siteId: contractForm.siteId,
        jobPositionId: contractForm.jobPositionId || null,
        startDate: contractForm.startDate,
        endDate: contractForm.contractType === 'CDI' ? null : contractForm.endDate || null,
        probationEndDate: contractForm.probationEndDate || null,
        cddRenewalCount: Number(contractForm.cddRenewalCount) || 0,
        weeklyHours: Number(contractForm.weeklyHours) || 45,
        payCurrency: contractForm.payCurrency,
        payFrequency: contractForm.payFrequency,
        baseSalary: contractForm.baseSalary.trim(),
        hiringPlace: contractForm.hiringPlace.trim(),
        onemVisaRef: contractForm.onemVisaRef.trim() || null,
        signedDocumentId: contractForm.signedDocumentId || null,
        status: contractForm.status,
      });
      setContractAdvisories(res.complianceAdvisories ?? []);
      setContractForm((prev) => ({
        ...prev,
        contractNumber: '',
        endDate: '',
        probationEndDate: '',
        baseSalary: '',
        onemVisaRef: '',
        signedDocumentId: '',
      }));
      setNotice(
        `Contrat ${res.contract.contractNumber} (${res.contract.contractType}) créé — rémunération chiffrée AES-256-GCM.`,
      );
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de l’enregistrement du contrat.');
    } finally {
      setBusy(false);
    }
  }

  async function handleContractTransition(
    contractId: string,
    newStatus: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'TERMINATED',
  ) {
    const reason = window.prompt(
      `Motif obligatoire pour le passage du contrat au statut ${CONTRACT_STATUS_LABELS[newStatus]} :`,
    );
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/employees/${employeeId}/contracts/${contractId}/status`, {
        status: newStatus,
        reason: reason.trim(),
      });
      setNotice('Statut du contrat mis à jour et consigné au journal d’audit.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de modifier ce contrat.');
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueBadge(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hasActive = badges.some((b) => b.status === 'ACTIVE');
      const res = await api.post<{ badge: EmployeeBadgeItem; qrPayloadOnce: string }>(
        `/employees/${employeeId}/badges`,
        {
          pin: badgeIssueForm.pin.trim(),
          expiresAt: badgeIssueForm.expiresAt || null,
          replaceReason: hasActive
            ? badgeIssueForm.replaceReason.trim() || 'Renouvellement de badge demandé par RH'
            : null,
        },
      );
      const dataUrl = await QRCode.toDataURL(res.qrPayloadOnce, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 240,
      });
      setIssuedQrOnce({
        badgeCode: res.badge.badgeCode,
        payload: res.qrPayloadOnce,
        dataUrl,
      });
      setBadgeIssueForm({ pin: '', expiresAt: '', replaceReason: '' });
      setNotice(
        `Badge ${res.badge.badgeCode} émis (PIN haché Argon2id 64 Mio). Imprimez ou remettez le QR ci-dessous maintenant : il ne sera plus jamais réaffiché.`,
      );
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de l’émission du badge QR+PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRotatePin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinRotateTarget) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/employees/${employeeId}/badges/${pinRotateTarget}/pin`, {
        newPin: pinRotateForm.newPin.trim(),
        reason: pinRotateForm.reason.trim(),
      });
      setPinRotateTarget(null);
      setPinRotateForm({ newPin: '', reason: '' });
      setNotice('Code PIN réinitialisé (Argon2id) et verrouillage levé.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la réinitialisation du PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeBadge(badgeId: string, status: 'REVOKED' | 'LOST') {
    const reason = window.prompt(
      `Motif obligatoire (${status === 'LOST' ? 'déclaration de perte' : 'révocation'}) :`,
    );
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/employees/${employeeId}/badges/${badgeId}/revoke`, {
        status,
        reason: reason.trim(),
      });
      setIssuedQrOnce(null);
      setNotice('Badge immédiatement révoqué et inutilisable.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la révocation du badge.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadDocument(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile) {
      setError('Veuillez sélectionner un fichier PDF, PNG, JPEG ou WebP (max. 5 Mo).');
      return;
    }
    if (!ALLOWED_MIMES.has(selectedFile.type)) {
      setError('Format non autorisé. Formats acceptés : PDF, PNG, JPEG, WebP.');
      return;
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      setError('La taille du document dépasse la limite de sécurité de 5 Mo.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const contentBase64 = arrayBufferToBase64(await selectedFile.arrayBuffer());
      const res = await api.post<{ document: EmployeeDocumentItem }>(
        `/employees/${employeeId}/documents`,
        {
          category: docForm.category,
          title: docForm.title.trim(),
          originalFilename: selectedFile.name,
          mimeType: selectedFile.type,
          contentBase64,
          retentionUntil: docForm.retentionUntil || null,
        },
      );
      setSelectedFile(null);
      setDocForm({ category: 'IDENTITY_DOC', title: '', retentionUntil: '' });
      setNotice(
        `Pièce « ${res.document.title} » chiffrée AES-256-GCM et archivée (SHA-256 : ${res.document.sha256Checksum.slice(0, 16)}…).`,
      );
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec du téléversement sécurisé.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadDocument(doc: EmployeeDocumentItem) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<{
        document: { originalFilename: string; mimeType: string; sha256Verified: boolean };
        contentBase64: string;
      }>(`/employees/${employeeId}/documents/${doc.id}/download`);
      const bin = atob(res.contentBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.document.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.document.originalFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        `Document déchiffré et intégrité SHA-256 vérifiée (${res.document.originalFilename}).`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec du téléchargement de la pièce.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteDocument(docId: string) {
    const reason = window.prompt(
      'Motif légal obligatoire pour le retrait de cette pièce du coffre S3 :',
    );
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/employees/${employeeId}/documents/${docId}`, { reason: reason.trim() });
      setNotice('Pièce retirée du coffre S3 et opération journalisée.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Suppression refusée.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordConsent(e: React.FormEvent) {
    e.preventDefault();
    if (!consentForm.decision) {
      setError(
        'Veuillez sélectionner explicitement la décision de l’agent (Accordé ou Refusé). Aucun choix n’est présumé.',
      );
      return;
    }
    if (!consentForm.alternativeQrPinOffered) {
      setError(
        'Vous devez confirmer que l’alternative non-biométrique (Badge QR + Code PIN) sans pénalité a été proposée à l’agent.',
      );
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/employees/${employeeId}/consents`, {
        consentType: consentForm.consentType,
        decision: consentForm.decision,
        policyVersion: consentForm.policyVersion.trim(),
        collectionMethod: consentForm.collectionMethod,
        noticeSummary: consentForm.noticeSummary.trim(),
        alternativeQrPinOffered: true,
        signedDocumentId: consentForm.signedDocumentId || null,
      });
      // Réinitialisation strictement non pré-cochée
      setConsentForm({
        consentType: 'HR_DATA_PROCESSING',
        decision: '',
        policyVersion: 'RDC-2026.1',
        collectionMethod: 'WRITTEN_SIGNED_UPLOAD',
        noticeSummary: '',
        alternativeQrPinOffered: false,
        signedDocumentId: '',
      });
      setNotice('Décision de consentement enregistrée de manière probante et auditée.');
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de l’enregistrement du consentement.');
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdrawConsent(consentId: string) {
    const reason = window.prompt(
      'Motif ou référence de la demande de retrait (aucune pénalité — le badge QR + PIN reste actif) :',
    );
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/employees/${employeeId}/consents/${consentId}/withdraw`, {
        reason: reason.trim(),
      });
      setNotice(
        'Consentement retiré avec effet immédiat — l’agent conserve l’accès complet par Badge QR + Code PIN.',
      );
      await loadDossier();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec du retrait du consentement.');
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: DossierTab; label: string; icon: React.ElementType; visible: boolean }> =
    [
      { id: 'profile', label: 'Identité & PII', icon: UserCheck, visible: true },
      {
        id: 'dependents',
        label: `Ayants droit (${dependents.length})`,
        icon: HeartHandshake,
        visible: true,
      },
      {
        id: 'contracts',
        label: `Contrats RDC (${contracts.length})`,
        icon: FileSignature,
        visible: canReadContracts,
      },
      {
        id: 'badges',
        label: `Badges QR + PIN (${badges.length})`,
        icon: QrCode,
        visible: true,
      },
      {
        id: 'documents',
        label: `Coffre S3 (${documents.length})`,
        icon: FileLock2,
        visible: canReadDocs,
      },
      {
        id: 'consents',
        label: `Consentements (${consents.length})`,
        icon: Scale,
        visible: canReadConsents,
      },
    ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Fil d'Ariane + en-tête agent */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <Link
          href="/dashboard/employees"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Répertoire des employés RDC
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="rounded-md bg-blue-50 px-2.5 py-1 font-mono text-xs font-bold text-blue-800 ring-1 ring-blue-200">
                {employee.matricule}
              </span>
              <h1 className="text-xl font-bold text-slate-900">
                {formatEmployeeFullName(employee)}
              </h1>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  employee.status === 'ACTIVE'
                    ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                    : employee.status === 'TERMINATED'
                      ? 'bg-red-50 text-red-800 ring-1 ring-red-200'
                      : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                }`}
              >
                {EMPLOYEE_STATUS_LABELS[employee.status] ?? employee.status}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-600">
              {primarySite
                ? `${primarySite.code} — ${primarySite.name} (${primarySite.city}, ${primarySite.timezone})`
                : 'Établissement rattaché'}{' '}
              · {currentPosition ? currentPosition.title : 'Poste non assigné'} · Engagement :{' '}
              <strong>{employee.hireDate}</strong> · Charges fiscales :{' '}
              <strong>{employee.taxDependentsCount}</strong>
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-right text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Mode de pointage autorisé
            </p>
            <p className="mt-0.5 font-mono font-semibold text-slate-900">
              {employee.attendanceMode === 'BIOMETRIC_OR_QR_PIN'
                ? 'Biométrie locale ou QR + PIN'
                : 'Badge QR + PIN uniquement'}
            </p>
          </div>
        </div>

        {/* Barre d'onglets */}
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-slate-100 pt-4">
          {tabs
            .filter((t) => t.visible)
            .map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setTab(t.id);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    active
                      ? 'bg-blue-700 text-white shadow-2xs'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
        </div>
      </div>

      {/* Alertes */}
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-600" />
            {error}
          </span>
          <button type="button" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            {notice}
          </span>
          <button type="button" onClick={() => setNotice(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ONGLET 1 : IDENTITÉ, PAIE & PII CHIFFRÉES */}
      {tab === 'profile' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4">
            <h2 className="text-base font-semibold text-slate-900">État civil & Coordonnées</h2>
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500">Sexe / Naissance</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {employee.gender} · {employee.birthDate}
                  {employee.birthPlace ? ` (${employee.birthPlace})` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Nationalité / État civil</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {employee.nationalityCode} ·{' '}
                  {MARITAL_STATUS_LABELS[employee.maritalStatus] ?? employee.maritalStatus}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Téléphone</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {employee.phonePrimary ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">E-mail professionnel</dt>
                <dd className="mt-0.5 font-medium text-slate-900">{employee.workEmail ?? '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Adresse (Province / Ville / Commune)</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {[employee.province, employee.city, employee.commune, employee.physicalAddress]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </dd>
              </div>
            </dl>

            {canUpdateEmp && (
              <form
                onSubmit={handleUpdateStatus}
                className="mt-4 space-y-3 border-t border-slate-100 pt-4"
              >
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Statut administratif du dossier
                </h3>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={statusForm.status}
                    onChange={(e) => setStatusForm({ ...statusForm, status: e.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                  >
                    {Object.entries(EMPLOYEE_STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Mettre à jour
                  </button>
                </div>
                {statusForm.status === 'TERMINATED' && (
                  <div className="grid gap-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs">
                    <p className="font-medium text-red-900">
                      La clôture du dossier révoque automatiquement le badge QR+PIN et le contrat
                      actif.
                    </p>
                    <input
                      required
                      type="date"
                      value={statusForm.terminationDate}
                      onChange={(e) =>
                        setStatusForm({ ...statusForm, terminationDate: e.target.value })
                      }
                      className="rounded border border-red-300 bg-white px-2.5 py-1.5"
                    />
                    <input
                      required
                      minLength={5}
                      placeholder="Motif légal de fin de service (min. 5 caractères) *"
                      value={statusForm.terminationReason}
                      onChange={(e) =>
                        setStatusForm({ ...statusForm, terminationReason: e.target.value })
                      }
                      className="rounded border border-red-300 bg-white px-2.5 py-1.5"
                    />
                  </div>
                )}
              </form>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
                  <Lock className="h-4 w-4 text-blue-700" />
                  Identifiants légaux & Règlement (AES-256-GCM)
                </h2>
                <p className="text-xs text-slate-500">
                  Masqués par défaut. Le déchiffrement ponctuel est journalisé dans l’audit SHA-256.
                </p>
              </div>
              {canReadPii && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleToggleSensitive()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100"
                >
                  {sensitive ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5" /> Masquer
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" /> Révéler (audité)
                    </>
                  )}
                </button>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500">Type de pièce d’identité</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {employee.identityDocType
                    ? (IDENTITY_DOC_LABELS[employee.identityDocType] ?? employee.identityDocType)
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">N° Pièce d’identité</dt>
                <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                  {sensitive
                    ? (sensitive.identityDocNumber ?? '—')
                    : (employee.identityDocMasked ?? '—')}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">N° Immatriculation CNSS</dt>
                <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                  {sensitive ? (sensitive.cnssNumber ?? '—') : (employee.cnssNumberMasked ?? '—')}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">N° Impôt individuel (DGI)</dt>
                <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                  {sensitive
                    ? (sensitive.individualTaxId ?? '—')
                    : (employee.individualTaxIdMasked ?? '—')}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Mode de règlement</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {PAYMENT_METHOD_LABELS[employee.paymentMethod] ?? employee.paymentMethod}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Banque / RIB</dt>
                <dd className="mt-0.5 font-mono text-slate-900">
                  {employee.bankName ? `${employee.bankName} · ` : ''}
                  {sensitive?.payment
                    ? (sensitive.payment.bankAccountNumber ?? '—')
                    : (employee.bankAccountMasked ?? '—')}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Mobile Money RDC</dt>
                <dd className="mt-0.5 font-mono text-slate-900">
                  {employee.mobileMoneyOperator
                    ? `${MOBILE_MONEY_LABELS[employee.mobileMoneyOperator] ?? employee.mobileMoneyOperator} · `
                    : ''}
                  {sensitive?.payment
                    ? (sensitive.payment.mobileMoneyNumber ?? '—')
                    : (employee.mobileMoneyMasked ?? '—')}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      )}

      {/* ONGLET 2 : FAMILLE & AYANTS DROIT */}
      {tab === 'dependents' && (
        <div className="space-y-6">
          {canUpdateEmp && (
            <form
              onSubmit={handleAddDependent}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4"
            >
              <h2 className="text-base font-semibold text-slate-900">
                Déclarer un membre de famille / ayant droit RDC
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <input
                  required
                  placeholder="Nom complet *"
                  value={depForm.fullName}
                  onChange={(e) => setDepForm({ ...depForm, fullName: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs lg:col-span-2"
                />
                <select
                  value={depForm.relationship}
                  onChange={(e) => setDepForm({ ...depForm, relationship: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {Object.entries(DEPENDENT_RELATION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={depForm.birthDate}
                  onChange={(e) => setDepForm({ ...depForm, birthDate: e.target.value })}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  Ajouter
                </button>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={depForm.isTaxDependent}
                  onChange={(e) => setDepForm({ ...depForm, isTaxDependent: e.target.checked })}
                />
                Personne légalement à charge (prise en compte dans le compteur familial IPR/CNSS)
              </label>
            </form>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
            <h3 className="text-sm font-semibold text-slate-900">
              Ayants droit actifs ({dependents.length}) — Personnes à charge retenues :{' '}
              {employee.taxDependentsCount}
            </h3>
            {dependents.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">Aucun ayant droit enregistré.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {dependents.map((d) => (
                  <div key={d.id} className="flex items-center justify-between py-2.5">
                    <div>
                      <p className="font-semibold text-slate-900">{d.fullName}</p>
                      <p className="text-slate-500">
                        {DEPENDENT_RELATION_LABELS[d.relationship] ?? d.relationship}
                        {d.birthDate ? ` · Né(e) le ${d.birthDate}` : ''} ·{' '}
                        {d.isTaxDependent ? 'À charge fiscale' : 'Hors charge fiscale'}
                      </p>
                    </div>
                    {canUpdateEmp && (
                      <button
                        type="button"
                        onClick={() => void handleArchiveDependent(d.id)}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-slate-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Archiver
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ONGLET 3 : CONTRATS DE TRAVAIL RDC */}
      {tab === 'contracts' && (
        <div className="space-y-6">
          {contractAdvisories.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 space-y-1">
              <p className="font-semibold">Points de vigilance Code du Travail RDC :</p>
              <ul className="list-disc pl-5 space-y-0.5">
                {contractAdvisories.map((adv) => (
                  <li key={adv}>{adv}</li>
                ))}
              </ul>
            </div>
          )}

          {canManageContracts && canManageSalary && employee.status !== 'TERMINATED' && (
            <form
              onSubmit={handleCreateContract}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Nouveau contrat de travail RDC
                </h2>
                <p className="text-xs text-slate-500">
                  Un seul contrat actif simultané par agent. Le salaire de base est saisi en décimal
                  exact et chiffré en AES-256-GCM (aucun taux fiscal codé en dur).
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    N° de contrat *
                  </label>
                  <input
                    required
                    placeholder="CTR-2026-001"
                    value={contractForm.contractNumber}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, contractNumber: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Nature du contrat *
                  </label>
                  <select
                    value={contractForm.contractType}
                    onChange={(e) =>
                      setContractForm({
                        ...contractForm,
                        contractType: e.target.value as EmploymentContractItem['contractType'],
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    {Object.entries(CONTRACT_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Date d’effet *</label>
                  <input
                    required
                    type="date"
                    value={contractForm.startDate}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, startDate: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                {contractForm.contractType !== 'CDI' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Date d’échéance {contractForm.contractType === 'JOURNALIER' ? '' : '*'}
                    </label>
                    <input
                      required={contractForm.contractType !== 'JOURNALIER'}
                      type="date"
                      value={contractForm.endDate}
                      onChange={(e) =>
                        setContractForm({ ...contractForm, endDate: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700">Devise *</label>
                  <select
                    value={contractForm.payCurrency}
                    onChange={(e) =>
                      setContractForm({
                        ...contractForm,
                        payCurrency: e.target.value as 'CDF' | 'USD',
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="CDF">Franc Congolais (CDF)</option>
                    <option value="USD">Dollar US (USD)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Salaire de base contractuel *
                  </label>
                  <input
                    required
                    placeholder="Ex: 1500.00"
                    pattern="^\d{1,12}(\.\d{1,2})?$"
                    value={contractForm.baseSalary}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, baseSalary: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Lieu d’engagement *
                  </label>
                  <input
                    required
                    placeholder="Kinshasa"
                    value={contractForm.hiringPlace}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, hiringPlace: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Référence visa ONEM
                  </label>
                  <input
                    placeholder="ONEM/KIN/..."
                    value={contractForm.onemVisaRef}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, onemVisaRef: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Horaire hebdomadaire (h)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={72}
                    value={contractForm.weeklyHours}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, weeklyHours: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                {contractForm.contractType === 'CDD' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      N° renouvellement CDD
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={contractForm.cddRenewalCount}
                      onChange={(e) =>
                        setContractForm({
                          ...contractForm,
                          cddRenewalCount: Number(e.target.value),
                        })
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Contrat signé (coffre S3)
                  </label>
                  <select
                    value={contractForm.signedDocumentId}
                    onChange={(e) =>
                      setContractForm({ ...contractForm, signedDocumentId: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="">— Non rattaché —</option>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Statut initial</label>
                  <select
                    value={contractForm.status}
                    onChange={(e) =>
                      setContractForm({
                        ...contractForm,
                        status: e.target.value as 'DRAFT' | 'ACTIVE',
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="ACTIVE">Actif immédiatement</option>
                    <option value="DRAFT">Brouillon</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  Enregistrer le contrat
                </button>
              </div>
            </form>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
            <h3 className="text-sm font-semibold text-slate-900">
              Historique contractuel ({contracts.length})
            </h3>
            {contracts.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">Aucun contrat enregistré.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {contracts.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        <span className="font-mono text-blue-800">{c.contractNumber}</span> ·{' '}
                        {CONTRACT_TYPE_LABELS[c.contractType] ?? c.contractType} ·{' '}
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px]">
                          {CONTRACT_STATUS_LABELS[c.status] ?? c.status}
                        </span>
                      </p>
                      <p className="mt-0.5 text-slate-600">
                        Du {c.startDate} {c.endDate ? `au ${c.endDate}` : '(durée indéterminée)'} ·{' '}
                        {c.weeklyHours} h/sem · Lieu : {c.hiringPlace} · ONEM :{' '}
                        {c.onemVisaRef ?? 'En attente'}
                      </p>
                      <p className="mt-0.5 font-mono text-slate-800">
                        Rémunération :{' '}
                        {c.salaryRedacted
                          ? 'Confidentielle (permission employees.salary.read requise)'
                          : `${c.baseSalary} ${c.payCurrency} (${c.payFrequency === 'MONTHLY' ? 'mensuel' : 'journalier'})`}
                      </p>
                    </div>
                    {canManageContracts &&
                      c.status !== 'TERMINATED' &&
                      c.status !== 'EXPIRED' && (
                        <div className="flex flex-wrap gap-1.5">
                          {c.status !== 'ACTIVE' && (
                            <button
                              type="button"
                              onClick={() => void handleContractTransition(c.id, 'ACTIVE')}
                              className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-800"
                            >
                              Activer
                            </button>
                          )}
                          {c.contractType !== 'CDI' && (
                            <button
                              type="button"
                              onClick={() => void handleContractTransition(c.id, 'EXPIRED')}
                              className="rounded border border-slate-300 px-2.5 py-1 text-slate-700"
                            >
                              Clôturer à échéance
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleContractTransition(c.id, 'TERMINATED')}
                            className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-red-700"
                          >
                            Résilier
                          </button>
                        </div>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ONGLET 4 : BADGES QR SIGNÉS + CODE PIN ARGON2ID */}
      {tab === 'badges' && (
        <div className="space-y-6">
          {/* Carte QR affichée UNE SEULE FOIS après émission */}
          {issuedQrOnce && (
            <div className="rounded-xl border-2 border-blue-600 bg-blue-50/50 p-6">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div className="space-y-2 max-w-xl">
                  <span className="inline-block rounded bg-blue-700 px-2 py-0.5 text-[11px] font-bold uppercase text-white">
                    Affichage unique à l’émission — {issuedQrOnce.badgeCode}
                  </span>
                  <h3 className="text-base font-bold text-slate-900">
                    Carte QR professionnelle de {formatEmployeeFullName(employee)} (
                    {employee.matricule})
                  </h3>
                  <p className="text-xs text-slate-700">
                    Pour des raisons de sécurité, seul le condensat SHA-256 de ce jeton signé
                    HMAC-SHA256 est conservé en base. Téléchargez le QR pour impression sur badge
                    avant de quitter cet écran.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <a
                      href={issuedQrOnce.dataUrl}
                      download={`badge-${employee.matricule}-${issuedQrOnce.badgeCode}.png`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800"
                    >
                      <Download className="h-3.5 w-3.5" /> Télécharger le QR (PNG)
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(issuedQrOnce.payload);
                        setNotice('Jeton QR copié dans le presse-papiers.');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copier le jeton QR
                    </button>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={issuedQrOnce.dataUrl}
                    alt={`Badge QR ${issuedQrOnce.badgeCode}`}
                    className="h-44 w-44"
                  />
                  <p className="mt-1 font-mono text-[11px] font-bold text-slate-800">
                    {employee.matricule}
                  </p>
                </div>
              </div>
            </div>
          )}

          {canManageBadges && employee.status === 'ACTIVE' && (
            <form
              onSubmit={handleIssueBadge}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Émettre ou renouveler un Badge QR + Code PIN personnel (Argon2id)
                </h2>
                <p className="text-xs text-slate-500">
                  Garantit une alternative de pointage pleinement fonctionnelle sans aucune
                  biométrie. Les codes PIN triviaux (123456, 000000…) sont automatiquement rejetés.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Code PIN initial (6 chiffres) *
                  </label>
                  <input
                    required
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    placeholder="••••••"
                    value={badgeIssueForm.pin}
                    onChange={(e) =>
                      setBadgeIssueForm({
                        ...badgeIssueForm,
                        pin: e.target.value.replace(/\D/g, ''),
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tracking-widest"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Date d’expiration (optionnel)
                  </label>
                  <input
                    type="date"
                    value={badgeIssueForm.expiresAt}
                    onChange={(e) =>
                      setBadgeIssueForm({ ...badgeIssueForm, expiresAt: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Motif (si remplacement)
                  </label>
                  <input
                    placeholder="Renouvellement carte…"
                    value={badgeIssueForm.replaceReason}
                    onChange={(e) =>
                      setBadgeIssueForm({ ...badgeIssueForm, replaceReason: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                  >
                    Émettre le badge QR+PIN
                  </button>
                </div>
              </div>
            </form>
          )}

          {pinRotateTarget && (
            <form
              onSubmit={handleRotatePin}
              className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 space-y-3"
            >
              <h3 className="text-xs font-semibold uppercase text-amber-900">
                Réinitialisation de code PIN & déverrouillage
              </h3>
              <div className="grid gap-3 sm:grid-cols-4">
                <input
                  required
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="Nouveau PIN (6 chiffres)"
                  value={pinRotateForm.newPin}
                  onChange={(e) =>
                    setPinRotateForm({
                      ...pinRotateForm,
                      newPin: e.target.value.replace(/\D/g, ''),
                    })
                  }
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
                />
                <input
                  required
                  minLength={5}
                  placeholder="Motif obligatoire *"
                  value={pinRotateForm.reason}
                  onChange={(e) => setPinRotateForm({ ...pinRotateForm, reason: e.target.value })}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs sm:col-span-2"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                  >
                    Valider
                  </button>
                  <button
                    type="button"
                    onClick={() => setPinRotateTarget(null)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
            <h3 className="text-sm font-semibold text-slate-900">
              Badges enregistrés ({badges.length})
            </h3>
            {badges.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">Aucun badge émis pour cet agent.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {badges.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-mono font-semibold text-slate-900">
                        {b.badgeCode}{' '}
                        <span
                          className={`ml-2 rounded px-2 py-0.5 font-sans text-[11px] ${
                            b.status === 'ACTIVE'
                              ? 'bg-emerald-50 text-emerald-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {b.status}
                        </span>
                        {b.pinLockedUntil && new Date(b.pinLockedUntil).getTime() > Date.now() && (
                          <span className="ml-2 rounded bg-red-100 px-2 py-0.5 font-sans text-[11px] text-red-800">
                            PIN verrouillé ({b.failedPinAttempts} échecs)
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-slate-500">
                        Émis le {new Date(b.issuedAt).toLocaleDateString('fr-CD')}
                        {b.expiresAt ? ` · Expire le ${b.expiresAt}` : ''}
                        {b.lastVerifiedAt
                          ? ` · Dernier contrôle : ${new Date(b.lastVerifiedAt).toLocaleString('fr-CD')}`
                          : ''}
                        {b.revokeReason ? ` · Motif : ${b.revokeReason}` : ''}
                      </p>
                    </div>
                    {canManageBadges && b.status === 'ACTIVE' && (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPinRotateTarget(b.id)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-slate-700 hover:bg-slate-50"
                        >
                          <KeyRound className="h-3 w-3" /> Réinitialiser PIN
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevokeBadge(b.id, 'LOST')}
                          className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-900"
                        >
                          Déclarer perdu
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevokeBadge(b.id, 'REVOKED')}
                          className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-red-700"
                        >
                          Révoquer
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ONGLET 5 : COFFRE DOCUMENTAIRE S3 CHIFFRÉ AES-256-GCM */}
      {tab === 'documents' && (
        <div className="space-y-6">
          {canManageDocs && (
            <form
              onSubmit={handleUploadDocument}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Verser une pièce justificative au coffre S3 chiffré
                </h2>
                <p className="text-xs text-slate-500">
                  Chiffrement par enveloppe AES-256-GCM, empreinte SHA-256 vérifiée et contrôle des
                  signatures binaires. Formats : PDF, PNG, JPEG, WebP (max. 5 Mo).
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Catégorie *</label>
                  <select
                    value={docForm.category}
                    onChange={(e) => setDocForm({ ...docForm, category: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Intitulé *</label>
                  <input
                    required
                    placeholder="Ex: Contrat CDI signé 2026"
                    value={docForm.title}
                    onChange={(e) => setDocForm({ ...docForm, title: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Conservation légale jusqu’au
                  </label>
                  <input
                    type="date"
                    value={docForm.retentionUntil}
                    onChange={(e) => setDocForm({ ...docForm, retentionUntil: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Fichier (≤ 5 Mo) *
                  </label>
                  <input
                    required
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                    className="mt-1 w-full text-xs text-slate-700 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2.5 file:py-1.5 file:text-xs file:font-semibold"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5" /> Chiffrer et archiver
                </button>
              </div>
            </form>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
            <h3 className="text-sm font-semibold text-slate-900">
              Pièces archivées ({documents.length})
            </h3>
            {documents.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">Aucune pièce dans le coffre de cet agent.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        {doc.title}{' '}
                        <span className="ml-1.5 rounded bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-800">
                          AES-256-GCM
                        </span>
                      </p>
                      <p className="mt-0.5 text-slate-500">
                        {DOCUMENT_CATEGORY_LABELS[doc.category] ?? doc.category} ·{' '}
                        {doc.originalFilename} ({formatBytes(doc.sizeBytes)}) · SHA-256 :{' '}
                        <code className="font-mono">{doc.sha256Checksum.slice(0, 16)}…</code>
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDownloadDocument(doc)}
                        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2.5 py-1 font-semibold text-blue-800 hover:bg-blue-100"
                      >
                        <Download className="h-3.5 w-3.5" /> Vérifier & télécharger
                      </button>
                      {canManageDocs && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteDocument(doc.id)}
                          className="inline-flex items-center gap-1 rounded border border-red-200 px-2.5 py-1 text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Retirer
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ONGLET 6 : CONSENTEMENTS EXPLICITES RDC (ORDONNANCE-LOI N° 23/010) */}
      {tab === 'consents' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 text-xs text-slate-800">
            <p className="font-semibold text-slate-900">
              Politique biométrique active de l’entreprise :{' '}
              <code className="font-mono font-bold text-blue-800">
                {me?.activeTenant?.biometricStoragePolicy ?? 'DEVICE_ONLY'}
              </code>
            </p>
            <p className="mt-1">
              Conformément à l’Ordonnance-Loi RDC n° 23/010, aucun consentement n’est pré-coché ni
              présumé. En cas de refus ou de retrait, l’agent utilise son{' '}
              <strong>Badge QR + Code PIN</strong> sans aucune pénalité.
              {tenantIsDeviceOnly &&
                ' La synchronisation centrale de gabarits biométriques est strictement verrouillée sur cette entreprise.'}
            </p>
          </div>

          {canManageConsents && (
            <form
              onSubmit={handleRecordConsent}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs space-y-4"
            >
              <h2 className="text-base font-semibold text-slate-900">
                Consigner une décision explicite de consentement
              </h2>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Finalité du consentement *
                  </label>
                  <select
                    value={consentForm.consentType}
                    onChange={(e) =>
                      setConsentForm({ ...consentForm, consentType: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    {Object.entries(CONSENT_TYPE_LABELS).map(([k, v]) => (
                      <option
                        key={k}
                        value={k}
                        disabled={k === 'BIOMETRIC_CENTRAL_TEMPLATE' && tenantIsDeviceOnly}
                      >
                        {v}
                        {k === 'BIOMETRIC_CENTRAL_TEMPLATE' && tenantIsDeviceOnly
                          ? ' [Verrouillé — DEVICE_ONLY]'
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Décision explicite de l’agent (non pré-sélectionnée) *
                  </label>
                  <select
                    required
                    value={consentForm.decision}
                    onChange={(e) =>
                      setConsentForm({
                        ...consentForm,
                        decision: e.target.value as '' | 'GRANTED' | 'REFUSED',
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="">— Choisir explicitement la décision —</option>
                    <option value="GRANTED">ACCORDÉ librement (GRANTED)</option>
                    <option value="REFUSED">REFUSÉ — maintien QR + PIN (REFUSED)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Mode de recueil *
                  </label>
                  <select
                    value={consentForm.collectionMethod}
                    onChange={(e) =>
                      setConsentForm({ ...consentForm, collectionMethod: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    {Object.entries(CONSENT_METHOD_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Version de la notice *
                  </label>
                  <input
                    required
                    value={consentForm.policyVersion}
                    onChange={(e) =>
                      setConsentForm({ ...consentForm, policyVersion: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700">
                    Preuve signée rattachée (coffre S3)
                    {consentForm.collectionMethod === 'WRITTEN_SIGNED_UPLOAD' &&
                    consentForm.decision === 'GRANTED'
                      ? ' *'
                      : ''}
                  </label>
                  <select
                    required={
                      consentForm.collectionMethod === 'WRITTEN_SIGNED_UPLOAD' &&
                      consentForm.decision === 'GRANTED'
                    }
                    value={consentForm.signedDocumentId}
                    onChange={(e) =>
                      setConsentForm({ ...consentForm, signedDocumentId: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="">— Sélectionner une pièce du coffre S3 —</option>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({d.originalFilename})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="block text-xs font-medium text-slate-700">
                    Résumé de la notice d’information remise à l’agent *
                  </label>
                  <textarea
                    required
                    minLength={15}
                    rows={2}
                    placeholder="Décrivez la finalité exacte, la durée de conservation et le droit de retrait communiqués à l’agent…"
                    value={consentForm.noticeSummary}
                    onChange={(e) =>
                      setConsentForm({ ...consentForm, noticeSummary: e.target.value })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                </div>
              </div>

              {/* Case de confirmation d'alternative QR+PIN — JAMAIS pré-cochée */}
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
                <input
                  type="checkbox"
                  checked={consentForm.alternativeQrPinOffered}
                  onChange={(e) =>
                    setConsentForm({ ...consentForm, alternativeQrPinOffered: e.target.checked })
                  }
                  className="mt-0.5"
                />
                <span>
                  Je certifie que l’agent a été informé de son droit de refuser ou retirer son
                  consentement à tout moment et que l’alternative fonctionnelle{' '}
                  <strong>Badge QR + Code PIN</strong> sans aucune pénalité lui est garantie. *
                </span>
              </label>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  Enregistrer la décision
                </button>
              </div>
            </form>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
            <h3 className="text-sm font-semibold text-slate-900">
              Registre probant des consentements ({consents.length})
            </h3>
            {consents.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                Aucun consentement enregistré (mode QR + PIN actif par défaut).
              </p>
            ) : (
              <div className="mt-3 divide-y divide-slate-100 text-xs">
                {consents.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="max-w-3xl">
                      <p className="font-semibold text-slate-900">
                        {CONSENT_TYPE_LABELS[c.consentType] ?? c.consentType}{' '}
                        <span
                          className={`ml-2 rounded px-2 py-0.5 text-[11px] font-bold ${
                            c.decision === 'GRANTED'
                              ? 'bg-emerald-50 text-emerald-800'
                              : c.decision === 'WITHDRAWN'
                                ? 'bg-amber-100 text-amber-900'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {c.decision}
                        </span>
                      </p>
                      <p className="mt-0.5 text-slate-600">{c.noticeSummary}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Notice {c.policyVersion} ·{' '}
                        {CONSENT_METHOD_LABELS[c.collectionMethod] ?? c.collectionMethod} · Décidé
                        le {new Date(c.decidedAt).toLocaleString('fr-CD')}
                        {c.withdrawnAt
                          ? ` · Retiré le ${new Date(c.withdrawnAt).toLocaleString('fr-CD')} (${c.withdrawalReason})`
                          : ''}
                      </p>
                    </div>
                    {canManageConsents && c.decision === 'GRANTED' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleWithdrawConsent(c.id)}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100"
                      >
                        Retirer le consentement
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
