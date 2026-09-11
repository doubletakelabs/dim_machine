#!/bin/sh
#
# Spoken placeholder stems for the exhibit-machine simulator.
#
# Each stem names its own state first, then adds one line of flavour — so in a
# demo the team hears WHICH state fired without watching the screen. macOS
# only (say + afconvert); the generated .wav files are committed so the
# simulator works on a clone without regenerating.
set -e
cd "$(dirname "$0")/.."
out="public/sim/stems"
mkdir -p "$out"

gen() {
    say -v Samantha -o /tmp/dim-stem.aiff "$2"
    afconvert -f WAVE -d LEI16@22050 -c 1 /tmp/dim-stem.aiff "$out/$1.wav"
    echo "  $1.wav"
}

gen entrance                "Entrance. Welcome. You chose to step inside."
gen in_room                 "In room. The room is alive now. It is responding to you."
gen complete                "Complete. It is done. Carry it with you."
gen return_visited          "Return, visited. You have been here before. It remembers you."
gen in_room_disabled        "In room, disabled. This room will not wake for you."
gen return_disabled         "Return, disabled. Still nothing here for you."

rm -f /tmp/dim-stem.aiff
echo "stems → $out"
