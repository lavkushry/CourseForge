import { el } from '../components';
import type { RateGroup } from './contracts';
import type { CareerStudioHost } from './view-host';
import { renderRateLine } from './view-helpers';

export function renderAnalytics(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Outcome analytics'),
    el(
      'p',
      'muted',
      'Callback and interview rates with 95% Wilson score confidence intervals. Matched pairs compare original vs tailored for the same company and role track.',
    ),
  );
  if (!host.analytics) {
    panel.append(el('p', 'muted', 'No analytics yet.'));
    return panel;
  }
  const a = host.analytics;
  panel.append(el('p', '', `${a.total_applications} applications · reliable n ≥ ${a.min_reliable_n}`));
  if (a.warning) panel.append(el('p', 'career-warn', a.warning));

  const sections: Array<[string, RateGroup[]]> = [
    ['By resume version', a.by_resume_version],
    ['By version type', a.by_version_type],
    ['By role track', a.by_role_track],
    ['By company', a.by_company],
    ['By rejection reason', a.by_rejection_reason],
    ['By applied-days bucket', a.by_applied_days],
  ];
  for (const [title, groups] of sections) {
    panel.append(el('h3', '', title));
    if (!groups.length) {
      panel.append(el('p', 'muted', 'No data'));
      continue;
    }
    for (const g of groups) {
      const box = el('div', 'career-match-result');
      box.append(el('strong', '', g.label || g.key));
      box.append(renderRateLine('Callback', g.callback));
      box.append(renderRateLine('Interview', g.interview));
      panel.append(box);
    }
  }

  if (a.matched_pairs.length) {
    panel.append(el('h3', '', 'Matched pairs (original vs tailored)'));
    for (const p of a.matched_pairs) {
      const box = el('div', 'career-match-result');
      box.append(el('strong', '', `${p.company_name} · ${p.track_id}`));
      box.append(renderRateLine('Original callback', p.original_callback));
      box.append(renderRateLine('Tailored callback', p.tailored_callback));
      box.append(renderRateLine('Original interview', p.original_interview));
      box.append(renderRateLine('Tailored interview', p.tailored_interview));
      panel.append(box);
    }
  }
  return panel;
}
