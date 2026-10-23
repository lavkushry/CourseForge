import type { HistoryItem } from '../contracts';
import { formatTime } from '../player/controller';

/** Empty-state copy when history failed to load vs truly empty. */
export function historyLoadFailureCopy(message: string): { title: string; description: string } {
  return {
    title: 'Could not load watch history',
    description: message,
  };
}

export function historyStatusLabels(
  item: HistoryItem,
  pct: number,
  done: boolean,
): { percentLabel: string; remainLabel: string } {
  if (done) {
    return { percentLabel: 'Completed', remainLabel: 'Finished' };
  }
  if (pct === 0 && item.position > 10) {
    return {
      percentLabel: `Resume at ${formatTime(item.position)}`,
      remainLabel: remainingLabel(item),
    };
  }
  return {
    percentLabel: `${pct}% watched`,
    remainLabel: remainingLabel(item),
  };
}

function remainingLabel(item: HistoryItem): string {
  if (item.duration_seconds <= 0) {
    return `At ${formatTime(item.position)}`;
  }
  const remainingSec = Math.max(0, item.duration_seconds - item.position);
  return remainingSec > 60 ? `${Math.ceil(remainingSec / 60)} min left` : 'Almost finished';
}
