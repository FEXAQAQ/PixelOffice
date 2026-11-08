/* Role registry: everything that makes the PM / BOSS who they are lives here.
   Shared by the browser (window.OfficeRoles), office-engine and the server config store. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeRoles = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // MetroCity sheets: 6 skin rows, 8 hair rows. Outfit1–4 are single garments,
  // so only 5 and 6 are complete dressed characters.
  const SKINS = 6, HAIRS = 8, OUTFITS = [5, 6];
  // Drawn on top of the sprite by office-sprites.js; a look may wear several at once.
  const ACCESSORIES = {tie: '領帶', glasses: '眼鏡', headphones: '耳機'};
  // '' keeps the sheet's own colour; the rest recolour the hair while keeping its shading.
  const HAIR_COLORS = {
    '': {label: '原色', color: ''},
    black: {label: '黑', color: '#3a3336'}, brown: {label: '棕', color: '#7b4a2b'},
    blonde: {label: '金', color: '#e2c16b'}, red: {label: '紅', color: '#c2472f'},
    silver: {label: '銀', color: '#c9cbd4'}, blue: {label: '藍', color: '#4b7bd0'},
    pink: {label: '粉', color: '#e98bb4'}, green: {label: '綠', color: '#5aa56d'},
  };
  const NAME_MAX = 12;

  // fallbackSeat: where the role sits without its desk; null means the role leaves with the desk.
  // aisle: the cell beside this role's seat is the office hub every engineer must be able to reach.
  // action: what clicking the role asks the dashboard to open; clickDesk extends that to its desk.
  // chair: chair sprite drawn behind the seat. labelColor: name-card text colour ('' = default).
  const ROLES = {
    pm:   {id: 'pm',   name: 'PM',   deskType: 'pmdesk',   look: {skin: 0, hair: 0, outfit: 5, hairColor: '', accessories: []},
           fallbackSeat: {x: 3, y: 3}, aisle: true,
           action: 'claim', clickDesk: false, chair: 'office', labelColor: ''},
    boss: {id: 'boss', name: 'BOSS', deskType: 'bossdesk', look: {skin: 1, hair: 7, outfit: 6, hairColor: '', accessories: ['tie']},
           fallbackSeat: null, aisle: false,
           action: 'worklog', clickDesk: true, chair: 'executive', labelColor: '#f3d27a'},
  };

  /** A usable look, or null when the value is missing or malformed. Reads the older single `accessory` too. */
  function normalizeLook(look) {
    if (!look || typeof look !== 'object') return null;
    const {skin, hair, outfit, hairColor = ''} = look;
    if (!Number.isInteger(skin) || skin < 0 || skin >= SKINS) return null;
    if (!Number.isInteger(hair) || hair < 0 || hair >= HAIRS) return null;
    if (!OUTFITS.includes(outfit) || typeof hairColor !== 'string' || !HAIR_COLORS[hairColor]) return null;
    const worn = look.accessories !== undefined ? look.accessories : look.accessory ? [look.accessory] : [];
    if (!Array.isArray(worn) || worn.some(a => !Object.hasOwn(ACCESSORIES, a))) return null;
    return {skin, hair, outfit, hairColor, accessories: Object.keys(ACCESSORIES).filter(a => worn.includes(a))};
  }
  /** Generated look for the n-th engineer, used when none is configured. */
  function autoLook(index = 0) {
    const n = Number.isInteger(index) && index >= 0 ? index : 0;
    return {skin: n % SKINS, hair: n % HAIRS, outfit: OUTFITS[n % OUTFITS.length], hairColor: '', accessories: []};
  }
  /** Random look, for the editor's shuffle button. Each accessory turns up about a quarter of the time. */
  function randomLook(random = Math.random) {
    const pick = list => list[Math.floor(random() * list.length)];
    return {skin: Math.floor(random() * SKINS), hair: Math.floor(random() * HAIRS), outfit: pick(OUTFITS),
      hairColor: pick(Object.keys(HAIR_COLORS)), accessories: Object.keys(ACCESSORIES).filter(() => random() < .25)};
  }
  // `roles` is the stored block, e.g. {pm: {name, look}, boss: {...}}; any part may be missing.
  function custom(roles, id) { return (roles && roles[id]) || {}; }
  function roleName(roles, id) {
    const name = typeof custom(roles, id).name === 'string' ? custom(roles, id).name.trim() : '';
    return name || ROLES[id].name;
  }
  function roleLook(roles, id) { return normalizeLook(custom(roles, id).look) || {...ROLES[id].look, accessories: [...ROLES[id].look.accessories]}; }

  /** Error message for a `roles` block, or '' when it is valid. */
  function validateRoles(roles) {
    if (roles === undefined) return '';
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return '角色設定格式不正確。';
    for (const [id, value] of Object.entries(roles)) {
      if (!ROLES[id] || !value || typeof value !== 'object') return '角色設定格式不正確。';
      if (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim().length > NAME_MAX)) return `${ROLES[id].name} 名稱最多 ${NAME_MAX} 個字元。`;
      if (value.look !== undefined && value.look !== null && !normalizeLook(value.look)) return `${ROLES[id].name} 外觀設定不正確。`;
    }
    return '';
  }
  /** Storable copy of a valid `roles` block: trimmed names, normalised looks, defaults dropped. */
  function cleanRoles(roles) {
    const out = {};
    for (const id of Object.keys(ROLES)) {
      const value = custom(roles, id), entry = {}, name = typeof value.name === 'string' ? value.name.trim() : '';
      if (name && name !== ROLES[id].name) entry.name = name;
      if (normalizeLook(value.look)) entry.look = normalizeLook(value.look);
      if (Object.keys(entry).length) out[id] = entry;
    }
    return out;
  }

  return {ROLES, SKINS, HAIRS, OUTFITS, ACCESSORIES, HAIR_COLORS, NAME_MAX, normalizeLook, autoLook, randomLook, roleName, roleLook, validateRoles, cleanRoles};
});
