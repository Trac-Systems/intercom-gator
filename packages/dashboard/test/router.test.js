import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, href, navKey } from '../public/js/lib/router.js';

test('parses every route', () => {
  assert.deepEqual(parse('').name, 'markets');
  assert.deepEqual(parse('#/').name, 'markets');
  assert.deepEqual(parse('#/markets/gainers').params, { tab: 'gainers' });
  assert.deepEqual(parse('#/token/eth%3A0xabc').params, { id: 'eth:0xabc' });
  assert.equal(parse('#/new').name, 'new');
  assert.equal(parse('#/exchanges').name, 'exchanges');
  assert.deepEqual(parse('#/feed/mentions').params, { lane: 'mentions' });
  assert.equal(parse('#/feed').name, 'feed');
  assert.deepEqual(parse('#/post/k1/i2').params, { key: 'k1', id: 'i2' });
  assert.deepEqual(parse('#/u/me').params, { key: 'me' });
  assert.equal(parse('#/channels').name, 'channels');
  assert.equal(parse('#/portfolio').name, 'portfolio');
  assert.deepEqual(parse('#/settings/agent').params, { section: 'agent' });
});

test('query strings and trailing slashes', () => {
  const r = parse('#/?cat=Meme');
  assert.equal(r.name, 'markets');
  assert.deepEqual(r.query, { cat: 'Meme' });
  assert.equal(parse('#/new/').name, 'new');
  assert.deepEqual(parse('#/token/btc%3Anative?s=posts').query, { s: 'posts' });
});

test('unknown and malformed routes', () => {
  assert.equal(parse('#/nope').name, 'notfound');
  assert.equal(parse('#/token').name, 'notfound');
  assert.equal(parse('#/token/%E0%A4%A').name, 'notfound');
});

test('href round-trips', () => {
  for (const [name, params, query] of [
    ['token', { id: 'sol:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' }, {}],
    ['markets', { tab: 'nfts' }, {}],
    ['feed', { lane: 'official' }, {}],
    ['post', { key: 'a/b', id: 'c?d' }, {}],
    ['profile', { key: 'me' }, {}],
    ['settings', { section: 'budget' }, {}],
    ['markets', {}, { chain: 'BNB Chain' }],
  ]) {
    const r = parse(href(name, params, query));
    assert.equal(r.name, name);
    assert.deepEqual(r.params, Object.fromEntries(Object.entries(params).filter(([k, v]) => !(name === 'markets' && k === 'tab' && v === 'all'))));
    assert.deepEqual(r.query, query);
  }
  assert.equal(href('markets', { tab: 'all' }), '#/');
  assert.equal(href('feed', { lane: 'latest' }), '#/feed');
  assert.equal(href('feed', { lane: 'following' }), '#/feed/following');
});

test('nav key per route', () => {
  assert.equal(navKey(parse('#/post/a/b')), 'feed');
  assert.equal(navKey(parse('#/token/x')), 'markets');
  assert.equal(navKey(parse('#/u/me')), 'settings');
  assert.equal(navKey(parse('#/u/abc')), 'channels');
});
