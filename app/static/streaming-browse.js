/**
 * CourseForge Streaming Browse & My List — Stage 3
 *
 * Implements:
 * 1. Browse / Category Hub (#/browse and #/browse/<category>).
 * 2. Category filter pills (#categoryFilterPills) with live count badges.
 * 3. 2:3 poster grid with .browse-poster-card styling.
 * 4. Hover preview cards with 180ms delay (synopsis, episodes, Play CTA, My List CTA).
 * 5. Dedicated My List surface (#/my-list) inside .mylist-surface container
 *    with 1-click remove, 1-click play, and streaming empty state.
 */
(function() {
  'use strict';

  let hoverTimer = null;
  let activePreview = null;

  // --------------------------------------------------------------------------
  // Category Hub & Deep Linking
  // --------------------------------------------------------------------------
  function initBrowseHub() {
    window.addEventListener('hashchange', handleBrowseRouting);
    window.addEventListener('courseforge-navigate', syncCategoryPills);

    // Observe changes to catalog to add streaming classes and preview cards
    const catalog = document.getElementById('courseCatalog');
    if (catalog) {
      const observer = new MutationObserver(() => {
        enhanceCatalogCards();
      });
      observer.observe(catalog, { childList: true });
    }

    handleBrowseRouting();
    setTimeout(syncCategoryPills, 300);
  }

  function handleBrowseRouting() {
    const hash = location.hash;
    if (hash.startsWith('#/browse') || hash.startsWith('#browse')) {
      const parts = hash.replace(/^#\/?browse\/?/, '').split('?');
      const categoryParam = parts[0] ? decodeURIComponent(parts[0]).trim() : '';
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      setTimeout(() => {
        syncCategoryPills();
        if (categoryParam) {
          applyCategoryFilter(categoryParam);
        }
      }, 50);
    } else if (hash === '#/my-list' || hash === '#my-list') {
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      renderMyListView();
    } else if (hash === '#/history' || hash === '#history') {
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      renderHistoryView();
    }
  }

  function syncCategoryPills() {
    const libraryControls = document.querySelector('.library-controls');
    if (!libraryControls) return;

    let pillsBar = document.getElementById('categoryFilterPills');
    if (!pillsBar) {
      pillsBar = document.createElement('div');
      pillsBar.id = 'categoryFilterPills';
      pillsBar.className = 'category-pills-bar';
      pillsBar.setAttribute('role', 'tablist');
      pillsBar.setAttribute('aria-label', 'Browse by category');
      libraryControls.parentNode.insertBefore(pillsBar, document.getElementById('courseCatalog'));
    }
    pillsBar.hidden = false;

    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];
    if (!courses.length) return;

    // Collect category counts
    const catCounts = { 'all': courses.length };
    courses.forEach(c => {
      const cat = c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : 'General');
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    });

    const activeCat = (window.state && window.state.category) || 'all';

    const categories = [
      { id: 'all', label: 'All Titles' },
      { id: 'Cloud & Azure', label: 'Cloud & Azure' },
      { id: 'Agentic AI', label: 'Agentic AI' },
      { id: 'Big Data', label: 'Big Data' },
      { id: 'System Design', label: 'System Design' },
      { id: 'DSA & ML', label: 'DSA & ML' }
    ];

    // Also include any other unique categories
    Object.keys(catCounts).forEach(cat => {
      if (cat !== 'all' && !categories.some(c => c.id.toLowerCase() === cat.toLowerCase() || c.label.toLowerCase() === cat.toLowerCase())) {
        categories.push({ id: cat, label: cat });
      }
    });

    pillsBar.innerHTML = '';
    categories.forEach(cat => {
      // Calculate count matching this category
      let count = 0;
      if (cat.id === 'all') {
        count = courses.length;
      } else {
        count = courses.filter(c => {
          const courseCat = (c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : '')).toLowerCase();
          const target = cat.id.toLowerCase();
          return courseCat.includes(target) || target.includes(courseCat);
        }).length;
      }

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `category-pill ${activeCat.toLowerCase() === cat.id.toLowerCase() ? 'active' : ''}`;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('data-category', cat.id);
      pill.innerHTML = `${escapeHtml(cat.label)} <span class="badge-count">${count}</span>`;

      pill.onclick = () => {
        pillsBar.querySelectorAll('.category-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        applyCategoryFilter(cat.id);
      };

      pillsBar.appendChild(pill);
    });
  }

  function applyCategoryFilter(cat) {
    if (!window.state) return;
    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];

    if (cat === 'all') {
      window.state.category = 'all';
    } else {
      // Find matching category value
      const match = courses.find(c => {
        const cCat = (c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : '')).toLowerCase();
        return cCat.includes(cat.toLowerCase()) || cat.toLowerCase().includes(cCat);
      });
      if (match) {
        window.state.category = match.category || (typeof window.courseCategory === 'function' ? window.courseCategory(match.name) : cat);
      } else {
        window.state.category = cat;
      }
    }

    const categorySelect = document.getElementById('categoryFilter');
    if (categorySelect) {
      categorySelect.value = window.state.category;
    }

    if (typeof window.renderCatalog === 'function') {
      window.renderCatalog();
    }
  }

  function enhanceCatalogCards() {
    const cards = document.querySelectorAll('#courseCatalog .course-tile, #courseCatalog .course-card');
    cards.forEach(card => {
      card.classList.add('browse-poster-card');
      attachHoverPreview(card);
    });
  }

  // --------------------------------------------------------------------------
  // Hover Preview Cards (180ms delay)
  // --------------------------------------------------------------------------
  function attachHoverPreview(card) {
    if (card._previewAttached) return;
    card._previewAttached = true;

    card.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        showPreviewModal(card);
      }, 180);
    });

    card.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
    });
  }

  function showPreviewModal(card) {
    // Stage 4 will render the full Netflix modal; Stage 3 activates hover styling
    card.classList.add('hover-active');
  }

  // --------------------------------------------------------------------------
  // Dedicated My List View (#/my-list)
  // --------------------------------------------------------------------------
  async function renderMyListView() {
    const catalog = document.getElementById('courseCatalog');
    const libraryCount = document.getElementById('libraryCount');
    const libraryEmpty = document.getElementById('libraryEmpty');
    const pillsBar = document.getElementById('categoryFilterPills');
    if (!catalog) return;

    if (pillsBar) pillsBar.hidden = true;
    if (libraryEmpty) libraryEmpty.hidden = true;
    catalog.setAttribute('aria-busy', 'true');
    catalog.innerHTML = '<div class="skeleton-row"><div class="skeleton-poster"></div><div class="skeleton-poster"></div><div class="skeleton-poster"></div></div>';

    try {
      const res = await fetch('/api/streaming/my-list');
      catalog.setAttribute('aria-busy', 'false');
      if (!res.ok) throw new Error('Could not load My List');
      const data = await res.json();
      const items = data.items || [];

      if (libraryCount) {
        libraryCount.textContent = `My List (${items.length} titles)`;
      }

      catalog.innerHTML = '';
      const surface = document.createElement('div');
      surface.className = 'mylist-surface';

      if (!items.length) {
        surface.innerHTML = `
          <div class="panel empty-mylist">
            <div class="empty-illustration"><svg class="icon"><use href="#i-bookmark"/></svg></div>
            <h3>Your list is empty</h3>
            <p>Explore our engineering masterclasses and save titles to watch anytime.</p>
            <a href="#/browse" class="btn btn-primary">Find titles to add</a>
          </div>
        `;
        catalog.appendChild(surface);
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'mylist-grid';

      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'mylist-card';

        const isCourse = item.item_type === 'course';
        const posterUrl = item.poster_url || `/api/artwork/courses/${item.slug || item.item_id}/poster`;
        const playLink = item.deep_link || (isCourse ? `#/course/${item.slug}` : `#/lecture/${item.item_id}`);

        card.innerHTML = `
          <div class="mylist-thumb-wrap">
            <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />
            <button type="button" class="mylist-remove-btn" data-type="${item.item_type}" data-id="${item.item_id || item.slug}" title="Remove from My List" aria-label="Remove from My List">
              <svg class="icon"><use href="#i-close"/></svg>
            </button>
            <a href="${playLink}" class="mylist-play-overlay" title="Play">
              <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
            </a>
          </div>
          <div class="mylist-card-info">
            <strong class="mylist-card-title">${escapeHtml(item.title)}</strong>
            <span class="mylist-card-meta">${isCourse ? 'Masterclass' : escapeHtml(item.course || 'Episode')}</span>
          </div>
        `;

        // Wire 1-click remove button
        const removeBtn = card.querySelector('.mylist-remove-btn');
        if (removeBtn) {
          removeBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const csrf = window.CourseForgeAccount?.csrf || '';
              const delRes = await fetch(`/api/streaming/my-list/${removeBtn.dataset.type}/${encodeURIComponent(removeBtn.dataset.id)}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': csrf }
              });
              if (delRes.ok) {
                card.remove();
                if (window.toast) window.toast('Removed from My List');
                if (grid.children.length === 0) {
                  renderMyListView();
                }
              }
            } catch (err) {
              if (window.toast) window.toast(err.message, true);
            }
          };
        }

        grid.appendChild(card);
      });

      surface.appendChild(grid);
      catalog.appendChild(surface);
    } catch (err) {
      catalog.setAttribute('aria-busy', 'false');
      catalog.innerHTML = `<p class="muted">Could not load My List: ${escapeHtml(err.message)}</p>`;
    }
  }

  // --------------------------------------------------------------------------
  // Dedicated Watch History View (#/history)
  // --------------------------------------------------------------------------
  async function renderHistoryView() {
    const catalog = document.getElementById('courseCatalog');
    const libraryCount = document.getElementById('libraryCount');
    const libraryEmpty = document.getElementById('libraryEmpty');
    const pillsBar = document.getElementById('categoryFilterPills');
    if (!catalog) return;

    if (pillsBar) pillsBar.hidden = true;
    if (libraryEmpty) libraryEmpty.hidden = true;
    catalog.setAttribute('aria-busy', 'true');
    catalog.innerHTML = '<div class="skeleton-row"><div class="skeleton-poster"></div><div class="skeleton-poster"></div><div class="skeleton-poster"></div></div>';

    try {
      const res = await fetch('/api/streaming/history');
      catalog.setAttribute('aria-busy', 'false');
      if (!res.ok) throw new Error('Could not load Watch History');
      const data = await res.json();
      const items = data.history || [];

      if (libraryCount) {
        libraryCount.textContent = `Watch History (${items.length} titles)`;
      }

      catalog.innerHTML = '';
      const surface = document.createElement('div');
      surface.className = 'history-surface';

      // Header row with Clear History button
      const headerRow = document.createElement('div');
      headerRow.className = 'history-header-row';
      headerRow.innerHTML = `
        <div class="history-title-wrap">
          <h2 class="history-heading">Watch History</h2>
          <p class="history-subheading">Chronological record of your watched lectures across all devices.</p>
        </div>
        ${items.length ? `
          <button type="button" class="btn btn-outline history-clear-btn" id="clearHistoryBtn">
            <svg class="icon"><use href="#i-trash"/></svg> Clear watch history
          </button>
        ` : ''}
      `;
      surface.appendChild(headerRow);

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'panel empty-history';
        empty.innerHTML = `
          <div class="empty-illustration"><svg class="icon"><use href="#i-clock"/></svg></div>
          <h3>No watch history yet</h3>
          <p>Lectures you stream will appear here in chronological order with your resume timestamps.</p>
          <a href="#/browse" class="btn btn-primary">Start exploring masterclasses</a>
        `;
        surface.appendChild(empty);
        catalog.appendChild(surface);
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'history-grid';

      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'history-card';

        const thumbUrl = item.thumbnail_url || `/api/artwork/lectures/${item.video_id}/thumbnail?size=md`;
        const durMins = item.duration ? Math.ceil(item.duration / 60) + 'm' : '';
        const posMins = item.position ? Math.floor(item.position / 60) + 'm' : '0m';
        const percent = item.duration ? Math.min(100, Math.round((item.position / item.duration) * 100)) : 0;
        const formattedDate = item.watched_at ? new Date(item.watched_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

        card.innerHTML = `
          <div class="history-thumb-wrap">
            <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />
            <div class="history-progress-bar"><div class="history-progress-fill" style="width: ${percent}%"></div></div>
            <a href="${item.deep_link}" class="history-play-overlay" title="Resume playback">
              <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
            </a>
          </div>
          <div class="history-card-info">
            <div class="history-card-meta-top">
              <span class="history-course-badge">${escapeHtml(item.course || '')}</span>
              ${formattedDate ? `<span class="history-date">${formattedDate}</span>` : ''}
            </div>
            <strong class="history-card-title">${escapeHtml(item.title)}</strong>
            <div class="history-card-meta-bottom">
              <span class="history-resume-pill">${item.completed ? 'Completed' : `Resume at ${posMins}`}</span>
              ${durMins ? `<span class="history-duration">${durMins}</span>` : ''}
            </div>
          </div>
        `;
        grid.appendChild(card);
      });

      surface.appendChild(grid);
      catalog.appendChild(surface);

      // Wire Clear History button with confirmation dialog
      const clearBtn = surface.querySelector('#clearHistoryBtn');
      if (clearBtn) {
        clearBtn.onclick = async () => {
          if (!window.confirm('Clear your entire watch history? This cannot be undone.')) {
            return;
          }
          try {
            const csrf = window.CourseForgeAccount?.csrf || '';
            const delRes = await fetch('/api/streaming/history', {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            if (delRes.ok) {
              if (window.toast) window.toast('Watch history cleared');
              renderHistoryView();
            } else {
              throw new Error('Failed to clear history');
            }
          } catch (err) {
            if (window.toast) window.toast('Could not clear watch history: ' + err.message, true);
          }
        };
      }
    } catch (err) {
      catalog.setAttribute('aria-busy', 'false');
      catalog.innerHTML = `<div class="error-panel">Failed to load Watch History. <button class="btn btn-outline" onclick="CourseForgeBrowse.renderHistoryView()">Retry</button></div>`;
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Export browse and my-list helper
  window.CourseForgeBrowse = {
    initBrowseHub,
    syncCategoryPills,
    renderMyListView,
    renderHistoryView
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowseHub);
  } else {
    initBrowseHub();
  }

})();
