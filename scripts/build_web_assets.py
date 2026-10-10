"""Build deterministic page bundles without a runtime CDN or npm dependency."""
from pathlib import Path

static = Path(__file__).resolve().parents[1] / 'app' / 'static'
groups = {
    'core.js': ['services.js', 'app.js', 'player-tracking.js', 'player-session.js',
                'player-recovery.js', 'native-player.js', 'player-studio.js',
                'loaders.js', 'academy.js', 'mobile.js'],
    'tools.js': ['learning-paths.js', 'assessments.js', 'practice.js', 'planner.js', 'weekly.js', 'focus.js'],
    'core.css': ['style.css', 'academy.css', 'player.css', 'mobile.css'],
    'tools.css': ['learning-paths.css', 'assessments.css', 'practice.css', 'planner.css', 'weekly.css', 'focus.css'],
}
for target, sources in groups.items():
    (static / target).write_text('\n'.join(f'/* {name} */\n{(static / name).read_text()}' for name in sources))
