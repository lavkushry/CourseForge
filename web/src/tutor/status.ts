import {
  aiOllamaReady,
  aiOfflineBanner,
  type AiDependencyStatus,
} from '../ai/status';

export type TutorAiStatus = AiDependencyStatus;

export function tutorIsReady(status: TutorAiStatus | null): boolean {
  return aiOllamaReady(status);
}

export function tutorUnavailableCopy(status: TutorAiStatus | null): { title: string; description: string } {
  if (!status) {
    return {
      title: 'AI tutor unavailable',
      description: 'AI status is unknown. Ask is disabled until Ollama reports online.',
    };
  }
  const offline = aiOfflineBanner(status);
  return {
    title: 'AI tutor unavailable',
    description:
      (offline ||
        `Ollama is offline${status.ollama_chat_model ? ` (expected model: ${status.ollama_chat_model})` : ''}. Indexed chunks: ${status.transcript_chunks}.`) +
      ' Ask is disabled until a local model is online — answers are never invented.',
  };
}
