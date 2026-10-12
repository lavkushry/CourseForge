import type { ApiClient } from '../api';
import type { LearningPath, PathStep } from './contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function button(text: string, action: () => void, cls = 'button'): HTMLButtonElement {
  const n = el('button', cls, text);
  n.type = 'button';
  n.addEventListener('click', action);
  return n;
}

export class PathsView {
  private paths: LearningPath[] = [];
  private activePath: LearningPath | null = null;
  private loading = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    private readonly openLesson: (courseId: string, lessonId: string, start?: number) => void,
    private readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    this.root.hidden = false;
    this.loading = true;
    this.render();
    try {
      const resp = await this.api.learningPaths('', signal);
      this.paths = resp.paths;
      if (this.paths.length > 0 && !this.activePath) {
        this.activePath = this.paths[0] ?? null;
      }
    } catch (err) {
      this.notice('Could not load learning paths: ' + (err instanceof Error ? err.message : String(err)), true);
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
    const sidebar = el('aside', 'paths-sidebar');
    const sideHead = el('div', 'paths-sidebar-head');
    sideHead.append(
      el('h2', '', 'Learning Roadmaps'),
      button('+ New Roadmap', () => void this.showCreateModal(), 'button primary new-path-btn')
    );
    sidebar.append(sideHead);

    const list = el('div', 'paths-list');
    if (this.loading && !this.paths.length) {
      list.append(el('p', 'muted', 'Loading roadmaps…'));
    } else if (!this.paths.length) {
      list.append(el('p', 'muted', 'No saved learning roadmaps yet. Create one to chart your learning journey!'));
    } else {
      for (const p of this.paths) {
        const item = el('div', `path-nav-item${this.activePath?.id === p.id ? ' active' : ''}`);
        item.append(
          el('strong', '', p.goal),
          el('span', 'muted', `${p.course_ids.length} courses · ${p.steps.length} steps · ${p.completion_percent}% complete`),
          el('progress', 'path-progress', '')
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
    sidebar.append(list);

    // Main detail pane
    const main = el('div', 'paths-main');
    if (!this.activePath) {
      main.append(el('div', 'paths-empty', 'Select or create a roadmap to see its milestones.'));
    } else {
      const p = this.activePath;
      const head = el('div', 'path-header');
      head.append(
        el('span', 'eyebrow', `LEARNING ROADMAP · ${p.provenance.toUpperCase()}`),
        el('h1', '', p.goal),
        el('p', 'muted', `Covering: ${p.course_ids.join(', ')}`),
        el('div', 'path-stats-row')
      );
      const stats = head.querySelector('.path-stats-row')!;
      stats.append(
        el('div', 'stat-chip', `Progress: ${p.completion_percent}%`),
        el('div', 'stat-chip', `Steps: ${p.completed_steps} / ${p.steps.length}`),
        el('div', 'stat-chip', `Revision: ${p.revision}`)
      );
      main.append(head);

      const stepsList = el('div', 'path-steps');
      for (let i = 0; i < p.steps.length; i++) {
        const step = p.steps[i];
        if (step) {
          stepsList.append(this.renderStep(p, step, i + 1));
        }
      }
      main.append(stepsList);
    }

    container.append(sidebar, main);
    this.root.append(container);
  }

  private renderStep(path: LearningPath, step: PathStep, index: number): HTMLElement {
    const card = el('article', `path-step-card${step.completed ? ' step-done' : ''}`);
    const top = el('div', 'step-card-head');
    const indexBadge = el('span', 'step-index-badge', `Step ${index}`);
    const title = el('h3', '', step.title);

    const checkLabel = el('label', 'step-checkbox-label');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = step.completed;
    checkbox.addEventListener('change', async () => {
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
    checkLabel.append(checkbox, el('span', '', step.completed ? 'Mastered' : 'Mark done'));

    top.append(indexBadge, title, checkLabel);
    card.append(top);

    if (step.objectives && step.objectives.length > 0) {
      const objList = el('ul', 'step-objectives');
      for (const obj of step.objectives) objList.append(el('li', '', obj));
      card.append(objList);
    }

    if (step.sources && step.sources.length > 0) {
      const sourcesWrap = el('div', 'step-sources');
      sourcesWrap.append(el('span', 'muted', 'Jump to Lecture: '));
      for (const src of step.sources) {
        const chip = button(
          `▶ ${src.title || src.lesson_id} (${Math.floor(src.start / 60)}:${String(Math.floor(src.start % 60)).padStart(2, '0')})`,
          () => this.openLesson(src.course_id, src.lesson_id, src.start),
          'button quiet source-chip'
        );
        sourcesWrap.append(chip);
      }
      card.append(sourcesWrap);
    }

    return card;
  }

  private async showCreateModal(): Promise<void> {
    const dialog = el('dialog', 'new-path-dialog');
    const form = el('form', 'new-path-form');

    form.append(
      el('h2', '', 'Create Learning Roadmap'),
      el('label', 'field-label', 'Your Learning Goal'),
      el('input', 'text-input')
    );
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.placeholder = 'e.g. Master Cloud Native Data Engineering';
    input.required = true;

    form.append(el('label', 'field-label', 'Target Course'));
    const select = el('select', 'select-input') as HTMLSelectElement;
    select.append(el('option', '', 'Loading courses…'));
    form.append(select);

    try {
      const res = await this.api.courses('', undefined, '');
      select.replaceChildren();
      for (const c of res.courses) {
        const opt = el('option', '', c.title);
        opt.value = c.id;
        select.append(opt);
      }
      if (!res.courses.length) {
        const opt = el('option', '', 'Default Course');
        opt.value = 'fixture-course';
        select.append(opt);
      }
    } catch {
      select.replaceChildren();
      const opt = el('option', '', 'CourseForge demonstration');
      opt.value = 'fixture-course';
      select.append(opt);
    }

    const actions = el('div', 'dialog-actions');
    const createBtn = button('Create Roadmap', async () => {
      const goal = input.value.trim();
      if (goal.length < 3) {
        this.notice('Goal must be at least 3 characters', true);
        return;
      }
      const courseId = select.value || 'fixture-course';
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
    }, 'button primary');

    const cancelBtn = button('Cancel', () => dialog.close(), 'button quiet');
    actions.append(cancelBtn, createBtn);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  }
}
