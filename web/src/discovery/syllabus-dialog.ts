import { svgIcon } from '../icons';
import type { Course, Lesson } from '../contracts';
import { artwork, cleanLessonTitle } from './view';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0 min';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}

export class SyllabusDialog {
  private dialog: HTMLDialogElement;

  constructor() {
    let existing = document.querySelector<HTMLDialogElement>('#syllabus-dialog');
    if (!existing) {
      existing = document.createElement('dialog');
      existing.id = 'syllabus-dialog';
      existing.className = 'syllabus-dialog';
      document.body.append(existing);
    }
    this.dialog = existing;

    this.dialog.addEventListener('click', e => {
      const rect = this.dialog.getBoundingClientRect();
      const inDialog =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width;
      if (!inDialog && e.target === this.dialog) {
        this.close();
      }
    });
  }

  close(): void {
    if (this.dialog.open) {
      this.dialog.close();
    }
    this.dialog.replaceChildren();
  }

  open(
    course: Course,
    lessons: Lesson[],
    learnedLessons: Set<string>,
    onPlayLesson: (lesson: Lesson) => void,
    onSaveToggle: (course: Course) => Promise<boolean>,
    isSaved: boolean,
  ): void {
    this.dialog.replaceChildren();

    const content = el('div', 'syllabus-content');

    // Close button
    const closeBtn = el('button', 'syllabus-close-btn');
    closeBtn.append(svgIcon('close'));
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close course details');
    closeBtn.addEventListener('click', () => this.close());

    // Hero Header with Billboard Backdrop
    const hero = el('div', 'syllabus-hero');
    const art = artwork(course);
    const heroOverlay = el('div', 'syllabus-hero-overlay');

    const badge = el(
      'span',
      'eyebrow',
      course.category ? `COURSEFORGE · ${course.category}` : 'COURSEFORGE MASTERCLASS',
    );
    const title = el('h1', 'syllabus-title', course.title);

    const metaRow = el('div', 'syllabus-meta-row');
    const totalDuration = lessons.reduce((sum, l) => sum + (l.duration_seconds || 0), 0);
    const completedCount = lessons.filter(l => learnedLessons.has(l.id)).length;

    metaRow.append(
      el('span', 'meta-chip quality', '1080p HD'),
      el('span', 'meta-chip', `${lessons.length} Lectures`),
      el('span', 'meta-chip', formatDuration(totalDuration)),
      el('span', 'meta-chip instructor', course.instructor ? `With ${course.instructor}` : 'CourseForge Faculty'),
    );

    const ctaRow = el('div', 'syllabus-cta-row');
    const startLesson = lessons[0];
    const playBtn = el(
      'button',
      'button primary syllabus-play-cta',
      completedCount > 0 ? 'Continue Learning' : 'Start Course',
    );
    playBtn.type = 'button';
    if (startLesson) {
      playBtn.addEventListener('click', () => {
        this.close();
        onPlayLesson(startLesson);
      });
    }

    const saveBtn = el('button', 'button syllabus-save-cta', isSaved ? 'In My List' : '+ Add to My List');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const nowSaved = await onSaveToggle(course);
      saveBtn.disabled = false;
      saveBtn.textContent = nowSaved ? 'In My List' : '+ Add to My List';
    });

    ctaRow.append(playBtn, saveBtn);

    heroOverlay.append(badge, title, metaRow, ctaRow);
    hero.append(art, heroOverlay);

    // Body: Overview & Modules
    const body = el('div', 'syllabus-body');

    if (course.description) {
      const descSection = el('section', 'syllabus-desc-section');
      descSection.append(el('h2', '', 'About this Masterclass'), el('p', 'syllabus-desc-text', course.description));
      if (course.tags && course.tags.length > 0) {
        const tagCloud = el('div', 'syllabus-tag-cloud');
        for (const t of course.tags) {
          tagCloud.append(el('span', 'syllabus-tag', t));
        }
        descSection.append(tagCloud);
      }
      body.append(descSection);
    }

    // Group lessons by module/section
    const sections: Record<string, Lesson[]> = {};
    for (const l of lessons) {
      const sec = l.section_title?.trim() || 'Core Curriculum';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(l);
    }

    const syllabusSection = el('section', 'syllabus-curriculum-section');
    const curriculumHeading = el('div', 'curriculum-heading');
    curriculumHeading.append(
      el('h2', '', 'Course Syllabus & Curriculum'),
      el('span', 'muted', `${Object.keys(sections).length} Modules · ${lessons.length} Lectures`),
    );
    syllabusSection.append(curriculumHeading);

    const accordion = el('div', 'syllabus-accordion');
    let modIndex = 0;
    for (const [secTitle, secLessons] of Object.entries(sections)) {
      modIndex++;
      const modDuration = secLessons.reduce((sum, l) => sum + (l.duration_seconds || 0), 0);
      const modCompleted = secLessons.filter(l => learnedLessons.has(l.id)).length;

      const details = document.createElement('details');
      details.className = 'syllabus-module-details';
      if (modIndex === 1) details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'syllabus-module-summary';

      const sumInfo = el('div', 'summary-info');
      sumInfo.append(
        el('span', 'module-index', `Module ${String(modIndex).padStart(2, '0')}`),
        el('h3', 'module-title', secTitle),
      );

      const sumMeta = el('div', 'summary-meta');
      sumMeta.append(
        el('span', 'muted', `${secLessons.length} lectures · ${formatDuration(modDuration)}`),
        modCompleted > 0 ? el('span', 'mod-progress', `${modCompleted}/${secLessons.length} done`) : el('span'),
      );

      summary.append(sumInfo, sumMeta);
      details.append(summary);

      const lessonList = el('ol', 'syllabus-lesson-list');
      secLessons.forEach((l, idx) => {
        const row = el('li', 'syllabus-lesson-row');
        const isDone = learnedLessons.has(l.id);

        const lBtn = el('button', 'syllabus-lesson-btn');
        lBtn.type = 'button';
        lBtn.addEventListener('click', () => {
          this.close();
          onPlayLesson(l);
        });

        const lNum = el('span', 'lesson-idx', String(idx + 1).padStart(2, '0'));
        const lDetails = el('div', 'lesson-main-info');
        lDetails.append(
          el('strong', 'lesson-row-title', cleanLessonTitle(l.title)),
          el('span', 'lesson-row-time', formatDuration(l.duration_seconds)),
        );

        const lStatus = el('span', isDone ? 'lesson-check done' : 'lesson-check', isDone ? 'Completed' : 'Play');

        lBtn.append(lNum, lDetails, lStatus);
        row.append(lBtn);
        lessonList.append(row);
      });

      details.append(lessonList);
      accordion.append(details);
    }

    syllabusSection.append(accordion);
    body.append(syllabusSection);

    content.append(closeBtn, hero, body);
    this.dialog.append(content);

    if (typeof this.dialog.showModal === 'function') {
      this.dialog.showModal();
    } else {
      this.dialog.setAttribute('open', '');
    }
  }
}
