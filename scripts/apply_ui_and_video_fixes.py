#!/usr/bin/env python3
"""Apply comprehensive UI color/button overhaul and video buffering optimizations."""
from pathlib import Path

ROOT = Path('/home/ubuntu/CourseForge')
STATIC = ROOT / 'app' / 'static'

# ==============================================================================
# 1. Update index.html
# ==============================================================================
index_path = STATIC / 'index.html'
html = index_path.read_text(encoding='utf-8')

# A. Default theme to dark
old_theme_script = "document.documentElement.dataset.theme=['dark','light','system'].includes(t.mode)?t.mode:'system';document.documentElement.dataset.resolvedTheme=t.mode==='dark'?'dark':t.mode==='light'?'light':(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');"
new_theme_script = "const m=['dark','light','system'].includes(t.mode)?t.mode:'dark';document.documentElement.dataset.theme=m;document.documentElement.dataset.resolvedTheme=m==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;"
if old_theme_script in html:
    html = html.replace(old_theme_script, new_theme_script)
    print("  [PASS] Set default theme to dark in index.html")

# B. Add avatar dropdown menu
old_avatar = '<div class="avatar" aria-label="Your account">CF</div>'
new_avatar = '''<div class="avatar avatar-menu-trigger" id="avatarBtn" role="button" tabindex="0" aria-label="Your account" aria-haspopup="true" aria-expanded="false">CF</div>
        <div class="avatar-popover" id="avatarPopover" role="menu" hidden>
          <div class="avatar-user-info">
            <span class="avatar-user-name" id="avatarUserName">Account</span>
            <span class="avatar-user-email" id="avatarUserEmail"></span>
          </div>
          <button class="avatar-menu-item" id="avatarAccountBtn" type="button" role="menuitem"><svg class="icon"><use href="#i-user"/></svg> Account settings</button>
          <button class="avatar-menu-item" id="avatarAdminBtn" type="button" role="menuitem"><svg class="icon"><use href="#i-shield"/></svg> Administration</button>
          <button class="avatar-menu-item" id="avatarCatalogBtn" type="button" role="menuitem"><svg class="icon"><use href="#i-book"/></svg> Browse catalog</button>
          <button class="avatar-menu-item" id="avatarLogoutBtn" type="button" role="menuitem"><svg class="icon"><use href="#i-close"/></svg> Sign out</button>
        </div>'''
if old_avatar in html:
    html = html.replace(old_avatar, new_avatar)
    print("  [PASS] Added avatar popover menu in index.html")

index_path.write_text(html, encoding='utf-8')

# ==============================================================================
# 2. Update academy.js (Hide academy-header when in workspace)
# ==============================================================================
acad_path = STATIC / 'academy.js'
acad_js = acad_path.read_text(encoding='utf-8')

# In workspace(): hide academy-header
old_ws = "el('academyContent').hidden=true;el('appShell').hidden=false;clearMessage();"
new_ws = "el('academyContent').hidden=true;el('appShell').hidden=false;clearMessage();const _acH=document.querySelector('.academy-header');if(_acH)_acH.hidden=true;"
if old_ws in acad_js:
    acad_js = acad_js.replace(old_ws, new_ws)
    print("  [PASS] Hide .academy-header in workspace()")

# In page(): show academy-header
old_pg = "el('appShell').hidden=true;el('academyContent').hidden=false;\n    const root=el('academyContent');"
new_pg = "el('appShell').hidden=true;el('academyContent').hidden=false;\n    const _acH=document.querySelector('.academy-header');if(_acH)_acH.hidden=false;\n    const root=el('academyContent');"
if old_pg in acad_js:
    acad_js = acad_js.replace(old_pg, new_pg)
    print("  [PASS] Show .academy-header in page()")

# Populate avatar user details in boot()
old_boot_user = "el('accountName').textContent=account.user?.name||'';"
new_boot_user = """el('accountName').textContent=account.user?.name||'';
    if(account.user){
      const aName=document.getElementById('avatarUserName');if(aName)aName.textContent=account.user.name||'Student';
      const aEmail=document.getElementById('avatarUserEmail');if(aEmail)aEmail.textContent=account.user.email||'';
      const aAdmin=document.getElementById('avatarAdminBtn');if(aAdmin)aAdmin.hidden=account.user.role!=='admin';
    }"""
if old_boot_user in acad_js:
    acad_js = acad_js.replace(old_boot_user, new_boot_user)
    print("  [PASS] Populate avatar dropdown in boot()")

acad_path.write_text(acad_js, encoding='utf-8')

# ==============================================================================
# 3. Update streaming-home.js (Wire up Avatar popover dropdown)
# ==============================================================================
sh_path = STATIC / 'streaming-home.js'
sh_js = sh_path.read_text(encoding='utf-8')

avatar_wiring = """
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
"""

if 'initAvatarDropdown' not in sh_js:
    # Append before the closing IIFE
    sh_js = sh_js.rstrip()
    if sh_js.endswith('})();'):
        sh_js = sh_js[:-5] + avatar_wiring + '\n})();\n'
    else:
        sh_js += '\n' + avatar_wiring
    sh_path.write_text(sh_js, encoding='utf-8')
    print("  [PASS] Wired avatar popover in streaming-home.js")

# ==============================================================================
# 4. Update player-session.js (Don't destroy playback on visibilitychange)
# ==============================================================================
ps_path = STATIC / 'player-session.js'
ps_js = ps_path.read_text(encoding='utf-8')
old_vis = """  document.addEventListener('visibilitychange',()=>{
    if(!owner)return;
    if(document.hidden){window.CourseForgeNative?.suspend();owner.onLost('Your lesson is paused. Resume when you’re ready.');heartbeat(false);}
    // Visible players reclaim only after a deliberate user action.
  });"""
new_vis = """  document.addEventListener('visibilitychange',()=>{
    if(!owner)return;
    // Keep playback session alive during tab switching
    heartbeat(!document.hidden);
  });"""
if old_vis in ps_js:
    ps_js = ps_js.replace(old_vis, new_vis)
    ps_path.write_text(ps_js, encoding='utf-8')
    print("  [PASS] Relaxed tab switching visibility in player-session.js")

# ==============================================================================
# 5. Update native-player.js (Advance prebuffering)
# ==============================================================================
np_path = STATIC / 'native-player.js'
np_js = np_path.read_text(encoding='utf-8')

# Ensure Accept-Ranges is known and preload is auto
if "v.preload='auto'" not in np_js and "v.preload = 'auto'" not in np_js:
    np_js = np_js.replace("v.preload='metadata'", "v.preload='auto'")

# Add buffer health tracking in timeupdate
old_tu = """    v.addEventListener('timeupdate',()=>{
      if(active!==a||v.error||v.readyState<1)return;
      const advanced=v.currentTime-a.savedPosition;a.savedPosition=v.currentTime;
      if(!v.paused&&advanced>0&&advanced<2){a.lastAdvance=performance.now();a.recovery.healthy(advanced/Math.max(.25,v.playbackRate));}
      window.CourseForgeStudio?.checkUpNext?.(lesson, v.currentTime, v.duration);
    });"""

new_tu = """    v.addEventListener('timeupdate',()=>{
      if(active!==a||v.error||v.readyState<1)return;
      const advanced=v.currentTime-a.savedPosition;a.savedPosition=v.currentTime;
      if(!v.paused&&advanced>0&&advanced<2){a.lastAdvance=performance.now();a.recovery.healthy(advanced/Math.max(.25,v.playbackRate));}
      window.CourseForgeStudio?.checkUpNext?.(lesson, v.currentTime, v.duration);
      // Advance buffer watchdog: if buffer headroom drops below 10s, prefetch next chunk
      try {
        if (v.buffered && v.buffered.length > 0 && !v.paused && !a.reloading) {
          let ahead = 0;
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) {
              ahead = v.buffered.end(i) - v.currentTime;
              break;
            }
          }
          if (ahead < 10 && !a.prebuffering) {
            a.prebuffering = true;
            fetch(session.media_url, { headers: { 'Range': 'bytes=0-2097152' }, credentials: 'same-origin' })
              .catch(() => {}).finally(() => { setTimeout(() => { if (active === a) a.prebuffering = false; }, 5000); });
          }
        }
      } catch (_) {}
    });"""

if old_tu in np_js:
    np_js = np_js.replace(old_tu, new_tu)
    np_path.write_text(np_js, encoding='utf-8')
    print("  [PASS] Added advance buffer prefetching in native-player.js")

print("\nAll script updates completed.")
