import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildContent, type Attachment} from './attachments.js';

const img = (name = 'shot.png'): Attachment => ({
  name,
  mimeType: 'image/png',
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
});
const file = (name = 'report.pdf'): Attachment => ({
  name,
  mimeType: 'application/pdf',
  data: Buffer.from('hello'),
});

test('images become base64 image parts, plus a trailing text part', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-att-'));
  const parts = buildContent('look at this', [img()], dir, 1000);

  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.type, 'image');
  const imgPart = parts[0] as Extract<(typeof parts)[number], {type: 'image'}>;
  assert.equal(imgPart.source.media_type, 'image/png');
  assert.ok(imgPart.source.data.length > 0);
  assert.deepEqual(parts[1], {type: 'text', text: 'look at this'});
});

test('non-image files are saved to disk and referenced by path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-att-'));
  const parts = buildContent('', [file()], dir, 1234);

  // Only a text part (no image part) and it mentions the saved path.
  assert.equal(parts.length, 1);
  const textPart = parts[0] as Extract<(typeof parts)[number], {type: 'text'}>;
  assert.ok(textPart.text.includes('please read them'));
  assert.ok(textPart.text.includes('report.pdf'));

  // The file was actually written under <dir>/.iris/attachments.
  const saved = readdirSync(join(dir, '.iris', 'attachments'));
  assert.equal(saved.length, 1);
  assert.ok(saved[0]!.includes('report.pdf'));
});

test('empty prompt gets a default for image-only and file-only messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-att-'));
  const imgOnly = buildContent('', [img()], dir, 1);
  const textPart = imgOnly.at(-1) as {type: 'text'; text: string};
  assert.ok(textPart.text.includes('image'));
});

test('mixed image + file produces an image part and a file reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-att-'));
  const parts = buildContent('check both', [img(), file()], dir, 9);
  const kinds = parts.map((p) => p.type);
  assert.deepEqual(kinds, ['image', 'text']);
  const textPart = parts[1] as {type: 'text'; text: string};
  assert.ok(textPart.text.includes('check both'));
  assert.ok(textPart.text.includes('report.pdf'));
});
