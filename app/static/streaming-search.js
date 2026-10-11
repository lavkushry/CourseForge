/**
 * CourseForge Streaming Search — Stage 3: Search Overlay & Typeahead Suggest
 *
 * Implements:
 * 1. Focus trigger on header search and "/" keyboard shortcut.
 * 2. Recent searches with removable chips saved in localStorage.
 * 3. Typeahead search grouped by Titles (Courses), Episodes (Lectures), and Topics.
 * 4. Substring match highlighting with <mark class="search-match">.
 * 5. Full keyboard navigation (ArrowUp, ArrowDown, Enter, Escape).
 */
(function() {
  'use strict';

  const RECENT_KEY = 'cf_recent_searches';
  let selectedIndex = -1;
  let currentResults = [];
  let debounceTimer = null;

  function getRecentSearches() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveRecentSearch(term) {
    if (!term || !term.trim()) return;
    const clean = term.trim();
    let recents = getRecentSearches().filter(t => t.toLowerCase() !== clean.toLowerCase());
    recents.unshift(clean);
    if (recents.length > 8) recents = recents.slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (_) {}
  }

  function removeRecentSearch(term) {
    let recents = getRecentSearches().filter(t => t.toLowerCase() !== term.toLowerCase());
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (_) {}
    renderRecentSearches();
  }

  function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapeRegex(escapedQuery)})`, 'gi');
    return escapedText.replace(regex, '<mark class="search-match">$1</mark>');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderRecentSearches() {
    const panel = document.getElementById('universalSearchResults');
    if (!panel) return;
    const recents = getRecentSearches();
    selectedIndex = -1;
    currentResults = [];

    if (!recents.length) {
      panel.innerHTML = `
        <div class="search-section">
          <div class="search-section-title">Explore Courses &amp; Episodes</div>
          <p class="search-hint muted">Type a title, topic (e.g. Spark, LLM, System Design), or instructor to search.</p>
        </div>
      `;
      panel.hidden = false;
      return;
    }

    let html = `
      <div class="search-section">
        <div class="search-section-header">
          <span class="search-section-title">Recent Searches</span>
          <button type="button" class="search-clear-btn" id="searchClearAll">Clear all</button>
        </div>
        <div class="recent-chips">
    `;

    recents.forEach(term => {
      html += `
        <span class="recent-chip">
          <span class="chip-text" data-term="${escapeHtml(term)}">${escapeHtml(term)}</span>
          <button type="button" class="chip-remove" data-remove="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(term)}">
            <svg class="icon"><use href="#i-close"/></svg>
          </button>
        </span>
      `;
    });

    html += `
        </div>
      </div>
    `;

    panel.innerHTML = html;
    panel.hidden = false;

    // Wire clicks on chips
    panel.querySelectorAll('.chip-text').forEach(chip => {
      chip.onclick = () => {
        const term = chip.dataset.term;
        const input = document.getElementById('globalSearch');
        if (input) {
          input.value = term;
          doSearch(term);
        }
      };
    });

    panel.querySelectorAll('.chip-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        removeRecentSearch(btn.dataset.remove);
      };
    });

    const clearAll = document.getElementById('searchClearAll');
    if (clearAll) {
      clearAll.onclick = () => {
        localStorage.removeItem(RECENT_KEY);
        renderRecentSearches();
      };
    }
  }

  function doSearch(query) {
    const panel = document.getElementById('universalSearchResults');
    if (!panel) return;

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      renderRecentSearches();
      return;
    }

    const state = window.state || { videos: [], courseMeta: new Map() };
    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];

    // 1. Matching Courses (Titles)
    const matchingCourses = courses.filter(c => {
      const title = (c.title || c.name || '').toLowerCase();
      const instructor = (c.instructor || '').toLowerCase();
      const category = (c.category || '').toLowerCase();
      const tags = (c.tags || []).join(' ').toLowerCase();
      return title.includes(trimmed) || instructor.includes(trimmed) || category.includes(trimmed) || tags.includes(trimmed);
    }).slice(0, 4);

    // 2. Matching Episodes (Lectures)
    const matchingEpisodes = (state.videos || []).filter(v => {
      const title = (v.title || '').toLowerCase();
      const section = (v.section || '').toLowerCase();
      return title.includes(trimmed) || section.includes(trimmed);
    }).slice(0, 6);

    // 3. Matching Topics / Categories
    const allTopics = new Set();
    courses.forEach(c => {
      if (c.category) allTopics.add(c.category);
      (c.tags || []).forEach(t => allTopics.add(t));
    });
    const matchingTopics = [...allTopics].filter(t => t.toLowerCase().includes(trimmed)).slice(0, 4);

    selectedIndex = -1;
    currentResults = [];

    if (!matchingCourses.length && !matchingEpisodes.length && !matchingTopics.length) {
      panel.innerHTML = `
        <div class="search-empty">
          <p>No results found for "<strong>${escapeHtml(query)}</strong>"</p>
          <span class="muted">Try checking for typos or searching by broad topic.</span>
        </div>
      `;
      panel.hidden = false;
      return;
    }

    let html = '';

    // Render Course Matches
    if (matchingCourses.length) {
      html += `<div class="search-section" id="searchSectionTitles"><div class="search-section-title">Titles &amp; Masterclasses</div><div class="search-items-list">`;
      matchingCourses.forEach(c => {
        const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const posterUrl = `/api/artwork/courses/${encodeURIComponent(c.name)}/poster`;
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'course', url: `#/course/${slug}`, term: c.title || c.name });

        html += `
          <a class="search-item search-item-course" href="#/course/${slug}" data-index="${itemIdx}">
            <img class="search-thumb-poster" src="${posterUrl}" alt="" loading="lazy" />
            <div class="search-item-info">
              <strong class="search-item-title">${highlightMatch(c.title || c.name, query)}</strong>
              <div class="search-item-meta">
                <span class="badge-category">${escapeHtml(c.category || 'Course')}</span>
                <span>${c.videos ? c.videos.length : 0} Episodes</span>
                ${c.instructor ? `<span>· By ${escapeHtml(c.instructor)}</span>` : ''}
              </div>
            </div>
            <span class="search-action-hint"><svg class="icon"><use href="#i-chevron"/></svg></span>
          </a>
        `;
      });
      html += `</div></div>`;
    }

    // Render Episode Matches
    if (matchingEpisodes.length) {
      html += `<div class="search-section" id="searchSectionEpisodes"><div class="search-section-title">Episodes &amp; Lectures</div><div class="search-items-list">`;
      matchingEpisodes.forEach(v => {
        const thumbUrl = `/api/artwork/lectures/${v.id}/thumbnail?size=sm`;
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'lecture', url: `#/lecture/${v.id}`, term: v.title });

        const durationMins = v.duration ? Math.ceil(v.duration / 60) + 'm' : '';

        html += `
          <a class="search-item search-item-episode" href="#/lecture/${v.id}" data-index="${itemIdx}">
            <img class="search-thumb-backdrop" src="${thumbUrl}" alt="" loading="lazy" />
            <div class="search-item-info">
              <strong class="search-item-title">${highlightMatch(v.title, query)}</strong>
              <div class="search-item-meta">
                <span>${escapeHtml(v.course || '')}</span>
                ${durationMins ? `<span class="badge-duration">${durationMins}</span>` : ''}
              </div>
            </div>
            <span class="search-action-play"><svg class="icon"><use href="#i-play"/></svg></span>
          </a>
        `;
      });
      html += `</div></div>`;
    }

    // Render Topic Matches
    if (matchingTopics.length) {
      html += `<div class="search-section" id="searchSectionTopics"><div class="search-section-title">Topics</div><div class="search-topics-list">`;
      matchingTopics.forEach(t => {
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'topic', url: `#/browse/${encodeURIComponent(t)}`, term: t });
        html += `
          <a class="search-topic-pill" href="#/browse/${encodeURIComponent(t)}" data-index="${itemIdx}">
            <svg class="icon"><use href="#i-spark"/></svg> ${highlightMatch(t, query)}
          </a>
        `;
      });
      html += `</div></div>`;
    }

    panel.innerHTML = html;
    panel.hidden = false;

    // Attach click recording to results
    panel.querySelectorAll('.search-item, .search-topic-pill').forEach(el => {
      el.addEventListener('click', () => {
        saveRecentSearch(query);
        panel.hidden = true;
      });
    });
  }

  function updateSelection(delta) {
    if (!currentResults.length) return;
    const items = document.querySelectorAll('#universalSearchResults [data-index]');
    items.forEach(el => el.classList.remove('selected'));

    selectedIndex += delta;
    if (selectedIndex < 0) selectedIndex = currentResults.length - 1;
    if (selectedIndex >= currentResults.length) selectedIndex = 0;

    const activeEl = document.querySelector(`#universalSearchResults [data-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.classList.add('selected');
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function setupSearchListeners() {
    const input = document.getElementById('globalSearch');
    const panel = document.getElementById('universalSearchResults');
    if (!input || !panel) return;

    input.addEventListener('focus', () => {
      if (!input.value.trim()) {
        renderRecentSearches();
      } else {
        doSearch(input.value);
      }
    });

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        doSearch(input.value);
      }, 150);
    });

    input.addEventListener('keydown', (e) => {
      if (panel.hidden) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        updateSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        updateSelection(-1);
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && currentResults[selectedIndex]) {
          e.preventDefault();
          const target = currentResults[selectedIndex];
          saveRecentSearch(input.value);
          panel.hidden = true;
          location.hash = target.url;
        } else if (input.value.trim()) {
          saveRecentSearch(input.value);
          panel.hidden = true;
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        panel.hidden = true;
        input.blur();
      }
    });
  }

  // Export search helper
  window.CourseForgeSearch = {
    doSearch,
    renderRecentSearches
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchListeners);
  } else {
    setupSearchListeners();
  }

})();
