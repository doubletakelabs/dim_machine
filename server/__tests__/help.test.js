/**
 * Help Me (2026-10-01): a guest presses it on their phone's ? screen; the
 * front desk iPad and the operator panel flash and mark them until someone
 * taps "On my way", which tells the phone someone is coming. The iPad
 * connects as a desk: it sees the show and answers help, and nothing else it
 * sends is acted on.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect, openOperator, openPhone, runShow } from './helpers/server-harness.js';

async function openDesk(server) {
  const desk = await connect(server).open();
  desk.send({ type: 'hello', role: 'desk' });
  await desk.waitFor('roster');
  return desk;
}
const guestIn = (roster, guestId) => roster.spatial.guests.find((g) => g.guestId === guestId);

describe('Help Me', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('reaches the desk, and "On my way" reaches the phone', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const desk = await openDesk(server);
    const phone = await openPhone(server, null, { device: 'mad0097' });
    const { guestId } = phone.welcome;

    let since = desk.mark();
    phone.send({ type: 'help' });
    await phone.waitFor('helpReceived');
    const asked = await desk.waitFor((m) => m.type === 'roster' && guestIn(m, guestId)?.help, { since, describe: 'roster with the help request' });
    assert.equal(typeof guestIn(asked, guestId).help.at, 'number');
    await op.waitFor((m) => m.type === 'roster' && guestIn(m, guestId)?.help, { describe: 'the operator panel sees it too' });

    since = desk.mark();
    desk.send({ type: 'helpOnTheWay', guestId });
    await phone.waitFor('helpOnTheWay');
    await desk.waitFor((m) => m.type === 'roster' && guestIn(m, guestId) && !guestIn(m, guestId).help, { since, describe: 'roster with the request answered' });
    phone.close(); desk.close(); op.close();
  });

  it('a desk cannot run the show', async () => {
    const op = await openOperator(server);
    await runShow(op);
    const phone = await openPhone(server, null, { device: 'mad0096' });
    const { guestId } = phone.welcome;
    const desk = await openDesk(server);
    desk.send({ type: 'removeGuest', guestId });
    desk.send({ type: 'stopShow' });
    const since = desk.mark();
    const roster = await desk.waitFor('roster', { since });
    assert.ok(guestIn(roster, guestId), 'the guest is still there');
    assert.equal(roster.show.running, true, "the show is still running");
    phone.close(); desk.close(); op.close();
  });
});
