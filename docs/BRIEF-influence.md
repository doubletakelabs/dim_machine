# Brief — converting Click Farm into a room experience

Read `ROOM-EXPERIENCE.md` first; this is what it means for *this* piece.

The good news is that the hard part is already right. Click Farm's README says
it plainly:

> *"Phone sends intent, wall owns physics."*

That is exactly the division the show needs. The intents already match —
`drag`, `release`, `tap`, `hold` — and they are already normalised to the phone's
screen, so device size drops out. Most of what follows is deletion.

---

## What changes

| Now | Needs to be |
|---|---|
| No manifest | `experience.json` — see the contract, §2 |
| `nextId++`, `HUES`, `MAX_DRIVERS`, `IDLE_RELEASE_MS`, the `ctrls` queue | **Deleted.** The show assigns driver ids, hues and caps |
| `hello` handles `ctrl` and `wall` | Add `role: "broker"`, answer `ready` |
| `if (drivers.size === 0)` → attract *(wall.html:459)* | Attract comes from `lifecycle`, never from socket count |
| Nothing clears between guests | Clear on `reset`; **hold** through `settling` |
| `localStorage.setItem('clickfarm.warp', …)` *(wall.html:569)* | `GET`/`POST /calibration`, written to a file |
| `drag { dy }` | `drag { dx, dy }` — ignore `dx`, but accept it |
| Any `ctrl` socket is trusted | Check `driverId` + `secret` against the current driver set |
| `controller.html` serves visitor phones | Not used in production — the show's own phone client is the controller. Keep it for your own testing if you like |
| 705MB of media in the folder | Ships separately; the manifest points at `media.dir` |

---

## The two that are easy to get subtly wrong

**`drivers` replaces, it never merges.** There are no "driver joined" or "driver
left" messages. Every `drivers` message is the complete set. This is what makes
your server restartable: if the machine is power-cycled mid-show, the first
message you receive is the whole truth, so there is no resync path to write.

**`settling` is not a slower `attract`.** A room in exit grace has two ways out —
the guest walks back in (`live` again, everything still there) or the grace
expires (`reset`, then `attract`). Someone stepping into the corridor for four
seconds and coming back to a wiped rack is the fault this exists to prevent.

---

## What is going to be checked, and what is not

`node tools/verify-experience.mjs ./your-folder` is the gate. It boots your
server, connects as a broker, and checks the protocol. Run it until it passes.

It **cannot** check behaviour, because it does not know what "state" means inside
your piece. These three will be tested by hand in the harness, and they are the
three most likely to be wrong:

1. Drive the rack somewhere distinctive → `settling` → `live`. It must be exactly
   where it was left.
2. `settling` → `reset` → `attract`. It must be back to the top.
3. Two drivers driving, then remove one in the panel. That driver's column band
   must stop responding.

---

## One thing outside the contract, worth raising now

TouchDesigner is not happening — the show stays web-based. Your own README
already names the consequence:

> *"GPU decode is why TD handles 60 simultaneous loops and a browser handles ~12."*

The default grid is 6×4 = 24 tiles, twice that. The tall-strip approach in your
README's *Browser-only production path* section is therefore the plan rather than
an optimisation, and it also removes the `<video>` churn you flagged in `fill()`.
Better built that way now than retrofitted.

---

## Done when

```
node tools/verify-experience.mjs ./your-folder      # all checks pass
node tools/experience-harness.mjs ws://localhost:8080
```

…and the three behaviours above hold with two phones on the harness driver page.
