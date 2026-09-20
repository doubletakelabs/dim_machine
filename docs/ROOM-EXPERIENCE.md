# This document has moved

The room-experience contract, the handover procedure, the tools, and the
reference template now live in the **dim_rooms** repo, which is also where
every room's code travels between the developer and the show:

**https://github.com/doubletakelabs/dim_rooms** → `docs/ROOM-EXPERIENCE.md`

Do not edit a copy here — there deliberately isn't one. When a protocol change
in this repo alters the contract (broker messages, intents, manifest fields,
env overrides), update the doc, tools, and template in dim_rooms in the same
piece of work, and note it in the commit; the handover loop over there tells
every future run to look for exactly such changes.
