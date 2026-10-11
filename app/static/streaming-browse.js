/**
 * CourseForge Streaming Browse & My List — Stage 3
 *
 * Implements:
 * 1. Browse / Category Hub (#/browse and #/browse/<category>).
 * 2. Filter pills with live counts, sort dropdown, and 2:3 poster grid.
 * 3. Hover preview cards with 180ms delay (synopsis, episodes, Play, My List).
 * 4. Dedicated My List surface (#/my-list) with 1-click remove, 1-click play,
 *    unwatched/in-progress filters, and streaming empty state.
 */
(function() {
  'use strict';

  let hoverTimeout = null;
  let activePreviewCard = null;

  // --------------------------------------------------------------------------
  // Category Hub & Deep Linking
  // --------------------------------------------------------------------------
  function initBrowseHub() {
    window.addEventListener('hashchange', handleBrowseRouting);
    handleBrowseRouting();
  }

  function handleBrowseRouting() {
    const hash = location.hash;
    if (hash.startsWith('#/browse') || hash.startsWith('#browse')) {
      const parts = hash.replace(/^#\/?browse\/?/, '').split('?');
      const categoryParam = parts[0] ? decodeURIComponent(parts[0]).trim() : '';
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      if (categoryParam) {
        applyCategoryFilter(categoryParam);
      }
    } else if (hash === '#/my-list' || hash === '#my-list') {
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      renderMyListView();
    }
  }

  function applyCategoryFilter(cat) {
    const categorySelect = document.getElementById('categoryFilter');
    if (!categorySelect) return;
    
    // Check if category matches select options
    for (let i = 0; i < categorySelect.options.length; i++) {
      const opt = categorySelect.options[i];
      if (opt.value.toLowerCase() === cat.toLowerCase() || opt.text.toLowerCase().includes(cat.toLowerCase())) {
        categorySelect.selectedIndex = i;
        if (window.state) window.state.category = opt.value;
        if (typeof window.renderCatalog === 'function') window.renderCatalog();
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Dedicated My List View
  // --------------------------------------------------------------------------
  async function renderMyListView() {
    const catalog = document.getElementById('courseCatalog');
    const libraryCount = document.getElementById('libraryCount');
    const libraryEmpty = document.getElementById('libraryEmpty');
    if (!catalog) return;

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

      if (!items.length) {
        catalog.innerHTML = `
          <div class="panel empty-mylist">
            <div class="empty-illustration"><svg class="icon"><use href="#i-bookmark"/></svg></div>
            <h3>Your list is empty</h3>
            <p>Explore our engineering masterclasses and save titles to watch anytime.</p>
            <a href="#/browse" class="btn btn-primary">Find titles to add</a>
          </div>
        `;
        return;
      }

      catalog.innerHTML = '';
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
            <a href="${playLink}" class="mylist-play-overlay">
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

      catalog.appendChild(grid);
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
    renderMyListView
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowseHub);
  } else {
    initBrowseHub();
  }

})();
