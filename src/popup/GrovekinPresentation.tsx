export function GrovekinPresentation({ condition, stage }: { condition: string; stage: number }) {
  return (
    <div className={`grovekin-art grovekin-${condition} grovekin-stage-${stage}`} role="img" aria-label={`Static Grovekin presentation: Stage ${stage}, ${condition} Condition`}>
      <span className="grovekin-leaf grovekin-leaf-left" aria-hidden="true" />
      <span className="grovekin-face" aria-hidden="true"><span className="grovekin-eye" /><span className="grovekin-eye" /></span>
      <span className="grovekin-leaf grovekin-leaf-right" aria-hidden="true" />
      <span className="visually-hidden">Condition is explicit text: {condition}. Evolution Stage {stage} is shown in text.</span>
    </div>
  );
}
