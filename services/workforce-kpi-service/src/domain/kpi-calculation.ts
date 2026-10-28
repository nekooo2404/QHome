export interface KpiInput {
  difficultyWeight: number;
  startedAt: Date;
  deadlineAt: Date;
  completedAt: Date;
  rating?: number;
}

export function calculateKpiScore(input: KpiInput): { onTime: boolean; completionMinutes: number; score: number; rating: number } {
  if (!Number.isFinite(input.difficultyWeight) || input.difficultyWeight <= 0) throw new Error('difficultyWeight must be positive');
  const completionMinutes = Math.max(0, Math.round((input.completedAt.getTime() - input.startedAt.getTime()) / 60_000));
  const onTime = input.completedAt.getTime() <= input.deadlineAt.getTime();
  const latenessHours = Math.max(0, (input.completedAt.getTime() - input.deadlineAt.getTime()) / 3_600_000);
  const timelinessFactor = onTime ? 1 : Math.max(0, 1 - Math.min(1, latenessHours / 24));
  const rating = Math.min(5, Math.max(0, input.rating ?? 5));
  const score = input.difficultyWeight * 100 * (timelinessFactor * 0.6 + (rating / 5) * 0.4);
  return { onTime, completionMinutes, score, rating };
}
