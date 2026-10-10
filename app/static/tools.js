/* learning-paths.js */
/* P1 · cross-course learning roadmap; complements v3 without altering the core player. */
'use strict';
(() => {
let activeLearningPath=null;
function renderPathCourseChoices(){
  const list=$('#pathCourseChoices');
  const chosen=new Set($$('#pathCourseChoices input:checked').map(el=>el.value));
  list.replaceChildren();
  const available=groupCourses().filter(c=>c.indexed);
  if(!available.length){list.append(make('p','muted','No indexed courses yet. Scan and process lectures, then generate each course syllabus below.'));return;}
  for(const course of available){
    const label=make('label','path-course-option');
    const box=make('input');box.type='checkbox';box.value=course.name;box.checked=chosen.has(course.name);
    label.append(box,make('span','',course.title||course.name));list.append(label);
  }
}
function pathStatusMessage(message){$('#crossPathHint').textContent=message;}
async function loadLearningPaths(selectedId=null){
  const {paths}=await services.learningPaths();
  const target=$('#savedPathList');target.replaceChildren();
  if(!paths.length){target.append(make('p','muted','No saved roadmaps yet. Generate individual syllabi first, then build a combined plan.'));$('#crossPathDetail').hidden=true;return;}
  for(const path of paths){
    const button=make('button','saved-path');button.type='button';button.dataset.pathId=path.id;
    button.append(make('strong','',path.goal));
    button.append(make('small','',`${path.courses.length} courses · ${path.steps.length} topics · ${path.completion_percent}% completed${path.outdated?' · Needs refresh':''}`));
    button.setAttribute('aria-pressed',String((selectedId||activeLearningPath)===path.id));
    button.addEventListener('click',()=>showLearningPath(path.id).catch(err=>toast(err.message,true)));
    target.append(button);
  }
  const chosen=paths.find(x=>x.id===(selectedId||activeLearningPath))||paths[0];
  await showLearningPath(chosen.id);
}
async function showLearningPath(id){
  const path=await services.learningPath(id);activeLearningPath=path.id;
  const practice=await services.practiceRecommendations(id);
  const recommendationsByStep=new Map();
  for(const item of practice.recommendations){if(!recommendationsByStep.has(item.step_id))recommendationsByStep.set(item.step_id,[]);recommendationsByStep.get(item.step_id).push(item);}
  $$('#savedPathList .saved-path').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.pathId===path.id)));
  $('#crossPathDetail').hidden=false;
  $('#crossPathTitle').textContent=path.goal;
  $('#crossPathMeta').textContent=`${path.courses.join(' + ')} · ${path.steps.length} unique topics · ${path.topics_collapsed} redundant sources grouped · ${path.inference==='ai'?'AI-suggested dependencies':'Conservative local rules'}`;
  $('#crossPathPercent').textContent=path.completion_percent+'%';
  $('#crossPathProgressBar').style.width=path.completion_percent+'%';
  pathStatusMessage(path.outdated?'Some source syllabi changed. Rebuild this path to include the latest indexed topics.':'Complete prerequisites first. Watched video links do not automatically mark a concept as mastered.');
  const list=$('#crossPathSteps');list.replaceChildren();
  const lookup=new Map(path.steps.map(s=>[s.id,s]));
  for(const step of path.steps){
    const unlocked=step.prerequisites.every(pre=>lookup.get(pre)?.completed);
    const card=make('article','cross-step'+(step.completed?' complete':''));
    const top=make('div','cross-step-head');
    const title=make('div');title.append(make('span','step-index',`STEP ${String(step.order).padStart(2,'0')}${step.goal_focus?' · Goal focus':''}`),make('h4','',step.title));
    const done=make('label','path-check');
    const box=make('input');box.type='checkbox';box.checked=Boolean(step.completed);box.disabled=!unlocked&&!step.completed;box.setAttribute('aria-label',`Mark ${step.title} ${step.completed?'incomplete':'complete'}`);
    box.addEventListener('change',async()=>{box.disabled=true;try{const updated=await services.completeLearningStep(path.id,step.id,box.checked);await showLearningPath(updated.id);await loadLearningPaths(updated.id);}catch(err){toast(err.message,true);box.checked=!box.checked;box.disabled=false;}});
    done.append(box,make('span','',step.completed?'Done':unlocked?'Mark done':'Locked'));
    top.append(title,done);card.append(top);
    if(step.objectives?.length)card.append(make('p','cross-objectives',step.objectives.join(' · ')));
    if(step.prerequisites.length){const req=make('p','path-prereqs','Requires: '+step.prerequisites.map(k=>lookup.get(k)?.title||'Unknown').join(', '));card.append(req)}
    const refs=make('div','cross-references');
    for(const source of step.sources){const btn=make('button','source-chip',`${source.course} · ${source.video_title} · ${prettyTime(source.start)}`);btn.type='button';btn.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(err=>toast(err.message,true)));refs.append(btn)}
    card.append(refs);
    const mastery=step.mastery;
    const signal=make('div','assessment-topic-signal',mastery?`Latest practice: ${mastery.last_score}% · ${mastery.attempts} attempt${mastery.attempts===1?'':'s'} · ${mastery.status.replaceAll('_',' ')}`:'Not assessed yet');
    card.append(signal);
    const assess=make('button','btn btn-outline assessment-trigger',mastery?'Try another topic check':'Assess this topic');
    assess.type='button';assess.dataset.assessStep=step.id;
    assess.addEventListener('click',()=>window.CourseForgeAssessments.begin(path.id,step));
    card.append(assess);
    if(step.watched_sources)card.append(make('p','path-evidence',`${step.watched_sources} source video${step.watched_sources===1?'':'s'} marked complete. Confirm understanding before marking done.`));
    window.CourseForgePractice?.decorateStep(card,path,step,recommendationsByStep.get(step.id)||[]);
    list.append(card);
  }
  window.CourseForgePractice?.showSelectedPath(path.id);
}
$('#crossPathForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const courses=$$('#pathCourseChoices input:checked').map(x=>x.value);
  if(!courses.length)return toast('Select one or more indexed courses with generated syllabi.',true);
  if(courses.length>8)return toast('Choose at most eight courses.',true);
  const button=$('#createPathBtn');button.disabled=true;button.textContent='Planning topics and prerequisites…';
  try{const path=await services.createLearningPath(courses,$('#pathGoal').value.trim(),$('#pathUseAI').checked);
    await loadLearningPaths(path.id);toast(`${path.steps.length} source-linked steps ready.`);
  }catch(err){toast(err.message,true)}finally{button.disabled=false;button.textContent='Build cross-course roadmap →'}
});
$('#reloadPathsBtn').addEventListener('click',()=>loadLearningPaths().catch(err=>toast(err.message,true)));

async function initCrossPaths(){
  try {await loadLibrary();renderPathCourseChoices();await loadLearningPaths();}
  catch(err){toast(err.message,true)}
}
$$('[data-nav="syllabus"]').forEach(button=>button.addEventListener('click',()=>{
  renderPathCourseChoices();loadLearningPaths().catch(err=>toast(err.message,true));
}));
window.addEventListener('hashchange',()=>{if(location.hash==='#syllabus'){
  renderPathCourseChoices();loadLearningPaths().catch(err=>toast(err.message,true));
}});
window.CourseForgeLearningPaths = Object.freeze({show:showLearningPath});
window.addEventListener('courseforge-ready',initCrossPaths);
})();

/* assessments.js */
/* P1 · Source-backed mastery checks for a roadmap topic. Never reveal answer keys before submission. */
'use strict';
(() => {
  let assessment = null;
  let activePath = null;
  let activeStep = null;

  const heading = $('#assessmentHeading');
  const status = $('#assessmentStatus');
  const panel = $('#assessmentPanel');
  const questions = $('#assessmentQuestions');
  const resultPanel = $('#assessmentResult');

  function reviewVideo(source) {
    return openVideo(source.video_id, source.start).catch(error => toast(error.message, true));
  }

  function statusLabel(value) {
    return ({needs_practice:'Needs practice', developing:'Developing', ready_for_review:'Ready for review'})[value] || 'Not assessed';
  }

  function reset() {
    assessment = null;
    questions.replaceChildren();
    resultPanel.replaceChildren();
    resultPanel.hidden = true;
    status.textContent = '';
    $('#assessmentSubmit').disabled = false;
    panel.hidden = true;
  }

  async function begin(pathId, step) {
    activePath = pathId;
    activeStep = step;
    panel.hidden = false;
    panel.scrollIntoView({behavior:'smooth',block:'start'});
    heading.textContent = `Check your understanding: ${step.title}`;
    status.textContent = 'Creating questions from your lessons…';
    questions.replaceChildren();
    resultPanel.hidden = true;
    $('#assessmentSubmit').disabled = true;
    $('#assessmentForm').hidden = true;
    try {
      assessment = await services.startAssessment(pathId, step.id, 3);
      questions.replaceChildren();
      for (let i=0; i<assessment.questions.length; i++) {
        const q = assessment.questions[i];
        const fieldset = make('fieldset','assessment-question');
        fieldset.dataset.questionId = q.id;
        const legend=make('legend','',`${i+1}. ${q.question}`);fieldset.append(legend);
        for (let index=0;index<q.options.length;index++){
          const label=make('label','assessment-option');
          const input=make('input');input.type='radio';input.name=`answer_${q.id}`;
          input.value=String(index);input.required=true;
          label.append(input,make('span','',q.options[index]));fieldset.append(label);
        }
        questions.append(fieldset);
      }
      status.textContent=`${assessment.question_count} questions from your lessons. Choose one answer per question.`;
      $('#assessmentForm').hidden=false;
      $('#assessmentSubmit').disabled=false;
      questions.querySelector('input')?.focus({preventScroll:true});
    }catch(error){status.textContent=error.message;toast(error.message,true)}
  }

  $('#assessmentForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if (!assessment) return;
    const answers={};
    for (const q of assessment.questions) {
      const container = [...questions.children].find(el=>el.dataset.questionId===q.id);
      const selected=container?.querySelector('input:checked');
      if (!selected) {status.textContent='Choose an answer for every question.';container?.querySelector('input')?.focus();return;}
      answers[q.id]=Number(selected.value);
    }
    const submit=$('#assessmentSubmit');submit.disabled=true;
    status.textContent='Checking your answers…';
    try {
      const result=await services.submitAssessment(assessment.id,answers);
      $('#assessmentForm').hidden=true;
      resultPanel.replaceChildren();resultPanel.hidden=false;
      const headline=make('h4','',`${result.score}% · ${statusLabel(result.status)}`);
      resultPanel.append(headline,make('p','',`${result.correct_count} of ${result.total_count} correct. This is a practice signal, not a certification or automatic mastery claim.`));
      for(const feedback of result.feedback){
        const original=assessment.questions.find(q=>q.id===feedback.question_id);
        const item=make('article','assessment-feedback'+(feedback.correct?' correct':' incorrect'));
        item.append(make('strong','',`${feedback.correct?'Correct':'Review needed'} · ${original?.question || 'Question'}`));
        item.append(make('p','',feedback.explanation));
        if(!feedback.correct){
          item.append(make('p','',`Suggested answer: ${original?.options[feedback.correct_index] || ''}`));
          const button=make('button','source-chip',`Revisit ${feedback.source.title} at ${prettyTime(feedback.source.start)} →`);
          button.type='button';button.addEventListener('click',()=>reviewVideo(feedback.source));item.append(button);
        }
        resultPanel.append(item);
      }
      status.textContent='Saved your attempt and updated the topic signal.';
      const pathId=activePath;
      await window.CourseForgeLearningPaths.show(pathId);
      resultPanel.querySelector('h4')?.setAttribute('tabindex','-1');
      resultPanel.querySelector('h4')?.focus({preventScroll:true});
    }catch(error){status.textContent=error.message;submit.disabled=false;toast(error.message,true)}
  });

  $('#assessmentClose').addEventListener('click',()=>{
    reset();
    const button=[...document.querySelectorAll('[data-assess-step]')].find(el=>el.dataset.assessStep===activeStep?.id);
    button?.focus({preventScroll:true});
  });

  window.CourseForgeAssessments = Object.freeze({begin,reset,statusLabel});
})();

/* practice.js */
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

/* planner.js */
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
    el('plannerSummary').textContent = `${plan.completed_count} of ${plan.items.length} checklist items · ${plan.actual_minutes} minutes you recorded as studied`;
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
      const field = make('label', 'planner-actual-label', 'Minutes you studied');
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

/* weekly.js */
'use strict';
/* Weekly study planning: use browser-local weekday and timezone; no fabricated elapsed time. */
(() => {
  const api = window.CourseForgeServices;
  const $ = (id) => document.getElementById(id);
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let loadedWeek = null;
  let token = 0;
  function localIso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function parseDay(day) {return new Date(`${day}T12:00:00`);}
  function monday(day) { const d = parseDay(day); d.setDate(d.getDate()-((d.getDay()+6)%7));return localIso(d); }
  function addDays(day, count) {const d = parseDay(day);d.setDate(d.getDate()+count);return localIso(d);}
  function make(tag, cls, value) {const n=document.createElement(tag);if(cls)n.className=cls;if(value)n.textContent=value;return n;}
  function message(value) {$('weekMessage').textContent=value || '';}
  function controls(minutes) {
    const root = $('weekDaysInput');root.replaceChildren();
    minutes.forEach((value, i) => {
      const label = make('label','week-budget-day');
      label.append(make('span','',weekdays[i]));
      const input = document.createElement('input');
      input.type='number';input.min='0';input.max='180';input.step='1';input.value=String(value);
      input.dataset.weekday=String(i);input.className='form-input';
      input.setAttribute('aria-label',`${weekdays[i]} study minutes, zero for rest`);
      label.append(input);root.append(label);
    });
  }
  function render(week) {
    loadedWeek = week;
    const root = $('weekCards');root.replaceChildren();root.setAttribute('aria-busy','false');
    $('weekTotals').textContent = `${week.planned_minutes} planned / ${week.actual_minutes} logged min`;
    for (const day of week.days) {
      const card=make('article',`week-card${day.rest_day?' rest':''}`);
      const date=make('span','week-date',`${weekdays[day.weekday]} · ${day.date.slice(5)}`);
      card.append(date);
      card.append(make('strong','week-number',day.rest_day?'Rest day':`${day.planned_minutes} min planned`));
      card.append(make('span','week-actual',day.rest_day?'Rest':`${day.actual_minutes} min logged`));
      if (!day.rest_day) {
        card.append(make('span','week-review',`${day.forecast_reviews} review card${day.forecast_reviews===1?'':'s'} forecast`));
        card.append(make('span','week-count',`${day.completed_count}/${day.task_count} checklist complete`));
        const open=make('button','btn btn-outline','Open day');open.type='button';
        open.setAttribute('aria-label',`Open ${day.date} daily study plan`);
        open.addEventListener('click',()=>{
          $('plannerDate').value=day.date;
          $('plannerDate').dispatchEvent(new Event('change',{bubbles:true}));
          $('plannerDayTitle').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
        });
        card.append(open);
      }
      root.append(card);
    }
    if (week.warnings?.length) message(week.warnings.join(' '));
  }
  async function loadWeek() {
    const week=monday($('weekStart').value);
    $('weekStart').value=week;
    const id=++token;
    try {const result=await api.weeklyCalendar(week);if(token===id){render(result);message(result.warnings?.join(' ')||'');}}
    catch(e){if(token!==id)return;loadedWeek=null;$('weekCards').replaceChildren(make('p','muted','No saved calendar for this week. Choose study days and build your week.'));$('weekTotals').textContent='Not planned';message(/404/.test(e.message)?'':e.message);}
  }
  async function init() {
    if (!$('weekStart').value) $('weekStart').value=monday(localIso(new Date()));
    const pref=await api.weekPreferences();controls(pref.weekday_minutes);
    await loadWeek();
  }
  $('weekPrevious').addEventListener('click',()=>{$('weekStart').value=addDays(monday($('weekStart').value),-7);loadWeek();});
  $('weekNext').addEventListener('click',()=>{$('weekStart').value=addDays(monday($('weekStart').value),7);loadWeek();});
  $('weekStart').addEventListener('change',loadWeek);
  $('weekForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('weekBuild');button.disabled=true;message('');$('weekCards').setAttribute('aria-busy','true');
    try {
      const minutes=[...$('weekDaysInput').querySelectorAll('input')].map(n=>Number(n.value));
      if(minutes.length!==7||minutes.some(n=>!Number.isInteger(n)||(n!==0&&(n<15||n>180))))throw new Error('Enter 0 or 15–180 whole minutes for each day');
      await api.saveWeekPreferences(minutes);
      // Reuse the daily planner path preference to avoid divergent goals.
      await api.savePlannerPreferences(Number($('plannerBudget').value),$('plannerPath').value||null);
      const week=monday($('weekStart').value);
      const result=await api.generateWeeklyCalendar(week,parseDay(week).getTimezoneOffset(),true);
      render(result);message(result.warnings?.join(' ')||'Weekly calendar saved.');
      $('plannerDate').dispatchEvent(new Event('change'));
    }catch(e){message(e.message);}finally{button.disabled=false;$('weekCards').setAttribute('aria-busy','false');}
  });
  window.CourseForgeWeekly=Object.freeze({refresh:loadWeek});
  window.addEventListener('hashchange',()=>{if(location.hash==='#planner')init().catch(e=>message(e.message));});
  if(location.hash==='#planner')init().catch(e=>message(e.message));
})();

/* focus.js */
'use strict';
/* Local-first focus timer: server owns elapsed time. Browser only animates the view. */
(() => {
  const api=window.CourseForgeServices;
  const $=id=>document.getElementById(id);
  const weekday=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let session=null, snapshotAt=performance.now(), pending=null, ticker=null, analyticsSeq=0;
  const msg=text=>{$('focusMessage').textContent=text||'';};
  function dayString(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function monday(s){const d=new Date(`${s}T12:00:00`);d.setDate(d.getDate()-(d.getDay()+6)%7);return dayString(d);}
  const format=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  function currentRemaining(){
    if(!session)return Number($('focusMinutes').value)*60;
    const running=session.status==='running';
    return Math.max(0,session.remaining_seconds-(running?(performance.now()-snapshotAt)/1000:0));
  }
  function render(){
    const status=session?.status||'ready', remaining=currentRemaining();
    $('focusClock').textContent=format(Math.ceil(remaining));
    $('focusState').textContent=session?`${session.mode==='break'?'Break':'Focus'} · ${status}`:'No active timer';
    $('focusLinked').textContent=session?.title||pending?.title||'Choose a lesson or start an independent focus session.';
    const pct=session?Math.min(100,Math.max(0,100*(1-remaining/session.duration_seconds))):0;
    $('focusProgress').setAttribute('aria-valuenow',String(Math.round(pct)));
    $('focusProgressFill').style.width=`${pct}%`;
    $('focusStart').hidden=!!session;
    $('focusPause').hidden=status!=='running';$('focusResume').hidden=status!=='paused';
    $('focusFinish').hidden=!session;$('focusCancel').hidden=!session;
    $('focusMode').disabled=!!session;$('focusMinutes').disabled=!!session;
  }
  function remember(next){session=next; snapshotAt=performance.now();render();}
  async function refreshInsights(){
    const id=++analyticsSeq;
    const week=monday($('weekStart').value||dayString(new Date()));
    const tz=new Date(`${week}T12:00:00`).getTimezoneOffset();
    const [a,history]=await Promise.all([api.focusAnalytics(week,tz),api.focusHistory()]);
    if(id!==analyticsSeq)return;
    $('focusWeekLabel').textContent=`Week of ${week} · planned vs reported vs measured`;
    $('focusPlanned').textContent=`${a.planned_minutes} min`;
    $('focusReported').textContent=`${a.self_reported_minutes} min`;
    $('focusMeasured').textContent=`${a.measured_minutes} min`;
    $('focusConsistency').textContent=`${a.active_days} of 7 days with at least 1 measured focus minute. These intervals do not verify attention.`;
    const root=$('focusBars');root.replaceChildren();
    const maximum=Math.max(1,...a.days.flatMap(x=>[x.planned_minutes,x.measured_minutes]));
    a.days.forEach((d,i)=>{
      const group=document.createElement('div');group.className='focus-chart-day';
      const bars=document.createElement('div');bars.className='focus-bar-pair';
      for(const [kind,value] of [['planned',d.planned_minutes],['measured',d.measured_minutes]]){
        const bar=document.createElement('span');bar.className=`focus-bar ${kind}`;
        bar.style.height=`${Math.max(0,value/maximum)*100}%`;
        bar.title=`${weekday[i]}: ${kind} ${value} minutes`;
        bars.append(bar);
      }
      const label=document.createElement('small');label.textContent=weekday[i];
      group.append(bars,label);root.append(group);
    });
    root.setAttribute('aria-label',a.days.map((d,i)=>`${weekday[i]} ${d.planned_minutes} planned, ${d.measured_minutes} measured`).join('; '));
    const list=$('focusHistory');list.replaceChildren();
    for(const h of history.sessions.slice(0,8)){
      if(h.status==='cancelled')continue;
      const row=document.createElement('div');row.className='focus-history-row';
      const title=document.createElement('span');title.textContent=h.title;
      const value=document.createElement('span');value.textContent=`${Math.round(h.elapsed_seconds/60*10)/10} min · ${h.mode} · ${h.status}`;
      row.append(title,value);list.append(row);
    }
    if(!list.children.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No completed focus sessions yet.';list.append(empty);}
  }
  async function begin(){
    if(session){msg('Finish or pause your current timer first.');return;}
    const mode=$('focusMode').value, duration_minutes=Number($('focusMinutes').value);
    const body={mode,duration_minutes};
    if(mode==='focus' && pending){Object.assign(body,pending);delete body.title;if(pending.title)body.title=pending.title;}
    $('focusStart').disabled=true;
    try{remember(await api.beginFocus(body));pending=null;msg('Focus timer started. Hide the tab to pause when possible.');await refreshInsights();}
    catch(e){msg(e.message);}finally{$('focusStart').disabled=false;}
  }
  async function action(value){
    if(!session)return;
    const id=session.id;
    try{
      const next=await api.focusAction(id,value);
      if(value==='finish'||value==='cancel'){remember(null);msg(value==='finish'?'Session saved. Study time recorded without changing mastery.':'Session discarded.');}
      else {remember(next);msg(value==='pause'?'Paused.': 'Resumed.');}
      await refreshInsights();
    }catch(e){msg(e.message);await reload().catch(()=>{});}
  }
  async function reload(){
    const data=await api.activeFocus();remember(data.session);
    await refreshInsights();
  }
  $('focusStart').addEventListener('click',begin);
  for(const value of ['pause','resume','finish','cancel'])$('focus'+value[0].toUpperCase()+value.slice(1)).addEventListener('click',()=>action(value));
  $('focusMinutes').addEventListener('change',render);
  $('focusMode').addEventListener('change',render);
  $('focusVideo').addEventListener('click',()=>{
    const source=$('player').getAttribute('src')||'';
    const videoId=/\/api\/videos\/([^/]+)\/stream/.exec(source)?.[1];
    if(!videoId){msg('Open a lesson first.');return;}
    pending={video_id:decodeURIComponent(videoId),title:$('playingTitle').textContent};
    document.querySelector('[data-nav="planner"]')?.click();
    msg('Lesson selected. Start your focus timer.');render();
  });
  window.CourseForgeFocus=Object.freeze({startForItem:(id,title)=>{
    if(session){msg('Finish or pause your current timer first.');document.querySelector('[data-nav="planner"]')?.click();return;}
    pending={planner_item_id:id,title};msg(`Ready to focus on: ${title}`);render();$('focusStart').focus();
  },startForLab:(id,title)=>{pending={lab_session_id:id,title};document.querySelector('[data-nav="planner"]')?.click();render();}});
  // When the browser tab is hidden, best-effort pause prevents background time
  // from being counted. A browser crash/offline request may still leave the
  // server timer running until its hard cap.
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&session?.status==='running'){
      const sid=session.id;
      remember({...session,status:'paused',remaining_seconds:currentRemaining()});
      api.focusAction(sid,'pause').then(remember).catch(()=>{msg('Auto-pause failed. Reopen the tab to sync the server timer.');});
    } else if(!document.hidden){reload().catch(e=>msg(e.message));}
  });
  $('focusLab').addEventListener('click',()=>{
    const button=$('focusLab');
    if(!button.dataset.sessionId){msg('Open a lab first.');return;}
    window.CourseForgeFocus.startForLab(button.dataset.sessionId,button.dataset.labTitle||'Practice lab');
    msg('Lab selected. Start the focus timer.');$('focusStart').focus();
  });
  $('weekStart').addEventListener('change',()=>refreshInsights().catch(e=>msg(e.message)));
  window.addEventListener('hashchange',()=>{if(location.hash==='#planner')reload().catch(e=>msg(e.message));});
  ticker=setInterval(()=>{
    if(session?.status==='running'&&currentRemaining()<=0){reload().catch(()=>{});}
    render();
  },1000);
  window.addEventListener('courseforge-ready',()=>reload().catch(e=>msg(e.message)));
})();
