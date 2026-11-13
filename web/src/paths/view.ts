import { svgIcon } from '../icons';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import { button, el, emptyState, sidebar } from '../components';
import { panelSkeleton } from '../ui/skeleton';
import { cleanLessonTitle } from '../discovery/view';
import { loadLectureSpatial } from '../spatial/catalog';
import { requestSpatialOpen } from '../spatial/pending';
import { renderPlanExplore } from '../spatial/ui';
import type { LearningPath, PathStep } from './contracts';
import {
  isFixtureCourseId,
  pathsLoadFailureCopy,
  realCourseIds,
  stepUnlocked,
  unmetPrerequisiteTitles,
} from './status';

export class PathsView {
  private paths: LearningPath[] = [];
  private activePath: LearningPath | null = null;
  private loading = false;
  private loadError: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    private readonly openLesson: (courseId: string, lessonId: string, start?: number) => void,
    private readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    this.root.hidden = false;
    this.loading = true;
    this.loadError = null;
    this.render();
    try {
      const resp = await this.api.learningPaths('', signal);
      this.paths = resp.paths.map(path => ({
        ...path,
        course_ids: realCourseIds(path.course_ids),
      }));
      if (this.activePath) {
        this.activePath = this.paths.find(p => p.id === this.activePath?.id) ?? this.paths[0] ?? null;
      } else if (this.paths.length > 0) {
        this.activePath = this.paths[0] ?? null;
      }
      this.loadError = null;
    } catch (err) {
      if (isAbort(err)) return;
      this.loadError = errorMessage(err);
      this.notice('Could not load learning paths: ' + this.loadError, true);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  deactivate(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private render(): void {
    this.root.replaceChildren();
    const container = el('div', 'paths-layout');

    // Sidebar list of paths
    const side = sidebar({ className: 'paths-sidebar', label: 'Learning roadmaps' });
    const sideHead = el('div', 'paths-sidebar-head');
    const aiBtn = button('AI Generate', () => void this.showAiGenerateModal(), 'button quiet ai-gen-path-btn');
    aiBtn.prepend(svgIcon('sparkle'));
    sideHead.append(
      el('h1', 'paths-page-title', 'Learning roadmaps'),
      aiBtn,
      button('+ New Roadmap', () => void this.showCreateModal(), 'button primary new-path-btn'),
    );
    side.append(sideHead);

    const list = el('div', 'paths-list');
    if (this.loading && !this.paths.length) {
      list.append(panelSkeleton({ variant: 'lines', count: 4, label: 'Loading roadmaps…' }));
    } else if (this.loadError && !this.paths.length) {
      const retry = button(
        'Retry',
        () => {
          void this.activate();
        },
        'button primary',
      );
      const failure = pathsLoadFailureCopy(this.loadError);
      list.append(
        emptyState({
          className: 'catalog-empty paths-empty-state',
          icon: 'sparkle',
          title: failure.title,
          description: failure.description,
          action: retry,
        }),
      );
    } else if (!this.paths.length) {
      list.append(
        emptyState({
          className: 'catalog-empty paths-empty-state',
          icon: 'sparkle',
          title: 'No saved learning roadmaps yet',
          description: 'Create one from a published catalog course — fixture placeholders are not accepted.',
        }),
      );
    } else {
      for (const p of this.paths) {
        const item = el('button', `path-nav-item${this.activePath?.id === p.id ? ' active' : ''}`) as HTMLButtonElement;
        item.type = 'button';
        item.append(
          el('strong', '', p.goal),
          el(
            'span',
            'muted',
            `${p.course_ids.length} courses · ${p.steps.length} steps · ${p.completion_percent}% complete`,
          ),
          el('progress', 'path-progress', ''),
        );
        const bar = item.querySelector<HTMLProgressElement>('.path-progress')!;
        bar.max = 100;
        bar.value = p.completion_percent;
        item.addEventListener('click', () => {
          this.activePath = p;
          this.render();
        });
        list.append(item);
      }
    }
    side.append(list);

    // Main detail pane
    const main = el('div', 'paths-main');
    if (!this.activePath) {
      main.append(el('div', 'paths-empty', 'Select or create a roadmap to see its milestones.'));
    } else {
      const p = this.activePath;
      const head = el('div', 'path-header');
      const courseLabel = p.course_ids.length ? p.course_ids.join(', ') : 'No published courses linked';
      head.append(
        el('span', 'eyebrow', `LEARNING ROADMAP · ${p.provenance.toUpperCase()}`),
        el('h2', '', p.goal),
        el('p', 'muted', `Covering: ${courseLabel}`),
        el('div', 'path-stats-row'),
      );
      const stats = head.querySelector('.path-stats-row')!;
      stats.append(
        el('div', 'stat-chip', `Progress: ${p.completion_percent}%`),
        el('div', 'stat-chip', `Steps: ${p.completed_steps} / ${p.steps.length}`),
        el('div', 'stat-chip', `Revision: ${p.revision}`),
      );
      main.append(head, this.renderSkillTree(p));

      const stepsList = el('div', 'path-steps');
      for (let i = 0; i < p.steps.length; i++) {
        const step = p.steps[i];
        if (step) {
          stepsList.append(this.renderStep(p, step, i + 1));
        }
      }
      main.append(stepsList);
    }

    container.append(side, main);
    this.root.append(container);
  }

  private renderStep(path: LearningPath, step: PathStep, index: number): HTMLElement {
    const unlocked = stepUnlocked(path, step);
    const blockedTitles = unmetPrerequisiteTitles(path, step);
    const card = el(
      'article',
      `path-step-card${step.completed ? ' step-done' : ''}${!unlocked && !step.completed ? ' step-locked' : ''}`,
    );
    card.id = `step-card-${index}`;
    const top = el('div', 'step-card-head');
    const indexBadge = el('span', 'step-index-badge', `Step ${index}`);
    if (step.completed) {
      indexBadge.prepend(svgIcon('check'));
    } else if (!unlocked) {
      indexBadge.prepend(svgIcon('lock'));
    } else {
      indexBadge.prepend(svgIcon('target'));
    }
    const title = el('h3', '', step.title);

    const checkLabel = el('label', 'step-checkbox-label');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = step.completed;
    checkbox.disabled = !unlocked && !step.completed;
    checkbox.addEventListener('change', async () => {
      if (!stepUnlocked(path, step) && checkbox.checked) {
        checkbox.checked = false;
        this.notice('Complete prerequisite steps before marking this milestone done.', true);
        return;
      }
      checkbox.disabled = true;
      try {
        const updated = await this.api.completeStep(path.id, step.id, checkbox.checked, path.revision);
        step.completed = checkbox.checked;
        path.revision = updated.revision;
        path.completed_steps = updated.completed_steps;
        path.completion_percent = updated.completion_percent;
        this.render();
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        this.notice('Could not update step: ' + (err instanceof Error ? err.message : String(err)), true);
      } finally {
        checkbox.disabled = false;
      }
    });
    checkLabel.append(
      checkbox,
      el('span', '', step.completed ? 'Mastered' : unlocked ? 'Mark done' : 'Locked'),
    );

    top.append(indexBadge, title, checkLabel);
    card.append(top);

    if (!unlocked && blockedTitles.length) {
      card.append(
        el('p', 'muted path-prereq-note', `Requires: ${blockedTitles.join(' · ')}`),
      );
    }

    if (step.objectives && step.objectives.length > 0) {
      const objList = el('ul', 'step-objectives');
      for (const obj of step.objectives) objList.append(el('li', '', obj));
      card.append(objList);
    }

    if (step.sources && step.sources.length > 0) {
      const sourcesWrap = el('div', 'step-sources');
      sourcesWrap.append(el('span', 'muted', unlocked ? 'Jump to Lecture: ' : 'Lectures unlock after prerequisites: '));
      for (const src of step.sources) {
        if (isFixtureCourseId(src.course_id)) continue;
        const chip = button(
          ` ${cleanLessonTitle(src.title || src.lesson_id)} (${Math.floor(src.start / 60)}:${String(Math.floor(src.start % 60)).padStart(2, '0')})`,
          () => {
            if (!unlocked) {
              this.notice('Complete prerequisite steps before jumping into this lecture.', true);
              return;
            }
            this.openLesson(src.course_id, src.lesson_id, src.start);
          },
          'button quiet source-chip',
        );
        chip.disabled = !unlocked;
        chip.prepend(svgIcon('play'));
        sourcesWrap.append(chip);
      }
      card.append(sourcesWrap);
      const first = step.sources.find(s => !isFixtureCourseId(s.course_id));
      if (first && unlocked) {
        void loadLectureSpatial(this.api, first.lesson_id)
          .then(assets => {
            if (!card.isConnected) return;
            const offer = renderPlanExplore(assets, asset => {
              requestSpatialOpen({
                lectureId: asset.lecture_id,
                kind: asset.kind,
                startSeconds: asset.start_seconds,
              });
              this.openLesson(first.course_id, first.lesson_id, asset.start_seconds);
            });
            if (offer) card.append(offer);
          })
          .catch(() => undefined);
      }
    }

    return card;
  }

  private async showCreateModal(): Promise<void> {
    const dialog = el('dialog', 'new-path-dialog');
    const form = el('form', 'new-path-form');

    form.append(
      el('h2', '', 'Create Learning Roadmap'),
      el('label', 'field-label', 'Your Learning Goal'),
      el('input', 'text-input'),
    );
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.placeholder = 'e.g. Master Cloud Native Data Engineering';
    input.required = true;

    form.append(el('label', 'field-label', 'Target Course'));
    const select = el('select', 'select-input') as HTMLSelectElement;
    select.append(el('option', '', 'Loading courses…'));
    form.append(select);

    let catalogReady = false;
    try {
      const res = await this.api.courses('', undefined, '');
      select.replaceChildren();
      const published = res.courses.filter(c => !isFixtureCourseId(c.id));
      for (const c of published) {
        const opt = el('option', '', c.title);
        opt.value = c.id;
        select.append(opt);
      }
      catalogReady = published.length > 0;
      if (!catalogReady) {
        const opt = el('option', '', 'No published courses available');
        opt.value = '';
        opt.disabled = true;
        select.append(opt);
      }
    } catch {
      select.replaceChildren();
      const opt = el('option', '', 'Could not load catalog courses');
      opt.value = '';
      opt.disabled = true;
      select.append(opt);
    }

    const actions = el('div', 'dialog-actions');
    const createBtn = button(
      'Create Roadmap',
      async () => {
        const goal = input.value.trim();
        if (goal.length < 3) {
          this.notice('Goal must be at least 3 characters', true);
          return;
        }
        const courseId = select.value;
        if (!courseId || isFixtureCourseId(courseId)) {
          this.notice('Pick a published catalog course. Fixture placeholders are not accepted.', true);
          return;
        }
        createBtn.disabled = true;
        try {
          const newPath = await this.api.createLearningPath(goal, [courseId], 4);
          dialog.close();
          this.activePath = newPath;
          await this.activate();
          this.notice('Roadmap created!');
        } catch (err) {
          createBtn.disabled = false;
          this.notice('Could not create roadmap: ' + (err instanceof Error ? err.message : String(err)), true);
        }
      },
      'button primary',
    );
    createBtn.disabled = !catalogReady;

    const cancelBtn = button('Cancel', () => dialog.close(), 'button quiet');
    actions.append(cancelBtn, createBtn);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  }

  private async showAiGenerateModal(): Promise<void> {
    const dialog = el('dialog', 'new-path-dialog');
    const form = el('form', 'new-path-form');

    form.append(
      el('h2', '', 'AI Career Roadmap Generator'),
      el('p', 'muted', 'Synthesize a multi-stage engineering roadmap powered by hosted Ollama and PostgreSQL courses.'),
      el('label', 'field-label', 'Target Career Goal'),
      el('input', 'text-input'),
    );
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.placeholder = 'e.g. Full-Stack Cloud & Distributed Systems Architect';
    input.value = 'Full-Stack Cloud & Distributed Systems Architect';
    input.required = true;

    form.append(el('label', 'field-label', 'Target Engineering Role'));
    const roleInput = el('input', 'text-input');
    roleInput.placeholder = 'e.g. Lead Platform Engineer';
    roleInput.value = 'Lead Platform Engineer';
    form.append(roleInput);

    const actions = el('div', 'dialog-actions');
    const generateBtn = button(
      'Synthesize with Ollama AI',
      async () => {
        const goal = input.value.trim();
        const role = roleInput.value.trim();
        if (goal.length < 3) {
          this.notice('Goal must be at least 3 characters', true);
          return;
        }
        try {
          generateBtn.disabled = true;
          generateBtn.textContent = 'Generating…';
          const aiResult = await this.api.generateAiRoadmap(goal, role);
          const courseIds = realCourseIds(
            (aiResult.steps || []).map(s => s.course_id).filter((id): id is string => Boolean(id)),
          );
          if (!courseIds.length) {
            throw new Error(
              'AI returned no mapped published courses. Roadmaps are not created from placeholder fixture courses.',
            );
          }
          const newPath = await this.api.createLearningPath(
            goal,
            courseIds.slice(0, 4),
            aiResult.steps.length || 4,
          );
          dialog.close();
          this.activePath = newPath;
          await this.activate();
          this.notice(`AI Career Roadmap generated: ${aiResult.steps.length} stages mapped!`);
        } catch (err) {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Synthesize with Ollama AI';
          this.notice('Could not generate AI roadmap: ' + (err instanceof Error ? err.message : String(err)), true);
        }
      },
      'button primary',
    );

    const cancelBtn = button('Cancel', () => dialog.close(), 'button quiet');
    actions.append(cancelBtn, generateBtn);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  }

  private renderSkillTree(path: LearningPath): HTMLElement {
    const wrap = el('div', 'path-skill-tree');
    const header = el('div', 'skill-tree-header');
    header.append(
      el('h3', '', 'Curriculum Progression & Skill Tree'),
      el('span', 'muted', `${path.steps.length} Milestones · Interactive Progression`),
    );
    wrap.append(header);

    const steps = path.steps;
    if (steps.length === 0) return wrap;

    const width = Math.max(580, steps.length * 130);
    const height = 110;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.classList.add('skill-tree-svg');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="activeNodeGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ff7952"/>
        <stop offset="100%" stop-color="#e54503"/>
      </linearGradient>
      <linearGradient id="doneNodeGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#10b981"/>
        <stop offset="100%" stop-color="#34d399"/>
      </linearGradient>
    `;
    svg.append(defs);

    const stepWidth = (width - 80) / Math.max(1, steps.length - 1);
    const yCenter = 45;

    for (let i = 0; i < steps.length - 1; i++) {
      const x1 = 40 + i * stepWidth;
      const x2 = 40 + (i + 1) * stepWidth;
      const isSegmentDone = steps[i]?.completed && steps[i + 1]?.completed;
      const isSegmentActive = steps[i]?.completed && !steps[i + 1]?.completed;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(yCenter));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(yCenter));
      line.setAttribute('stroke', isSegmentDone ? '#10b981' : isSegmentActive ? '#ff7952' : '#2b2d42');
      line.setAttribute('stroke-width', '4');
      line.setAttribute('stroke-dasharray', isSegmentDone ? 'none' : isSegmentActive ? '4 3' : 'none');
      svg.append(line);
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const x = 40 + i * stepWidth;
      const isDone = step.completed;
      const isCurrent = !isDone && (i === 0 || steps[i - 1]?.completed);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.classList.add('skill-node-group');
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        const elStep = document.querySelector(`#step-card-${i + 1}`);
        if (elStep) elStep.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      if (isCurrent) {
        const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pulse.setAttribute('cx', String(x));
        pulse.setAttribute('cy', String(yCenter));
        pulse.setAttribute('r', '24');
        pulse.setAttribute('fill', 'rgba(255, 121, 82, 0.25)');
        g.append(pulse);
      }

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(yCenter));
      circle.setAttribute('r', '18');
      circle.setAttribute('fill', isDone ? 'url(#doneNodeGrad)' : isCurrent ? 'url(#activeNodeGrad)' : '#161824');
      circle.setAttribute('stroke', isDone ? '#10b981' : isCurrent ? '#ff7952' : '#393c54');
      circle.setAttribute('stroke-width', '2.5');
      g.append(circle);

      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', String(x));
      txt.setAttribute('y', String(yCenter + 5));
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('font-size', '12');
      txt.setAttribute('font-weight', '700');
      txt.setAttribute('fill', isDone || isCurrent ? '#090a0f' : '#8c90a8');
      txt.textContent = isDone ? '✓' : String(i + 1);
      g.append(txt);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(yCenter + 35));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '10.5');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', isCurrent ? '#ffb395' : isDone ? '#6ee7b7' : '#70748e');
      const truncatedTitle = step.title.length > 18 ? step.title.slice(0, 16) + '…' : step.title;
      label.textContent = truncatedTitle;
      g.append(label);

      svg.append(g);
    }

    const scrollWrap = el('div', 'skill-tree-scroll');
    scrollWrap.append(svg);
    wrap.append(scrollWrap);
    return wrap;
  }
}
