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
    renderMyListView
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowseHub);
  } else {
    initBrowseHub();
  }

})();
