import { svgIcon, type IconName } from '../icons';
import './chrome.css';

export interface ChapterSplit {
  index: number;
  title: string;
  start_seconds: number;
  end_seconds: number;
  summary?: string;
}

export interface ChromeActions {
  seek(position: number): void;
  nextLesson?: () => void;
  getNextLesson?: () => void;
  prevLesson?: () => void;
  toggleTheater?: () => void;
  markComplete?: () => Promise<void>;
  onWatchNext?: () => void;
  onCancelNext?: () => void;
  toggleZen?: () => void;
  getChapters?: () => ChapterSplit[];
  onOpenChapters?: () => void;
}

function ui<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function formatPlayerTime(seconds: number, forceHours = false): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0 || forceHours) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function mountPlayerChrome(
  wrap: HTMLElement,
  video: HTMLVideoElement,
  actions: ChromeActions,
  signal: AbortSignal
): void {
  const media = wrap.querySelector<HTMLElement>('media-controller');
  const row = media?.querySelector<HTMLElement>('media-control-bar');
  const oldTimeline = row?.querySelector<HTMLElement>('media-time-range');
  if (!media || !row || signal.aborted) return;

  // Remove default media-chrome single time range
  if (oldTimeline) oldTimeline.remove();

  media.setAttribute('fullscreenelement', wrap.id);
  wrap.classList.add('player-enhanced');
  row.classList.add('cinema-control-row');

  const source = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
  const delegates: Array<{ button: HTMLButtonElement; source: HTMLButtonElement }> = [];

  const delegate = (label: string, selector: string, iconName: IconName, extraClass = '') => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `cinema-button ${extraClass}`.trim();
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(svgIcon(iconName));
    const target = source(selector);
    if (target) {
      delegates.push({ button: node, source: target });
      node.addEventListener('click', () => target.click(), { signal });
    } else {
      node.disabled = true;
    }
    return node;
  };

  // 1. TOP CHROME: Title breadcrumb & Quick Actions
  const top = ui('div', 'cinema-top-actions');
  top.slot = 'top-chrome';

  const breadcrumb = ui('div', 'cinema-breadcrumb');
  const courseCrumb = ui('span', 'cinema-course-crumb');
  courseCrumb.id = 'cinema-course-crumb';
  const sep = ui('span', 'cinema-sep', '/');
  const lessonCrumb = ui('span', 'cinema-lesson-crumb');
  lessonCrumb.id = 'cinema-lesson-crumb';
  breadcrumb.append(courseCrumb, sep, lessonCrumb);

  const topButtons = ui('div', 'cinema-top-buttons');
  const episodes = delegate('Course lessons', '#episodes', 'grid');
  episodes.setAttribute('aria-haspopup', 'dialog');

  const capture = delegate('Capture lesson timestamp', '#capture', 'edit');

  const zenBtn = document.createElement('button');
  zenBtn.type = 'button';
  zenBtn.className = 'cinema-button cinema-zen-btn';
  zenBtn.id = 'studio-zen-toggle';
  zenBtn.title = 'Toggle Zen Study Mode (Z)';
  zenBtn.setAttribute('aria-label', 'Toggle Zen Study Mode');
  zenBtn.append(svgIcon('target'));
  zenBtn.addEventListener('click', () => {
    const isZen = document.body.classList.toggle('in-zen-studio');
    zenBtn.setAttribute('aria-pressed', String(isZen));
    zenBtn.classList.toggle('active', isZen);
    actions.toggleZen?.();
    triggerHud('target', isZen ? 'Zen Studio On' : 'Normal Mode');
  }, { signal });

  const shortcutsBtn = document.createElement('button');
  shortcutsBtn.type = 'button';
  shortcutsBtn.className = 'cinema-button';
  shortcutsBtn.title = 'Keyboard shortcuts';
  shortcutsBtn.setAttribute('aria-label', 'Keyboard shortcuts');
  shortcutsBtn.append(svgIcon('help'));

  const lock = delegate('Lock player controls', '#lock-controls', 'lock');
  topButtons.append(episodes, capture, zenBtn, shortcutsBtn, lock);
  top.append(breadcrumb, topButtons);
  media.append(top);

  // Sync breadcrumb titles
  const updateBreadcrumb = () => {
    const courseEl = document.querySelector('#course-name') || document.querySelector('#course-name-sub');
    const lessonEl = document.querySelector('#lesson-title');
    courseCrumb.textContent = courseEl?.textContent || 'CourseForge';
    lessonCrumb.textContent = lessonEl?.textContent || 'Lesson';
  };
  const titleObserver = new MutationObserver(updateBreadcrumb);
  const courseNameEl = document.querySelector('#course-name');
  const lessonTitleEl = document.querySelector('#lesson-title');
  if (courseNameEl) titleObserver.observe(courseNameEl, { childList: true, characterData: true, subtree: true });
  if (lessonTitleEl) titleObserver.observe(lessonTitleEl, { childList: true, characterData: true, subtree: true });
  updateBreadcrumb();

  // 2. CENTER CHROME: Center Play Button, Double-tap Ripples, HUD Pill
  const center = ui('div', 'cinema-center-actions');
  center.slot = 'centered-chrome';

  const leftRipple = ui('div', 'cinema-ripple ripple-left');
  leftRipple.hidden = true;
  leftRipple.append(svgIcon('skip-back-10'), ui('span', 'ripple-text', '-10s'));

  const rightRipple = ui('div', 'cinema-ripple ripple-right');
  rightRipple.hidden = true;
  rightRipple.append(svgIcon('skip-forward-10'), ui('span', 'ripple-text', '+10s'));

  const centerPlay = document.createElement('button');
  centerPlay.type = 'button';
  centerPlay.className = 'cinema-button cinema-center-play';
  centerPlay.setAttribute('aria-label', 'Play lesson');
  centerPlay.title = 'Play lesson (Space/K)';
  centerPlay.append(svgIcon('play'));
  centerPlay.addEventListener('click', () => {
    source('#play-toggle')?.click();
  }, { signal });

  const feedback = ui('span', 'cinema-seek-feedback');
  feedback.hidden = true;
  feedback.setAttribute('aria-live', 'polite');
  wrap.append(feedback);

  center.append(leftRipple, centerPlay, rightRipple);
  media.append(center);

  let feedbackTimer: any = undefined;
  const triggerHud = (icon: IconName, text: string) => {
    feedback.replaceChildren(svgIcon(icon), ui('span', 'hud-text', text));
    feedback.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedback.hidden = true;
    }, 1100);
  };

  const showRipple = (side: 'left' | 'right') => {
    const el = side === 'left' ? leftRipple : rightRipple;
    el.hidden = false;
    el.classList.remove('is-animating');
    void el.offsetWidth;
    el.classList.add('is-animating');
    setTimeout(() => {
      el.classList.remove('is-animating');
      el.hidden = true;
    }, 600);
  };

  // 3. BOTTOM CHROME CONTROLS ROW (EXACT STYLE FROM SCREENSHOT)
  row.replaceChildren();

  // A. Left Play/Pause Pill Button (Circular translucent button)
  const bottomPlayBtn = document.createElement('button');
  bottomPlayBtn.type = 'button';
  bottomPlayBtn.className = 'cinema-button cinema-play-circle-btn';
  bottomPlayBtn.title = 'Play (Space/K)';
  bottomPlayBtn.setAttribute('aria-label', 'Play');
  bottomPlayBtn.append(svgIcon('play'));
  bottomPlayBtn.addEventListener('click', () => {
    source('#play-toggle')?.click();
  }, { signal });

  // B. Volume Button & Hover Slider
  const volumeGroup = ui('div', 'cinema-volume-group');
  const volumeBtn = document.createElement('button');
  volumeBtn.type = 'button';
  volumeBtn.className = 'cinema-button cinema-volume-btn';
  volumeBtn.title = 'Mute / Unmute (M)';
  volumeBtn.setAttribute('aria-label', 'Mute audio');
  volumeBtn.append(svgIcon('volume'));

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = String(video.volume);
  volumeSlider.className = 'cinema-volume-slider';
  volumeSlider.setAttribute('aria-label', 'Volume');

  const updateVolumeUI = () => {
    const muted = video.muted || video.volume === 0;
    volumeBtn.replaceChildren(svgIcon(muted ? 'volume-mute' : 'volume'));
    volumeBtn.title = muted ? 'Unmute (M)' : 'Mute (M)';
    volumeSlider.value = muted ? '0' : String(video.volume);
  };
  video.addEventListener('volumechange', updateVolumeUI, { signal });
  updateVolumeUI();

  volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    triggerHud(video.muted ? 'volume-mute' : 'volume', video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
  }, { signal });

  volumeSlider.addEventListener('input', () => {
    video.volume = Number(volumeSlider.value);
    video.muted = false;
    triggerHud('volume', `Volume ${Math.round(video.volume * 100)}%`);
  }, { signal });

  volumeGroup.append(volumeBtn, volumeSlider);

  // C. Timestamp Text (e.g. "17:29 / 0:58:42")
  let showRemaining = false;
  const timeDisplay = document.createElement('button');
  timeDisplay.type = 'button';
  timeDisplay.className = 'cinema-time-text';
  timeDisplay.title = 'Click to toggle remaining time';
  timeDisplay.setAttribute('aria-label', 'Playback time');

  const updateTimeText = () => {
    const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const forceHours = dur >= 3600;
    if (showRemaining) {
      const rem = Math.max(0, dur - cur);
      timeDisplay.textContent = `-${formatPlayerTime(rem, forceHours)}`;
    } else {
      timeDisplay.textContent = `${formatPlayerTime(cur, forceHours)} / ${formatPlayerTime(dur, forceHours)}`;
    }
  };
  timeDisplay.addEventListener('click', () => {
    showRemaining = !showRemaining;
    updateTimeText();
  }, { signal });
  video.addEventListener('timeupdate', updateTimeText, { signal });
  video.addEventListener('loadedmetadata', updateTimeText, { signal });
  updateTimeText();

  // D. THE INLINE SEGMENTED PROGRESS BAR (CORE FEATURE)
  const segmentedTimeline = ui('div', 'cinema-segmented-timeline');
  segmentedTimeline.setAttribute('role', 'slider');
  segmentedTimeline.setAttribute('aria-label', 'Seek lesson and browse split chapters');
  segmentedTimeline.setAttribute('tabindex', '0');

  const trackWrapper = ui('div', 'cinema-segmented-track');
  segmentedTimeline.append(trackWrapper);

  // Scrubber thumb: outer white circle with inner dark dot (exact screenshot style ◉)
  const thumb = ui('div', 'cinema-segmented-thumb');
  const thumbDot = ui('div', 'cinema-thumb-dot');
  thumb.append(thumbDot);
  segmentedTimeline.append(thumb);

  // Floating Chapter Tooltip Card
  const hoverCard = ui('div', 'cinema-hover-card');
  hoverCard.hidden = true;
  const hoverTitle = ui('div', 'cinema-hover-title');
  const hoverTime = ui('div', 'cinema-hover-time');
  hoverCard.append(hoverTitle, hoverTime);
  segmentedTimeline.append(hoverCard);

  interface SegmentNode {
    element: HTMLElement;
    fill: HTMLElement;
    chapter: ChapterSplit;
    startPct: number;
    endPct: number;
    startSec: number;
    endSec: number;
  }
  let renderedSegments: SegmentNode[] = [];

  const rebuildSegments = () => {
    trackWrapper.replaceChildren();
    renderedSegments = [];
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    let chapters = actions.getChapters?.() || [];

    // If no AI chapters loaded yet, partition into 4-5 thematic curriculum splits
    if (chapters.length === 0) {
      const numSplits = dur > 3600 ? 5 : 4;
      const step = dur / numSplits;
      const defaultNames = [
        'Architecture Overview & Setup',
        'Core Data Models & Execution',
        'API Design & Implementation',
        'Optimization & Tradeoffs',
        'Production Deployment & Review',
      ];
      chapters = [];
      for (let i = 0; i < numSplits; i++) {
        chapters.push({
          index: i + 1,
          title: defaultNames[i % defaultNames.length] ?? "Chapter",
          start_seconds: i * step,
          end_seconds: Math.min(dur, (i + 1) * step),
          summary: `Thematic split ${i + 1}`,
        });
      }
    }

    for (const c of chapters) {
      const sSec = Math.max(0, Math.min(dur, c.start_seconds));
      const eSec = Math.max(sSec, Math.min(dur, c.end_seconds));
      const segSpan = Math.max(0.1, eSec - sSec);
      const flexRatio = (segSpan / dur) * 100;

      const seg = ui('div', 'cinema-seg-pill');
      seg.style.flex = `${flexRatio.toFixed(3)} 1 0%`;
      seg.setAttribute('data-title', c.title);

      const fill = ui('div', 'cinema-seg-fill');
      seg.append(fill);
      trackWrapper.append(seg);

      renderedSegments.push({
        element: seg,
        fill,
        chapter: c,
        startPct: (sSec / dur) * 100,
        endPct: (eSec / dur) * 100,
        startSec: sSec,
        endSec: eSec,
      });
    }
    updateSegmentProgress();
  };

  const updateSegmentProgress = () => {
    const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const currentPct = Math.max(0, Math.min(100, (cur / dur) * 100));

    // Update thumb position across timeline
    thumb.style.left = `${currentPct}%`;

    // Update each split segment fill
    for (const seg of renderedSegments) {
      if (currentPct >= seg.endPct) {
        seg.fill.style.width = '100%';
        seg.element.classList.add('is-completed');
        seg.element.classList.remove('is-active');
      } else if (currentPct <= seg.startPct) {
        seg.fill.style.width = '0%';
        seg.element.classList.remove('is-completed', 'is-active');
      } else {
        const span = seg.endPct - seg.startPct;
        const progressInSeg = span > 0 ? ((currentPct - seg.startPct) / span) * 100 : 0;
        seg.fill.style.width = `${Math.max(0, Math.min(100, progressInSeg))}%`;
        seg.element.classList.add('is-active');
        seg.element.classList.remove('is-completed');
      }
    }
  };

  video.addEventListener('timeupdate', updateSegmentProgress, { signal });
  video.addEventListener('durationchange', rebuildSegments, { signal });
  video.addEventListener('loadedmetadata', rebuildSegments, { signal });

  // Poll for chapters once study rail finishes loading
  let chaptersCheckCount = 0;
  const chapterCheckTimer = setInterval(() => {
    chaptersCheckCount++;
    const ch = actions.getChapters?.() || [];
    if (ch.length > 0 || chaptersCheckCount > 20) {
      clearInterval(chapterCheckTimer);
      rebuildSegments();
    }
  }, 500);

  // Scrubber scrubbing interactions (smooth pointer dragging)
  let isDragging = false;

  const seekFromPointer = (e: PointerEvent | MouseEvent) => {
    const rect = segmentedTimeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const targetSec = ratio * dur;
    actions.seek(targetSec);
    updateSegmentProgress();
    updateTimeText();
  };

  segmentedTimeline.addEventListener('pointerdown', (e: PointerEvent) => {
    isDragging = true;
    segmentedTimeline.setPointerCapture(e.pointerId);
    seekFromPointer(e);
    wrap.classList.add('scrubbing');
  }, { signal });

  segmentedTimeline.addEventListener('pointermove', (e: PointerEvent) => {
    const rect = segmentedTimeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pos = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = pos / rect.width;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const hoverSec = ratio * dur;

    if (isDragging) {
      seekFromPointer(e);
    }

    // Update hover card preview
    let currentChapter: ChapterSplit | undefined;
    for (const seg of renderedSegments) {
      if (hoverSec >= seg.startSec && hoverSec < seg.endSec) {
        currentChapter = seg.chapter;
        break;
      }
    }
    if (!currentChapter && renderedSegments.length > 0) {
      currentChapter = renderedSegments[renderedSegments.length - 1]?.chapter;
    }

    const forceHours = dur >= 3600;
    hoverTime.textContent = formatPlayerTime(hoverSec, forceHours);
    if (currentChapter) {
      hoverTitle.textContent = currentChapter.title;
      hoverTitle.hidden = false;
    } else {
      hoverTitle.hidden = true;
    }

    hoverCard.style.left = `${pos}px`;
    hoverCard.hidden = false;
  }, { signal });

  const stopDragging = (e: PointerEvent) => {
    if (isDragging) {
      isDragging = false;
      try {
        segmentedTimeline.releasePointerCapture(e.pointerId);
      } catch {}
      wrap.classList.remove('scrubbing');
    }
  };
  segmentedTimeline.addEventListener('pointerup', stopDragging, { signal });
  segmentedTimeline.addEventListener('pointercancel', stopDragging, { signal });

  segmentedTimeline.addEventListener('mouseleave', () => {
    if (!isDragging) {
      hoverCard.hidden = true;
    }
  }, { signal });

  // Keyboard navigation on segmented timeline
  segmentedTimeline.addEventListener('keydown', (e: KeyboardEvent) => {
    const cur = video.currentTime;
    if (e.key === 'ArrowLeft' || e.key === 'j') {
      e.preventDefault();
      actions.seek(cur - 5);
    } else if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      actions.seek(cur + 5);
    } else if (e.key === '[' || e.key === 'PageUp') {
      e.preventDefault();
      // Jump to previous chapter
      const chapters = actions.getChapters?.() || [];
      const prev = [...chapters].reverse().find(c => c.start_seconds < cur - 1.5);
      if (prev) actions.seek(prev.start_seconds);
      else actions.seek(0);
    } else if (e.key === ']' || e.key === 'PageDown') {
      e.preventDefault();
      // Jump to next chapter
      const chapters = actions.getChapters?.() || [];
      const next = chapters.find(c => c.start_seconds > cur + 1);
      if (next) actions.seek(next.start_seconds);
    }
  }, { signal });

  // E. Right Controls Group: Settings (Gear), Loop, Popout/Fullscreen
  const rightGroup = ui('div', 'cinema-right-group');

  // 1. Settings Gear Popover Menu
  const settingsGroup = ui('div', 'cinema-popover-group settings-group');
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'cinema-button cinema-settings-btn';
  settingsBtn.title = 'Settings (Playback speed, quality, captions)';
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.append(svgIcon('settings'));

  const settingsPopover = ui('div', 'cinema-frosted-popover settings-popover');
  settingsPopover.hidden = true;

  const speedRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  let captionsEnabled = false;

  const renderSettingsPopover = () => {
    settingsPopover.replaceChildren();

    // Section 1: Playback Speed
    const speedHeader = ui('div', 'popover-heading', 'Playback Speed');
    settingsPopover.append(speedHeader);
    const speedChips = ui('div', 'popover-chips-row');
    for (const rate of speedRates) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'popover-chip' + (video.playbackRate === rate ? ' active' : '');
      chip.textContent = `${rate}x`;
      chip.addEventListener('click', () => {
        video.playbackRate = rate;
        renderSettingsPopover();
        triggerHud('settings', `${rate}x Speed`);
      }, { signal });
      speedChips.append(chip);
    }
    settingsPopover.append(speedChips);

    // Section 2: Quality Selection
    const qualityHeader = ui('div', 'popover-heading', 'Streaming Quality');
    settingsPopover.append(qualityHeader);
    const qualityChips = ui('div', 'popover-chips-row');
    for (const q of ['Auto (1080p)', '1080p', '720p', '480p']) {
      const qChip = document.createElement('button');
      qChip.type = 'button';
      qChip.className = 'popover-chip' + (q.startsWith('Auto') ? ' active' : '');
      qChip.textContent = q;
      qChip.addEventListener('click', () => {
        triggerHud('quality', `Quality: ${q}`);
      }, { signal });
      qualityChips.append(qChip);
    }
    settingsPopover.append(qualityChips);

    // Section 3: Subtitles / Captions Toggle
    const ccRow = ui('div', 'popover-toggle-row');
    ccRow.append(ui('span', 'toggle-label', 'Subtitles / CC'));
    const ccToggle = document.createElement('button');
    ccToggle.type = 'button';
    ccToggle.className = 'popover-toggle-btn' + (captionsEnabled ? ' active' : '');
    ccToggle.textContent = captionsEnabled ? 'ON' : 'OFF';
    ccToggle.addEventListener('click', () => {
      captionsEnabled = !captionsEnabled;
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        if (tr) tr.mode = captionsEnabled ? 'showing' : 'hidden';
      }
      renderSettingsPopover();
      triggerHud('captions', captionsEnabled ? 'Subtitles On' : 'Subtitles Off');
    }, { signal });
    ccRow.append(ccToggle);
    settingsPopover.append(ccRow);

    // Section 4: Autoplay Toggle
    const autoplayCheckbox = document.querySelector<HTMLInputElement>('#autoplay');
    const autoRow = ui('div', 'popover-toggle-row');
    autoRow.append(ui('span', 'toggle-label', 'Autoplay Next'));
    const autoToggle = document.createElement('button');
    autoToggle.type = 'button';
    const isAuto = autoplayCheckbox?.checked ?? true;
    autoToggle.className = 'popover-toggle-btn' + (isAuto ? ' active' : '');
    autoToggle.textContent = isAuto ? 'ON' : 'OFF';
    autoToggle.addEventListener('click', () => {
      if (autoplayCheckbox) {
        autoplayCheckbox.checked = !autoplayCheckbox.checked;
        autoplayCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      renderSettingsPopover();
      triggerHud('pulse', (autoplayCheckbox?.checked ?? true) ? 'Autoplay On' : 'Autoplay Off');
    }, { signal });
    autoRow.append(autoToggle);
    settingsPopover.append(autoRow);
  };

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderSettingsPopover();
    settingsPopover.hidden = !settingsPopover.hidden;
  }, { signal });

  document.addEventListener('click', (e) => {
    if (!settingsGroup.contains(e.target as Node)) {
      settingsPopover.hidden = true;
    }
  }, { signal });

  settingsGroup.append(settingsBtn, settingsPopover);
  rightGroup.append(settingsGroup);

  // 2. Loop / Repeat Button (Two circular arrows)
  let loopMode: 'off' | 'chapter' | 'all' = 'off';
  let activeChapterStart = 0;
  let activeChapterEnd = 0;

  const loopBtn = document.createElement('button');
  loopBtn.className = 'cinema-button cinema-loop-btn';
  loopBtn.type = 'button';
  loopBtn.title = 'Loop mode (Repeat Chapter / Lesson)';
  loopBtn.setAttribute('aria-label', 'Loop repeat');
  loopBtn.append(svgIcon('loop'));

  loopBtn.addEventListener('click', () => {
    const chapters = actions.getChapters?.() || [];
    const cur = video.currentTime;
    const curChap = chapters.find(c => cur >= c.start_seconds && cur < c.end_seconds);

    if (loopMode === 'off') {
      if (curChap) {
        loopMode = 'chapter';
        activeChapterStart = curChap.start_seconds;
        activeChapterEnd = curChap.end_seconds;
        loopBtn.classList.add('active');
        loopBtn.title = `Looping chapter: ${curChap.title}`;
        triggerHud('loop', `Loop: ${curChap.title}`);
      } else {
        loopMode = 'all';
        loopBtn.classList.add('active');
        loopBtn.title = 'Looping full video';
        triggerHud('loop', 'Loop All');
      }
    } else if (loopMode === 'chapter') {
      loopMode = 'all';
      loopBtn.title = 'Looping full video';
      triggerHud('loop', 'Loop Lesson');
    } else {
      loopMode = 'off';
      loopBtn.classList.remove('active');
      loopBtn.title = 'Loop mode (Repeat Chapter / Lesson)';
      triggerHud('loop', 'Loop Off');
    }
  }, { signal });

  video.addEventListener('timeupdate', () => {
    if (loopMode === 'chapter' && activeChapterEnd > activeChapterStart && video.currentTime >= activeChapterEnd) {
      video.currentTime = activeChapterStart;
    } else if (loopMode === 'all' && video.ended) {
      video.currentTime = 0;
      void video.play();
    }
  }, { signal });
  rightGroup.append(loopBtn);

  // 3. Popout / Fullscreen Button (Square with diagonal arrow)
  const popoutBtn = document.createElement('button');
  popoutBtn.type = 'button';
  popoutBtn.className = 'cinema-button cinema-popout-btn';
  popoutBtn.title = 'Toggle Fullscreen (F) / Picture in Picture';
  popoutBtn.setAttribute('aria-label', 'Fullscreen');
  popoutBtn.append(svgIcon('popout'));

  popoutBtn.addEventListener('click', (e) => {
    if (e.shiftKey) {
      // Shift+click for Picture-in-Picture
      if (document.pictureInPictureElement) {
        void document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === 'function') {
        void video.requestPictureInPicture();
      }
    } else {
      // Fullscreen
      if (document.fullscreenElement === wrap) {
        void document.exitFullscreen();
      } else {
        void wrap.requestFullscreen();
      }
    }
  }, { signal });
  rightGroup.append(popoutBtn);

  // Assemble the unified control row
  row.append(bottomPlayBtn, volumeGroup, timeDisplay, segmentedTimeline, rightGroup);

  // Update play state
  const updatePlayState = () => {
    const paused = video.paused;
    centerPlay.setAttribute('aria-label', paused ? 'Play lesson' : 'Pause lesson');
    centerPlay.title = paused ? 'Play lesson (Space/K)' : 'Pause lesson (Space/K)';
    centerPlay.replaceChildren(svgIcon(paused ? 'play' : 'pause'));
    center.classList.toggle('is-playing', !paused);

    bottomPlayBtn.replaceChildren(svgIcon(paused ? 'play' : 'pause'));
    bottomPlayBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    bottomPlayBtn.title = paused ? 'Play (Space/K)' : 'Pause (Space/K)';
  };
  for (const ev of ['play', 'pause', 'ended', 'emptied']) {
    video.addEventListener(ev, updatePlayState, { signal });
  }
  updatePlayState();

  // Autohide & activity tracking
  let autohideTimer: any = undefined;
  const showControls = () => {
    wrap.classList.remove('user-inactive');
    clearTimeout(autohideTimer);
    if (!video.paused && settingsPopover.hidden && !wrap.classList.contains('controls-locked') && !isDragging) {
      autohideTimer = setTimeout(() => {
        if (!video.paused && settingsPopover.hidden && !wrap.classList.contains('controls-locked') && !isDragging) {
          wrap.classList.add('user-inactive');
        }
      }, 2500);
    }
  };

  wrap.addEventListener('mousemove', showControls, { signal });
  wrap.addEventListener('pointermove', showControls, { signal });
  wrap.addEventListener('pointerdown', showControls, { signal });
  video.addEventListener('play', showControls, { signal });
  video.addEventListener('pause', () => {
    wrap.classList.remove('user-inactive');
    clearTimeout(autohideTimer);
  }, { signal });

  // Keyboard Shortcuts dialog
  const shortcutsPopover = ui('div', 'player-shortcuts-popover');
  shortcutsPopover.hidden = true;
  shortcutsPopover.setAttribute('role', 'dialog');
  shortcutsPopover.setAttribute('aria-label', 'Keyboard shortcuts cheatsheet');
  shortcutsPopover.innerHTML = `
    <div class="shortcuts-header">
      <strong>Keyboard Shortcuts</strong>
      <button type="button" class="cinema-button shortcuts-close" aria-label="Close shortcuts">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="shortcuts-grid">
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Space</kbd><kbd>K</kbd></span><span class="shortcut-label">Play / Pause</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>[</kbd><kbd>]</kbd></span><span class="shortcut-label">Prev / Next Split Chapter</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>J</kbd><kbd>Left</kbd></span><span class="shortcut-label">Rewind 10s</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>L</kbd><kbd>Right</kbd></span><span class="shortcut-label">Forward 10s</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Up</kbd><kbd>Down</kbd></span><span class="shortcut-label">Volume +5% / -5%</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>M</kbd></span><span class="shortcut-label">Mute / Unmute</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>F</kbd></span><span class="shortcut-label">Fullscreen</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Shift+N</kbd></span><span class="shortcut-label">Next Lesson</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Shift+P</kbd></span><span class="shortcut-label">Previous Lesson</span></div>
    </div>
  `;
  wrap.append(shortcutsPopover);
  shortcutsBtn.addEventListener('click', () => {
    shortcutsPopover.hidden = !shortcutsPopover.hidden;
  }, { signal });
  shortcutsPopover.querySelector('.shortcuts-close')?.addEventListener('click', () => {
    shortcutsPopover.hidden = true;
  }, { signal });

  // Episode dialog hook
  const dialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  if (dialog) {
    wrap.append(dialog);
    let openedFromInPlayer = false;
    episodes.addEventListener('click', () => {
      openedFromInPlayer = true;
      episodes.setAttribute('aria-expanded', String(dialog.open));
    }, { signal });
    dialog.addEventListener('close', () => {
      episodes.setAttribute('aria-expanded', 'false');
      if (openedFromInPlayer && wrap.isConnected && !signal.aborted) {
        episodes.focus();
      }
      openedFromInPlayer = false;
    }, { signal });
  }

  // Keyboard listener on window
  window.addEventListener('keydown', (e) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (video.paused) void video.play();
      else video.pause();
    } else if (e.key === '[' || e.key === 'PageUp') {
      e.preventDefault();
      const chapters = actions.getChapters?.() || [];
      const cur = video.currentTime;
      const prev = [...chapters].reverse().find(c => c.start_seconds < cur - 1.5);
      if (prev) {
        actions.seek(prev.start_seconds);
        triggerHud('skip-back', prev.title);
      }
    } else if (e.key === ']' || e.key === 'PageDown') {
      e.preventDefault();
      const chapters = actions.getChapters?.() || [];
      const cur = video.currentTime;
      const next = chapters.find(c => c.start_seconds > cur + 1);
      if (next) {
        actions.seek(next.start_seconds);
        triggerHud('skip-forward', next.title);
      }
    }
  }, { signal });
}
