/** Shared AI dependency honesty — never invent online/success/latency. */

export interface AiDependencyStatus {
  ollama_online: boolean;
  pgvector_active: boolean;
  transcript_chunks: number;
  embeddings_count?: number;
  vector_dimensions?: number;
  ollama_chat_model?: string;
  ollama_embedding_model?: string;
  qdrant_configured?: boolean;
  qdrant_online?: boolean;
}

export function aiOllamaReady(status: AiDependencyStatus | null | undefined): boolean {
  return Boolean(status?.ollama_online);
}

export function aiRetrievalReady(status: AiDependencyStatus | null | undefined): boolean {
  if (!status) return false;
  if (status.qdrant_configured) return Boolean(status.qdrant_online);
  return Boolean(status.pgvector_active);
}

export function aiOfflineBanner(status: AiDependencyStatus | null | undefined): string | null {
  if (!status) {
    return 'AI status is unknown. Companion, index, and scan actions stay disabled until status is measured.';
  }
  const parts: string[] = [];
  if (!status.ollama_online) {
    parts.push(
      `Ollama is offline${status.ollama_chat_model ? ` (expected ${status.ollama_chat_model})` : ''}`,
    );
  }
  if (status.qdrant_configured && !status.qdrant_online) {
    parts.push('Qdrant is offline');
  } else if (!status.qdrant_configured && !status.pgvector_active) {
    parts.push('pgvector is not active');
  }
  if (!parts.length) return null;
  return `${parts.join(' · ')}. Indexed chunks: ${status.transcript_chunks}. Success, citations, and latency are never invented.`;
}

export function aiStatusLabel(status: AiDependencyStatus | null | undefined): string {
  if (!status) return 'AI status unknown';
  if (status.ollama_online && aiRetrievalReady(status)) {
    return `Ollama online · ${status.ollama_chat_model || 'chat model'} · ${status.transcript_chunks} indexed chunks`;
  }
  if (!status.ollama_online) return 'Ollama offline';
  if (status.qdrant_configured && !status.qdrant_online) return 'Qdrant offline';
  return 'Vector retrieval offline';
}

export function companionUnavailableCopy(status: AiDependencyStatus | null | undefined): {
  title: string;
  description: string;
} {
  const offline = aiOfflineBanner(status);
  return {
    title: 'Companion unavailable',
    description:
      offline ||
      'Companion briefs require measured AI dependencies. Nothing is fabricated when adapters are offline.',
  };
}

export function indexScanUnavailableCopy(status: AiDependencyStatus | null | undefined): {
  title: string;
  description: string;
} {
  const offline = aiOfflineBanner(status);
  return {
    title: 'Index / scan unavailable',
    description:
      offline ||
      'Index and scan jobs are not started when AI or vector dependencies are offline. Progress is never invented.',
  };
}
