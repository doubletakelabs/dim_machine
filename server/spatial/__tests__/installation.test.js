/**
 * Installations — which machines run a show's pieces.
 *
 * The cases that matter are the two ends: a laptop where almost nothing is
 * installed and that is correct, and a venue where a missing room is somebody
 * about to stand in front of nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyInstallation, overrideHost } from '../installation.js';

const show = () => ({
  rooms: {
    influence: { name: 'Influence', experience: { experienceId: 'clickfarm', inputMode: 'stream' } },
    kin: { name: 'Kin', experience: { experienceId: 'kin-piece', inputMode: 'stream' } },
    cyclorama: { name: 'Cyclorama' },
  },
});

const endpointOf = (def, roomId) => def.rooms[roomId].experience?.endpoint ?? null;

describe('placing a show in an installation', () => {
  it('gives each room the machine that runs it', () => {
    const { def, errors } = applyInstallation(show(), {
      installation: 'venue',
      experiences: { influence: 'ws://10.0.0.11:8080', kin: 'ws://10.0.0.12:8080' },
    });
    assert.deepEqual(errors, []);
    assert.equal(endpointOf(def, 'influence'), 'ws://10.0.0.11:8080');
    assert.equal(endpointOf(def, 'kin'), 'ws://10.0.0.12:8080');
    // A phone reaches the same machine unless told otherwise.
    assert.equal(def.rooms.kin.experience.phoneEndpoint, 'ws://10.0.0.12:8080');
  });

  it('lets the phone take a different route to the same room', () => {
    const { def } = applyInstallation(show(), {
      installation: 'venue',
      experiences: {
        influence: { endpoint: 'ws://10.0.0.11:8080', phoneEndpoint: 'ws://192.168.4.11:8080' },
      },
    });
    // The show server may reach a room machine on a wired segment while a
    // handset on the guest wifi needs another address entirely.
    assert.equal(endpointOf(def, 'influence'), 'ws://10.0.0.11:8080');
    assert.equal(def.rooms.influence.experience.phoneEndpoint, 'ws://192.168.4.11:8080');
  });

  it('is happy with a laptop where almost nothing is installed', () => {
    const { def, errors, warnings, notInstalled } = applyInstallation(show(), {
      installation: 'laptop',
      experiences: { influence: 'ws://127.0.0.1:8081' },
    });
    assert.deepEqual(errors, [], 'a partial installation is the normal case in rehearsal');
    assert.deepEqual(notInstalled, ['kin']);
    assert.match(warnings.join('\n'), /kin declares an experience with no address/);
    // Not half-configured — simply an ordinary room here.
    assert.equal(endpointOf(def, 'kin'), null);
  });

  it('refuses a venue with a room nobody gave an address', () => {
    const { errors } = applyInstallation(show(), {
      installation: 'venue',
      requireAll: true,
      experiences: { influence: 'ws://10.0.0.11:8080' },
    });
    // The check worth having: a forgotten room found at load rather than by a
    // guest walking into it.
    assert.equal(errors.length, 1);
    assert.match(errors[0], /kin declares an experience with no address/);
  });

  it('catches an address aimed at a room that cannot use it', () => {
    const typo = applyInstallation(show(), {
      installation: 'venue', experiences: { influnce: 'ws://10.0.0.11:8080' },
    });
    assert.match(typo.errors.join('\n'), /names a room the show does not have/);

    const wrongRoom = applyInstallation(show(), {
      installation: 'venue', experiences: { cyclorama: 'ws://10.0.0.11:8080' },
    });
    // Configured-looking and silent: the room it was meant for goes uninstalled
    // while this one looks like it was set up.
    assert.match(wrongRoom.errors.join('\n'), /that room declares no experience/);
  });

  it('refuses an address that is not one', () => {
    const { errors } = applyInstallation(show(), {
      installation: 'venue', experiences: { influence: '10.0.0.11:8080' },
    });
    assert.match(errors.join('\n'), /must be a ws:\/\/ URL/);
  });

  it('overrules an address the show was still carrying', () => {
    const def = show();
    def.rooms.influence.experience.endpoint = 'ws://stale.example:8080';
    const placed = applyInstallation(def, {
      installation: 'venue', experiences: { influence: 'ws://10.0.0.11:8080' },
    });
    assert.equal(endpointOf(placed.def, 'influence'), 'ws://10.0.0.11:8080');
  });

  it('drops an address the show carried when the installation does not name it', () => {
    const def = show();
    def.rooms.kin.experience.endpoint = 'ws://stale.example:8080';
    const placed = applyInstallation(def, { installation: 'laptop', experiences: {} });
    // Otherwise a laptop reaches for a venue machine that is not on this
    // network, and the panel reports a room server down that was never here.
    assert.equal(endpointOf(placed.def, 'kin'), null);
    assert.deepEqual(placed.notInstalled, ['influence', 'kin']);
  });

  it('leaves a show alone when there is no installation at all', () => {
    const def = show();
    def.rooms.influence.experience.endpoint = 'ws://10.0.0.11:8080';
    const placed = applyInstallation(def, null);
    assert.deepEqual(placed.errors, []);
    assert.equal(endpointOf(placed.def, 'influence'), 'ws://10.0.0.11:8080');
  });

  it('does not touch the show it was given', () => {
    const original = show();
    applyInstallation(original, { installation: 'v', experiences: { influence: 'ws://10.0.0.11:8080' } });
    assert.equal(endpointOf(original, 'influence'), null);
  });
});

describe('the laptop host override', () => {
  it('points everything at one machine, keeping each port', () => {
    const { def } = applyInstallation(show(), {
      installation: 'venue',
      experiences: { influence: 'ws://10.0.0.11:8080', kin: 'ws://10.0.0.12:9000' },
    });
    const local = overrideHost(def, '192.168.1.50');
    assert.equal(endpointOf(local, 'influence'), 'ws://192.168.1.50:8080');
    assert.equal(endpointOf(local, 'kin'), 'ws://192.168.1.50:9000', 'two pieces, two ports, one laptop');
  });

  it('takes a port when one is given', () => {
    const { def } = applyInstallation(show(), {
      installation: 'v', experiences: { influence: 'ws://10.0.0.11:8080' },
    });
    assert.equal(endpointOf(overrideHost(def, '127.0.0.1:8081'), 'influence'), 'ws://127.0.0.1:8081');
  });

  it('is a no-op when unset', () => {
    const { def } = applyInstallation(show(), {
      installation: 'v', experiences: { influence: 'ws://10.0.0.11:8080' },
    });
    assert.equal(endpointOf(overrideHost(def, undefined), 'influence'), 'ws://10.0.0.11:8080');
  });
});
