import test from 'node:test';
import assert from 'node:assert/strict';
import { photoUrl, photoSource, photoOriginalUrl } from '../site/dist/photos.mjs';

test('photo URLs use official host and small/large renditions',()=>{
  const photo={version_id:'068Ps00001EM7ldIAD',source_parent_id:'a1PPs000007xYssMAE'};
  const small=new URL(photoUrl(photo));
  assert.equal(small.hostname,'sf-row.my.site.com');
  assert.equal(small.searchParams.get('rendition'),'THUMB240BY180');
  assert.equal(new URL(photoUrl(photo,'large')).searchParams.get('rendition'),'THUMB720BY480');
  assert.equal(photoSource(photo),'https://sf-row.my.site.com/s/submission/a1PPs000007xYssMAE');
  assert.equal(photoOriginalUrl(photo),'https://sf-row.my.site.com/sfc/servlet.shepherd/version/download/068Ps00001EM7ldIAD');
});
test('malformed and foreign IDs cannot become image or source URLs',()=>{
  for(const id of ['https://evil.example/photo','068abc" onerror="x','069Ps00001EM7ldIAD',null]) {
    assert.equal(photoUrl({version_id:id}),null);
    assert.equal(photoOriginalUrl({version_id:id}),null);
  }
  assert.equal(photoSource({source_parent_id:'javascript:alert(1)'}),null);
});
