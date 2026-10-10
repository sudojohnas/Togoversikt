(() => {
  const storageKey = 'togoversikt-theme';
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch {}
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const theme = stored === 'dark' || stored === 'light' ? stored : systemDark ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme === 'dark' ? '#071421' : '#f4f6f8');
})();
