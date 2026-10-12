/**
 * CourseForge Streaming Experience — Stage 2: Chrome & Cinematic Home
 *
 * Implements:
 * 1. Sticky Header scroll darkening and avatar menu.
 * 2. 6-second auto-rotating Billboard Hero Slider with pause on hover/focus.
 * 3. Netflix-style horizontal rows with smooth scroll, desktop chevrons, mobile snap.
 * 4. Cards: Continue Watching (16:9 + progress), Top 10 (SVG numerals + 2:3),
 *    Featured Masterclasses (2:3), New Episodes (16:9 + NEW chip), Category rows.
 */
(function() {
  'use strict';

  let heroSlides = [];
  let currentSlide = 0;
  let heroTimer = null;
  let isPaused = false;
  let savedMyList = new Set();

  // Scroll listener for sticky header glassmorphism
  window.addEventListener('scroll', function() {
    const isScrolled = window.scrollY > 15;
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.classList.toggle('scrolled', isScrolled);
    const academyHeader = document.querySelector('.academy-header');
    if (academyHeader) academyHeader.classList.toggle('scrolled', isScrolled);
  }, { passive: true });

  // Load My List items for visual bookmark state
  async function loadMyListIds() {
    try {
      const res = await fetch('/api/streaming/my-list');
      if (res.ok) {
        const data = await res.json();
        savedMyList = new Set((data.items || []).map(i => i.item_id));
      }
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // Hero Billboard Slider
  // --------------------------------------------------------------------------
  function initStreamingBillboard(heroData) {
    const heroEl = document.getElementById('streamingHero');
    if (!heroEl || !heroData || !heroData.length) return;

    heroSlides = heroData;
    currentSlide = 0;

    renderDots();
    showSlide(currentSlide);
    startTimer();

    // Event listeners
    heroEl.addEventListener('mouseenter', pauseTimer);
    heroEl.addEventListener('mouseleave', resumeTimer);
    heroEl.addEventListener('focusin', pauseTimer);
    heroEl.addEventListener('focusout', resumeTimer);

    const prevBtn = document.getElementById('heroPrevBtn');
    const nextBtn = document.getElementById('heroNextBtn');
    if (prevBtn) prevBtn.onclick = () => { prevSlide(); resetTimer(); };
    if (nextBtn) nextBtn.onclick = () => { nextSlide(); resetTimer(); };

    heroEl.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowLeft') { prevSlide(); resetTimer(); }
      else if (e.key === 'ArrowRight') { nextSlide(); resetTimer(); }
    });

    // Wire More Info button
    const infoBtn = document.getElementById('heroInfoBtn');
    if (infoBtn) {
      infoBtn.onclick = () => {
        const slide = heroSlides[currentSlide];
        if (slide?.slug) {
          location.hash = `#/course/${slide.slug}`;
        }
      };
    }

    // Wire My List button
    const listBtn = document.getElementById('heroListBtn');
    if (listBtn) {
      listBtn.onclick = async () => {
        const slide = heroSlides[currentSlide];
        if (!slide?.slug) return;
        const inList = savedMyList.has(slide.slug);
        try {
          const csrf = window.CourseForgeAccount?.csrf || '';
          if (inList) {
            await fetch(`/api/streaming/my-list/course/${slide.slug}`, {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            savedMyList.delete(slide.slug);
          } else {
            await fetch('/api/streaming/my-list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
              body: JSON.stringify({ item_type: 'course', item_id: slide.slug })
            });
            savedMyList.add(slide.slug);
          }
          updateHeroListBtn();
          if (window.toast) {
            window.toast(inList ? 'Removed from My List' : 'Added to My List');
          }
        } catch (_) {}
      };
    }
  }

  function showSlide(index) {
    if (!heroSlides.length) return;
    currentSlide = (index + heroSlides.length) % heroSlides.length;
    const slide = heroSlides[currentSlide];

    const backdrop = document.getElementById('heroBackdrop');
    if (backdrop) {
      backdrop.style.opacity = '0';
      setTimeout(() => {
        backdrop.style.backgroundImage = `url("${slide.backdrop_url}")`;
        backdrop.style.opacity = '1';
      }, 150);
    }

    const badgeText = document.getElementById('heroBadgeText');
    if (badgeText) badgeText.textContent = slide.category ? `${slide.category} Masterclass` : 'Featured Series';

    const titleEl = document.getElementById('heroTitle');
    if (titleEl) titleEl.textContent = slide.title || '';

    const catEl = document.getElementById('heroCategory');
    if (catEl) catEl.textContent = slide.category || 'Engineering';

    const epsEl = document.getElementById('heroEpisodes');
    if (epsEl) epsEl.textContent = `${slide.lesson_count || 10} Episodes`;

    const durEl = document.getElementById('heroDuration');
    if (durEl) durEl.textContent = slide.duration ? formatDuration(slide.duration) : 'Full Series';

    const synEl = document.getElementById('heroSynopsis');
    if (synEl) synEl.textContent = slide.synopsis || 'Explore in-depth production workflows, structured modules, and verifiable engineering practices.';

    // Update play button text while keeping existing resume momentum
    const playBtn = document.getElementById('heroLearnBtn');
    if (playBtn) {
      const activeVideo = window.CourseForgeHabit?.activeLesson;
      if (!playBtn.dataset.originalBound) {
        playBtn.dataset.originalBound = 'true';
        playBtn.onclick = () => {
          window.CourseForgeServices?.trackStreamingEvent('row_click', 'billboard_hero', { item_id: slide.slug || slide.first_video_id });
          if (slide.first_video_id) {
            location.hash = `#/lecture/${slide.first_video_id}`;
          } else if (slide.slug) {
            location.hash = `#/course/${slide.slug}`;
          }
        };
      }
    }

    updateHeroListBtn();
    updateActiveDot();
  }

  function updateHeroListBtn() {
    const listBtn = document.getElementById('heroListBtn');
    if (!listBtn || !heroSlides[currentSlide]) return;
    const inList = savedMyList.has(heroSlides[currentSlide].slug);
    listBtn.innerHTML = inList
      ? `<svg class="icon"><use href="#i-check"/></svg> In My List`
      : `<svg class="icon"><use href="#i-bookmark"/></svg> My List`;
  }

  function renderDots() {
    const dotsContainer = document.getElementById('heroDots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';
    heroSlides.forEach((slide, idx) => {
      const dot = document.createElement('button');
      dot.className = `billboard-dot ${idx === currentSlide ? 'active' : ''}`;
      dot.setAttribute('aria-label', `Go to slide ${idx + 1}: ${slide.title}`);
      dot.onclick = () => {
        showSlide(idx);
        resetTimer();
      };
      dotsContainer.appendChild(dot);
    });
  }

  function updateActiveDot() {
    const dots = document.querySelectorAll('.billboard-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === currentSlide);
    });
  }

  function nextSlide() {
    showSlide(currentSlide + 1);
  }

  function prevSlide() {
    showSlide(currentSlide - 1);
  }

  function startTimer() {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      if (!isPaused) nextSlide();
    }, 6000);
  }

  function resetTimer() {
    startTimer();
  }

  function pauseTimer() {
    isPaused = true;
  }

  function resumeTimer() {
    isPaused = false;
  }

  // --------------------------------------------------------------------------
  // Netflix-Style Horizontal Rows
  // --------------------------------------------------------------------------
  function renderStreamingRows(rows) {
    const container = document.getElementById('streamingCarousels');
    if (!container || !rows) return;
    container.innerHTML = '';

    rows.forEach(row => {
      if (!row.items || !row.items.length) return;

      const rowSec = document.createElement('section');
      rowSec.className = 'streaming-row';
      rowSec.dataset.rowId = row.id;

      // Header
      const header = document.createElement('div');
      header.className = 'row-header';
      header.innerHTML = `
        <h2 class="row-title">${escapeHtml(row.title)}</h2>
        <a class="row-explore" href="#library">Explore all <svg class="icon"><use href="#i-arrow"/></svg></a>
      `;
      rowSec.appendChild(header);

      // Slider wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'row-slider-wrapper';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'row-nav-btn row-nav-prev';
      prevBtn.setAttribute('aria-label', `Previous ${row.title}`);
      prevBtn.innerHTML = `<svg class="icon"><use href="#i-chevron"/></svg>`;

      const track = document.createElement('div');
      track.className = 'row-track';
      track.tabIndex = 0;

      const nextBtn = document.createElement('button');
      nextBtn.className = 'row-nav-btn row-nav-next';
      nextBtn.setAttribute('aria-label', `Next ${row.title}`);
      nextBtn.innerHTML = `<svg class="icon"><use href="#i-chevron"/></svg>`;

      prevBtn.onclick = () => track.scrollBy({ left: -track.clientWidth * 0.75, behavior: 'smooth' });
      nextBtn.onclick = () => track.scrollBy({ left: track.clientWidth * 0.75, behavior: 'smooth' });

      // Render items according to row style
      row.items.forEach((item, index) => {
        let card;
        const kind = (row.kind || row.id || '').replace(/-/g, '_');
        if (kind === 'continue_watching' || kind === 'lecture_card') {
          card = buildContinueCard(item);
        } else if (kind === 'trending_top_10' || kind === 'rank_card') {
          card = buildTop10Card(item, index + 1);
        } else if (kind === 'new_episodes' || kind === 'episode_card') {
          card = buildNewEpisodeCard(item);
        } else {
          card = buildPosterCard(item);
        }
        card.addEventListener('click', () => {
          window.CourseForgeServices?.trackStreamingEvent('row_click', row.title || row.id, { item_id: item.id || item.slug, position: index + 1 });
        });
        track.appendChild(card);
      });

      wrapper.appendChild(prevBtn);
      wrapper.appendChild(track);
      wrapper.appendChild(nextBtn);
      rowSec.appendChild(wrapper);

      container.appendChild(rowSec);
    });
  }

  // 1. Continue Watching Card (16:9)
  function buildContinueCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-continue';
    card.href = item.deep_link || `#/lecture/${item.id}`;

    const percent = Math.min(100, Math.round(((item.position || 0) / (item.duration || 1)) * 100));
    const remainingSec = Math.max(0, (item.duration || 0) - (item.position || 0));
    const remainingMins = Math.ceil(remainingSec / 60);

    card.innerHTML = `
      <div class="card-thumb-wrap">
        <img src="${escapeHtml(item.thumbnail_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
        <div class="card-play-overlay">
          <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
        </div>
        <div class="card-progress-bar-wrap">
          <div class="card-progress-fill" style="width: ${percent}%;"></div>
        </div>
      </div>
      <div class="card-info">
        <span class="card-series-title">${escapeHtml(item.course || '')}</span>
        <strong class="card-episode-title">${escapeHtml(item.title)}</strong>
        <span class="card-time-remaining">${remainingMins}m remaining</span>
      </div>
    `;
    return card;
  }

  // 2. Top 10 Card (Big Numeral + 2:3 Poster)
  function buildTop10Card(item, rank) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-top10';
    card.href = item.deep_link || `#/course/${item.slug || item.course_slug}`;

    const posterUrl = item.poster_url || (item.course_slug ? `/api/artwork/courses/${item.course_slug}/poster` : '') || item.thumbnail_url || '';
    const fallbackUrl = item.thumbnail_url || (item.course_slug ? `/api/artwork/courses/${item.course_slug}/backdrop` : '') || '';

    card.innerHTML = `
      <div class="top10-rank-wrap">
        <svg class="top10-num-svg" viewBox="0 0 70 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <text x="35" y="105" text-anchor="middle" font-size="96" font-weight="900">${rank}</text>
        </svg>
      </div>
      <div class="top10-poster-wrap">
        <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" ${fallbackUrl ? `onerror="this.onerror=null;this.src='${escapeHtml(fallbackUrl)}';"` : ''} />
      </div>
    `;
    return card;
  }

  // 3. Featured / Masterclass Poster Card (2:3)
  function buildPosterCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-poster';
    card.href = item.deep_link || `#/course/${item.slug}`;

    const posterUrl = item.poster_url || `/api/artwork/courses/${item.slug}/poster`;
    const fallbackUrl = item.backdrop_url || `/api/artwork/courses/${item.slug}/backdrop`;

    card.innerHTML = `
      <div class="poster-image-wrap">
        <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.onerror=null;this.src='${escapeHtml(fallbackUrl)}';" />
        <span class="poster-badge">${escapeHtml(item.category || 'Masterclass')}</span>
      </div>
      <div class="poster-info">
        <strong class="poster-title">${escapeHtml(item.title)}</strong>
        <span class="poster-sub">${item.lesson_count || 12} Episodes</span>
      </div>
    `;
    return card;
  }

  // 4. New Episodes Card (16:9 Backdrop + NEW Chip)
  function buildNewEpisodeCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-backdrop';
    card.href = item.deep_link || `#/lecture/${item.id}`;

    card.innerHTML = `
      <div class="backdrop-image-wrap">
        <img src="${escapeHtml(item.backdrop_url || item.thumbnail_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
        <span class="new-chip">NEW</span>
      </div>
      <div class="backdrop-info">
        <span class="backdrop-series">${escapeHtml(item.course || '')}</span>
        <strong class="backdrop-title">${escapeHtml(item.title)}</strong>
      </div>
    `;
    return card;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(sec) {
    const s = Number(sec) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Export module globally
  window.CourseForgeStreaming = {
    initStreamingBillboard,
    renderStreamingRows,
    loadMyListIds
  };

  // Auto-fetch streaming feed when dashboard is active
  async function loadStreamingHome() {
    try {
      await loadMyListIds();
      const res = await fetch('/api/streaming/home-feed');
      if (res.ok) {
        const feed = await res.json();
        if (feed.hero && feed.hero.length) {
          initStreamingBillboard(feed.hero);
        }
        if (feed.rows && feed.rows.length) {
          renderStreamingRows(feed.rows);
        }
      }
    } catch (_) {}
  }

  // Trigger on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadStreamingHome);
  } else {
    loadStreamingHome();
  }


  // Avatar Profile Dropdown Interaction
  function initAvatarDropdown() {
    const avatarBtn = document.getElementById('avatarBtn');
    const popover = document.getElementById('avatarPopover');
    if (!avatarBtn || !popover) return;

    function toggleAvatar(open) {
      const show = open ?? popover.hidden;
      popover.hidden = !show;
      avatarBtn.setAttribute('aria-expanded', String(show));
      if (show) {
        const first = popover.querySelector('.avatar-menu-item');
        if (first) first.focus();
      }
    }

    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAvatar();
    });

    avatarBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAvatar();
      }
    });

    document.addEventListener('click', (e) => {
      if (!popover.hidden && !popover.contains(e.target) && e.target !== avatarBtn) {
        toggleAvatar(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.hidden) {
        toggleAvatar(false);
        avatarBtn.focus();
      }
    });

    const acctBtn = document.getElementById('avatarAccountBtn');
    if (acctBtn) acctBtn.addEventListener('click', () => { toggleAvatar(false); window.CourseForgeAcademy?.myAccount(); });

    const adminBtn = document.getElementById('avatarAdminBtn');
    if (adminBtn) adminBtn.addEventListener('click', () => { toggleAvatar(false); window.CourseForgeAcademy?.adminCourses(); });

    const catBtn = document.getElementById('avatarCatalogBtn');
    if (catBtn) catBtn.addEventListener('click', () => { toggleAvatar(false); window.CourseForgeAcademy?.catalog(); });

    const logoutBtn = document.getElementById('avatarLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
      toggleAvatar(false);
      const lNav = document.getElementById('logoutNav');
      if (lNav) lNav.click();
      else fetch('/api/auth/logout', {method:'POST'}).then(() => location.reload());
    });
  }

  // Initialize on load and ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAvatarDropdown);
  } else {
    initAvatarDropdown();
  }
  window.addEventListener('courseforge-ready', initAvatarDropdown);

})();
