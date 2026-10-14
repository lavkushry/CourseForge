import type { HttpClient } from './http';

export function aiStatus(client: HttpClient, signal?: AbortSignal): Promise<{
  pgvector_active: boolean;
  vector_dimensions: number;
  embeddings_count: number;
  transcript_chunks: number;
  ollama_online: boolean;
  ollama_embedding_model: string;
  ollama_chat_model: string;
}> {
  return client.request('/ai/status', signal ? { signal } : {});
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
