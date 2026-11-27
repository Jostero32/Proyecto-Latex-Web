// Se carga antes de pintar y sin JavaScript inline, para poder restringir script-src.
try {
  var tema = localStorage.getItem('pliego.tema');
  var oscuro = tema === 'oscuro' || (tema !== 'claro' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = oscuro ? 'dark' : 'light';
} catch { /* Sin localStorage se usa el tema por defecto. */ }
