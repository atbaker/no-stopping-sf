import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, looksLikeAddress, suggestAddresses } from '../site/dist/address.mjs';

test('typed addresses normalize to EAS spelling', () => {
  assert.equal(normalizeAddress(' 2550 mission street, San Francisco, CA 94110 '), '2550 MISSION ST');
  assert.equal(normalizeAddress('101 Third St.'), '101 3RD ST');
  assert.equal(normalizeAddress("450 O'Farrell St Apt 4"), '450 OFARRELL ST');
  assert.equal(normalizeAddress('123A Market Street #5'), '123 A MARKET ST');
  assert.equal(normalizeAddress('0100 05th Avenue SF'), '100 5TH AVE');
});

test('address detection needs a house number then a street', () => {
  assert.ok(looksLikeAddress('2550 Mission'));
  assert.ok(!looksLikeAddress('SSP-26-02177'));
  assert.ok(!looksLikeAddress('Clark Construction'));
  assert.ok(!looksLikeAddress('2550'));
});

// Two streets; coordinates are 1e-5 degree deltas from the base, as prepare_data.py writes them.
const index = {base:[3770000, -12244000], streets:{
  'MAIN ST':'10,100,200;12,1,1;20,1,1', 'MAINE AVE':'10,500,500', 'MARKET ST':'1,0,0', 'MAIN BAY BLVD NORTH':'300,0,0'}};

test('suggestions match exact house numbers on matching streets', () => {
  const found = suggestAddresses(index, '10 main');
  assert.deepEqual(found.map(a => a.address), ['10 MAIN ST', '10 MAINE AVE']);
  assert.deepEqual([found[0].lat, found[0].lng, found[0].exact], [37.701, -122.438, true]);
  assert.deepEqual(suggestAddresses(index, '12 Main Street').map(a => a.address), ['12 MAIN ST']);
});

test('missing house numbers fall back to the nearest number on file', () => {
  const [nearest] = suggestAddresses(index, '19 Main St');
  assert.equal(nearest.address, '20 MAIN ST');
  assert.equal(nearest.exact, false);
  assert.deepEqual(suggestAddresses(index, '5 Nowhere St'), []);
  assert.deepEqual(suggestAddresses(index, '999 Main St'), []);
  assert.deepEqual(suggestAddresses(null, '10 Main'), []);
});

test('typed street names prefer the shortest completion', () => {
  assert.equal(suggestAddresses(index, '301 Main')[0], undefined);
  assert.equal(suggestAddresses(index, '21 Main')[0].address, '20 MAIN ST');
});
