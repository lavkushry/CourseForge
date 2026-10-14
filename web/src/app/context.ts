import { ApiClient } from '../api';
import { LearningApi } from '../learning/api';
import type { Course, Lesson, Note, User } from '../contracts';
import type { DiscoveryView } from '../discovery/view';
import type { LearningView } from '../learning/view';
import type { CertificatesView } from '../certificates/view';
import type { PathsView } from '../paths/view';
import type { AdminView } from '../admin/view';
import type { SyllabusDialog } from '../discovery/syllabus-dialog';
import type { StudyRail } from '../player/study-rail';
import type { LibraryView } from '../library/view';
import type { HistoryView } from '../history/view';
import type { SettingsView } from '../settings/view';
import type { PlanningView } from '../planning/view';
import type { ReviewsView } from '../reviews/view';
import type { TutorView } from '../tutor/view';
import type { LabsView } from '../labs/view';
import type { OmniSearch } from '../search/omni';
import type { PlayerController, PlayerState } from '../player/controller';
import type { PreferenceStore } from '../player/preferences';
import type { PulseAck } from '../contracts';
import type { CatalogView } from '../discovery/view';

export type NavigationHandle = {
  signal: AbortSignal;
  generation: number;
  current(): boolean;
};

export type AppContext = {
  api: ApiClient;
  learningApi: LearningApi;
  app: HTMLElement;
  user: User | null;
  controller: PlayerController | null;
  preferences: PreferenceStore | null;
  pageScope: AbortController;
  navigationScope: AbortController;
  navigationGeneration: number;
  lessons: Lesson[];
  selectedLesson: Lesson | null;
  selectedCourse: Course | null;
  discovery: DiscoveryView | null;
  learning: LearningView | null;
  certificates: CertificatesView | null;
  pathsView: PathsView | null;
  adminView: AdminView | null;
  syllabusDialog: SyllabusDialog | null;
  studyRail: StudyRail | null;
  libraryView: LibraryView | null;
  historyView: HistoryView | null;
  settingsView: SettingsView | null;
  planningView: PlanningView | null;
  reviewsView: ReviewsView | null;
  tutorView: TutorView | null;
  labsView: LabsView | null;
  omniSearch: OmniSearch | null;
  lessonCursor: string | null;
  noteCursor: string | null;
  noteSubmission: { lessonId: string; key: string; content: string; position: number } | null;
  learnedLessons: Set<string>;
  learnedCursor: string;
  learnedLoaded: boolean;

  feedback(message: string, error?: boolean): void;
  newNavigation(): NavigationHandle;
  renderLogin(message?: string): void;
  renderApp(account: User): void;
  hideAllWorkspaces(): void;
  setWorkspaceMode(mode: 'normal' | 'studio'): void;
  setActiveNav(name: string): void;
  showLibrary(): Promise<void>;
  showPlanner(): Promise<void>;
  showHistory(): Promise<void>;
  showSettings(): Promise<void>;
  showReviews(): Promise<void>;
  showTutor(): Promise<void>;
  showLabs(): Promise<void>;
  showPaths(): Promise<void>;
  showAdmin(): Promise<void>;
  openCourseSyllabus(course: Course): Promise<void>;
  loadCatalog(_append?: boolean, view?: CatalogView): Promise<void>;
  resumeLesson(courseId: string, lessonId: string): Promise<void>;
  loadCourse(id: string, preview?: boolean, targetLessonId?: string, autoplay?: boolean): Promise<void>;
  loadLesson(lesson: Lesson, autoplay?: boolean, takeOver?: boolean): Promise<void>;
  renderLessons(): void;
  loadLearnedStatus(append?: boolean): Promise<void>;
  nextLesson(): Lesson | null;
  loadMoreLessons(): Promise<void>;
  prefetchLesson(lessonId: string): Promise<void>;
  markComplete(targetLessonId?: string): Promise<void>;
  loadNotes(lessonId: string, append?: boolean): Promise<void>;
  renderNote(note: Note): HTMLElement;
  saveNote(): Promise<void>;
  updatePlayerState(state: PlayerState, message: string): void;
  updateProgress(ack: PulseAck): void;
  renderMaterials(lesson: Lesson): void;
  closeEpisodes(): void;
  toggleTheater(): void;
  fullscreen(): Promise<void>;
  togglePiP(): Promise<void>;
  restoreBrowserPreferences(video: HTMLVideoElement): void;
  bindInterface(video: HTMLVideoElement, signal: AbortSignal): void;
  bootstrapFeatureViews(account: User): void;
};

export function createBaseContext(app: HTMLElement): AppContext {
  const api = new ApiClient();
  const ctx = {
    api,
    learningApi: new LearningApi(api),
    app,
    user: null,
    controller: null,
    preferences: null,
    pageScope: new AbortController(),
    navigationScope: new AbortController(),
    navigationGeneration: 0,
    lessons: [],
    selectedLesson: null,
    selectedCourse: null,
    discovery: null,
    learning: null,
    certificates: null,
    pathsView: null,
    adminView: null,
    syllabusDialog: null,
    studyRail: null,
    libraryView: null,
    historyView: null,
    settingsView: null,
    planningView: null,
    reviewsView: null,
    tutorView: null,
    labsView: null,
    omniSearch: null,
    lessonCursor: null,
    noteCursor: null,
    noteSubmission: null,
    learnedLessons: new Set<string>(),
    learnedCursor: '',
    learnedLoaded: false,
  } as unknown as AppContext;

  ctx.feedback = (message: string, error = false): void => {
    const node = document.querySelector<HTMLElement>('#notice');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('is-error', error);
    node.hidden = !message;
  };

  return ctx;
}
