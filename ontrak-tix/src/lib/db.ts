import { PrismaClient } from "@prisma/client";

import { configureTickets, ticketServices, type TicketServices } from "./ticket-server";
import { PrismaAuditReader, type TicketPrismaClient } from "./ticket-store-prisma";
import { CsatService } from "./csat-service";
import { PrismaCsatStore, type CsatPrismaClient } from "./csat-store-prisma";
import { AttachmentService } from "./attachment-service";
import { PrismaAttachmentStore, type AttachmentPrismaClient } from "./attachment-store-prisma";
import { FileBlobStore } from "./attachment-blob-file";
import { FileEvidenceObjectStore } from "./object-lock-file";
import { EscalationService } from "./escalation-service";
import { PrismaEscalationStore, type EscalationPrismaClient } from "./escalation-store-prisma";
import { PrismaSlaPolicyStore, type SlaPolicyPrismaClient } from "./sla-store-prisma";
import { CannedResponseService } from "./canned-service";
import { PrismaCannedStore, type CannedPrismaClient } from "./canned-store-prisma";
import { TicketLinkService } from "./link-service";
import { PrismaLinkStore, type LinkPrismaClient } from "./link-store-prisma";
import { ConsoleEmailSender, NotificationService } from "./notification-service";
import { PrismaNotificationStore, type NotificationPrismaClient } from "./notification-store-prisma";
import {
  PrismaNotificationPreferenceStore,
  type NotificationPreferencePrismaClient,
} from "./notification-preference-store-prisma";
import { TicketTemplateService } from "./template-service";
import { PrismaTemplateStore, type TemplatePrismaClient } from "./template-store-prisma";
import { SavedViewService } from "./saved-view-service";
import { PrismaSavedViewStore, type SavedViewPrismaClient } from "./saved-view-store-prisma";
import { SecurityAlertService } from "./security-alert-service";
import { PrismaSecurityAlertStore, type SecurityAlertPrismaClient } from "./security-alert-store-prisma";
import { AlertPromotionService } from "./alert-promotion-service";
import { PrismaPromotionStore, type AlertPromotionPrismaClient } from "./alert-promotion-store-prisma";
import { IdentityService } from "./identity-service";
import { PrismaIdentityStore, type IdentityPrismaClient } from "./identity-store-prisma";
import { IncidentService } from "./incident-service";
import { PrismaIncidentStore, type IncidentPrismaClient } from "./incident-store-prisma";
import { IncidentDocsService } from "./incident-docs-service";
import { PrismaIncidentDocsStore, type IncidentDocsPrismaClient } from "./incident-docs-store-prisma";
import { AssuranceService } from "./assurance-service";
import { assuranceSigner } from "./assurance-sign";
import { IncidentComplianceService } from "./compliance-service";
import { PrismaComplianceStore, type CompliancePrismaClient } from "./compliance-store-prisma";
import { IncidentCommsTemplateService } from "./comms-template-service";
import {
  PrismaCommsTemplateStore,
  type CommsTemplatePrismaClient,
} from "./comms-template-store-prisma";
import { WarRoomService } from "./war-room-service";
import { ClientService } from "./client-service";
import { PrismaClientStore, type ClientPrismaClient } from "./client-store-prisma";
import { SlaPolicyService } from "./sla-policy-service";
import { TimeService } from "./time-service";
import { PrismaTimeStore, type TimePrismaClient } from "./time-store-prisma";
import { ClientSurveyService } from "./client-survey-service";
import {
  PrismaClientSurveyStore,
  type ClientSurveyPrismaClient,
} from "./client-survey-store-prisma";

/**
 * The OnTrak Tix database client and service bootstrap.
 *
 * Prisma is instantiated once per process and stashed on `globalThis` so Next's
 * dev hot-reload does not open a new pool on every edit. Importing this module
 * is what wires the process-wide service stack, so server components import
 * `ticketServicesFor` (and friends) rather than configuring anything themselves.
 *
 * The generated client is described structurally, so the service code never
 * depends on a generated type directly.
 */
const globalForPrisma = globalThis as unknown as { tixPrisma?: PrismaClient };

export const prisma = globalForPrisma.tixPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.tixPrisma = prisma;

// Building the service stacks does no I/O; the connection opens on first query.
configureTickets(prisma as unknown as TicketPrismaClient);

let satisfaction: CsatService | null = null;
let attachments: AttachmentService | null = null;
let escalations: EscalationService | null = null;
let slaPolicies: PrismaSlaPolicyStore | null = null;
let promises: SlaPolicyService | null = null;
let time: TimeService | null = null;
let clientSurveys: ClientSurveyService | null = null;
let canned: CannedResponseService | null = null;
let links: TicketLinkService | null = null;
let notifications: NotificationService | null = null;
let savedViews: SavedViewService | null = null;
let templates: TicketTemplateService | null = null;
let securityAlerts: SecurityAlertService | null = null;
let alertPromotions: AlertPromotionService | null = null;
let identities: IdentityService | null = null;
let incidents: IncidentService | null = null;
let incidentDocs: IncidentDocsService | null = null;
let assurance: AssuranceService | null = null;
let compliance: IncidentComplianceService | null = null;
let commsTemplates: IncidentCommsTemplateService | null = null;
let clients: ClientService | null = null;
let warRoom: WarRoomService | null = null;

function csat(): CsatService {
  satisfaction ??= new CsatService(new PrismaCsatStore(prisma as unknown as CsatPrismaClient));
  return satisfaction;
}

function attachment(): AttachmentService {
  attachments ??= new AttachmentService(
    new PrismaAttachmentStore(prisma as unknown as AttachmentPrismaClient),
    new FileBlobStore(),
  );
  return attachments;
}

/** The configured ticket service stack for this process. */
export function ticketServicesFor(): TicketServices {
  return ticketServices();
}

/** The configured CSAT service for this process. */
export function csatServicesFor(): CsatService {
  return csat();
}

/** The configured attachment service for this process. */
export function attachmentServicesFor(): AttachmentService {
  return attachment();
}

function notification(): NotificationService {
  notifications ??= new NotificationService(
    new PrismaNotificationStore(prisma as unknown as NotificationPrismaClient),
    new ConsoleEmailSender(),
    undefined,
    new PrismaNotificationPreferenceStore(prisma as unknown as NotificationPreferencePrismaClient),
  );
  return notifications;
}

/** The configured canned-response service for this process. */
export function cannedServicesFor(): CannedResponseService {
  canned ??= new CannedResponseService(new PrismaCannedStore(prisma as unknown as CannedPrismaClient));
  return canned;
}

/** The configured ticket-template service for this process. */
export function templateServicesFor(): TicketTemplateService {
  templates ??= new TicketTemplateService(new PrismaTemplateStore(prisma as unknown as TemplatePrismaClient));
  return templates;
}

/** The configured ticket link/merge service for this process. */
export function linkServicesFor(): TicketLinkService {
  links ??= new TicketLinkService(
    new PrismaLinkStore(prisma as unknown as LinkPrismaClient),
    ticketServices().store,
    ticketServices().audit,
  );
  return links;
}

/** The configured notification service for this process. */
export function notificationServicesFor(): NotificationService {
  return notification();
}

/** The configured saved-view service for this process. */
export function savedViewServicesFor(): SavedViewService {
  savedViews ??= new SavedViewService(new PrismaSavedViewStore(prisma as unknown as SavedViewPrismaClient));
  return savedViews;
}

/**
 * The configured SLA escalation service. It shares the ticket stack's audit
 * sink so escalation notices join the same per-tenant hash chain (two sinks
 * caching the chain independently would race on `seq`), and raises a
 * notification for every rung it lifts.
 */
export function escalationServicesFor(): EscalationService {
  escalations ??= new EscalationService(
    new PrismaEscalationStore(prisma as unknown as EscalationPrismaClient),
    ticketServices().audit,
    undefined,
    undefined,
    async (record) => {
      await notification().notifyEscalation(record);
    },
  );
  return escalations;
}

/** The configured SLA policy reader for this process. */
export function slaPolicyStoreFor(): PrismaSlaPolicyStore {
  slaPolicies ??= new PrismaSlaPolicyStore(prisma as unknown as SlaPolicyPrismaClient);
  return slaPolicies;
}

/**
 * The configured SLA policy authoring service (M4). It shares the ticket
 * stack's audit sink, so a promise written, changed or removed joins the same
 * per-tenant hash chain as the tickets measured against it.
 */
export function slaPolicyServicesFor(): SlaPolicyService {
  promises ??= new SlaPolicyService(slaPolicyStoreFor(), ticketServices().audit, clientServicesFor());
  return promises;
}

/**
 * The configured security-alert ingest service. It shares the ticket stack's
 * audit sink, so an ingested alert joins the same per-tenant hash chain as the
 * tickets it may later be promoted to.
 */
export function securityAlertServicesFor(): SecurityAlertService {
  securityAlerts ??= new SecurityAlertService(
    new PrismaSecurityAlertStore(prisma as unknown as SecurityAlertPrismaClient),
    ticketServices().audit,
  );
  return securityAlerts;
}

/**
 * The configured alert-promotion service. It writes tickets through the normal
 * `TicketService` and the same audit sink, and persists verdicts, suppressions
 * and promotion decisions through the Prisma promotion store.
 */
export function alertPromotionServicesFor(): AlertPromotionService {
  alertPromotions ??= new AlertPromotionService(
    {
      alerts: securityAlertServicesFor(),
      tickets: {
        createTicket: (actor, input) => ticketServices().service.createTicket(actor, input),
        findTicket: (tenantId, ticketId) => ticketServices().store.findTicket(tenantId, ticketId),
      },
    },
    new PrismaPromotionStore(prisma as unknown as AlertPromotionPrismaClient),
    ticketServices().audit,
  );
  return alertPromotions;
}

/**
 * The configured identity (IdP) service. It shares the ticket stack's audit
 * sink, so sign-ins, role changes and SCIM pushes join the same per-tenant hash
 * chain as the tickets they touch.
 */
export function identityServicesFor(): IdentityService {
  identities ??= new IdentityService(
    new PrismaIdentityStore(prisma as unknown as IdentityPrismaClient),
    ticketServices().audit,
  );
  return identities;
}

/**
 * The configured incident service. It shares the ticket stack's audit sink, so
 * an incident's declaration, phase changes and staffing join the same per-tenant
 * hash chain as the tickets they touch.
 */
export function incidentServicesFor(): IncidentService {
  incidents ??= new IncidentService(
    new PrismaIncidentStore(prisma as unknown as IncidentPrismaClient),
    ticketServices().audit,
  );
  return incidents;
}

/**
 * The configured incident-documentation service (playbook + evidence). It
 * writes timeline entries through the incident store and shares the ticket
 * stack's audit sink, so the whole record lives on one per-tenant chain.
 */
export function incidentDocsServicesFor(): IncidentDocsService {
  incidentDocs ??= new IncidentDocsService(
    new PrismaIncidentDocsStore(prisma as unknown as IncidentDocsPrismaClient),
    new PrismaIncidentStore(prisma as unknown as IncidentPrismaClient),
    ticketServices().audit,
    undefined,
    undefined,
    // Artifact bytes go to the filesystem on a single node, under the retention
    // mode this deployment chose (`ONTRAK_TIX_EVIDENCE_LOCK_MODE`, COMPLIANCE by
    // default). A shared, object-locked bucket replaces the store behind the
    // same port; the rules do not change.
    { objects: new FileEvidenceObjectStore() },
  );
  return incidentDocs;
}

/**
 * The configured incident-compliance service: the regulatory notification clock
 * and the post-incident review. It writes timeline entries through the incident
 * store and shares the ticket stack's audit sink, so a waiver or a published
 * action is on the same per-tenant chain as the incident it came from.
 */
export function complianceServicesFor(): IncidentComplianceService {
  compliance ??= new IncidentComplianceService(
    new PrismaComplianceStore(prisma as unknown as CompliancePrismaClient),
    new PrismaIncidentStore(prisma as unknown as IncidentPrismaClient),
    ticketServices().audit,
  );
  return compliance;
}

/**
 * The configured client service (M4): who the desk serves, who serves them, and
 * the recorded windows in which somebody is looking through a client's eyes. It
 * shares the ticket stack's audit sink, so an assignment or an act-as joins the
 * same per-tenant hash chain as the work it touches.
 */
export function clientServicesFor(): ClientService {
  clients ??= new ClientService(new PrismaClientStore(prisma as unknown as ClientPrismaClient), ticketServices().audit);
  return clients;
}

/**
 * The configured time-and-billing service (M4). It shares the ticket stack's
 * audit sink, so logged hours and issued invoices join the same per-tenant hash
 * chain as the work they charge for, and it reuses the client service for the
 * scope an agent's timesheet is read under.
 */
export function timeServicesFor(): TimeService {
  time ??= new TimeService(
    new PrismaTimeStore(prisma as unknown as TimePrismaClient),
    clientServicesFor(),
    ticketServices().audit,
  );
  return time;
}

/**
 * The configured client-survey service (M4): the question a client's own people
 * answer from a link, without an account. It reuses the client service for the
 * scope a staff reader sees it under, and shares the ticket stack's audit sink so
 * asking and answering are on the same chain as everything else.
 */
export function clientSurveyServicesFor(): ClientSurveyService {
  clientSurveys ??= new ClientSurveyService(
    new PrismaClientSurveyStore(prisma as unknown as ClientSurveyPrismaClient),
    clientServicesFor(),
    ticketServices().audit,
  );
  return clientSurveys;
}

/**
 * The configured incident-communications template service: the tenant's own
 * drafts for a notification duty, which the console offers ahead of ours.
 */
export function commsTemplateServicesFor(): IncidentCommsTemplateService {
  commsTemplates ??= new IncidentCommsTemplateService(
    new PrismaCommsTemplateStore(prisma as unknown as CommsTemplatePrismaClient),
  );
  return commsTemplates;
}

/**
 * The configured war-room timeline service. It reads the incident log, the
 * tenant's audit chain, the alert stream and the promotion decisions, and merges
 * them into one story — a read-only view over services that already exist, so it
 * needs no store of its own.
 */
export function warRoomServicesFor(): WarRoomService {
  warRoom ??= new WarRoomService({
    incidents: new PrismaIncidentStore(prisma as unknown as IncidentPrismaClient),
    auditReader: new PrismaAuditReader(prisma as unknown as TicketPrismaClient),
    alerts: securityAlertServicesFor(),
    decisions: alertPromotionServicesFor(),
  });
  return warRoom;
}

/**
 * The configured assurance-packet service. It bundles the incident record, the
 * evidence manifest and the tenant's audit chain, and signs the result with
 * `ONTRAK_TIX_ASSURANCE_SECRET` (falling back to the session secret). The
 * signer is resolved per call so a deployment without the variable configured
 * fails when it exports a packet rather than at boot.
 */
export function assuranceServicesFor(): AssuranceService {
  assurance ??= new AssuranceService({
    incidents: new PrismaIncidentStore(prisma as unknown as IncidentPrismaClient),
    docs: incidentDocsServicesFor(),
    auditReader: new PrismaAuditReader(prisma as unknown as TicketPrismaClient),
    sign: (payload) => assuranceSigner()(payload),
    audit: ticketServices().audit,
  });
  return assurance;
}
