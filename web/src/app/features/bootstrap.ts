import type { User } from '../../contracts';
import type { AppContext } from '../context';
import { errorMessage, isAbort } from '../../api';
import { required } from '../../components';
import { CertificatesView } from '../../certificates/view';
import { LearningView } from '../../learning/view';
import { SyllabusDialog } from '../../discovery/syllabus-dialog';
import { StudyRail } from '../../player/study-rail';
import { LibraryView } from '../../library/view';
import { HistoryView } from '../../history/view';
import { SettingsView } from '../../settings/view';
import { DiscoveryView } from '../../discovery/view';
import { OmniSearch } from '../../search/omni';
import { adminDeniedCopy } from '../../admin/rbac';

/** Seek after resume once the player controller exists (phone load can lag the open). */
function seekWhenReady(ctx: AppContext, position: number | undefined, tries = 24): void {
  if (position === undefined || !Number.isFinite(position) || position <= 0) return;
  const attempt = (): void => {
    if (ctx.controller) {
      ctx.controller.seek(position);
      return;
    }
    if (tries <= 0) return;
    tries -= 1;
    window.setTimeout(attempt, 120);
  };
  attempt();
}

/** Play/open for watch: enroll when needed so lesson lease is not blocked by preview. */
async function openCourseForWatch(ctx: AppContext, id: string, preview: boolean): Promise<void> {
  let asPreview = preview;
  if (asPreview && ctx.user && ctx.user.role !== 'admin') {
    try {
      await ctx.api.enroll(id, ctx.navigationScope.signal);
      asPreview = false;
    } catch (err) {
      if (!isAbort(err)) ctx.feedback(errorMessage(err), true);
    }
  }
  await ctx.loadCourse(id, asPreview);
}

/** Eager: discovery/library/history/settings + player helpers. Heavy studio panels load on first visit. */
export function installFeatureBootstraps(ctx: AppContext): void {
  ctx.bootstrapFeatureViews = function bootstrapFeatureViews(account: User): void {
    ctx.certificates = new CertificatesView(ctx.api, ctx.feedback);
    ctx.learning = new LearningView(
      required<HTMLElement>('#learning-tools'),
      ctx.learningApi,
      () => ctx.controller?.position ?? 0,
      position => ctx.controller?.seek(position),
      () => {
        void ctx.controller?.close().then(() => {
          ctx.controller = null;
          ctx.renderLogin('Your sign-in expired. Sign in again to continue.');
        });
      },
      lesson => {
        ctx.learnedLessons.add(lesson);
        ctx.renderLessons();
      },
    );
    ctx.syllabusDialog = new SyllabusDialog();
    ctx.studyRail = new StudyRail({
      root: required<HTMLElement>('#study-rail'),
      dock: required<HTMLElement>('#focus-dock'),
      api: ctx.api,
      learningApi: ctx.learningApi,
      getCurrentPosition: () => ctx.controller?.position ?? 0,
      seekTo: sec => ctx.controller?.seek(sec),
      onPlayLesson: lesson => {
        void ctx.loadLesson(lesson, true, false);
      },
      onMarkComplete: async lessonId => {
        await ctx.markComplete(lessonId);
      },
      onQuizPassed: lessonId => {
        ctx.learnedLessons.add(lessonId);
        ctx.renderLessons();
      },
    });
    ctx.libraryView = new LibraryView({
      root: required<HTMLElement>('#library-panel'),
      api: ctx.api,
      onOpenSyllabus: course => {
        void ctx.openCourseSyllabus(course);
      },
      onPlayCourse: course => {
        void openCourseForWatch(ctx, course.id, !course.enrolled);
      },
      onContinueLesson: (courseId, lessonId, position) => {
        void ctx.resumeLesson(courseId, lessonId).then(() => seekWhenReady(ctx, position));
      },
      onToggleSave: async (course, currentlySaved) => {
        if (currentlySaved) {
          await ctx.api.removeSaved('course', course.id, ctx.navigationScope.signal);
          ctx.discovery?.setSaved(course.id, false);
          return false;
        }
        await ctx.api.saveCourse(course.id, ctx.navigationScope.signal);
        ctx.discovery?.setSaved(course.id, true);
        return true;
      },
      isSaved: id => ctx.discovery?.isSaved(id) ?? false,
      onOpenMyList: () => {
        void ctx.loadCatalog(false, 'saved');
      },
    });
    ctx.historyView = new HistoryView({
      root: required<HTMLElement>('#history-panel'),
      api: ctx.api,
      onResumeLesson: (courseId, lessonId, position) => {
        void ctx.resumeLesson(courseId, lessonId).then(() => seekWhenReady(ctx, position));
      },
    });
    ctx.settingsView = new SettingsView({
      root: required<HTMLElement>('#settings-panel'),
      api: ctx.api,
      account,
      onSignOut: () => {
        void ctx.api.logout().finally(() => {
          ctx.user = null;
          ctx.renderLogin();
        });
      },
      feedback: ctx.feedback,
    });

    // Deferred studio panels — constructed on first navigation to keep login→home fast.
    ctx.planningView = null;
    ctx.reviewsView = null;
    ctx.tutorView = null;
    ctx.labsView = null;
    ctx.careerView = null;
    ctx.pathsView = null;
    ctx.adminView = null;
    ctx.ensurePlanningView = async () => {
      if (ctx.planningView) return ctx.planningView;
      const { PlanningView } = await import('../../planning/view');
      ctx.planningView = new PlanningView({
        root: required<HTMLElement>('#planner-panel'),
        api: ctx.api,
        onNavigateLesson: lessonId => {
          void ctx.api
            .lesson(lessonId, ctx.navigationScope.signal)
            .then(res => {
              void ctx.resumeLesson(res.lesson.course_id, lessonId);
            })
            .catch(err => {
              if (!isAbort(err)) ctx.feedback(errorMessage(err), true);
            });
        },
      });
      return ctx.planningView;
    };
    ctx.ensureReviewsView = async () => {
      if (ctx.reviewsView) return ctx.reviewsView;
      const { ReviewsView } = await import('../../reviews/view');
      ctx.reviewsView = new ReviewsView({
        root: required<HTMLElement>('#reviews-panel'),
        api: ctx.api,
      });
      return ctx.reviewsView;
    };
    ctx.ensureTutorView = async () => {
      if (ctx.tutorView) return ctx.tutorView;
      const { TutorView } = await import('../../tutor/view');
      ctx.tutorView = new TutorView({
        root: required<HTMLElement>('#tutor-panel'),
        api: ctx.api,
        account,
        onNavigateLesson: (lessonId, timestamp) => {
          void ctx.api
            .lesson(lessonId, ctx.navigationScope.signal)
            .then(res => {
              void ctx.resumeLesson(res.lesson.course_id, lessonId).then(() => seekWhenReady(ctx, timestamp));
            })
            .catch(err => {
              if (!isAbort(err)) ctx.feedback(errorMessage(err), true);
            });
        },
      });
      return ctx.tutorView;
    };
    ctx.ensureLabsView = async () => {
      if (ctx.labsView) return ctx.labsView;
      const { LabsView } = await import('../../labs/view');
      ctx.labsView = new LabsView({
        root: required<HTMLElement>('#labs-panel'),
        api: ctx.api,
      });
      return ctx.labsView;
    };
    ctx.ensureCareerView = async () => {
      if (ctx.careerView) return ctx.careerView;
      const { CareerView } = await import('../../career/view');
      ctx.careerView = new CareerView({
        root: required<HTMLElement>('#career-panel'),
        api: ctx.api,
        account,
        feedback: ctx.feedback,
        onNavigatePlan: () => {
          const btn = document.querySelector<HTMLButtonElement>('#primary-nav [data-catalog-view="planner"]');
          btn?.click();
        },
      });
      return ctx.careerView;
    };
    ctx.ensurePathsView = async () => {
      if (ctx.pathsView) return ctx.pathsView;
      const { PathsView } = await import('../../paths/view');
      ctx.pathsView = new PathsView(
        required<HTMLElement>('#paths-panel'),
        ctx.api,
        (courseId, lessonId, start) => {
          void ctx.resumeLesson(courseId, lessonId).then(() => seekWhenReady(ctx, start));
        },
        ctx.feedback,
      );
      return ctx.pathsView;
    };
    ctx.ensureAdminView = async () => {
      if (account.role !== 'admin') {
        const panel = document.querySelector<HTMLElement>('#admin-panel');
        if (panel) {
          const denied = adminDeniedCopy();
          panel.hidden = false;
          panel.replaceChildren();
          const wrap = document.createElement('div');
          wrap.className = 'page-heading';
          const h = document.createElement('h1');
          h.textContent = denied.title;
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = denied.description;
          wrap.append(h, p);
          panel.append(wrap);
        }
        return null;
      }
      if (ctx.adminView) return ctx.adminView;
      const { AdminView } = await import('../../admin/view');
      ctx.adminView = new AdminView(required<HTMLElement>('#admin-panel'), ctx.api, ctx.feedback);
      return ctx.adminView;
    };

    ctx.discovery = new DiscoveryView({
      api: ctx.api,
      open: (id, preview) => {
        void openCourseForWatch(ctx, id, preview);
      },
      resume: (id, lessonId, position) => {
        void ctx.resumeLesson(id, lessonId).then(() => seekWhenReady(ctx, position));
      },
      notice: ctx.feedback,
      syllabus: course => {
        void ctx.openCourseSyllabus(course);
      },
      openLibrarySaved: () => {
        void ctx.showLibrary().then(() => {
          ctx.libraryView?.setStatusFilter('saved');
        });
      },
    });
    ctx.omniSearch?.destroy();
    ctx.omniSearch = new OmniSearch({
      onSelectCourse: courseId => {
        void openCourseForWatch(ctx, courseId, true);
      },
      onSelectLesson: (courseId, lessonId) => {
        void ctx.resumeLesson(courseId, lessonId);
      },
      onNavigateView: view => {
        const btn = document.querySelector<HTMLButtonElement>(`#primary-nav [data-catalog-view="${view}"]`);
        btn?.click();
      },
    });
  };
}
