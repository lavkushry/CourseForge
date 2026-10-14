import { errorMessage } from '../api';
import { svgIcon, type IconName } from '../icons';
import type { PlanningHost } from './host';

export function renderDaily(host: PlanningHost): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'planning-tab-content daily-plan-section';

  // 1. Corporate LMS Momentum & Stats Header (Dribbble 27240387)
  const statsGrid = document.createElement('div');
  statsGrid.className = 'planning-overview-grid';

  const currentMinutes = host.preferences?.daily_minutes ?? 45;
  const items = host.currentDay?.items || [];
  const completedCount = host.currentDay?.completed_count ?? items.filter(it => it.status === 'done').length;

  const cardsData = [
    {
      icon: 'target',
      title: 'Daily Goal',
      value: `${currentMinutes}m`,
      sub: `${Math.min(currentMinutes, completedCount * 25)}m completed today`,
      tag: 'FOCUS TARGET',
    },
    {
      icon: 'flame',
      title: 'Weekly Streak',
      value: '5 Days',
      sub: '86% consistency score',
      tag: 'ACTIVE STREAK',
    },
    {
      icon: 'graduation',
      title: 'Masterclasses',
      value: '3 Enrolled',
      sub: '62% average progress',
      tag: 'LEARNING PATH',
    },
    {
      icon: 'award',
      title: 'Retention Mastery',
      value: '94%',
      sub: '24 cards & quizzes',
      tag: 'SPACED RECALL',
    },
  ] as const;

  for (const c of cardsData) {
    const card = document.createElement('div');
    card.className = 'momentum-stat-card';
    const iconWrap = document.createElement('div');
    iconWrap.className = 'momentum-card-icon';
    iconWrap.append(svgIcon(c.icon as IconName));

    const cardBody = document.createElement('div');
    cardBody.className = 'momentum-card-body';
    const tagEl = document.createElement('span');
    tagEl.className = 'momentum-card-tag';
    tagEl.textContent = c.tag;
    const valEl = document.createElement('strong');
    valEl.className = 'momentum-card-value';
    valEl.textContent = c.value;
    const subEl = document.createElement('span');
    subEl.className = 'momentum-card-sub';
    subEl.textContent = c.sub;

    cardBody.append(tagEl, valEl, subEl);
    card.append(iconWrap, cardBody);
    statsGrid.append(card);
  }
  sec.append(statsGrid);

  // 2. 7-Day Weekly Calendar Strip
  const stripCard = document.createElement('div');
  stripCard.className = 'planning-card calendar-strip-card';
  const stripHead = document.createElement('div');
  stripHead.className = 'calendar-strip-head';
  const stripTitle = document.createElement('h3');
  stripTitle.textContent = 'This Week’s Schedule';
  const stripDate = document.createElement('span');
  stripDate.className = 'muted';
  stripDate.textContent = 'Week of ' + host.weekStart;
  stripHead.append(stripTitle, stripDate);

  const stripRow = document.createElement('div');
  stripRow.className = 'calendar-strip-row';
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 7; i++) {
    const dayPill = document.createElement('div');
    dayPill.className = i === 1 ? 'calendar-day-pill today-active' : (i < 1 ? 'calendar-day-pill day-complete' : 'calendar-day-pill');
    const dName = document.createElement('span');
    dName.className = 'day-pill-name';
    dName.textContent = dayNames[i] ?? "";
    const dDot = document.createElement('span');
    dDot.className = 'day-pill-dot';
    dayPill.append(dName, dDot);
    stripRow.append(dayPill);
  }
  stripCard.append(stripHead, stripRow);
  sec.append(stripCard);

  // 3. Heading & Preferences Card
  const h = document.createElement('h2');
  h.className = 'planning-heading';
  h.textContent = 'Daily plan';
  sec.append(h);

  const prefCard = document.createElement('div');
  prefCard.className = 'planning-card daily-preferences-card';

  const prefTop = document.createElement('div');
  prefTop.className = 'daily-preferences-top';

  const prefLabel = document.createElement('label');
  prefLabel.htmlFor = 'daily-minutes';
  prefLabel.textContent = 'Daily study minutes';

  const prefInput = document.createElement('input');
  prefInput.id = 'daily-minutes';
  prefInput.type = 'number';
  prefInput.min = '15';
  prefInput.max = '180';
  prefInput.value = String(host.preferences?.daily_minutes ?? 45);

  // Quick Budget Selection Pills
  const budgetPillsRow = document.createElement('div');
  budgetPillsRow.className = 'budget-pills-row';
  for (const [mVal, mLabel] of [
    [15, '15m Spark'],
    [30, '30m Core'],
    [45, '45m Deep'],
    [60, '60m Master'],
    [90, '90m Marathon'],
  ] as const) {
    const bBtn = document.createElement('button');
    bBtn.type = 'button';
    bBtn.className = Number(prefInput.value) === mVal ? 'budget-choice-pill active' : 'budget-choice-pill';
    bBtn.textContent = mLabel;
    bBtn.onclick = () => {
      prefInput.value = String(mVal);
      for (const sibling of budgetPillsRow.querySelectorAll('.budget-choice-pill')) {
        sibling.classList.remove('active');
      }
      bBtn.classList.add('active');
    };
    budgetPillsRow.append(bBtn);
  }

  const savePrefBtn = document.createElement('button');
  savePrefBtn.type = 'button';
  savePrefBtn.className = 'button primary save-pref-btn';
  savePrefBtn.textContent = 'Save preferences';
  savePrefBtn.onclick = async () => {
    const minutes = Number(prefInput.value || 45);
    const body = {
      daily_minutes: minutes,
      path_id: host.selectedPathId,
      expected_revision: host.preferences?.revision ?? 0,
    };
    const key = host.commands.get('planner:preferences', body).key;
    try {
      const updated = await host.planningApi.savePreferences(body, key, host.signal);
      host.preferences = updated;
      prefInput.value = String(updated.daily_minutes);
      host.statusMessage = 'Preferences saved.';
      host.render();
    } catch (err) {
      host.statusMessage = errorMessage(err);
      host.render();
    }
  };

  prefTop.append(prefLabel, prefInput, savePrefBtn);
  prefCard.append(prefTop, budgetPillsRow);
  sec.append(prefCard);

  // 4. Checklist Summary Badge
  const summaryEl = document.createElement('div');
  summaryEl.className = 'checklist-summary-badge';
  summaryEl.textContent = `${completedCount}/${items.length} checklist complete`;
  sec.append(summaryEl);

  // 5. Items Grid / Recommended Focus
  const list = document.createElement('div');
  list.className = 'planning-items-grid';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = item.status === 'done' ? 'plan-item-card done' : 'plan-item-card';

    const itemH = document.createElement('h3');
    itemH.textContent = item.title;
    card.append(itemH);

    const desc = document.createElement('p');
    desc.className = 'muted';
    desc.textContent = `${item.minutes} min · ${item.description}`;
    card.append(desc);

    if (item.actual_minutes > 0) {
      const rep = document.createElement('span');
      rep.className = 'tag self-reported-tag';
      rep.textContent = `${item.actual_minutes} min self-reported`;
      card.append(rep);
    }

    if (item.status !== 'done') {
      const markBtn = document.createElement('button');
      markBtn.type = 'button';
      markBtn.className = 'button';
      markBtn.textContent = `Mark done: ${item.title}`;
      markBtn.onclick = async () => {
        const body = { status: 'done' as const, expected_revision: item.revision };
        const key = host.commands.get(`planner:items:${item.id}:status`, body).key;
        try {
          const updated = await host.planningApi.status(item, 'done', key, host.signal);
          host.currentDay = updated;
          host.statusMessage = '';
          host.render();
        } catch (err) {
          host.statusMessage = errorMessage(err);
          host.render();
        }
      };
      card.append(markBtn);
    }

    // Reported time form
    const timeBox = document.createElement('div');
    timeBox.className = 'reported-time-row';

    const repLabel = document.createElement('label');
    repLabel.htmlFor = `actual-minutes-${item.id}`;
    repLabel.textContent = `Reported minutes for ${item.title}`;

    const repInput = document.createElement('input');
    repInput.id = `actual-minutes-${item.id}`;
    repInput.type = 'number';
    repInput.min = '0';
    repInput.max = '600';
    repInput.value = host.reportedMinutes[item.id] !== undefined
      ? String(host.reportedMinutes[item.id])
      : (item.actual_minutes > 0 ? String(item.actual_minutes) : '');

    const saveTimeBtn = document.createElement('button');
    saveTimeBtn.type = 'button';
    saveTimeBtn.className = 'button quiet';
    saveTimeBtn.textContent = 'Save time';
    saveTimeBtn.onclick = async () => {
      const minutes = Number(repInput.value || 0);
      host.reportedMinutes[item.id] = minutes;
      const body = { actual_minutes: minutes, expected_revision: item.revision };
      const key = host.commands.get(`planner:items:${item.id}:actual`, body).key;
      try {
        const updated = await host.planningApi.actual(item, minutes, key, host.signal);
        host.currentDay = updated;
        host.statusMessage = '';
        host.render();
      } catch (err) {
        host.statusMessage = errorMessage(err);
        host.render();
      }
    };
    timeBox.append(repLabel, repInput, saveTimeBtn);
    card.append(timeBox);

    if (item.action) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'button quiet';
      openBtn.textContent = 'Open source';
      openBtn.onclick = async () => {
        if (host.hooks.navigate) {
          await host.hooks.navigate(item.action);
        }
      };
      card.append(openBtn);
    }

    list.append(card);
  }

  // If items are empty, render Recommended Daily Curriculum Cards
  if (items.length === 0) {
    const recSection = document.createElement('div');
    recSection.className = 'recommended-focus-section';
    const recHeading = document.createElement('div');
    recHeading.className = 'recommended-heading-row';
    recHeading.append(
      (() => { const s = document.createElement('span'); s.className = 'eyebrow'; s.textContent = 'TODAY’S RECOMMENDED CURRICULUM'; return s; })(),
      (() => { const h3 = document.createElement('h3'); h3.textContent = 'Targeted Mastery Goals'; return h3; })(),
      (() => { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Tailored to keep your momentum high and accelerate your software engineering mastery.'; return p; })(),
    );
    recSection.append(recHeading);

    const recGrid = document.createElement('div');
    recGrid.className = 'recommended-focus-grid';

    const recTasks = [
      {
        tag: 'STREAMING LECTURE',
        title: 'Deep Focus Masterclass Lecture',
        desc: 'Resume your current system design or data engineering video module with zero-buffering adaptive streaming.',
        duration: '25 min',
        actionText: 'Stream Lecture ↗',
        icon: 'play',
        action: () => {
          const coursesBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="courses"]');
          coursesBtn?.click();
        },
      },
      {
        tag: 'SPACED REPETITION',
        title: 'Review Retention Flashcards',
        desc: 'Practice 10 due concept cards with SM-2 spaced repetition to solidify long-term memory retention.',
        duration: '10 min',
        actionText: 'Open Review Deck ↗',
        icon: 'cards',
        action: () => {
          const revBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="reviews"]');
          revBtn?.click();
        },
      },
      {
        tag: 'SANDBOX PRACTICE',
        title: 'Hands-on Engineering Lab',
        desc: 'Write real SQL CTE window queries or PySpark broadcast joins in the verified container sandbox.',
        duration: '15 min',
        actionText: 'Launch Sandbox Lab ↗',
        icon: 'terminal',
        action: () => {
          const labBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="labs"]');
          labBtn?.click();
        },
      },
    ];

    for (const t of recTasks) {
      const tCard = document.createElement('div');
      tCard.className = 'recommended-task-card';

      const tTop = document.createElement('div');
      tTop.className = 'task-card-top';
      const tTag = document.createElement('span');
      tTag.className = 'task-card-tag';
      tTag.textContent = t.tag;
      const tDur = document.createElement('span');
      tDur.className = 'task-card-dur';
      tDur.textContent = t.duration;
      tTop.append(tTag, tDur);

      const tH = document.createElement('h4');
      tH.className = 'task-card-title';
      tH.textContent = t.title;

      const tDesc = document.createElement('p');
      tDesc.className = 'task-card-desc muted';
      tDesc.textContent = t.desc;

      const tBtn = document.createElement('button');
      tBtn.type = 'button';
      tBtn.className = 'button primary task-action-btn';
      tBtn.textContent = t.actionText;
      tBtn.onclick = t.action;

      tCard.append(tTop, tH, tDesc, tBtn);
      recGrid.append(tCard);
    }

    recSection.append(recGrid);
    list.append(recSection);
  }

  sec.append(list);

  return sec;
}
