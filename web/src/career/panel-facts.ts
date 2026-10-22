import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import type { CareerStudioHost } from './view-host';
import { labeledField, splitCommaList } from './view-helpers';

export function renderFacts(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Confirmed facts'),
    el(
      'p',
      'muted',
      'Suggestions may only reuse these. Leave metric blank to get a [METRIC] placeholder — never invent numbers.',
    ),
  );

  const form = el('form', 'career-form') as HTMLFormElement;
  const action = el('input', '') as HTMLInputElement;
  action.placeholder = 'Action (e.g. Built checkout API)';
  action.required = true;
  const impact = el('input', '') as HTMLInputElement;
  impact.placeholder = 'Impact (e.g. reduced payment failures)';
  impact.required = true;
  const metric = el('input', '') as HTMLInputElement;
  metric.placeholder = 'Metric (optional — leave blank for placeholder)';
  const skills = el('input', '') as HTMLInputElement;
  skills.placeholder = 'Skills, comma-separated (go, kubernetes, …)';
  const submit = el('button', 'button primary', 'Confirm fact') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(
    labeledField('Action', action),
    labeledField('Impact', impact),
    labeledField('Metric', metric),
    labeledField('Skills', skills),
    submit,
  );
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void createFact(host, action.value, impact.value, metric.value, skills.value);
  });
  panel.append(form);

  const list = el('div', 'career-fact-list');
  if (!host.facts.length) list.append(el('p', 'muted', 'No confirmed facts yet.'));
  for (const fact of host.facts) {
    const row = el('div', 'career-fact-card');
    const metricLabel = fact.metric ? fact.metric : '[METRIC] needed';
    row.append(
      el('strong', '', fact.action),
      el('p', '', `${fact.impact} · ${metricLabel}`),
      el('p', 'muted', fact.skills.join(', ') || 'No skills tagged'),
    );
    const del = el('button', 'button quiet', 'Remove') as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => void removeFact(host, fact.id));
    row.append(del);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

export async function createFact(
  host: CareerStudioHost,
  action: string,
  impact: string,
  metric: string,
  skillsRaw: string,
): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    const skills = splitCommaList(skillsRaw);
    const body: { action: string; impact: string; metric?: string; skills: string[] } = {
      action: action.trim(),
      impact: impact.trim(),
      skills,
    };
    if (metric.trim()) body.metric = metric.trim();
    await host.career.createFact(body, host.signal ?? undefined);
    host.options.feedback('Fact confirmed');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function removeFact(host: CareerStudioHost, id: string): Promise<void> {
  try {
    await host.career.deleteFact(id, host.signal ?? undefined);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}
