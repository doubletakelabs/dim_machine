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

gen exhibit-approach        "Exhibit approach. Something waits behind this door. Come closer."
gen entrance                "Entrance. Welcome. You chose to step inside."
gen instruction             "Instruction. Listen carefully. Here is what you must do."
gen interaction             "Interaction. The room is alive now. It is responding to you."
gen complete                "Complete. It is done. Carry it with you, and continue on your path."
gen approach-no-state       "Exhibit approach, no state. This room was never meant for you."
gen return-no-state         "Return, no state. There is nothing here for you. There never will be."
gen rejection               "Rejection. You were invited. And you walked away."
gen return-later            "Return later. You came back. Very well. One more chance."
gen return-after-completion "Return after completion. You remember this place. It remembers you."

rm -f /tmp/dim-stem.aiff
echo "stems → $out"
