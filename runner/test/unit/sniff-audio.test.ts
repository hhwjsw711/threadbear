// sniffAudio takes a sound only by what it really is (Gemini's review of the
// phone's comparison board, 27 Nov): a file starting "ID3", or two bytes of
// MPEG sync, used to pass as an MP3, and it goes to the phone as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAudioInfo, sniffAudio } from '../../src/media.ts';

// MPEG-1 layer III, 128 kbps, 44.1 kHz: 417 bytes a frame.
function mp3Frame(): Buffer {
  const f = Buffer.alloc(417);
  f.set([0xff, 0xfb, 0x90, 0x64]);
  return f;
}
// An ADTS (AAC) frame of 20 bytes, no CRC.
function adtsFrame(): Buffer {
  const f = Buffer.alloc(20);
  f.set([0xff, 0xf1, 0x50, 0x80, 20 >> 3, ((20 & 7) << 5) | 0x1f, 0xfc]);
  return f;
}
function id3(size: number, version = 4): Buffer {
  const h = Buffer.from([0x49, 0x44, 0x33, version, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([h, Buffer.alloc(size)]);
}

test('real sounds pass', () => {
  assert.equal(sniffAudio(Buffer.concat([mp3Frame(), mp3Frame()]))?.mediaType, 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([id3(30), mp3Frame(), mp3Frame()]))?.mediaType, 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([id3(0, 3), mp3Frame(), mp3Frame()]))?.mediaType, 'audio/mpeg');
  // A v2.4 footer flag is a real flag, and moves the frames on by ten.
  const footed = id3(0);
  footed[5] = 0x10;
  assert.equal(sniffAudio(Buffer.concat([footed, Buffer.alloc(10), mp3Frame(), mp3Frame()]))?.mediaType, 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([adtsFrame(), adtsFrame()]))?.mediaType, 'audio/aac');
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.write('WAVEfmt ', 8);
  assert.equal(sniffAudio(wav)?.mediaType, 'audio/wav');
  const m4a = Buffer.alloc(16);
  m4a.writeUInt32BE(16, 0);
  m4a.write('ftypM4A ', 4);
  assert.equal(sniffAudio(m4a)?.mediaType, 'audio/mp4');
});

test('look-alikes are refused', () => {
  const rejects: Record<string, Buffer> = {
    'ID3 then nothing': Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), Buffer.alloc(40)]),
    'ID3 then text': Buffer.concat([id3(0), Buffer.from('#!/bin/sh\necho hi\n'.repeat(10))]),
    'ID3 version 9': Buffer.concat([id3(0, 9), mp3Frame(), mp3Frame()]),
    'ID3 size not synchsafe': Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0x80]), mp3Frame(), mp3Frame()]),
    'one MP3 frame header and junk': Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(900, 0x41)]),
    'two sync bytes': Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.alloc(900)]),
    'free bitrate': Buffer.concat([Buffer.from([0xff, 0xfb, 0x00, 0x64]), Buffer.alloc(900)]),
    'one ADTS frame and junk': Buffer.concat([adtsFrame(), Buffer.alloc(40, 0x41)]),
    'RIFF but AVI': Buffer.concat([Buffer.from('RIFF\0\0\0\0AVI LIST'), Buffer.alloc(40)]),
    'one MP3 frame and the next header only': Buffer.concat([mp3Frame(), mp3Frame().subarray(0, 7)]),
    'one MP3 frame and most of the next': Buffer.concat([mp3Frame(), mp3Frame().subarray(0, 416)]),
    'one ADTS frame and the next header only': Buffer.concat([adtsFrame(), adtsFrame().subarray(0, 7)]),
    'ID3v2.4 with a reserved flag bit': (() => { const t = id3(0); t[5] = 0x01; return Buffer.concat([t, mp3Frame(), mp3Frame()]); })(),
    'ID3v2.3 with a reserved flag bit': (() => { const t = id3(0, 3); t[5] = 0x10; return Buffer.concat([t, mp3Frame(), mp3Frame()]); })(),
    'MP4 video brand': Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(40)]),
  };
  for (const [what, bytes] of Object.entries(rejects)) assert.equal(sniffAudio(bytes), null, what);
});

test('an MP3 with cover art past the first 64 KB is still read as one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-audio-'));
  try {
    const file = path.join(dir, 'art.mp3');
    fs.writeFileSync(file, Buffer.concat([id3(200 * 1024), mp3Frame(), mp3Frame()]));
    assert.equal(readAudioInfo(file)?.mediaType, 'audio/mpeg');
    fs.writeFileSync(file, Buffer.concat([id3(200 * 1024), Buffer.alloc(2000, 0x41)]));
    assert.equal(readAudioInfo(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
