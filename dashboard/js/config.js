// Household settings. The defaults are a generic demo; put your own in .env.local (gitignored,
// and the DASHBOARD_ENV secret for the GitHub deploy). See .env.example.
(function () {
  'use strict';
  var env = import.meta.env;
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return (n >> 16) + ' ' + (n >> 8 & 255) + ' ' + (n & 255); }
  // VITE_PEOPLE: "id:Name:#RRGGBB,..." (quoted in .env files); ids match the Worker's CALENDARS secret.
  // The colour is optional and its # may be left out.
  var palette = ['#2D5BFF', '#E4007C', '#00A86B', '#FF8A00'];
  var people = (env.VITE_PEOPLE || 'alex:Alex:#2D5BFF,jordan:Jordan:#E4007C').split(',').filter(function (p) {
    return p.trim();
  }).map(function (p, i) {
    var f = p.trim().split(':'), hex = (f[2] || '').replace(/^#?/, '#');
    if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = palette[i % palette.length];
    return { id: f[0], name: f[1] || f[0], color: hex, rgb: hexRgb(hex), ink: '#FFFFFF', home: true, status: 'Home' };
  });
  window.CONFIG = {
    lat: num(env.VITE_HOME_LAT, 43.6532), // weather and sunset/sunrise; default Toronto
    lon: num(env.VITE_HOME_LON, -79.3832),
    people: people,
    dog: env.VITE_DOG_NAME || 'Rex', // the "<dog>'s walk" jacket tile
    pinnedList: env.VITE_PINNED_LIST || 'To-do', // Reminders list shown on the Today screen
  };
})();
