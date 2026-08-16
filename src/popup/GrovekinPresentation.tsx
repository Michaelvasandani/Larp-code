import { useEffect, useMemo, useState } from "react";

import grovekinManifest from "../../art/grovekin/generated/manifest.json";
import { clipVariantStage, idleClipId } from "./grovekin-clips";
import type { GrovekinTransition } from "./grovekin-motion";

type GrovekinCondition = "healthy" | "hungry" | "sad" | "deteriorated";

type AnimationManifest = {
  frames?: readonly { id: string; file: string }[];
  clips?: readonly {
    id: string;
    loop: boolean;
    frames: readonly { frameId: string; durationMs: number }[];
    variants?: readonly {
      stage: number;
      fromStage: number;
      toStage: number;
      frames: readonly { frameId: string; durationMs: number }[];
    }[];
  }[];
};

const animationManifest = grovekinManifest as AnimationManifest;

function assetUrl(file: string): string {
  const extensionRuntime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
  return extensionRuntime?.getURL?.(`assets/grovekin/${file}`) ?? `/assets/grovekin/${file}`;
}

function validCondition(condition: string): GrovekinCondition {
  return condition === "hungry" || condition === "sad" || condition === "deteriorated" ? condition : "healthy";
}

function validStage(stage: number): 1 | 2 | 3 | 4 {
  return stage === 2 || stage === 3 || stage === 4 ? stage : 1;
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ));
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reducedMotion;
}

export function GrovekinPresentation({
  condition,
  stage,
  transition = "none",
}: {
  condition: string;
  stage: number;
  transition?: GrovekinTransition;
}) {
  const safeCondition = validCondition(condition);
  const safeStage = validStage(stage);
  const reducedMotion = useReducedMotion();
  const staticFile = `stills/stage-${safeStage}-${safeCondition}.png`;
  const clipId = transition !== "none"
    ? transition
    : safeCondition === "healthy"
      ? idleClipId(safeStage)
      : null;
  const clip = useMemo(
    () => animationManifest.clips?.find((candidate) => candidate.id === clipId),
    [clipId],
  );
  const frameById = useMemo(
    () => new Map((animationManifest.frames ?? []).map((frame) => [frame.id, frame.file])),
    [],
  );
  const frames = useMemo(() => {
    const variant = clip?.variants?.find((candidate) => candidate.stage === clipVariantStage(clip.id, safeStage));
    return variant?.frames ?? clip?.frames ?? [];
  }, [clip, safeStage]);
  const [frameIndex, setFrameIndex] = useState(0);
  const animated = Boolean(clip && !reducedMotion);
  const frame = animated && frames.length > 0 ? frames[frameIndex % frames.length] : undefined;
  const frameFile = frame ? frameById.get(frame.frameId) : undefined;

  useEffect(() => {
    setFrameIndex(0);
    if (!clip || reducedMotion || frames.length < 1) return undefined;
    let timer: number | undefined;
    const advance = (index: number) => {
      const duration = frames[index]?.durationMs ?? 160;
      timer = window.setTimeout(() => {
        const nextIndex = index + 1;
        if (nextIndex >= frames.length && !clip.loop) {
          setFrameIndex(frames.length - 1);
          return;
        }
        const next = clip.loop ? nextIndex % frames.length : nextIndex;
        setFrameIndex(next);
        advance(next);
      }, duration);
    };
    advance(0);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clip, frames, reducedMotion]);

  const transitionLabel = transition !== "none" ? `, ${transition.replaceAll("-", " ")} playback` : "";
  return (
    <div
      className={`grovekin-art grovekin-${safeCondition} grovekin-stage-${safeStage}${animated ? " grovekin-animated" : " grovekin-static"}`}
      role="img"
      aria-label={`Grovekin Stage ${safeStage}, ${safeCondition} Condition${transitionLabel}`}
    >
      <img className="grovekin-still" src={assetUrl(staticFile)} alt="" width="48" height="48" draggable={false} />
      {frameFile && (
        <img
          className="grovekin-frame"
          src={assetUrl(frameFile)}
          alt=""
          width="48"
          height="48"
          aria-hidden="true"
          draggable={false}
        />
      )}
      <span className="visually-hidden">Static Grovekin presentation remains available. Condition is explicit text: {safeCondition}. Evolution Stage {safeStage} is shown in text.</span>
    </div>
  );
}
