import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
const theme=readFileSync(new URL('../public/theme.js',import.meta.url),'utf8');

test('offers stop-place search and a theme toggle instead of sharing', () => {
  assert.match(html,/Stasjon \/ blokkpost \/ stoppested/);
  assert.match(html,/id="theme-toggle"/);
  assert.doesNotMatch(html,/id="share"/);
});

test('loads the saved or system theme before the stylesheet is painted', () => {
  assert.ok(html.indexOf('/theme.js')<html.indexOf('/style.css'));
  assert.match(theme,/togoversikt-theme/);
  assert.match(theme,/prefers-color-scheme: dark/);
});

test('dark mode covers primary surfaces and status rows', () => {
  for(const selector of ['body','.panel','.train-row.ontime','.train-row.delayed','.train-row.cancelled','.detail','.filter-sheet','.site-menu-panel']) {
    assert.match(css,new RegExp(`data-theme="dark"[^\\n]*${selector.replace('.','\\.')}`));
  }
});
