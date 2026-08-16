import clipRegistry from "../../art/grovekin/clip-registry.json";

export type GrovekinPlaybackClip =
  | "hungry-accent"
  | "sad-accent"
  | "deteriorated-accent"
  | "solve-reaction"
  | "evolution-transition"
  | "stage-4-farewell";

export const GROVEKIN_CLIP_REGISTRY = clipRegistry;

export function isGrovekinPlaybackClip(value: string): value is GrovekinPlaybackClip {
  return GROVEKIN_CLIP_REGISTRY.clips.some((clip) => clip.id === value && clip.template !== "idle");
}

export function clipVariantStage(clipId: string, stage: number): number {
  if (clipId === "evolution-transition") return stage;
  return stage;
}

export function idleClipId(stage: number): string {
  return `stage-${stage}-idle`;
}
