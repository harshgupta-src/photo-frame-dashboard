// What the Home tab (js/views/control.js) shows. Edit this list to add, move or rename devices; the
// view has no per-entity logic. Entity ids come from Home Assistant (Settings → Entities).
//   rooms     tiles grouped by room, in order. An item is an entity id or { id, name }; the name
//             defaults to HA's friendly name with the room name taken off the front. Supported tile
//             domains: light (tap toggles, drag sideways or hold for brightness), fan (tap toggles,
//             drag for speed, hold for presets), switch and media_player (tap toggles power).
//             Entities missing from HA are left out; unavailable ones show dimmed as "Offline".
//   climate   the thermostat card
//   media     now-playing card: the first of these that is playing (else paused, else the first)
//   people    who's home, from person.* (home = in zone.home, even when inside a smaller zone)
//   tempUnit  'C' or 'F' for the thermostat and inside temperature (the rest of the dashboard is °C)
// Any new domain here must also be streamed (js/hastate.js WATCH_DOMAINS) and callable through the
// kiosk bridge (kiosk MainActivity HA_POST / js/haweb.js).
export var HOME = {
  tempUnit: 'C',
  rooms: [
    { name: 'Living Room', items: [
      { id: 'light.living_room_table_lamp', name: 'Table Lamp' },
      { id: 'light.living_room_pot_lights', name: 'Pot Lights' },
      { id: 'light.tv_backlight', name: 'TV Backlight' },
      { id: 'media_player.living_room_samsung_living_room_tv', name: 'TV' },
    ] },
    { name: 'Kitchen', items: [{ id: 'light.kitchen_pot_lights', name: 'Pot Lights' }] },
    { name: 'Dining', items: [{ id: 'light.dining_room_lamp', name: 'Lamp' }] },
    { name: 'Office', items: [{ id: 'light.uplighter', name: 'Uplighter' }] },
    { name: 'Bedroom', items: [{ id: 'fan.bedroom_fan', name: 'Fan' }] },
    { name: 'Guest Room', items: [
      { id: 'light.guest_bedroom_floor_lamp', name: 'Floor Lamp' },
      { id: 'light.guest_bedroom_table_lamp', name: 'Table Lamp' },
    ] },
    { name: 'Outside', items: [{ id: 'light.tree_spotlights', name: 'Tree Spots' }] },
  ],
  climate: { id: 'climate.living_room_living_room', name: 'Thermostat' },
  media: [
    { id: 'media_player.living_room_living_room', name: 'Sonos Arc' },
    { id: 'media_player.spotify_harsh', name: 'Spotify' },
  ],
  people: [
    { id: 'person.harsh_gupta', name: 'Harsh' },
    { id: 'person.ambuja_banerjee', name: 'Ambuja' },
  ],
};
