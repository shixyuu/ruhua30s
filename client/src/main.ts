import './style.css';

// block double-tap zoom / pinch zoom / long-press menu
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const now = Date.now();
    if (now - lastTouchEnd < 300) e.preventDefault();
    lastTouchEnd = now;
  },
  { passive: false },
);
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());
// pull-to-refresh guard: block touchmove on non-scrollable pages
document.addEventListener(
  'touchmove',
  (e) => {
    if (!document.body.classList.contains('scrollable') && !(e.target as HTMLElement)?.closest?.('.setup')) e.preventDefault();
  },
  { passive: false },
);

const route = location.pathname.replace(/\/+$/, '') || '/';
const app = document.getElementById('app')!;

async function boot(): Promise<void> {
  switch (route) {
    case '/main':
      return (await import('./pages/main')).default(app);
    case '/door':
      return (await import('./pages/door')).default(app);
    case '/station1':
      return (await import('./pages/station1')).default(app);
    case '/station2':
      return (await import('./pages/station2')).default(app);
    case '/admin':
      return (await import('./pages/admin')).default(app);
    case '/upload':
      return (await import('./pages/upload')).default(app);
    default:
      return (await import('./pages/home')).default(app);
  }
}
boot();
