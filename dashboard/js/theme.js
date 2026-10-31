// Light / dark theme. "Auto" follows the frame's ambient light sensor, leaning dark: dark after
// 1 min below DARK_LUX, light again only after 3 min above LIGHT_LUX, and dark when it starts in
// between. The Home HQ kiosk sends readings as window.frameLux(lux) every few seconds.
// Without the sensor (a browser, or no reading for a minute) Auto falls back to the sun: dark
// from 30 min before sunset until 30 min after sunrise.
// Sunrise and sunset are computed on the device (no network). Everything is done on absolute
// timestamps; only "which calendar day is it" comes from the local clock. A DST change therefore
// only moves the times shown, never the moment the theme switches.
(function () {
  'use strict';
  var App = window.App;
  var LAT = window.CONFIG.lat, LON = window.CONFIG.lon; // same place as the weather
  var MARGIN = 30 * 60000;
  var KEY = 'theme-v1';

  // Sunrise/sunset (NOAA-style approximation, as used by SunCalc; ±1-2 min).
  var rad = Math.PI / 180, DAY = 864e5, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009, OBL = rad * 23.4397;
  function sunTimes(date) {
    // Local noon always exists (DST changes happen at night) and picks the right solar day.
    var noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    var lw = rad * -LON, phi = rad * LAT;
    var d = +noon / DAY - 0.5 + J1970 - J2000;
    var n = Math.round(d - J0 - lw / (2 * Math.PI));
    var ds = J0 + lw / (2 * Math.PI) + n;
    var M = rad * (357.5291 + 0.98560028 * ds);
    var L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    var dec = Math.asin(Math.sin(OBL) * Math.sin(L));
    var transit = function (a) { return J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L); };
    var w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    var jNoon = transit(ds), jSet = transit(J0 + (w + lw) / (2 * Math.PI) + n), jRise = jNoon - (jSet - jNoon);
    var ms = function (j) { return new Date((j + 0.5 - J1970) * DAY); };
    return { rise: ms(jRise), set: ms(jSet) };
  }
  App.sunTimes = sunTimes;

  // Dark from (sunset - 30 min) today until (sunrise + 30 min) the next morning.
  App.themeWindow = function (now) {
    var s = sunTimes(now);
    return { darkFrom: new Date(+s.set - MARGIN), lightFrom: new Date(+s.rise + MARGIN) };
  };
  App.sunTheme = function (now) {
    var w = App.themeWindow(now);
    return now < w.lightFrom || now >= w.darkFrom ? 'dark' : 'light';
  };

  // Room light. Real time throughout (not the demo clock): this is about the sensor's freshness.
  // The sensor sits behind the bezel and reads low: about 43 lux on a sunny October afternoon.
  var DARK_LUX = 25, LIGHT_LUX = 40, TO_DARK = 60000, TO_LIGHT = 180000, STALE = 60000;
  var room = { lux: null, at: 0, theme: null, pendingSince: 0 };
  App.room = room;
  App.roomThresholds = { dark: DARK_LUX, light: LIGHT_LUX };
  function sensorLive() { return room.theme !== null && Date.now() - room.at < STALE; }
  App.themeSource = function () { return sensorLive() ? 'sensor' : 'sun'; };
  window.frameLux = function (v) {
    v = +v;
    if (!isFinite(v) || v < 0) return;
    var t = Date.now(), wasLive = sensorLive();
    room.lux = v;
    room.at = t;
    if (room.theme === null) {
      room.theme = v >= LIGHT_LUX ? 'light' : 'dark';
    } else {
      var flip = room.theme === 'light' ? v < DARK_LUX : v > LIGHT_LUX;
      if (!flip) room.pendingSince = 0;
      else if (!room.pendingSince) room.pendingSince = t;
      else if (t - room.pendingSince >= (room.theme === 'light' ? TO_DARK : TO_LIGHT)) {
        room.theme = room.theme === 'light' ? 'dark' : 'light';
        room.pendingSince = 0;
      }
    }
    if (!wasLive || App.theme !== App.autoTheme(App.now())) apply();
  };

  App.autoTheme = function (now) { return sensorLive() ? room.theme : App.sunTheme(now); };

  var pref = 'auto';
  try { pref = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* storage disabled */ }
  App.themePref = function () { return pref; };
  App.theme = null;

  function apply() {
    var t = pref === 'auto' ? App.autoTheme(App.now()) : pref;
    if (t === App.theme) return;
    var first = App.theme === null;
    App.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#161513' : '#F2EEE6');
    // Views bake person colours (App.pstyle) into their HTML, so rebuild them.
    if (!first && App.current) { App.emit('data'); App.rerender(); }
  }
  App.setThemePref = function (p) {
    pref = p;
    try { localStorage.setItem(KEY, p); } catch (e) { /* storage disabled */ }
    apply();
  };

  apply();
  App.on('minute', apply);
  App.on('time', apply); // demo clock
})();
