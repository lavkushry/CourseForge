import type { User } from '../../contracts';
import type { AppContext } from '../context';
import { errorMessage, isAbort } from '../../api';
import { required } from '../../components';
import { CertificatesView } from '../../certificates/view';
import { LearningView } from '../../learning/view';
import { SyllabusDialog } from '../../discovery/syllabus-dialog';
import { StudyRail } from '../../player/study-rail';
import { LibraryView } from '../../library/view';
import { PlanningView } from '../../planning/view';
import { HistoryView } from '../../history/view';
import { SettingsView } from '../../settings/view';
import { ReviewsView } from '../../reviews/view';
import { TutorView } from '../../tutor/view';
import { LabsView } from '../../labs/view';
import { PathsView } from '../../paths/view';
import { CareerView } from '../../career/view';
import { AdminView } from '../../admin/view';
import { DiscoveryView } from '../../discovery/view';
import { OmniSearch } from '../../search/omni';

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
        void ctx.loadLesson(lesson, true, true);
      },
      onMarkComplete: async lessonId => {
        await ctx.markComplete(lessonId);
      },
    });
    ctx.libraryView = new LibraryView({
      root: required<HTMLElement>('#library-panel'),
      api: ctx.api,
      onOpenSyllabus: course => {
        void ctx.openCourseSyllabus(course);
      },
      onPlayCourse: course => {
        void ctx.loadCourse(course.id, !course.enrolled);
      },
      onToggleSave: async course => {
        const isSaved = ctx.discovery?.isSaved(course.id) ?? false;
        if (isSaved) {
          await ctx.api.removeSaved('course', course.id, ctx.navigationScope.signal);
          return false;
        } else {
          await ctx.api.saveCourse(course.id, ctx.navigationScope.signal);
          return true;
        }
      },
      isSaved: id => ctx.discovery?.isSaved(id) ?? false,
    });
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
    ctx.historyView = new HistoryView({
      root: required<HTMLElement>('#history-panel'),
      api: ctx.api,
      onResumeLesson: (courseId, lessonId, position) => {
        void ctx.resumeLesson(courseId, lessonId).then(() => {
          if (position && ctx.controller) ctx.controller.seek(position);
        });
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
    ctx.reviewsView = new ReviewsView({
      root: required<HTMLElement>('#reviews-panel'),
      api: ctx.api,
    });
    ctx.tutorView = new TutorView({
      root: required<HTMLElement>('#tutor-panel'),
      api: ctx.api,
      onNavigateLesson: (lessonId, timestamp) => {
        void ctx.api
          .lesson(lessonId, ctx.navigationScope.signal)
          .then(res => {
            void ctx.resumeLesson(res.lesson.course_id, lessonId).then(() => {
              if (timestamp !== undefined && ctx.controller) ctx.controller.seek(timestamp);
            });
          })
          .catch(err => {
            if (!isAbort(err)) ctx.feedback(errorMessage(err), true);
          });
      },
    });
    ctx.labsView = new LabsView({
      root: required<HTMLElement>('#labs-panel'),
      api: ctx.api,
    });
    ctx.careerView = new CareerView({
      root: required<HTMLElement>('#career-panel'),
      api: ctx.api,
      feedback: ctx.feedback,
    });
    ctx.pathsView = new PathsView(
      required<HTMLElement>('#paths-panel'),
      ctx.api,
      (courseId, lessonId, start) => {
        void ctx.resumeLesson(courseId, lessonId).then(() => {
          if (start !== undefined && ctx.controller) ctx.controller.seek(start);
        });
      },
      ctx.feedback,
    );
    if (account.role === 'admin') {
      ctx.adminView = new AdminView(required<HTMLElement>('#admin-panel'), ctx.api, ctx.feedback);
    }
    ctx.discovery = new DiscoveryView({
      api: ctx.api,
      open: (id, preview) => {
        void ctx.loadCourse(id, preview);
      },
      resume: (id, lessonId) => {
        void ctx.resumeLesson(id, lessonId);
      },
      notice: ctx.feedback,
      syllabus: course => {
        void ctx.openCourseSyllabus(course);
      },
    });
    ctx.omniSearch?.destroy();
    ctx.omniSearch = new OmniSearch({
      onSelectCourse: courseId => {
        void ctx.loadCourse(courseId, true);
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
