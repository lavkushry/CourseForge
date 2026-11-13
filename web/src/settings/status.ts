import type { AiDependencyStatus } from '../ai/status';
import { aiOfflineBanner, aiOllamaReady, aiStatusLabel } from '../ai/status';

export function settingsAiPanelCopy(status: AiDependencyStatus | null): {
  title: string;
  description: string;
  ready: boolean;
} {
  if (!status) {
    return {
      title: 'Local AI status unknown',
      description: 'AI status has not been measured yet. Ollama is not started from Settings.',
      ready: false,
    };
  }
  const ready = aiOllamaReady(status);
  const offline = aiOfflineBanner(status);
  return {
    title: ready ? 'Local AI reachable' : 'Local AI offline',
    description:
      offline ||
      `${aiStatusLabel(status)}. Indexed chunks: ${status.transcript_chunks}. Settings never invents online status.`,
    ready,
  };
}

export function settingsPrivacyCopy(): string {
  return 'Theme and accent stay in this browser. Player defaults require a durable preferences acknowledgment. Planner goals sync when the planner API accepts the write; otherwise a local fallback is kept. Local AI is never started from this page.';
}
