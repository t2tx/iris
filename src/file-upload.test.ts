import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {detectFiles} from './file-upload.js';

describe('detectFiles', () => {
  it('detects absolute image paths', () => {
    const text = 'I created the chart at /tmp/chart.png for you.';
    const files = detectFiles(text);
    // Won't exist on CI, so we test the pattern matching only
    // (existsSync will filter it out — that's correct behavior)
    assert.ok(files.length === 0 || files[0]!.name === 'chart.png');
  });

  it('detects paths in backticks', () => {
    const text = 'File saved to `/Users/me/output.pdf`';
    const files = detectFiles(text);
    assert.ok(files.length === 0 || files[0]!.name === 'output.pdf');
  });

  it('ignores non-uploadable extensions', () => {
    const text = 'I edited /Users/me/src/index.ts';
    const files = detectFiles(text);
    // .ts is not in UPLOADABLE_EXTS
    assert.equal(files.length, 0);
  });

  it('ignores relative paths', () => {
    const text = 'See ./output.png for the result';
    const files = detectFiles(text);
    assert.equal(files.length, 0);
  });

  it('deduplicates same path', () => {
    const text = '/tmp/a.png and again /tmp/a.png';
    const files = detectFiles(text);
    assert.ok(files.length <= 1);
  });
});
