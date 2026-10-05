// Build URLs from validated Salesforce version IDs, never from attachment text.
export function photoUrl(photo, size = 'small') {
  if (!/^068[A-Za-z0-9]{15}$/.test(photo?.version_id || '')) return null;
  const params = new URLSearchParams({rendition:size === 'large' ? 'THUMB720BY480' : 'THUMB240BY180',
    versionId:photo.version_id, operationContext:'CHATTER'});
  return `https://sf-row.my.site.com/sfc/servlet.shepherd/version/renditionDownload?${params}`;
}
export function photoSource(photo) {
  if (!/^(?:a1P|a10)[A-Za-z0-9]{15}$/.test(photo?.source_parent_id || '')) return null;
  return `https://sf-row.my.site.com/s/${photo.source_parent_id.startsWith('a1P') ? 'submission' : 'permit2'}/${photo.source_parent_id}`;
}
export function photoOriginalUrl(photo) {
  if (!photoUrl(photo)) return null;
  return `https://sf-row.my.site.com/sfc/servlet.shepherd/version/download/${photo.version_id}`;
}
