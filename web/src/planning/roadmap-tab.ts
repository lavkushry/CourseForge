import { errorMessage } from '../api';
import { svgIcon } from '../icons';
import type { PlanningHost } from './host';

type RoadmapData = {
  estimated_weeks?: number;
  target_role?: string;
  steps?: Array<{
    step_number: number;
    title: string;
    description: string;
    course_id: string;
    course_title: string;
    estimated_hours: number;
    key_concepts: string[];
  }>;
};

export function renderRoadmap(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-section roadmap-section';

  const header = document.createElement('div');
  header.className = 'roadmap-header';
  const title = document.createElement('h2');
  title.textContent = 'Dynamic AI Learning Roadmap';
  const sub = document.createElement('p');
  sub.className = 'muted';
  sub.textContent = 'Personalized multi-week study milestones synthesized from real CourseForge courses and lessons.';
  header.append(title, sub);
  sec.append(header);

  // Goal Suggestions Row
  const goalRow = document.createElement('div');
  goalRow.className = 'roadmap-goals-row';
  const presets = [
    'Full-Stack Cloud & Distributed Systems',
    'Kubernetes & DevOps Platform Lead',
    'Golang High-Concurrency Systems Engineer',
    'Advanced AI & LLM Systems Engineer',
  ];

  const form = document.createElement('div');
  form.className = 'roadmap-form';
  const goalInput = document.createElement('input');
  goalInput.type = 'text';
  goalInput.className = 'form-input';
  goalInput.placeholder = 'Enter target engineering role or learning goal…';
  goalInput.value = 'Full-Stack Cloud & Distributed Systems';

  for (const p of presets) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'mode-pill';
    pill.textContent = p;
    pill.onclick = () => {
      goalInput.value = p;
      void triggerGenerate(p);
    };
    goalRow.append(pill);
  }
  sec.append(goalRow);

  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'button primary';
  genBtn.append(svgIcon('sparkle'), document.createTextNode(' Generate Dynamic AI Roadmap'));

  const triggerGenerate = async (goal: string) => {
    host.roadmapLoading = true;
    genBtn.disabled = true;
    genBtn.textContent = 'Synthesizing Roadmap…';
    try {
      host.roadmapData = await host.api.generateAiRoadmap(goal);
    } catch (err) {
      host.statusMessage = errorMessage(err);
    } finally {
      host.roadmapLoading = false;
      host.render();
    }
  };

  genBtn.onclick = () => void triggerGenerate(goalInput.value.trim());
  form.append(goalInput, genBtn);
  sec.append(form);

  const content = document.createElement('div');
  content.className = 'roadmap-content';

  if (host.roadmapLoading) {
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = 'Synthesizing personalized curriculum from CourseForge masterclasses…';
    content.append(loading);
  } else if (host.roadmapData) {
    const data = host.roadmapData as RoadmapData;
    if (!data.steps?.length) {
      /* fall through visually via empty timeline */
    }
    const meta = document.createElement('div');
    meta.className = 'roadmap-meta-badge-row';
    const wBadge = document.createElement('span');
    wBadge.className = 'badge-stat';
    wBadge.append(svgIcon('clock'), document.createTextNode(` ${data.estimated_weeks ?? '—'} Weeks Estimated`));
    const rBadge = document.createElement('span');
    rBadge.className = 'badge-stat';
    rBadge.append(svgIcon('target'), document.createTextNode(` Role: ${data.target_role || 'General'}`));
    meta.append(wBadge, rBadge);
    content.append(meta);

    const timeline = document.createElement('div');
    timeline.className = 'roadmap-timeline';

    for (const step of data.steps ?? []) {
      const card = document.createElement('div');
      card.className = 'roadmap-step-card';

      const stepTop = document.createElement('div');
      stepTop.className = 'step-top-row';
      const sNum = document.createElement('span');
      sNum.className = 'step-num';
      sNum.textContent = `Stage ${step.step_number}`;
      const sHours = document.createElement('span');
      sHours.className = 'step-hours';
      sHours.textContent = `~${step.estimated_hours}h`;
      stepTop.append(sNum, sHours);

      const sTitle = document.createElement('h3');
      sTitle.textContent = step.title;

      const sCourse = document.createElement('p');
      sCourse.className = 'step-course-name';
      sCourse.append(svgIcon('book'), document.createTextNode(` Course: ${step.course_title}`));

      const sDesc = document.createElement('p');
      sDesc.className = 'step-desc muted';
      sDesc.textContent = step.description;

      const conceptsBox = document.createElement('div');
      conceptsBox.className = 'step-concepts-pills';
      for (const c of step.key_concepts || []) {
        const pill = document.createElement('span');
        pill.className = 'concept-pill';
        pill.textContent = c;
        conceptsBox.append(pill);
      }

      card.append(stepTop, sTitle, sCourse, sDesc, conceptsBox);
      timeline.append(card);
    }
    content.append(timeline);
  } else {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent =
      'Select a learning goal above or enter your dream role to generate a dynamic masterclass roadmap.';
    content.append(empty);
  }

  sec.append(content);
  return sec;
}
