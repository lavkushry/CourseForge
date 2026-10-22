import { el } from '../components';
import { labeledField } from './view-helpers';
import { errorMessage, isAbort } from '../api';
import type { CareerStudioHost } from './view-host';

export function renderMatch(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'JD match scoring'),
    el('p', 'muted', 'Weighted keyword score plus action+impact+metric rewrites from confirmed facts only.'),
  );

  const run = el('button', 'button primary', 'Score selected track vs company profile') as HTMLButtonElement;
  run.type = 'button';
  run.disabled = !host.selectedTrackId || !host.selectedCompanyId || host.busy;
  run.addEventListener('click', () => void runMatch(host));
  panel.append(run);

  const pasteForm = el('form', 'career-form') as HTMLFormElement;
  const jd = el('textarea', '') as HTMLTextAreaElement;
  jd.placeholder = 'Or paste a one-off JD to score without saving…';
  jd.rows = 4;
  const pasteBtn = el('button', 'button', 'Score pasted JD') as HTMLButtonElement;
  pasteBtn.type = 'submit';
  pasteForm.append(labeledField('Job description', jd), pasteBtn);
  pasteForm.addEventListener('submit', ev => {
    ev.preventDefault();
    void runMatch(host, jd.value);
  });
  panel.append(pasteForm);

  if (host.match) {
    const result = el('div', 'career-match-result');
    result.append(el('h3', '', `Match score: ${host.match.score}%`));
    result.append(el('p', 'muted', `Source: ${host.match.extraction_source}`));

    const matched = el('div', 'career-chip-row');
    matched.append(el('span', 'career-cat', 'Matched'));
    for (const item of host.match.matched_keywords.slice(0, 20)) {
      matched.append(el('span', 'career-chip career-chip-ok', `${item.term} · ${item.weight}`));
    }
    if (!host.match.matched_keywords.length) matched.append(el('span', 'muted', 'None'));
    result.append(matched);

    const missing = el('div', 'career-chip-row');
    missing.append(el('span', 'career-cat', 'Missing'));
    for (const item of host.match.missing_keywords.slice(0, 20)) {
      missing.append(el('span', 'career-chip career-chip-warn', `${item.term} · ${item.weight}`));
    }
    if (!host.match.missing_keywords.length) missing.append(el('span', 'muted', 'None'));
    result.append(missing);

    result.append(el('h3', '', 'Suggested bullets'));
    if (!host.match.suggested_bullets.length) {
      result.append(el('p', 'muted', 'Add confirmed facts to unlock grounded rewrites.'));
    }
    for (const bullet of host.match.suggested_bullets) {
      const card = el('div', 'career-bullet-card');
      card.append(el('p', '', bullet.text));
      if (bullet.missing_metric) {
        card.append(el('p', 'career-warn', 'Missing metric flagged as placeholder — fill in a real number yourself.'));
      }
      if (bullet.matched_keywords.length) {
        card.append(el('p', 'muted', `Overlaps JD: ${bullet.matched_keywords.join(', ')}`));
      }
      result.append(card);
    }

    result.append(el('h3', '', 'Skill-gap bridge'));
    result.append(
      el('p', 'muted', 'Missing JD skills mapped to existing CourseForge courses and lessons (tags/titles).'),
    );
    if (!host.match.skill_bridges.length) {
      result.append(el('p', 'muted', 'No catalog matches for missing skills yet.'));
    }
    for (const bridge of host.match.skill_bridges) {
      const card = el('div', 'career-bullet-card');
      card.append(el('strong', '', bridge.skill));
      if (bridge.courses.length) {
        const row = el('div', 'career-chip-row');
        row.append(el('span', 'career-cat', 'Courses'));
        for (const course of bridge.courses) {
          const link = el('a', 'career-bridge-link', course.title) as HTMLAnchorElement;
          link.href = course.href || '#courses';
          row.append(link);
        }
        card.append(row);
      }
      if (bridge.lessons.length) {
        const row = el('div', 'career-chip-row');
        row.append(el('span', 'career-cat', 'Lessons'));
        for (const lesson of bridge.lessons) {
          const link = el('a', 'career-bridge-link', lesson.title) as HTMLAnchorElement;
          link.href = lesson.href || `#learning/${lesson.id}`;
          row.append(link);
        }
        card.append(row);
      }
      result.append(card);
    }
    panel.append(result);
  }
  return panel;
}

export async function runMatch(host: CareerStudioHost, jdText?: string): Promise<void> {
  if (!host.selectedTrackId || host.busy) return;
  if (!jdText && !host.selectedCompanyId) {
    host.options.feedback('Select a company or paste a JD', true);
    return;
  }
  host.busy = true;
  try {
    host.match = await host.career.match(
      {
        track_id: host.selectedTrackId,
        ...(jdText?.trim() ? { jd_text: jdText.trim() } : { company_id: host.selectedCompanyId }),
      },
      host.signal ?? undefined,
    );
    host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}
