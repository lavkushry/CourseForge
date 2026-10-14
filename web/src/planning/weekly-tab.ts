import { errorMessage } from '../api';
import type { PlanningHost } from './host';
import * as c from './contracts';

export function renderWeekly(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-tab-content weekly-plan-section';

  const h = document.createElement('h2');
  h.className = 'planning-heading';
  h.textContent = 'Weekly calendar';
  sec.append(h);

  const weekCard = document.createElement('div');
  weekCard.className = 'planning-card weekly-setup-card';

  const weekLabel = document.createElement('label');
  weekLabel.htmlFor = 'week-containing';
  weekLabel.textContent = 'Week containing';

  const weekInput = document.createElement('input');
  weekInput.id = 'week-containing';
  weekInput.type = 'date';
  weekInput.value = host.weekStart;
  weekInput.onchange = () => {
    try {
      host.weekStart = c.monday(weekInput.value);
      weekInput.value = host.weekStart;
    } catch {}
  };
  weekCard.append(weekLabel, weekInput);

  const grid = document.createElement('div');
  grid.className = 'weekday-budgets-grid';

  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 7; i++) {
    const box = document.createElement('div');
    box.className = 'weekday-box';

    const lbl = document.createElement('label');
    lbl.htmlFor = `weekday-${i}`;
    lbl.textContent = `${weekdayNames[i]} study minutes`;

    const inp = document.createElement('input');
    inp.id = `weekday-${i}`;
    inp.type = 'number';
    inp.min = '0';
    inp.max = '180';
    inp.value = String(host.weekdayMinutes[i] ?? 0);
    inp.oninput = () => {
      host.weekdayMinutes[i] = Number(inp.value || 0);
    };

    box.append(lbl, inp);
    grid.append(box);
  }
  weekCard.append(grid);

  const buildBtn = document.createElement('button');
  buildBtn.type = 'button';
  buildBtn.className = 'button primary';
  buildBtn.textContent = 'Build weekly calendar';
  buildBtn.onclick = async () => {
    for (let i = 0; i < 7; i++) {
      const inp = host.root.querySelector<HTMLInputElement>(`#weekday-${i}`);
      if (inp) host.weekdayMinutes[i] = Number(inp.value || 0);
    }

    const wpBody = {
      weekday_minutes: host.weekdayMinutes,
      expected_revision: host.weekPreferences?.revision ?? 0,
    };
    const wpKey = host.commands.get('planner:week-preferences', wpBody).key;
    try {
      host.weekPreferences = await host.planningApi.saveWeekPreferences(wpBody, wpKey, host.signal);
    } catch {}

    const genBody = {
      week_start: host.weekStart,
      refresh: true,
      expected_revision: host.currentWeek?.revision ?? 0,
    };
    const genKey = host.commands.get('planner:weeks', genBody).key;
    try {
      host.currentWeek = await host.planningApi.generateWeek(genBody, genKey, host.signal);
      host.render();
    } catch (err) {
      host.statusMessage = errorMessage(err);
      host.render();
    }
  };
  weekCard.append(buildBtn);
  sec.append(weekCard);

  if (host.currentWeek?.days) {
    const daysGrid = document.createElement('div');
    daysGrid.className = 'weekly-days-display';

    for (const d of host.currentWeek.days) {
      const dayCard = document.createElement('div');
      dayCard.className = 'week-day-display-card';

      const dayHead = document.createElement('strong');
      dayHead.textContent = `${d.date} (${d.planned_minutes}m)`;
      dayCard.append(dayHead);

      if (d.rest_day || d.budget_minutes === 0) {
        const restBadge = document.createElement('span');
        restBadge.className = 'rest-day-badge';
        restBadge.textContent = 'Rest day';
        dayCard.append(restBadge);
      }

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'button quiet';
      openBtn.textContent = `Open day ${d.date}`;
      openBtn.onclick = async () => {
        host.studyDate = d.date;
        await host.open('daily');
      };
      dayCard.append(openBtn);
      daysGrid.append(dayCard);
    }
    sec.append(daysGrid);
  }

  return sec;
}
