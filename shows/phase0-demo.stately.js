// Generated from shows/phase0-demo.json — paste into stately.ai (Import code, XState v5)
import { createMachine } from "xstate";

export const machine = createMachine({
  "id": "phase0",
  "initial": "lobby",
  "states": {
    "lobby": {
      "entry": [
        "stopAudio()",
        "showPage(waiting)"
      ],
      "on": {
        "START": "act1"
      }
    },
    "act1": {
      "entry": [
        "playAudio(ambient.wav) (scheduled)",
        "showPage(audioPlayer)"
      ],
      "on": {
        "NEXT": "act2",
        "RESET": "lobby"
      }
    },
    "act2": {
      "entry": [
        "playAudio(whisper.wav) (scheduled)",
        "showPage(audioPlayer)"
      ],
      "on": {
        "NEXT": "finale",
        "BACK": "act1",
        "RESET": "lobby"
      }
    },
    "finale": {
      "entry": [
        "stopAudio()",
        "playAudio(chime.wav) (scheduled)",
        "showPage(text)"
      ],
      "on": {
        "NEXT": "ended",
        "BACK": "act2",
        "RESET": "lobby"
      }
    },
    "ended": {
      "entry": [
        "stopAudio()",
        "showPage(waiting)"
      ],
      "on": {
        "RESET": "lobby"
      }
    }
  }
});
