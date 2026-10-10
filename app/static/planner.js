'use strict';
/* Daily Planner: no fabricated learner state; browser-local date & timezone are explicit. */
(() => {
  const api = window.CourseForgeServices;
  const el = (id) => document.getElementById(id);
  let loadedDate = '';
  let current = null;
  let requestToken = 0;
  const make = (tag, cls = '', text = '') => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    node.textContent = text;
    return node;
  };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const error = (message) => { el('plannerError').textContent = message || ''; };

  async function navigateTo(action) {
    // Links are derived from existing local video IDs and curated lab slugs only.
    if (action.view === 'learning' && action.video_id && typeof window.openVideo === 'function') {
      await window.openVideo(action.video_id, action.start || 0);
      return;
    }
    const nav = document.querySelector(`[data-nav="${action.view}"]`);
    if (nav) nav.click();
    if (action.view === 'syllabus' && action.path_id) {
      await window.CourseForgeLearningPaths?.show(action.path_id);
      if (action.step_id && window.CourseForgeAssessments?.begin) {
        const path = await api.learningPath(action.path_id);
        const step = path.steps.find(item => item.id === action.step_id);
        if (step) await window.CourseForgeAssessments.begin(action.path_id, step);
      }
    }
    if (action.view === 'labs' && action.path_id && action.step_id && action.lab_slug) {
      const session = await api.startRecommendedPractice(action.path_id, action.step_id, action.lab_slug);
      if (!window.CourseForgeLabs?.openSession) throw new Error('Lab workspace is unavailable. Open Labs.');
      window.CourseForgeLabs.openSession(session);
    }
  }

  function render(plan) {
    current = plan;
    const items = el('plannerItems');
    items.replaceChildren();
    items.setAttribute('aria-busy', 'false');
    el('plannerDayTitle').textContent = `Study plan · ${plan.study_date}`;
    el('plannerTimeBadge').textContent = `${plan.planned_minutes} / ${plan.budget_minutes} min`;
    el('plannerSummary').textContent = `${plan.completed_count} of ${plan.items.length} checklist items · ${plan.actual_minutes} minutes recorded as studied (self-reported)`;
    const pct = plan.planned_minutes ? Math.round(100 * plan.reported_done_minutes / plan.planned_minutes) : 0;
    el('plannerTrack').setAttribute('aria-valuenow', String(pct));
    el('plannerTrackBar').style.width = `${pct}%`;
    if (!plan.items.length) items.append(make('p', 'muted', 'No due cards or eligible lessons yet. Import a video course and build a study path to unlock a personalized day.'));
    for (const task of plan.items) {
      const card = make('article', `planner-task${task.status === 'done' ? ' is-done' : ''}`);
      const top = make('div', 'planner-task-header');
      const body = make('div', 'planner-task-copy');
      body.append(make('span', 'planner-kind', `${task.kind} · ${task.minutes} estimated min`));
      body.append(make('h3', '', task.title), make('p', 'muted', task.description));
      top.append(body, make('span', 'planner-status', task.status));
      const actions = make('div', 'planner-task-actions');
      const open = make('button', 'btn btn-outline', task.kind === 'lab' ? 'Open graded lab' : task.kind === 'lesson' ? 'Open source lesson' : task.kind === 'review' ? 'Review cards' : 'Assess topic');
      open.type = 'button';
      open.addEventListener('click', async () => {
        open.disabled = true;
        try {await navigateTo(task.action);} catch (e) {error(e.message);} finally {open.disabled = false;}
      });
      actions.append(open);
      const focus = make('button', 'btn btn-outline', 'Start focus');
      focus.type = 'button';focus.setAttribute('aria-label',`Start focus for ${task.title}`);
      focus.addEventListener('click',()=>window.CourseForgeFocus?.startForItem(task.id,task.title));
      actions.append(focus);

      const statuses = [['done','Mark done'],['skipped','Skip'],['pending','Reset']];
      for (const [value, label] of statuses) {
        if (value === task.status) continue;
        const button = make('button', 'btn btn-outline', label);
        button.type = 'button';
        button.setAttribute('aria-label', `${label}: ${task.title}`);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { render(await api.setPlannerItem(task.id, value)); window.CourseForgeWeekly?.refresh().catch(() => {}); error(''); }
          catch (e) { error(e.message); button.disabled = false; }
        });
        actions.append(button);
      }
      const actual = make('div', 'planner-actual');
      const field = make('label', 'planner-actual-label', 'Actual minutes (self-reported)');
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '600'; input.step = '1';
      input.value = String(task.actual_minutes ?? 0);
      input.className = 'form-input planner-actual-input';
      input.setAttribute('aria-label', `Actual minutes for ${task.title}`);
      field.append(input);
      const save = make('button', 'btn btn-outline', 'Save time'); save.type = 'button';
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          const minutes = Number(input.value);
          if (!Number.isInteger(minutes) || minutes < 0 || minutes > 600) throw new Error('Use 0–600 whole minutes');
          render(await api.savePlannerActual(task.id, minutes));
          window.CourseForgeWeekly?.refresh().catch(() => {});
          error('');
        } catch (e) { error(e.message); } finally {save.disabled = false;}
      });
      actual.append(field, save);
      card.append(top, actions, actual); items.append(card);
    }
    if (plan.warnings?.length) error(plan.warnings.join(' '));
  }

  async function init() {
    const token = ++requestToken;
    el('plannerDate').value ||= today();
    const [pref, res] = await Promise.all([api.plannerPreferences(), api.learningPaths()]);
    if (token !== requestToken) return;
    const budget = el('plannerBudget');
    if (![...budget.options].some(o => +o.value === pref.daily_minutes)) budget.add(new Option(`${pref.daily_minutes} minutes`, String(pref.daily_minutes)));
    budget.value = String(pref.daily_minutes);
    const select = el('plannerPath');
    select.replaceChildren(new Option('My library (no roadmap)', ''));
    for (const path of res.paths || []) select.add(new Option(path.goal + (path.outdated ? ' · refresh needed' : ''), path.id));
    select.value = pref.path_id && [...select.options].some(x => x.value === pref.path_id) ? pref.path_id : '';
    await loadDay();
  }

  async function loadDay() {
    const day = el('plannerDate').value || today();
    if (!day) return;
    loadedDate = day;
    try { render(await api.plannerDay(day)); error(''); }
    catch (e) {
      if (/404/.test(e.message) || /No plan/.test(e.message)) {
        current = null;
        el('plannerItems').replaceChildren(make('p','muted','No saved plan for this date. Choose your goal and select Build / refresh plan.'));
        el('plannerDayTitle').textContent = `Study plan · ${day}`;
        el('plannerSummary').textContent = 'Create your first daily plan to get started.';
        el('plannerTimeBadge').textContent = 'Not planned';
        el('plannerTrackBar').style.width = '0%';
        el('plannerTrack').setAttribute('aria-valuenow', '0');
        error('');
      } else error(e.message);
    }
  }
  el('plannerDate').addEventListener('change', loadDay);
  el('plannerPrefs').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = el('plannerCreate');
    button.disabled = true;
    el('plannerItems').setAttribute('aria-busy', 'true');
    error('');
    try {
      await api.savePlannerPreferences(Number(el('plannerBudget').value), el('plannerPath').value || null);
      const day = el('plannerDate').value;
      render(await api.generatePlannerDay(day, new Date(`${day}T12:00:00`).getTimezoneOffset(), true));
      window.CourseForgeWeekly?.refresh().catch(() => {});
    } catch (e) {error(e.message);} finally {
      button.disabled = false;
      el('plannerItems').setAttribute('aria-busy', 'false');
    }
  });
  window.addEventListener('hashchange', () => {if (location.hash === '#planner') init().catch(e => error(e.message));});
  window.CourseForgePlanner = Object.freeze({refresh: init});
  if (location.hash === '#planner') init().catch(e => error(e.message));
})();
