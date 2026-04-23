import { describe, it, expect } from 'vitest';
import { getChatHTML } from '../static-content.js';

describe('getChatHTML', () => {
  it('returns valid HTML with the fingerprint embedded', () => {
    const html = getChatHTML('abc123xyz');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('"abc123xyz"');
    expect(html).toContain('/ws/');
  });

  it('escapes closing script tags in fingerprint to prevent XSS', () => {
    const html = getChatHTML('test</script><script>alert(1)//');
    // The </script> inside the fingerprint must be escaped to prevent
    // breaking out of the <script> block
    expect(html).not.toContain('test</script>');
    // The escaped form should be present
    expect(html).toContain('test<\\/script>');
  });

  it('contains essential UI elements', () => {
    const html = getChatHTML('fp123');
    expect(html).toContain('msg-input');
    expect(html).toContain('send-btn');
    expect(html).toContain('status-bar');
    expect(html).toContain('messages');
  });
});
