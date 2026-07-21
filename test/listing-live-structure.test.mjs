import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listingAdapter } from '../src/lib/adapters.mjs';
import { listingDate } from '../src/lib/listing.mjs';

const haiFixture = await readFile(new URL('../fixtures/listings/stanford-hai-news.html', import.meta.url), 'utf8');
const cmuFixture = await readFile(new URL('../fixtures/listings/cmu-hcii-news.html', import.meta.url), 'utf8');
const cmuDetail = await readFile(new URL('../fixtures/listings/cmu-hcii-detail.html', import.meta.url), 'utf8');
const dnsLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const network = { allowHosts: ['hai.stanford.edu', 'hcii.cmu.edu'], timeoutMs: 100, retries: 0, maxPageBytes: 400000 };

test('Stanford HAI Next Flight cards infer a safe year from month and day', async () => {
  const source = { id: 'stanford-hci-news', name: 'Stanford HAI News', adapter: 'listing', listingFormat: 'next-flight', articlePathPrefix: '/news/', url: 'https://hai.stanford.edu/news', locale: 'en', category: 'frontier', institution: 'Stanford University', optional: true };
  const items = await listingAdapter(source, { network }, {
    now: () => Date.parse('2026-07-21T00:00:00Z'), dnsLookup,
    fetchImpl: async () => new Response(haiFixture, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Today's AI Talks Like Nobody");
  assert.equal(items[0].publishedAt, '2026-06-08');
  assert.equal(items[0].source.url, 'https://hai.stanford.edu/news/todays-ai-talks-like-nobody-new-research-gives-it-real-personality');
});

test('CMU cards use at most same-host detail pages for explicit publication time', async () => {
  const source = { id: 'cmu-hcii-news', name: 'CMU HCII News', adapter: 'listing', listingContainerClass: 'newsfront-cards', articlePathPrefix: '/news/', detailDateMax: 8, url: 'https://hcii.cmu.edu/news', locale: 'en', category: 'frontier', institution: 'Carnegie Mellon University', optional: true };
  const calls = [];
  const items = await listingAdapter(source, { network }, {
    now: () => Date.parse('2026-07-21T00:00:00Z'), dnsLookup,
    fetchImpl: async url => {
      calls.push(String(url));
      return new Response(String(url).endsWith('/news') ? cmuFixture : cmuDetail, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Stepping Toward Better Mobility');
  assert.equal(items[0].publishedAt, '2026-07-14');
  assert.deepEqual(calls, ['https://hcii.cmu.edu/news', 'https://hcii.cmu.edu/news/stepping-toward-better-mobility']);
});

test('detail-date fanout is hard-capped at eight requests', async () => {
  const cards = Array.from({ length: 10 }, (_, index) => `<li><h2>HCII item ${index}</h2><a href="/news/item-${index}">Read more</a></li>`).join('');
  let calls = 0;
  const items = await listingAdapter({ id: 'cmu', adapter: 'listing', detailDateMax: 99, url: 'https://hcii.cmu.edu/news', locale: 'en', category: 'frontier' }, { network }, {
    dnsLookup, now: () => Date.parse('2026-07-21T00:00:00Z'),
    fetchImpl: async url => {
      calls++;
      return new Response(String(url).endsWith('/news') ? `<ul class="newsfront-cards">${cards}</ul>` : cmuDetail, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });
  assert.equal(calls, 9);
  assert.equal(items.length, 8);
});

test('year inference rolls a date more than 24 hours ahead into the prior year', () => {
  assert.equal(listingDate('Dec 31', Date.parse('2026-01-01T12:00:00Z')), '2025-12-31');
  assert.equal(listingDate('Jan 02', Date.parse('2026-01-01T12:00:00Z')), '2026-01-02');
  assert.equal(listingDate('Feb 30, 2026', Date.parse('2026-02-01T00:00:00Z')), '');
});
