/* Apply the saved theme before first paint to avoid a flash. */
(() => {
  try {
    const saved = localStorage.getItem("taskly:theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  } catch (_) {
    /* storage unavailable */
  }
})();
