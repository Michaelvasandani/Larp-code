declare module "*.mjs" {
  export function validateNetworkTrace(trace: unknown, options?: unknown): unknown;
  export function captureNetworkTrace(options: unknown): Promise<unknown>;
  export function createDeterministicZip(packageRoot: string, archivePath: string): string;
  export function validatePublishableKey(value: string): { role: string };
  export function validatePublicationPackage(inputPath: string, options?: unknown): Promise<unknown>;
  export function auditQualificationRecord(record: unknown, options?: unknown): { eligible: boolean; blockers: string[]; earliestBlockedGate: number | null; record: unknown };
  export function findEarliestBlockedGate(gates: unknown): number | null;
  export function validateQualificationRecord(record: unknown, options?: unknown): { eligible: true; blockers: string[]; earliestBlockedGate: number | null; record: unknown };
  export function qualificationRecordPath(root: string): string;
  export function readQualificationRecord(path: string): unknown;
}
