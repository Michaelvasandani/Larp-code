declare module "*.mjs" {
  export function validateNetworkTrace(trace: unknown, options?: unknown): unknown;
  export function captureNetworkTrace(options: unknown): Promise<unknown>;
  export function createDeterministicZip(packageRoot: string, archivePath: string): string;
  export function validatePublishableKey(value: string): { role: string };
  export function validatePublicationPackage(inputPath: string, options?: unknown): Promise<unknown>;
}
