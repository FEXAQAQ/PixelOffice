/* Draws MetroCity characters from a look (see office-roles.js). Shared by the office scene,
   the look editor preview and the task-tab portraits so every place shows the same person. */
(function (root) {
  'use strict';
  const R = root.OfficeRoles;
  const SOURCES = {body: 'CharacterModel/Character%20Model.png', hair: 'Hair/Hairs.png', outfit5: 'Outfits/Outfit5.png', outfit6: 'Outfits/Outfit6.png'};
  const images = {};
  let loading = null;

  /** Resolves once every sheet is loaded; rejects when one is missing. */
  function load() {
    if (!loading) loading = Promise.all(Object.entries(SOURCES).map(([name, src]) => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => { images[name] = image; resolve(); }; image.onerror = reject;
      image.src = '/assets/MetroCity/' + src;
    })));
    return loading;
  }
  const ready = () => Object.keys(SOURCES).every(name => images[name]);

  // Recoloured copies of the hair sheet. Each style row is normalised on its own, so a dark
  // style still comes out light when tinted blonde, and the original shading survives.
  const tinted = {};
  function hairSheet(key) {
    const color = R.HAIR_COLORS[key] && R.HAIR_COLORS[key].color;
    if (!color) return images.hair;
    if (tinted[key]) return tinted[key];
    const src = images.hair, canvas = document.createElement('canvas');
    canvas.width = src.width; canvas.height = src.height;
    const c = canvas.getContext('2d'); c.drawImage(src, 0, 0);
    const data = c.getImageData(0, 0, canvas.width, canvas.height), px = data.data;
    const [tr, tg, tb] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const luma = i => .3 * px[i] + .59 * px[i + 1] + .11 * px[i + 2];
    for (let top = 0; top < canvas.height; top += 32) {
      let lo = 255, hi = 0;
      for (let y = top; y < top + 32; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4; if (px[i + 3]) { const l = luma(i); lo = Math.min(lo, l); hi = Math.max(hi, l); }
      }
      for (let y = top; y < top + 32; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4; if (!px[i + 3]) continue;
        const shade = .5 + .7 * (hi > lo ? (luma(i) - lo) / (hi - lo) : .5);
        px[i] = Math.min(255, tr * shade); px[i + 1] = Math.min(255, tg * shade); px[i + 2] = Math.min(255, tb * shade);
      }
    }
    c.putImageData(data, 0, 0);
    return (tinted[key] = canvas);
  }

  // Accessory pixels in 32px sprite space, per direction (0 front, 1 right, 2 back, 3 left):
  // [x, y, w, h, colour]. Directions without an entry draw nothing (e.g. a tie seen from behind).
  const INK = '#2b2a33', LENS = 'rgba(200,236,245,.55)', BAND = '#2e3542', CUP = '#3d4656', GLOW = '#5aa9ff';
  const mirror = rects => rects.map(([x, y, w, h, color]) => [32 - x - w, y, w, h, color]);
  const headphonesSide = [[14, 2, 4, 1, BAND], [13, 3, 1, 8, BAND], [11, 11, 4, 5, CUP], [12, 12, 2, 3, GLOW]];
  const headphonesFront = [[13, 1, 7, 1, BAND], [11, 2, 2, 1, BAND], [20, 2, 2, 1, BAND], [10, 3, 1, 1, BAND], [22, 3, 1, 1, BAND],
    [9, 4, 1, 7, BAND], [23, 4, 1, 7, BAND], [8, 11, 3, 5, CUP], [22, 11, 3, 5, CUP], [9, 12, 1, 3, GLOW], [23, 12, 1, 3, GLOW]];
  const glassesSide = [[12, 15, 5, 1, INK], [17, 14, 3, 1, INK], [17, 15, 1, 2, INK], [18, 15, 2, 2, LENS], [17, 17, 3, 1, INK]];
  const ART = {
    tie: {0: [[16, 18, 2, 1, '#e3b94f'], [16, 19, 2, 3, '#c9982f'], [16, 22, 2, 1, '#a57b24']]},
    glasses: {
      0: [[13, 14, 8, 1, INK], [13, 15, 1, 2, INK], [16, 15, 2, 1, INK], [20, 15, 1, 2, INK], [13, 17, 4, 1, INK], [17, 17, 4, 1, INK],
        [14, 15, 2, 2, LENS], [18, 15, 2, 2, LENS]],
      1: glassesSide, 3: mirror(glassesSide),
    },
    headphones: {0: headphonesFront, 1: headphonesSide, 2: headphonesFront, 3: mirror(headphonesSide)},
  };

  /** Paints one frame of `look` at (x, y), `size` px square. step is the walking frame 0–5. */
  function paint(ctx, look, direction = 0, step = 0, x = 0, y = 0, size = 64) {
    if (!ready()) return false;
    const frame = direction * 6 + step, s = size / 32;
    ctx.drawImage(images.body, frame * 32, look.skin * 32, 32, 32, x, y, size, size);
    ctx.drawImage(images['outfit' + look.outfit], frame * 32, 0, 32, 32, x, y, size, size);
    ctx.drawImage(hairSheet(look.hairColor || ''), frame * 32, look.hair * 32, 32, 32, x, y, size, size);
    for (const name of look.accessories || []) for (const [ax, ay, w, h, color] of (ART[name] && ART[name][direction]) || []) {
      ctx.fillStyle = color; ctx.fillRect(x + ax * s, y + ay * s, w * s, h * s);
    }
    return true;
  }

  root.OfficeSprites = {load, ready, paint};
})(window);
