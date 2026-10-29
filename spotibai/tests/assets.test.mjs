import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { localAssetUrl } from '../js/assets.js';

for (const artist of ['baij', 'spotibai', 'rene', 'lucky']) {
  test(`${artist} artwork resolves to a bundled file for each catalog format`, () => {
    const name = `artist-${artist}.svg`;
    for (const path of [name, `/assets/covers/${name}`, `./assets/covers/${name}`,
      `https://example.supabase.co/storage/v1/object/public/covers/${name}`]) {
      const resolved = localAssetUrl('covers', path);
      assert.equal(resolved, new URL(`../assets/covers/${name}`, import.meta.url).href);
      assert.ok(existsSync(new URL(resolved)));
    }
  });
}
test('custom artwork and empty values are preserved', () => {
  for (const path of ['https://example.com/artist-baij.svg',
    'https://example.supabase.co/storage/v1/object/public/covers/custom.svg',
    'data:image/svg+xml,example']) {
    assert.equal(localAssetUrl('covers', path), path);
  }
  assert.equal(localAssetUrl('covers', null), null);
});
