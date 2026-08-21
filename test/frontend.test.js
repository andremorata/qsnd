import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hasTranslation, resolveLocale, translate } from '../public/i18n.js';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('keeps page chrome fixed and scrolls the room feed', () => {
  assert.match(css, /body\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.room-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.feed\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.composer textarea\s*\{[^}]*resize:\s*none;/s);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
  assert.equal((html.match(/data-theme-toggle/g) || []).length, 2);
  assert.match(app, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
});

test('selects the browser language and covers every localized field', () => {
  assert.equal(resolveLocale(null, ['pt-PT', 'en-US']), 'pt-BR');
  assert.equal(resolveLocale(null, ['es-ES']), 'en-US');
  assert.equal(resolveLocale('en-US', ['pt-BR']), 'en-US');
  assert.equal(translate('en-US', 'toast.filesSent', { count: 2 }), '2 files uploaded.');

  const keys = [
    ...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g),
    ...app.matchAll(/\bt\('([^']+)'/g),
  ].map((match) => match[1]);
  for (const key of keys) {
    assert.ok(hasTranslation('pt-BR', key), `missing pt-BR translation: ${key}`);
    assert.ok(hasTranslation('en-US', key), `missing en-US translation: ${key}`);
  }
});
