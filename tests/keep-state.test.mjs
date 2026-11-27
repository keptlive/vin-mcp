// public/keep-state.js: the place on screen is kept by an element at the top of the viewport. A sticky or fixed bar
// (the report's tab bar, public/report-tabs.js) sits there without moving with the page, so it must never be the
// anchor: with it, NHTSA's complaint list arriving late pushed what the reader was looking at down by the list's
// height (browser check at 1280 px, 2026-11-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function load({byY, position}) {
  const body = {nodeType: 1, id: 'body', parentElement: null};
  const html = {nodeType: 1, id: 'html', parentElement: null};
  body.parentElement = html;
  const el = (id, parent = body, top = 0) => ({nodeType: 1, id, parentElement: parent, getBoundingClientRect: () => ({top})});
  const nav = el('report-nav', body, 0), navTitle = el('report-nav-title', nav, 6), card = el('card-plant', body, 140);
  const els = {nav, navTitle, card};
  const document = {body, documentElement: html, elementFromPoint: (x, y) => els[byY(y)] || null};
  const ctx = {document, innerWidth: 1280, innerHeight: 900, getComputedStyle: e => ({position: position(e)})};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/keep-state.js', import.meta.url), 'utf8'), ctx);
  return {KeepState: vm.runInContext('KeepState', ctx), els};
}

test('the anchor skips a sticky bar at the top of the viewport and takes the page content below it', () => {
  const {KeepState, els} = load({byY: y => (y < 100 ? 'navTitle' : 'card'), position: e => (e.id === 'report-nav' ? 'sticky' : 'static')});
  const mark = KeepState.anchor([]);
  assert.equal(mark.el, els.card);
  assert.equal(mark.top, 140);
});

test('a fixed element is skipped too; with no sticky bar the top element is the anchor', () => {
  let r = load({byY: y => (y < 100 ? 'navTitle' : 'card'), position: e => (e.id === 'report-nav' ? 'fixed' : 'static')});
  assert.equal(r.KeepState.anchor([]).el, r.els.card);
  r = load({byY: () => 'navTitle', position: () => 'static'});
  assert.equal(r.KeepState.anchor([]).el, r.els.navTitle);
});

test('only sticky elements in view: no anchor rather than a wrong one', () => {
  const {KeepState} = load({byY: () => 'navTitle', position: e => (e.id === 'report-nav' ? 'sticky' : 'static')});
  assert.equal(KeepState.anchor([]), null);
});
