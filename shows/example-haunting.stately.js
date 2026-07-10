// Generated from shows/example-haunting.json — paste into stately.ai (Import code, XState v5)
import { createMachine } from "xstate";

export const machine = createMachine({
  "id": "haunting",
  "initial": "waiting",
  "on": {
    "escape": "#haunting.finale"
  },
  "states": {
    "waiting": {
      "entry": [
        "showPage(waiting)"
      ],
      "on": {
        "START": "intro"
      }
    },
    "intro": {
      "entry": [
        "showPage(text)",
        "playAudio(ambient.wav) (scheduled)"
      ],
      "after": {
        "6000": {
          "target": "doorChoice"
        }
      }
    },
    "doorChoice": {
      "entry": [
        "showPage(prompt)"
      ],
      "on": {
        "choice:enter": {
          "target": "hallway",
          "actions": [
            "haptic()"
          ]
        },
        "choice:stay": "stayed"
      }
    },
    "stayed": {
      "entry": [
        "showPage(text)"
      ],
      "on": {
        "pageDismiss": "hallway"
      }
    },
    "hallway": {
      "entry": [
        "global.enteredCount +1",
        "showPage(gestureSurface)"
      ],
      "on": {
        "revealClue": {
          "target": "clue",
          "actions": [
            "context.cluesFound +1"
          ]
        }
      }
    },
    "clue": {
      "entry": [
        "playAudio(whisper.wav)",
        "log: found the clue",
        "showPage(text)"
      ],
      "on": {
        "button:vote": {
          "target": "voted",
          "actions": [
            "global.votesForExit +1"
          ]
        }
      }
    },
    "voted": {
      "entry": [
        "showPage(text)"
      ],
      "on": {
        "global.changed": {
          "guard": "global.votesForExit >= 2",
          "actions": [
            "sendTo orchestrator: escape"
          ]
        }
      }
    },
    "finale": {
      "entry": [
        "stopAudio()",
        "playAudio(chime.wav) (scheduled)",
        "haptic()",
        "showPage(text)"
      ],
      "after": {
        "10000": {
          "target": "end"
        }
      }
    },
    "end": {
      "entry": [
        "showPage(waiting)"
      ]
    }
  }
});
