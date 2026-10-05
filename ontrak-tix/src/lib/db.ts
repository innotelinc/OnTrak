import { PrismaClient } from "@prisma/client";

import { configureTickets, ticketServices, type TicketServices } from "./ticket-server";
import { PrismaAuditReader, sha256Hex, type TicketPrismaClient } from "./ticket-store-prisma";
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
import { ScimSyncService } from "./scim-sync-service";
import { prismaScimPeople } from "./scim-sync-store-prisma";
import { HttpScimClient } from "./scim-client";
import { scimTargetFromEnv } from "./scim-rules";
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
import { RuleService } from "./rule-service";
import { PrismaRuleStore, type RulePrismaClient } from "./rule-store-prisma";
import { MacroService } from "./macro-service";
import { PrismaMacroStore, type MacroPrismaClient } from "./macro-store-prisma";
import { MacroIntake, type MacroPlannerPort } from "./macro-intake";
import { KnowledgeService } from "./knowledge-service";
import { PrismaKnowledgeStore, type KnowledgePrismaClient } from "./knowledge-store-prisma";
import {
  RuleIntake,
  type RequesterDirectory,
  type RuleEffectSink,
  type RulePlannerPort,
} from "./rule-intake";
import { ClientSurveyService } from "./client-survey-service";
import { ClientBrandingService } from "./client-branding-service";
import {
  PrismaClientBrandingStore,
  type ClientBrandingPrismaClient,
} from "./client-branding-store-prisma";
import { RotaService } from "./rota-service";
import { PrismaRotaStore, type RotaPrismaClient } from "./rota-store-prisma";
import {
  PrismaClientSurveyStore,
  type ClientSurveyPrismaClient,
} from "./client-survey-store-prisma";
import { ApiTokenService } from "./public-api-service";
import { PrismaApiTokenStore, type ApiTokenPrismaClient } from "./public-api-store-prisma";
import { FetchWebhookTransport, WebhookService } from "./webhook-service";
import { PrismaWebhookStore, type WebhookPrismaClient } from "./webhook-store-prisma";
import { RmmConnectorService } from "./rmm-service";
import { PrismaRmmStore, type RmmPrismaClient } from "./rmm-store-prisma";
import { ChatNotifyService, FetchChatTransport } from "./chat-notify-service";
import { PrismaChatStore, type ChatPrismaClient } from "./chat-notify-store-prisma";
import { FormService } from "./form-service";
import type { TicketFormGate } from "./ticket-service";
import { PrismaFormStore, type FormPrismaClient } from "./form-store-prisma";
import { RoleService, systemRoleIds } from "./role-service";
import { PrismaRoleStore, type RolePrismaClient } from "./role-store-prisma";
import { ConnectorService } from "./connector-service";
import { ConnectorRegistry } from "./connector-rules";
import { PrismaConnectorStore, type ConnectorPrismaClient } from "./connector-store-prisma";

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

/*
 * The M5 rules engine, as the ticket service sees it.
 *
 * The planner is a *port* rather than the service itself so this module, which
 * configures the ticket stack at import time, does not need the rules stack to
 * exist yet: `ruleServicesFor` is resolved on the first ticket a rule could fire
 * on. The effects go to the notification service — one staff notice for `notify`
 * and one on-call page for `escalate` — and the directory answers the one field
 * a ticket row does not carry, the requester's address.
 */
const ticketRulePlanner: RulePlannerPort = {
  planForTicket: (tenantId, ticket, trigger) => ruleServicesFor().planForTicket(tenantId, ticket, trigger),
};

const ruleEffects: RuleEffectSink = {
  notify: async (notice) => {
    await notification().notifyRule(notice);
  },
  escalate: async (notice) => {
    await notification().notifyRuleEscalation(notice);
  },
};

const requesterDirectory: RequesterDirectory = {
  emailFor: async (tenantId, requesterId) => {
    const user = await prisma.user.findFirst({ where: { tenantId, id: requesterId }, select: { email: true } });
    return user?.email ?? null;
  },
};

/*
 * The M5 macros, as the ticket service sees them. A port for the same reason
 * the rule planner is one: this module wires the ticket stack at import time,
 * and the macro service is resolved on the first shortcut an agent runs. The
 * effects are the same sink the rules use — a macro's `notify` and `escalate`
 * reach staff the one way the desk already reaches them.
 */
const macroPlanner: MacroPlannerPort = {
  findMacro: (tenantId, macroId) => macroServicesFor().find(tenantId, macroId),
};

const macroIntake = new MacroIntake(macroPlanner, ruleEffects);

/*
 * The M6 custom fields, as the ticket service sees them.
 *
 * A port for the same reason the rule planner is one: `formServicesFor()` resolves the
 * forms stack on the first ticket somebody raises, rather than at import time. What the
 * ticket path needs of it is one question — “are these the values this queue's form
 * accepts?” — answered in one place, so the portal, the console and the API cannot
 * disagree about a required field.
 */
const ticketFormGate: TicketFormGate = {
  validateTicketValues: (tenantId, queueId, values) => formServicesFor().validateTicketValues(tenantId, queueId, values),
};

// Building the service stacks does no I/O; the connection opens on first query.
configureTickets(
  prisma as unknown as TicketPrismaClient,
  undefined,
  new RuleIntake(ticketRulePlanner, ruleEffects, requesterDirectory),
  macroIntake,
  ticketFormGate,
);

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
let scimSync: ScimSyncService | null = null;
let incidents: IncidentService | null = null;
let incidentDocs: IncidentDocsService | null = null;
let assurance: AssuranceService | null = null;
let compliance: IncidentComplianceService | null = null;
let commsTemplates: IncidentCommsTemplateService | null = null;
let clients: ClientService | null = null;
let branding: ClientBrandingService | null = null;
let rota: RotaService | null = null;
let warRoom: WarRoomService | null = null;
let rules: RuleService | null = null;
let macros: MacroService | null = null;
let knowledge: KnowledgeService | null = null;
let apiTokens: ApiTokenService | null = null;
let webhooks: WebhookService | null = null;
let rmm: RmmConnectorService | null = null;
let chatNotify: ChatNotifyService | null = null;
let forms: FormService | null = null;
let roles: RoleService | null = null;
let connectors: ConnectorService | null = null;

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
/**
 * The desk's queues, for the one thing the SLA console needs them for: checking
 * that a promise names a queue this desk actually has. Described structurally,
 * like every other Prisma surface here, so the service layer never depends on a
 * generated type.
 */
const queueLookup = {
  listQueues: (tenantId: string) =>
    (
      prisma as unknown as {
        queue: { findMany(args: unknown): Promise<{ id: string; name: string }[]> };
      }
    ).queue.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
};

export function slaPolicyServicesFor(): SlaPolicyService {
  promises ??= new SlaPolicyService(
    slaPolicyStoreFor(),
    ticketServices().audit,
    clientServicesFor(),
    undefined,
    queueLookup,
  );
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
 * The configured outbound provisioning service: the desk's people, pushed to the
 * identity provider over SCIM.
 *
 * The target comes from the environment rather than the database, for the same
 * reason the OIDC client secret does: a connector token is a credential, and a
 * token column would make a database dump a set of working credentials. A
 * deployment that names no target gets a service that refuses to run and a console
 * that says so, rather than a button that fails one person at a time.
 */
export function scimSyncServicesFor(): ScimSyncService {
  if (!scimSync) {
    const { target } = scimTargetFromEnv();
    scimSync = new ScimSyncService(
      prismaScimPeople(),
      target ? new HttpScimClient(target) : null,
      ticketServices().audit,
    );
  }
  return scimSync;
}

/**
 * The configured automation-rule service (M5). It shares the ticket stack's
 * audit sink, so a rule written, changed, switched off or removed joins the same
 * per-tenant hash chain as the tickets it acts on — which is the whole point of
 * auditing rules: the outcome and the configuration belong to one history.
 */
export function ruleServicesFor(): RuleService {
  rules ??= new RuleService(new PrismaRuleStore(prisma as unknown as RulePrismaClient), ticketServices().audit);
  return rules;
}

/**
 * The configured macro service (M5). It shares the ticket stack's audit sink, so
 * a shortcut written, changed, switched off or removed joins the same per-tenant
 * hash chain as the tickets one click acts on.
 */
export function macroServicesFor(): MacroService {
  macros ??= new MacroService(new PrismaMacroStore(prisma as unknown as MacroPrismaClient), ticketServices().audit);
  return macros;
}

/**
 * The configured knowledge service (M5). It shares the ticket stack's audit sink,
 * so an article written, edited, published or removed joins the same per-tenant
 * hash chain as the tickets it deflects.
 */
export function knowledgeServicesFor(): KnowledgeService {
  knowledge ??= new KnowledgeService(
    new PrismaKnowledgeStore(prisma as unknown as KnowledgePrismaClient),
    ticketServices().audit,
  );
  return knowledge;
}

/**
 * The configured public-API token service (M6). It shares the ticket stack's audit
 * sink, so minting, revoking and refusing a token joins the same per-tenant hash
 * chain as the tickets that token touches — which is the question an incident
 * asks after a bad bulk update. The hash is the ticket stack's own SHA-256, so a
 * token's stored digest is the same digest everything else here uses.
 */
export function apiTokenServicesFor(): ApiTokenService {
  apiTokens ??= new ApiTokenService(
    new PrismaApiTokenStore(prisma as unknown as ApiTokenPrismaClient),
    ticketServices().audit,
    undefined,
    (input) => sha256Hex(input),
  );
  return apiTokens;
}

/**
 * The configured webhook service (M6). It shares the ticket stack's audit sink, so
 * every delivery attempt — success or refusal — joins the same per-tenant hash
 * chain as the ticket it is telling somebody about. The transport is the real
 * `fetch`, and it is a port so a test (and, later, a queue) replaces it whole.
 */
export function webhookServicesFor(): WebhookService {
  webhooks ??= new WebhookService(
    new PrismaWebhookStore(prisma as unknown as WebhookPrismaClient),
    new FetchWebhookTransport(),
    ticketServices().audit,
  );
  return webhooks;
}

/**
 * The requester is the desk's, not the vendor's: a monitoring alert has nobody
 * behind it, so `ONTRAK_TIX_RMM_REQUESTER_EMAIL` names the mailbox the work is
 * raised for, and a tenant without one falls back to its first active
 * administrator. Neither existing is a `503` rather than a ticket filed against a
 * user that does not exist.
 */
/**
 * The configured chat notification service (M6): the Slack and Teams rooms the desk
 * posts to. It shares the ticket stack's audit sink, so a message delivered — or a
 * delivery exhausted — joins the same per-tenant hash chain as the ticket it is
 * about, and the transport is the real `fetch` behind a port a test replaces whole.
 *
 * `ONTRAK_TIX_BASE_URL` is this deployment's own address, read once here. A
 * deployment that does not set it sends messages without a link, which is honest —
 * a button pointing at a host we invented is worse than no button.
 */
export function chatNotifyServicesFor(): ChatNotifyService {
  chatNotify ??= new ChatNotifyService(
    new PrismaChatStore(prisma as unknown as ChatPrismaClient),
    new FetchChatTransport(),
    ticketServices().audit,
    undefined,
    process.env.ONTRAK_TIX_BASE_URL ?? null,
  );
  return chatNotify;
}

/**
 * The configured RMM/monitoring connector (M6). It raises and closes work through
 * the normal `TicketService` — so a monitoring ticket fires the desk's rules and
 * lands on the same per-tenant hash chain as one a person raised — and it shares
 * that chain, because the open and the close of a condition have to be readable as
 * one story.
 */
export function rmmServicesFor(): RmmConnectorService {
  rmm ??= new RmmConnectorService(
    new PrismaRmmStore(prisma as unknown as RmmPrismaClient),
    {
      tickets: {
        createTicket: (actor, input) => ticketServices().service.createTicket(actor, input),
        setStatus: (actor, ticketId, to) => ticketServices().service.setStatus(actor, ticketId, to),
        reply: (actor, ticketId, body, kind) => ticketServices().service.reply(actor, ticketId, body, kind),
        findTicket: (tenantId, ticketId) => ticketServices().store.findTicket(tenantId, ticketId),
      },
      requesterFor: async (tenantId) => {
        const configured = process.env.ONTRAK_TIX_RMM_REQUESTER_EMAIL;
        const user = await prisma.user.findFirst({
          where: configured
            ? { tenantId, email: configured, active: true }
            : { tenantId, role: "ADMIN", active: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        return user?.id ?? null;
      },
    },
    ticketServices().audit,
  );
  return rmm;
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
 * The configured client-branding service (M4): the name, colour and voice one
 * client's own people see. It reuses the client service for the scope a brand is
 * read and written under — speaking as a client you do not serve is exactly what
 * act-as exists to prevent — and shares the ticket stack's audit sink, so a
 * colour change is on the same chain as the notices it will appear in.
 */
export function clientBrandingServicesFor(): ClientBrandingService {
  branding ??= new ClientBrandingService(
    new PrismaClientBrandingStore(prisma as unknown as ClientBrandingPrismaClient),
    clientServicesFor(),
    ticketServices().audit,
  );
  return branding;
}

/**
 * The configured rota service (M4): who is on, when, and what changed hands. It
 * shares the ticket stack's audit sink, so a published shift and a handoff join
 * the same per-tenant hash chain as the work they cover.
 */
export function rotaServicesFor(): RotaService {
  rota ??= new RotaService(new PrismaRotaStore(prisma as unknown as RotaPrismaClient), ticketServices().audit);
  return rota;
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
 * The configured custom-field and form service (M6).
 *
 * It shares the ticket stack's audit sink, so a field defined, a field archived and a
 * queue's form changed all join the same per-tenant hash chain as the tickets they shape.
 */
export function formServicesFor(): FormService {
  forms ??= new FormService(new PrismaFormStore(prisma as unknown as FormPrismaClient), ticketServices().audit);
  return forms;
}

/**
 * The configured granular-role service (M6).
 *
 * It shares the ticket stack's audit sink, so a role written, a role archived and a role handed
 * to somebody all join the same per-tenant hash chain as the work those roles govern — which is
 * the only reason a role definition is worth having rather than a code edit.
 */
export function roleServicesFor(): RoleService {
  roles ??= new RoleService(
    new PrismaRoleStore(prisma as unknown as RolePrismaClient),
    systemRoleIds(),
    ticketServices().audit,
  );
  return roles;
}

/**
 * The process-wide connector catalog (M6).
 *
 * The first-party connectors are loaded from `connector-rules.ts`. A third-party
 * connector is added with `connectorRegistry.register(manifest, handler)` — and that
 * is the whole marketplace seam: shipping one is a registration, not a change to
 * this file or to the install path.
 */
export const connectorRegistry = new ConnectorRegistry();

/**
 * The configured connector marketplace service (M6).
 *
 * It shares the ticket stack's audit sink, so a connector installed, configured,
 * switched on or removed joins the same per-tenant hash chain as the tickets it will
 * carry. Config values never reach that chain — only which fields were set and which
 * are secrets (`auditConfigSummary`).
 */
export function connectorServicesFor(): ConnectorService {
  connectors ??= new ConnectorService(
    new PrismaConnectorStore(prisma as unknown as ConnectorPrismaClient),
    connectorRegistry,
    ticketServices().audit,
  );
  return connectors;
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
