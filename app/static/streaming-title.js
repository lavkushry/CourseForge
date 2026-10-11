/**
 * CourseForge Streaming Title & Episode Details — Stage 4
 *
 * Implements:
 * 1. Title surface & Netflix-style modal (#/course/<slug>) with 16:9 cinematic backdrop.
 * 2. Primary Play CTA (Play S1:E1 or Resume), My List toggle, Share button (clipboard + toast).
 * 3. Metadata line: Match %, Year (2026), Seasons count, Category, Audio/Video quality.
 * 4. Full synopsis and instructor byline.
 * 5. Seasons & Episodes selector: dropdown switcher with batch durations and episode counts.
 * 6. Episode list: 16:9 thumbnails, episode number, title, duration, collapsible synopsis,
 *    progress bar, completion checkmark, direct Play CTA.
 * 7. More Like This: 6-card row of related courses based on category + co-enrollment.
 * 8. Details tab: curriculum breakdown, secure materials downloads, prerequisites, certification.
 */
(function() {
  'use strict';

  let currentTitleData = null;
  let activeSeasonIndex = 0;
  let activeTab = 'episodes';

  function initTitleExperience() {
    window.addEventListener('hashchange', handleTitleRouting);
    document.addEventListener('click', handleCardClicks);

    const dialog = document.getElementById('titleDetailDialog');
    if (dialog) {
      dialog.addEventListener('click', (e) => {
        // Close on clicking backdrop outside dialog content
        const rect = dialog.getBoundingClientRect();
        const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
                            rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!isInDialog && e.target === dialog) {
          closeTitleModal();
        }
      });

      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeTitleModal();
      });
    }

    handleTitleRouting();
  }

  function handleCardClicks(e) {
    const link = e.target.closest('a[href*="#/course/"], button[data-course-slug]');
    if (!link) return;

    let slug = '';
    if (link.dataset && link.dataset.courseSlug) {
      slug = link.dataset.courseSlug;
    } else if (link.getAttribute('href')) {
      const href = link.getAttribute('href');
      const match = href.match(/#\/course\/([a-zA-Z0-9_-]+)/);
      if (match) slug = match[1];
    }

    if (slug) {
      e.preventDefault();
      openTitleModal(slug);
    }
  }

  function handleTitleRouting() {
    const hash = location.hash;
    const match = hash.match(/^#\/?course\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const slug = match[1];
      openTitleModal(slug);
    }
  }

  async function openTitleModal(slug) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }

    // Render skeleton state
    dialog.innerHTML = `
      <div class="title-dialog-content">
        <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
          <svg class="icon"><use href="#i-close"/></svg>
        </button>
        <div class="skeleton-hero title-skeleton-hero"></div>
        <div class="title-dialog-body">
          <div class="skeleton-row">
            <div class="skeleton-poster" style="height: 40px; width: 140px;"></div>
            <div class="skeleton-poster" style="height: 40px; width: 140px;"></div>
          </div>
        </div>
      </div>
    `;

    const closeBtn = document.getElementById('titleDialogClose');
    if (closeBtn) closeBtn.onclick = closeTitleModal;

    try {
      const res = await fetch(`/api/streaming/courses/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('Could not load course details');
      const data = await res.json();
      currentTitleData = data;
      activeSeasonIndex = 0;
      activeTab = 'episodes';

      renderTitleContent(data);
    } catch (err) {
      dialog.innerHTML = `
        <div class="title-dialog-content title-error-content">
          <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
            <svg class="icon"><use href="#i-close"/></svg>
          </button>
          <div class="title-error-box">
            <h3>Unable to load title details</h3>
            <p class="muted">${escapeHtml(err.message)}</p>
            <button type="button" class="btn btn-primary" onclick="window.CourseForgeTitle.closeTitleModal()">Close</button>
          </div>
        </div>
      `;
      const btn = document.getElementById('titleDialogClose');
      if (btn) btn.onclick = closeTitleModal;
    }
  }

  function renderTitleContent(data) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    const course = data.course;
    const seasons = data.seasons || [];
    const related = data.related || [];

    const nextLec = course.next_lecture;
    const playUrl = nextLec ? nextLec.deep_link : (seasons[0]?.episodes[0]?.deep_link || '#');
    const playLabel = nextLec && nextLec.resume_position > 30 ? 'Resume Playing' : 'Play S1:E1';

    const backdropUrl = course.backdrop_url || `/api/artwork/courses/${course.slug}/backdrop`;
    const inList = Boolean(course.in_my_list);

    let html = `
      <div class="title-dialog-content">
        <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
          <svg class="icon"><use href="#i-close"/></svg>
        </button>

        <!-- Billboard Backdrop & Title Treatment -->
        <div class="title-billboard" style="background-image: linear-gradient(180deg, rgba(13,17,23,0.1) 0%, rgba(13,17,23,0.95) 100%), url('${escapeHtml(backdropUrl)}')">
          <div class="title-billboard-overlay">
            <span class="title-badge-eyebrow"><svg class="icon"><use href="#i-spark"/></svg> COURSEFORGE ORIGINAL MASTERCLASS</span>
            <h1 class="title-main-heading">${escapeHtml(course.title)}</h1>

            <div class="title-meta-row">
              <span class="match-score">98% Match</span>
              <span class="meta-year">2026</span>
              <span class="meta-seasons">${seasons.length} ${seasons.length === 1 ? 'Season' : 'Seasons'}</span>
              <span class="meta-badge-quality">4K Ultra HD</span>
              <span class="meta-badge-audio">Stereo</span>
              <span class="meta-category-chip">${escapeHtml(course.category)}</span>
            </div>

            <div class="title-cta-row">
              <a href="${escapeHtml(playUrl)}" class="btn btn-primary title-play-cta" id="titlePlayCta">
                <svg class="icon"><use href="#i-play"/></svg> ${playLabel}
              </a>
              <button type="button" class="btn btn-outline title-mylist-cta ${inList ? 'in-list' : ''}" id="titleMyListBtn" data-slug="${escapeHtml(course.slug)}">
                <svg class="icon"><use href="#${inList ? 'i-check' : 'i-bookmark'}"/></svg>
                <span id="titleMyListLabel">${inList ? 'In My List' : 'Add to My List'}</span>
              </button>
              <button type="button" class="btn btn-outline title-share-cta" id="titleShareBtn" data-slug="${escapeHtml(course.slug)}" title="Copy shareable link">
                <svg class="icon"><use href="#i-paperclip"/></svg> Share
              </button>
            </div>
          </div>
        </div>

        <div class="title-dialog-body">
          <!-- Overview & Synopsis -->
          <div class="title-synopsis-section">
            <div class="title-synopsis-main">
              <p class="title-synopsis-text">${escapeHtml(course.synopsis)}</p>
              ${course.progress_percent > 0 ? `
                <div class="title-progress-bar-wrap">
                  <div class="title-progress-meta">
                    <span>${course.completed_episodes} of ${course.total_episodes} episodes completed</span>
                    <strong>${course.progress_percent}%</strong>
                  </div>
                  <div class="progress-track"><span style="width: ${course.progress_percent}%"></span></div>
                </div>
              ` : ''}
            </div>
            <div class="title-credits-aside">
              <div class="credit-row"><span class="credit-label">Instructor:</span> <strong class="credit-val">${escapeHtml(course.instructor)}</strong></div>
              <div class="credit-row"><span class="credit-label">Category:</span> <span class="credit-val">${escapeHtml(course.category)}</span></div>
              <div class="credit-row"><span class="credit-label">Total Duration:</span> <span class="credit-val">${formatDuration(course.total_duration)}</span></div>
              <div class="credit-row"><span class="credit-label">Audio:</span> <span class="credit-val">English · Stereo 2.0</span></div>
            </div>
          </div>

          <!-- Navigation Tabs -->
          <div class="title-tabs-bar" role="tablist">
            <button type="button" class="title-tab ${activeTab === 'episodes' ? 'active' : ''}" data-tab="episodes" role="tab">Episodes</button>
            <button type="button" class="title-tab ${activeTab === 'related' ? 'active' : ''}" data-tab="related" role="tab">More Like This</button>
            <button type="button" class="title-tab ${activeTab === 'details' ? 'active' : ''}" data-tab="details" role="tab">Curriculum &amp; Details</button>
          </div>

          <!-- Tab Content Panes -->
          <div class="title-tab-panes">
            <div class="tab-pane ${activeTab === 'episodes' ? 'active' : ''}" id="paneEpisodes">
              ${renderEpisodesPane(seasons)}
            </div>
            <div class="tab-pane ${activeTab === 'related' ? 'active' : ''}" id="paneRelated">
              ${renderRelatedPane(related)}
            </div>
            <div class="tab-pane ${activeTab === 'details' ? 'active' : ''}" id="paneDetails">
              ${renderDetailsPane(course, seasons)}
            </div>
          </div>
        </div>
      </div>
    `;

    dialog.innerHTML = html;

    // Attach Event Handlers
    wireTitleEventHandlers(course);
  }

  function renderEpisodesPane(seasons) {
    if (!seasons.length) {
      return '<p class="muted">No episodes available yet.</p>';
    }

    const currentSeason = seasons[activeSeasonIndex] || seasons[0];

    let selectOptions = '';
    seasons.forEach((s, idx) => {
      selectOptions += `<option value="${idx}" ${idx === activeSeasonIndex ? 'selected' : ''}>Season ${s.season_number}: ${escapeHtml(s.title)} (${s.episodes_count} Episodes)</option>`;
    });

    let episodesHtml = '';
    (currentSeason.episodes || []).forEach(ep => {
      const durText = ep.duration ? Math.ceil(ep.duration / 60) + 'm' : '';
      const thumbUrl = ep.thumbnail_url || `/api/artwork/lectures/${ep.id}/thumbnail?size=md`;

      episodesHtml += `
        <div class="episode-row ${ep.is_next ? 'next-up' : ''}">
          <div class="episode-num">${ep.episode_number}</div>
          <div class="episode-thumb-wrap">
            <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(ep.title)}" loading="lazy" />
            <a href="${escapeHtml(ep.deep_link)}" class="episode-thumb-play" title="Play episode">
              <svg class="icon"><use href="#i-play"/></svg>
            </a>
            ${durText ? `<span class="episode-duration-badge">${durText}</span>` : ''}
            ${ep.progress_percent > 0 && !ep.completed ? `
              <div class="episode-thumb-progress"><span style="width: ${ep.progress_percent}%"></span></div>
            ` : ''}
          </div>
          <div class="episode-info">
            <div class="episode-header-line">
              <h4 class="episode-title">
                <a href="${escapeHtml(ep.deep_link)}">${escapeHtml(ep.title)}</a>
              </h4>
              <div class="episode-actions">
                ${ep.completed ? `<span class="episode-completed-badge" title="Completed"><svg class="icon"><use href="#i-check-circle"/></svg></span>` : ''}
                <a href="${escapeHtml(ep.deep_link)}" class="btn btn-outline btn-sm episode-direct-play">
                  <svg class="icon"><use href="#i-play"/></svg> Play
                </a>
              </div>
            </div>
            <p class="episode-synopsis">${escapeHtml(ep.synopsis || 'Comprehensive technical walk-through and architectural analysis.')}</p>
          </div>
        </div>
      `;
    });

    return `
      <div class="season-selector-bar">
        <label for="titleSeasonSelect" class="season-select-label">Select Season:</label>
        <select id="titleSeasonSelect" class="form-input season-select">
          ${selectOptions}
        </select>
      </div>
      <div class="episodes-list">
        ${episodesHtml}
      </div>
    `;
  }

  function renderRelatedPane(related) {
    if (!related.length) {
      return '<p class="muted">No related titles found.</p>';
    }

    let cardsHtml = '';
    related.slice(0, 6).forEach(rc => {
      const posterUrl = rc.poster_url || `/api/artwork/courses/${rc.slug}/poster`;
      cardsHtml += `
        <div class="related-course-card" data-course-slug="${escapeHtml(rc.slug)}">
          <div class="related-poster-wrap">
            <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(rc.title)}" loading="lazy" />
            <div class="related-play-overlay">
              <svg class="icon"><use href="#i-play"/></svg>
            </div>
          </div>
          <strong class="related-card-title">${escapeHtml(rc.title)}</strong>
        </div>
      `;
    });

    return `
      <div class="more-like-this-grid">
        ${cardsHtml}
      </div>
    `;
  }

  function renderDetailsPane(course, seasons) {
    let materialsList = [];
    seasons.forEach(s => {
      (s.materials || []).forEach(m => materialsList.push(m));
    });

    let matsHtml = '';
    if (materialsList.length) {
      materialsList.slice(0, 8).forEach(mat => {
        matsHtml += `
          <div class="detail-material-item">
            <svg class="icon"><use href="#i-file"/></svg>
            <span class="mat-name">${escapeHtml(mat.friendly_name)}</span>
            <span class="mat-badge">${escapeHtml(mat.material_type || 'File')}</span>
            <a href="${escapeHtml(mat.download_url)}" class="btn btn-outline btn-sm" download>
              <svg class="icon"><use href="#i-download"/></svg> Download
            </a>
          </div>
        `;
      });
    } else {
      matsHtml = '<p class="muted">No study materials attached to this masterclass.</p>';
    }

    return `
      <div class="title-details-content">
        <div class="detail-section">
          <h3>Curriculum Breakdown</h3>
          <p class="muted">${seasons.length} modules covering comprehensive system engineering and architecture patterns.</p>
          <ul class="curriculum-list">
            ${seasons.map(s => `<li><strong>Season ${s.season_number}: ${escapeHtml(s.title)}</strong> — ${s.episodes_count} lectures</li>`).join('')}
          </ul>
        </div>

        <div class="detail-section">
          <h3>Study Materials &amp; Architecture Documents</h3>
          <div class="materials-download-list">
            ${matsHtml}
          </div>
        </div>

        <div class="detail-section">
          <h3>Prerequisites &amp; Certification</h3>
          <p>Upon completion of all ${course.total_episodes} lectures, an official CourseForge Certificate of Completion is awarded and recorded in your learning profile.</p>
        </div>
      </div>
    `;
  }

  function wireTitleEventHandlers(course) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    // Close button
    const closeBtn = document.getElementById('titleDialogClose');
    if (closeBtn) closeBtn.onclick = closeTitleModal;

    // My List toggle
    const myListBtn = document.getElementById('titleMyListBtn');
    if (myListBtn) {
      myListBtn.onclick = async () => {
        const isCurrentlyIn = myListBtn.classList.contains('in-list');
        const csrf = window.CourseForgeAccount?.csrf || '';
        try {
          if (isCurrentlyIn) {
            const delRes = await fetch(`/api/streaming/my-list/course/${encodeURIComponent(course.slug)}`, {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            if (delRes.ok) {
              myListBtn.classList.remove('in-list');
              myListBtn.querySelector('use').setAttribute('href', '#i-bookmark');
              document.getElementById('titleMyListLabel').textContent = 'Add to My List';
              if (window.toast) window.toast('Removed from My List');
            }
          } else {
            const addRes = await fetch('/api/streaming/my-list', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf
              },
              body: JSON.stringify({
                item_type: 'course',
                item_id: course.id
              })
            });
            if (addRes.ok) {
              myListBtn.classList.add('in-list');
              myListBtn.querySelector('use').setAttribute('href', '#i-check');
              document.getElementById('titleMyListLabel').textContent = 'In My List';
              if (window.toast) window.toast('Added to My List');
            }
          }
        } catch (err) {
          if (window.toast) window.toast(err.message, true);
        }
      };
    }

    // Share button
    const shareBtn = document.getElementById('titleShareBtn');
    if (shareBtn) {
      shareBtn.onclick = () => {
        const shareUrl = `${location.origin}/#/course/${course.slug}`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareUrl).then(() => {
            if (window.toast) window.toast('Link copied to clipboard');
          }).catch(() => {
            prompt('Copy course link:', shareUrl);
          });
        } else {
          prompt('Copy course link:', shareUrl);
        }
      };
    }

    // Tab switcher
    dialog.querySelectorAll('.title-tab').forEach(tab => {
      tab.onclick = () => {
        activeTab = tab.dataset.tab;
        dialog.querySelectorAll('.title-tab').forEach(t => t.classList.toggle('active', t === tab));
        dialog.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        if (activeTab === 'episodes') {
          const p = document.getElementById('paneEpisodes');
          if (p) p.classList.add('active');
        } else if (activeTab === 'related') {
          const p = document.getElementById('paneRelated');
          if (p) p.classList.add('active');
        } else if (activeTab === 'details') {
          const p = document.getElementById('paneDetails');
          if (p) p.classList.add('active');
        }
      };
    });

    // Season switcher
    const seasonSelect = document.getElementById('titleSeasonSelect');
    if (seasonSelect) {
      seasonSelect.onchange = (e) => {
        activeSeasonIndex = parseInt(e.target.value, 10) || 0;
        const episodesPane = document.getElementById('paneEpisodes');
        if (episodesPane && currentTitleData) {
          episodesPane.innerHTML = renderEpisodesPane(currentTitleData.seasons || []);
          wireSeasonSelect();
        }
      };
    }

    // Wire clicks on related courses
    dialog.querySelectorAll('.related-course-card').forEach(card => {
      card.onclick = () => {
        const slug = card.dataset.courseSlug;
        if (slug) {
          openTitleModal(slug);
        }
      };
    });
  }

  function wireSeasonSelect() {
    const seasonSelect = document.getElementById('titleSeasonSelect');
    if (seasonSelect) {
      seasonSelect.onchange = (e) => {
        activeSeasonIndex = parseInt(e.target.value, 10) || 0;
        const episodesPane = document.getElementById('paneEpisodes');
        if (episodesPane && currentTitleData) {
          episodesPane.innerHTML = renderEpisodesPane(currentTitleData.seasons || []);
          wireSeasonSelect();
        }
      };
    }
  }

  function closeTitleModal() {
    const dialog = document.getElementById('titleDetailDialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    if (location.hash.startsWith('#/course/') || location.hash.startsWith('#course/')) {
      history.replaceState(null, '', '#/browse');
    }
  }

  function formatDuration(seconds) {
    if (!seconds) return '0m';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Export helper
  window.CourseForgeTitle = {
    initTitleExperience,
    openTitleModal,
    closeTitleModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTitleExperience);
  } else {
    initTitleExperience();
  }

})();
