import type { HttpClient } from './http';

import type { AiDependencyStatus } from '../ai/status';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid AI status response');
  }
  return value as Record<string, unknown>;
}

export function parseAiStatus(value: unknown): AiDependencyStatus {
  const data = object(value);
  return {
    pgvector_active: data.pgvector_active === true,
    vector_dimensions: typeof data.vector_dimensions === 'number' ? data.vector_dimensions : 0,
    embeddings_count: typeof data.embeddings_count === 'number' ? data.embeddings_count : 0,
    transcript_chunks: typeof data.transcript_chunks === 'number' ? data.transcript_chunks : 0,
    ollama_online: data.ollama_online === true,
    ollama_embedding_model:
      typeof data.ollama_embedding_model === 'string' ? data.ollama_embedding_model : '',
    ollama_chat_model: typeof data.ollama_chat_model === 'string' ? data.ollama_chat_model : '',
    qdrant_configured: data.qdrant_configured === true,
    qdrant_online: data.qdrant_online === true,
  };
}

export function aiStatus(client: HttpClient, signal?: AbortSignal): Promise<AiDependencyStatus> {
  return client.request('/ai/status', signal ? { signal } : {}).then(parseAiStatus);
}

export function aiAsk(
  client: HttpClient,
  courseId: string,
  lessonId: string,
  question: string,
  mode = 'general',
  signal?: AbortSignal,
): Promise<{
  answer: string;
  mode: string;
  citations: Array<{
    chunk_id: string;
    lesson_id: string;
    lesson_title: string;
    start_seconds: number;
    end_seconds: number;
    text: string;
  }>;
}> {
  return client.request('/ai/tutor/ask', {
    method: 'POST',
    body: { course_id: courseId, lesson_id: lessonId, question, mode },
    ...(signal ? { signal } : {}),
  });
}

export function aiSummary(
  client: HttpClient,
  lessonId: string,
  signal?: AbortSignal,
): Promise<{
  lesson_id: string;
  title: string;
  course_id: string;
  summary: string;
}> {
  return client.request(`/ai/lessons/${encodeURIComponent(lessonId)}/summary`, signal ? { signal } : {});
}

export function getLessonTranscripts(
  client: HttpClient,
  lessonId: string,
  signal?: AbortSignal,
): Promise<{
  lesson_id: string;
  title: string;
  count: number;
  chunks: Array<{
    id: string;
    start_seconds: number;
    end_seconds: number;
    text: string;
    kind: string;
  }>;
}> {
  return client.request(`/ai/lessons/${encodeURIComponent(lessonId)}/transcripts`, signal ? { signal } : {});
}

export function getLessonChapters(
  client: HttpClient,
  lessonId: string,
  signal?: AbortSignal,
): Promise<{
  lesson_id: string;
  title: string;
  duration: number;
  chapters: Array<{
    index: number;
    title: string;
    start_seconds: number;
    end_seconds: number;
    summary: string;
  }>;
}> {
  return client.request(`/ai/lessons/${encodeURIComponent(lessonId)}/chapters`, signal ? { signal } : {});
}

export function classifyVideoSplit(
  client: HttpClient,
  lessonId: string,
  signal?: AbortSignal,
): Promise<{
  lesson_id: string;
  title: string;
  chapters: Array<{
    index: number;
    title: string;
    start_seconds: number;
    end_seconds: number;
    summary: string;
  }>;
}> {
  return client.request(`/ai/lessons/${encodeURIComponent(lessonId)}/classify-split`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
}

export function generateAiRoadmap(
  client: HttpClient,
  goal: string,
  role?: string,
  signal?: AbortSignal,
): Promise<{
  id: string;
  goal: string;
  target_role: string;
  estimated_weeks: number;
  steps: Array<{
    step_number: number;
    title: string;
    description: string;
    course_id: string;
    course_title: string;
    estimated_hours: number;
    key_concepts: string[];
  }>;
}> {
  return client.request('/ai/roadmaps/generate', {
    method: 'POST',
    body: { goal, role: role || '' },
    ...(signal ? { signal } : {}),
  });
}
