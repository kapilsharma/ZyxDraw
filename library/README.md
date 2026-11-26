# ZyxDraw libraries

Ready-made shapes for ZyxDraw. Each `.zyxdl` file here is a **library**: custom shapes that a drawing can import.

| Library | Shapes |
| ------- | ------ |
| `shapes.speech` | Speech bubbles for comics, storyboards and user journeys: `say`, `think` and `whisper`, whose tail points at any spot (`tip-x` and `tip-y`, measured from the middle of the bubble), plus `shout` and `caption`; `text-size` sets the size of the words. Example: `examples/17_speech_bubbles.zyxd`. |

## Using a library

1. Copy the `.zyxdl` file into the **library folder** set in ZyxDraw's settings, keeping its folders. For example, `shapes/speech.zyxdl` goes to `<library folder>/shapes/speech.zyxdl`.
2. Import the shapes in a drawing, and use them like any other shape:

```text
import say, think from shapes.speech

hello is say(label="Hello!", x=20, y=20)
idea is think(label="What if...", x=220, y=20)
```

Open the `.zyxdl` file in ZyxDraw to see every shape it holds, with example values.

Installing libraries from inside ZyxDraw is planned (issue #29).

## Folders and names

A library's name is its path with dots between folders: `shapes/speech.zyxdl` is `shapes.speech`. Each part uses only letters, digits, `-` and `_`.

## `index.json`

Lists every library in this folder. ZyxDraw will read it to show the libraries that can be installed.

```json
{
  "format": 1,
  "libraries": [
    {
      "name": "shapes.speech",
      "description": "One sentence on what the library is for.",
      "version": "1.0.0",
      "licence": "MIT",
      "files": ["shapes/speech.zyxdl"],
      "imports": []
    }
  ]
}
```

| Field | Meaning |
| ----- | ------- |
| `format` | The version of this file's format. Now `1`. |
| `name` | The library name, as written after `from` in an `import` line. |
| `description` | One sentence on what the library is for. |
| `version` | The library's own version, `major.minor.patch`. Raise the major number when a change can break existing drawings, such as a renamed shape or parameter. |
| `licence` | The licence of the shapes. Libraries without their own licence use the repository's (MIT). |
| `files` | The library's files, relative to this folder. The first one is the library itself. |
| `imports` | The names of other libraries in this folder that it imports, so they can be installed with it. |

## Contributing a library

A library is accepted when:

- every exported shape appears in the `preview()` block, so it can be seen when the file is open;
- every parameter that has a sensible value has a default (sizes, colors). Leave the default out only when the value must come from the drawing, such as a label;
- it has a row in `index.json` and in the table above;
- it imports only libraries from this folder;
- it uses only shapes, icons or artwork it is allowed to share under its licence;
- the plugin's tests pass. They compile every library here, and check `index.json` and the `preview()` blocks.
