// Household settings. The defaults are a generic demo; put your own in .env.local (gitignored,
// and the DASHBOARD_ENV secret for the GitHub deploy). See .env.example.
(function () {
  'use strict';
  var env = import.meta.env;
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return (n >> 16) + ' ' + (n >> 8 & 255) + ' ' + (n & 255); }
  // VITE_PEOPLE: "id:Name:#RRGGBB,..."; ids match the Worker's CALENDARS secret.
  var people = (env.VITE_PEOPLE || 'alex:Alex:#2D5BFF,jordan:Jordan:#E4007C').split(',').map(function (p) {
    var f = p.trim().split(':');
    return { id: f[0], name: f[1] || f[0], color: f[2] || '#2D5BFF', rgb: hexRgb(f[2] || '#2D5BFF'), ink: '#FFFFFF', home: true, status: 'Home' };
  });
  window.CONFIG = {
    lat: num(env.VITE_HOME_LAT, 43.6532), // weather and sunset/sunrise; default Toronto
    lon: num(env.VITE_HOME_LON, -79.3832),
    people: people,
    dog: env.VITE_DOG_NAME || 'Rex', // the "<dog>'s walk" jacket tile
    pinnedList: env.VITE_PINNED_LIST || 'To-do', // Reminders list shown on the Today screen
  };
})();
