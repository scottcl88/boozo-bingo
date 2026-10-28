// Static UI accessibility regression suite (no browser needed). Guards the defects found in the
// 2026-10-28 design assessment: low-contrast primary buttons, div bingo cells, missing landmarks, misplaced errors.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const css = pub('style.css'), html = pub('index.html'), js = pub('app.js');
let failed = 0;
function test(name, fn) { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); } }

const lum = (hex) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const token = (n) => { const m = css.match(new RegExp('--' + n + ':\\s*(#[0-9a-fA-F]{6})')); assert(m, 'token --' + n + ' missing'); return m[1]; };
const textColorOf = (sel) => { const start = css.indexOf(sel + ' {'); assert(start >= 0, sel + ' rule missing'); const body = css.slice(start, css.indexOf('}', start)); const m = body.match(/(?:^|[\s;{])color:\s*([^;]+);/); assert(m, sel + ' has no color'); const v = m[1].trim(); const tk = v.match(/var\(--([a-z-]+)\)/); return tk ? token(tk[1]) : v; };

test('primary button text meets WCAG AA (4.5:1) on its fill', () => { const r = ratio(textColorOf('.btn-primary'), token('accent')); assert(r >= 4.5, 'contrast ' + r.toFixed(2)); });
test('secondary button text meets WCAG AA (4.5:1) on its fill', () => { const r = ratio(textColorOf('.btn-secondary'), token('purple')); assert(r >= 4.5, 'contrast ' + r.toFixed(2)); });
test('player mark-count text meets WCAG AA on the list surface (axe color-contrast regression)', () => { const start = css.indexOf('.player-list li .mark-count {'); assert(start >= 0, 'mark-count rule missing'); const body = css.slice(start, css.indexOf('}', start)); const m = body.match(/(?:^|[\s;{])color:\s*(#[0-9a-fA-F]{6})/); assert(m, 'mark-count color must be a hex literal'); const r = ratio(m[1], token('surface')); assert(r >= 4.5, 'contrast ' + r.toFixed(2)); });
test('bingo cells are real buttons with aria-pressed (keyboard playable)', () => { assert(/<button type="button" class="bingo-cell/.test(js), 'cell not a button'); assert(/aria-pressed=/.test(js), 'no aria-pressed'); assert(!/<div class="bingo-cell/.test(js), 'div cell still present'); });
test('aria-pressed is kept in sync when marks change', () => { assert(/setAttribute\('aria-pressed'/.test(js)); });
test('page has a main landmark', () => { assert(/<main>[\s\S]*<\/main>/.test(html)); });
test('every screen has an h1 (visible or sr-only)', () => { for (const id of ['screen-home', 'screen-lobby', 'screen-game', 'screen-join-link']) { const block = html.slice(html.indexOf('id="' + id + '"')); assert(/<h1[ >]/.test(block.slice(0, 1500)), id + ' lacks h1'); } });
test('name error renders under the name field and is announced', () => { assert(/id="home-name-error"[^>]*role="alert"/.test(html)); assert(/aria-describedby="home-name-error"/.test(html)); assert(/showError\('Please enter your name\.', 'home-name-error'\)/.test(js)); });
test('winner dismiss button says what it does', () => { assert(/btn-dismiss-winner[^>]*>Keep playing</.test(html)); });
test('visible focus style exists for buttons, cells and inputs', () => { assert(/:focus-visible/.test(css) && /button\.bingo-cell:focus-visible/.test(css)); });

console.log(failed ? '\n' + failed + ' FAILED' : '\nALL UI A11Y CHECKS PASSED');
process.exit(failed ? 1 : 0);
