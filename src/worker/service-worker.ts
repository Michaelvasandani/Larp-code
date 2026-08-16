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
import {
  createAuthSessionAdapter,
  type AuthApi,
  type MemberStorage,
} from "./auth-session";
import {
  createMemberAccountAdapter,
  parseMemberAccount,
  type MemberAccountRpc,
} from "./member-account";

const BOOT_COUNT_KEY = "larp-code.workerBootCount";
const SESSION_STORAGE_PREFIX = "larp-code.supabase.";

type FoundationHealth = {
  service: "larp-code";
  schemaVersion: number;
  serverTime: string;
};

function createPrefixedStorage(prefix: string) {
  const storageKey = (key: string) => `${prefix}${key}`;
  return {
    async getItem(key: string): Promise<string | null> {
      const values = await chrome.storage.local.get(storageKey(key));
      const value = values[storageKey(key)];
      return typeof value === "string" ? value : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      await chrome.storage.local.set({ [storageKey(key)]: value });
    },
    async removeItem(key: string): Promise<void> {
      await chrome.storage.local.remove(storageKey(key));
    },
    async get(key: string): Promise<unknown> {
      const values = await chrome.storage.local.get(storageKey(key));
      return values[storageKey(key)] ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [storageKey(key)]: value });
    },
    async remove(key: string): Promise<void> {
      await chrome.storage.local.remove(storageKey(key));
    },
    async clear(): Promise<void> {
      const values = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(
        Object.keys(values).filter((key) => key.startsWith(prefix)),
      );
    },
  };
}

const extensionStorage = createPrefixedStorage(SESSION_STORAGE_PREFIX);
const memberStorage: MemberStorage = extensionStorage;

const client: SupabaseClient = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
  auth: {
    // The adapter owns the single explicit refresh attempt for each snapshot.
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: true,
    storage: extensionStorage,
  },
});

const authSessionAdapter = createAuthSessionAdapter({
  auth: client.auth as unknown as AuthApi,
  storage: memberStorage,
});
const memberAccountRpc: MemberAccountRpc = {
  async getMemberAccount() {
    const response = await client.rpc("get_member_account_v1");
    const data: unknown = response.data;
    const error: unknown = response.error;
    if (error) throw error;
    return data === null ? null : parseMemberAccount(data);
  },
  async createMemberAccount(input) {
    const { data, error } = await client.rpc("create_member_account_v1", {
      p_display_name: input.displayName,
      p_adult_confirmed: input.adultConfirmed,
      p_consent_accepted: input.consentAccepted,
      p_consent_version: input.consentVersion,
    });
    if (error) throw error;
    return parseMemberAccount(data);
  },
};
const bootId = crypto.randomUUID();
const initialSessionStatePromise = authSessionAdapter.restoreSession();
let pendingSnapshotSession: typeof initialSessionStatePromise | undefined = initialSessionStatePromise;
const workerEvidencePromise = initializeWorkerEvidence();
const popupPorts = new Set<chrome.runtime.Port>();

async function initializeWorkerEvidence(): Promise<WorkerEvidence> {
  const stored = await chrome.storage.local.get(BOOT_COUNT_KEY);
  const previous = typeof stored[BOOT_COUNT_KEY] === "number" ? stored[BOOT_COUNT_KEY] : 0;
  const bootCount = previous + 1;
  await chrome.storage.local.set({ [BOOT_COUNT_KEY]: bootCount });
  const restored = await initialSessionStatePromise;
  return {
    bootId,
    bootCount,
    sessionRestoredFromStorage: restored.status === "authenticated",
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
  let data: unknown;
  let error: unknown;
  try {
    const response = await client.rpc("foundation_health_v1");
    data = response.data;
    error = response.error;
  } catch {
    throw new Error("The backend connection is unavailable.");
  }
  if (error) throw new Error("The backend connection is unavailable.");
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
  const sessionStatePromise = pendingSnapshotSession ?? authSessionAdapter.restoreSession();
  pendingSnapshotSession = undefined;
  const [health, worker, sessionState] = await Promise.all([
    readFoundationHealth(),
    workerEvidencePromise,
    sessionStatePromise,
  ]);
  if (sessionState.status === "service_unavailable") throw new Error("The authentication connection is unavailable.");
  const metadata = snapshotMetadata(health, worker);
  if (sessionState.status !== "authenticated") return { ...metadata, kind: "signed_out" };

  const memberAccount = createMemberAccountAdapter({ rpc: memberAccountRpc, session: sessionState.session });
  const account = await memberAccount.getMemberAccount();
  if (!account) {
    const email = sessionState.session.user.email;
    if (!email) throw new Error("The authenticated session has no verified email.");
    return { ...metadata, kind: "setup_required", email };
  }
  return { ...metadata, kind: "account", account };
}

function diagnosticId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function toProtocolError(error: unknown): ProtocolError {
  const message = error instanceof Error ? error.message : String(error);
  const isConnectionError = /fetch|network|connect|supabase|failed to reach|unavailable|socket|refused|reset|aborted|json/i.test(message);
  const isUnauthorized = /unauthorized|authentication is required|verified email is required/i.test(message);
  const isBadRequest = /required|characters or fewer|consent version|adult confirmation/i.test(message);
  return {
    code: isConnectionError ? "connection_unavailable" : isUnauthorized ? "unauthorized" : isBadRequest ? "bad_request" : "internal",
    message: isConnectionError
      ? "The larp-code connection is unavailable."
      : isUnauthorized
        ? "Sign in with the verified email to continue."
        : isBadRequest
          ? message
          : "The foundation could not load current state.",
    diagnosticId: diagnosticId(),
  };
}

async function responseWithAuth(auth: NonNullable<Extract<PopupResponse, { ok: true }>['auth']>): Promise<PopupResponse> {
  return { ok: true, auth };
}

async function handleRequest(request: PopupRequest): Promise<PopupResponse> {
  try {
    switch (request.type) {
      case "get_snapshot":
        return { ok: true, snapshot: await getAppSnapshot() };
      case "request_email_otp":
      case "resend_email_otp":
        return responseWithAuth(await authSessionAdapter.requestEmailOtp(request.email));
      case "verify_email_otp": {
        const result = await authSessionAdapter.verifyEmailOtp(request.email, request.token);
        if (result.status === "authenticated") return { ok: true, snapshot: await getAppSnapshot() };
        return responseWithAuth(result);
      }
      case "create_member_account": {
        const sessionState = await authSessionAdapter.restoreSession();
        if (sessionState.status === "service_unavailable") throw new Error("The authentication connection is unavailable.");
        if (sessionState.status !== "authenticated") throw new Error("Authentication is required.");
        const memberAccount = createMemberAccountAdapter({ rpc: memberAccountRpc, session: sessionState.session });
        await memberAccount.createMemberAccount(request);
        return { ok: true, snapshot: await getAppSnapshot() };
      }
      case "sign_out": {
        await authSessionAdapter.signOut();
        try {
          return { ok: true, snapshot: await getAppSnapshot(), auth: { status: "ready" } };
        } catch {
          return responseWithAuth({ status: "ready" });
        }
      }
    }
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
