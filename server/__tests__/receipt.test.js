/**
 * The Library's receipt (server/receipt.js): what it says, and that the
 * printer is given what it needs to print, a QR code and a cut.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildReceipt, sendToPrinter, wrap } from '../receipt.js';
import { rng } from '../../poster/compose.js';

const visit = ['calibration', 'maskRoom', 'cyclorama', 'slop', 'kin', 'cyclorama', 'library'].map((roomId) => ({ roomId }));
const build = (seed = 1, extra = {}) => buildReceipt({
  phone: '#mad0033', visit, counts: { taps: 41, swipes: 17, drags: 9, dragMs: 23400 }, random: rng(seed),
  at: new Date(2026, 9, 1, 17, 5), ...extra,
});

describe('the receipt', () => {
  it('heads with the phone, when, and what the guest did', () => {
    const { text } = build();
    assert.match(text, /P H O N E {3}M A D 0 0 3 3/);
    assert.match(text, /OCT 01 2026 5:05 PM/);
    assert.match(text, /TAPS \.+ 041/);
    assert.match(text, /SWIPES \.+ 017/);
    assert.match(text, /DRAGS \.+ 009/);
    assert.match(text, /TIME SPENT DRAGGING \.+ 00:23/);
    assert.match(text, /ROOMS VISITED \.+ 6/, 'a return is not another room');
  });

  it('makes its poster from the words the visit collected, once each', () => {
    const { words } = build();
    assert.deepEqual(words, ['FOCUS', 'MASK', 'COOL', 'SLOP', 'PREY']);
  });

  it('is plain ASCII to the printer, with a QR code to the site and a cut at the end', () => {
    const { bytes } = build();
    const site = Buffer.from('https://www.deadinternetmuseum.com/');
    assert.ok(bytes.includes(site), 'the QR code carries the site');
    assert.ok(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30])), 'and is printed');
    assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 66, 3], 'ends with a cut');
    for (const b of bytes) assert.ok(b < 0x80, `byte ${b} is not ASCII or a command`);
  });

  it('still prints for a guest with no words and no counts', () => {
    const { text, bytes } = buildReceipt({ phone: '#mad0001', visit: [], random: rng(2) });
    assert.match(text.replace(/ /g, ''), /YOUWEREHERE/, 'a headline of its own');
    assert.match(text, /TAPS \.+ 000/);
    assert.ok(bytes.length > 100);
  });

  it('wraps to the paper', () => {
    assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  });
});

describe('sending to the printer', () => {
  it('writes the bytes to a raw socket', async () => {
    const got = [];
    const server = net.createServer((s) => s.on('data', (d) => got.push(d)));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    await sendToPrinter(`127.0.0.1:${port}`, Buffer.from('hello'));
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    assert.equal(Buffer.concat(got).toString(), 'hello');
  });

  it('gives up on a printer that is not there', async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    server.close();
    await assert.rejects(sendToPrinter(`127.0.0.1:${port}`, Buffer.from('x'), 1000));
  });
});
