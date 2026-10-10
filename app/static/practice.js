'use strict';
/* Adaptive practice uses trusted local assessment signals and CURATED lab graders. */
(() => {
  let selectedPath = '';
  let loadVersion = 0;
  const $ = selector => document.querySelector(selector);
  const make = (tag, className = '', value = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  };

  async function openLinkedLab(pathId, stepId, slug, button) {
    button.disabled = true;
    try {
      const session = await window.CourseForgeServices.startRecommendedPractice(pathId, stepId, slug);
      window.CourseForgeLabs.openSession(session);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function decorateStep(card, path, step, recommended) {
    const wrap = make('div', 'practice-step');
    const attempts = step.practice?.attempts || 0;
    const passed = step.practice?.passed_labs?.length || 0;
    wrap.append(make('p', 'practice-summary', `${attempts} graded lab attempt${attempts === 1 ? '' : 's'} · ${passed} currently passed lab${passed === 1 ? '' : 's'} · Doesn't automatically complete this topic`));
    const relevant = recommended.slice(0, 2);
    if (!relevant.length) {
      wrap.append(make('p', 'muted', 'No current curated lab match. Use the source lecture or take a concept assessment.'));
    }
    for (const recommendation of relevant) {
      const row = make('div', 'practice-step-item');
      const description = make('span', '', `${recommendation.lab_title} · ${recommendation.action}`);
      const button = make('button', 'btn btn-outline', recommendation.last_lab_passed ? 'Practice again' : 'Start targeted lab');
      button.type = 'button'; button.disabled = Boolean(path.outdated);
      button.setAttribute('aria-label', `${recommendation.action}: ${recommendation.lab_title} for ${step.title}`);
      button.addEventListener('click', () => openLinkedLab(path.id, step.id, recommendation.lab_slug, button));
      row.append(description, button);
      wrap.append(row);
    }
    card.append(wrap);
  }

  function showSelectedPath(id) {
    if (!id || selectedPath === id) return;
    selectedPath = id;
    const selector = $('#practicePathSelect');
    if ([...selector.options].some(option => option.value === id)) selector.value = id;
    load(id).catch(error => {
      $('#practiceRecommendations').replaceChildren(make('p', 'muted', error.message));
    });
  }

  async function syncPaths() {
    const {paths} = await window.CourseForgeServices.learningPaths();
    const selector = $('#practicePathSelect');
    const wanted = selectedPath || selector.value;
    selector.replaceChildren(new Option('Choose a learning path', ''));
    for (const path of paths) selector.add(new Option(path.goal, path.id));
    selectedPath = paths.some(path => path.id === wanted) ? wanted : (paths[0]?.id || '');
    selector.value = selectedPath;
    if (selectedPath) await load(selectedPath);
    else {
      $('#practiceRecommendations').replaceChildren(make('p', 'muted', 'Create a cross-course study path to receive targeted lab suggestions.'));
      $('#practiceHistory').replaceChildren(make('p', 'muted', 'No linked graded attempts.'));
    }
  }

  async function load(pathId) {
    if (!pathId) return;
    const version = ++loadVersion;
    const [suggestions, history] = await Promise.all([
      window.CourseForgeServices.practiceRecommendations(pathId),
      window.CourseForgeServices.practiceHistory(pathId),
    ]);
    if (version !== loadVersion || pathId !== selectedPath) return;
    const list = $('#practiceRecommendations'); list.replaceChildren();
    if (suggestions.outdated) list.append(make('p', 'practice-warning', 'This roadmap is outdated. Refresh the path before starting linked practice.'));
    const rows = suggestions.recommendations.slice(0, 6);
    if (!rows.length) list.append(make('p', 'muted', 'No current weak-topic matches. Take an assessment or revisit your source-linked syllabus.'));
    for (const item of rows) {
      const row = make('div', 'practice-row');
      const body = make('div', 'practice-row-copy');
      body.append(make('strong', '', item.lab_title));
      body.append(make('span', '', `${item.step_title} · ${item.action}${item.assessment_score === null ? '' : ` · Last quiz ${item.assessment_score}%`}`));
      const button = make('button', 'btn btn-outline', item.last_lab_passed ? 'Repeat' : 'Start lab');
      button.type = 'button'; button.disabled = Boolean(suggestions.outdated);
      button.setAttribute('aria-label', `Start ${item.lab_title} for ${item.step_title}`);
      button.addEventListener('click', () => openLinkedLab(pathId, item.step_id, item.lab_slug, button));
      row.append(body, button); list.append(row);
    }
    const attempts = $('#practiceHistory'); attempts.replaceChildren();
    if (!history.attempts.length) attempts.append(make('p', 'muted', 'No attempts linked to this learning path.'));
    for (const item of history.attempts.slice(0, 7)) {
      const row = make('div', 'practice-row');
      row.append(make('strong', '', `${item.passed ? 'Passed' : 'Needs work'} · ${item.lab_slug}`));
      row.append(make('span', '', `${item.checks_passed}/${item.checks_total} verified checks · ${item.completed_at}`));
      attempts.append(row);
    }
  }

  $('#practiceRefreshBtn').addEventListener('click', () => syncPaths().catch(error => toast(error.message, true)));
  $('#practicePathSelect').addEventListener('change', event => {
    selectedPath = event.target.value;
    if (selectedPath) load(selectedPath).catch(error => toast(error.message, true));
  });
  window.addEventListener('courseforge:practicegraded', () => {
    syncPaths().catch(error => toast(error.message, true));
    // The app may have navigated to Labs from a roadmap; refresh roadmap badges too.
    const roadmapId = selectedPath;
    if (roadmapId) window.CourseForgeLearningPaths?.show(roadmapId).catch(() => {});
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#labs') syncPaths().catch(() => {});
  });
  window.CourseForgePractice = Object.freeze({decorateStep, showSelectedPath, refresh:syncPaths});
  window.addEventListener('courseforge-ready',()=>syncPaths().catch(error => $('#practiceRecommendations').replaceChildren(make('p', 'muted', error.message))));
})();
