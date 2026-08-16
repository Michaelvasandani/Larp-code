import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  PROTOCOL_VERSION,
  isPopupRequest,
  type AppSnapshot,
  type PopupRequest,
  type PopupResponse,
  type ProtocolError,
  type WorkerEvidence,
} from "../shared/protocol";

const BOOT_COUNT_KEY = "larp-code.workerBootCount";
const SESSION_STORAGE_PREFIX = "larp-code.supabase.";

type FoundationHealth = {
  service: "larp-code";
  schemaVersion: number;
  serverTime: string;
};

const extensionStorage = {
  async getItem(key: string): Promise<string | null> {
    const values = await chrome.storage.local.get(`${SESSION_STORAGE_PREFIX}${key}`);
    const value = values[`${SESSION_STORAGE_PREFIX}${key}`];
    return typeof value === "string" ? value : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [`${SESSION_STORAGE_PREFIX}${key}`]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(`${SESSION_STORAGE_PREFIX}${key}`);
  },
};

const client: SupabaseClient = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    persistSession: true,
    storage: extensionStorage,
  },
});

const bootId = crypto.randomUUID();
const workerEvidencePromise = initializeWorkerEvidence();
const popupPorts = new Set<chrome.runtime.Port>();

async function initializeWorkerEvidence(): Promise<WorkerEvidence> {
  const stored = await chrome.storage.local.get(BOOT_COUNT_KEY);
  const previous = typeof stored[BOOT_COUNT_KEY] === "number" ? stored[BOOT_COUNT_KEY] : 0;
  const bootCount = previous + 1;
  await chrome.storage.local.set({ [BOOT_COUNT_KEY]: bootCount });
  const { data } = await client.auth.getSession();
  return {
    bootId,
    bootCount,
    sessionRestoredFromStorage: Boolean(data.session),
  };
}

function isFoundationHealth(value: unknown): value is FoundationHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return health.service === "larp-code"
    && typeof health.schemaVersion === "number"
    && Number.isInteger(health.schemaVersion)
    && typeof health.serverTime === "string"
    && !Number.isNaN(Date.parse(health.serverTime));
}

async function readFoundationHealth(): Promise<FoundationHealth> {
  const { data, error } = await client.rpc("foundation_health_v1");
  if (error) throw error;
  if (!isFoundationHealth(data)) throw new Error("The backend returned an invalid foundation health response.");
  return data;
}

function snapshotMetadata(health: FoundationHealth, worker: WorkerEvidence) {
  const fetchedAt = new Date().toISOString();
  return {
    contractVersion: PROTOCOL_VERSION,
    authoritativeServerTime: health.serverTime,
    freshness: {
      revision: `${health.schemaVersion}:${health.serverTime}`,
      fetchedAt,
    },
    compatibility: { minimumClientVersion: __CLIENT_VERSION__ },
    backend: { status: "reachable" as const, schemaVersion: health.schemaVersion },
    worker,
  };
}

async function getAppSnapshot(): Promise<AppSnapshot> {
  const [health, worker] = await Promise.all([readFoundationHealth(), workerEvidencePromise]);
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const metadata = snapshotMetadata(health, worker);
  return data.session
    ? { ...metadata, kind: "setup_required" }
    : { ...metadata, kind: "signed_out" };
}

function diagnosticId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function toProtocolError(error: unknown): ProtocolError {
  const message = error instanceof Error ? error.message : String(error);
  const isConnectionError = /fetch|network|connect|supabase|failed to reach|unavailable/i.test(message);
  return {
    code: isConnectionError ? "connection_unavailable" : "internal",
    message: isConnectionError ? "The larp-code connection is unavailable." : "The foundation could not load current state.",
    diagnosticId: diagnosticId(),
  };
}

async function handleRequest(_request: PopupRequest): Promise<PopupResponse> {
  try {
    return { ok: true, snapshot: await getAppSnapshot() };
  } catch (error) {
    return { ok: false, error: toProtocolError(error) };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isPopupRequest(message)) return false;
  void handleRequest(message).then(sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== `larp-code-popup-v${PROTOCOL_VERSION}`) return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});
