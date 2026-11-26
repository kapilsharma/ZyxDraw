# Why ZyxDraw: goals and non-goals

This page says what ZyxDraw is for and where it stops. It explains why some feature requests are accepted and others are politely declined.

## In one line

ZyxDraw is a quick way to make drawings while taking notes, by hand or with help from AI. A drawing is text you can read, and shapes you can drag. It always exports to plain SVG.

## Built on the shoulders of others

There are many excellent drawing tools, both open source and commercial: diagram-as-text languages, vector illustration programs, whiteboards and design platforms. Their communities have spent years making them great, and ZyxDraw learns a lot from them.

ZyxDraw is **not** trying to replace any of them. It covers one small need that sits between them: drawings that live inside your notes as readable text. If another tool fits your work better, please use it. Many people will happily use ZyxDraw next to their favorite tools.

## Goals

- **Quick for people taking notes.** A simple drawing is a few short lines, and needs no programming knowledge.
- **Works well with AI help.** The text is short and readable, so an AI assistant can write it, change it, and fix its own mistakes from clear problem messages.
- **Two-way editing.** Type text and the drawing updates. Drag a shape in the drawing area and the text changes in a small, readable way.
- **The text is the only source of truth.** Nothing is hidden. Everything the drawing shows is in the text.
- **Plain SVG, always.** Every drawing exports to standard SVG that opens anywhere. If you stop using ZyxDraw, you keep your drawings.
- **Room for big drawings.** An infinite canvas (`canvas(infinite)`) for system designs, maps and other drawings that keep growing.
- **Reuse.** Custom shapes with parameters, and libraries that split a big drawing into small files.
- **Easy to diff.** A change to a drawing reads like a change to a note, so it fits notes kept in git.
- **Part of your notes.** Drawings can be searched, linked and embedded like any other note. Nothing to install beyond the plugin.

## Non-goals

- **Not a professional design or illustration suite.** You can draw vector art with ZyxDraw, but brushes, free-hand pencil tools, effect stacks, photo editing and print work belong in tools built for them.
- **Not a shared whiteboard.** A drawing can use an infinite canvas (`canvas(infinite)`), but there is no real-time multi-user editing and there are no live cursors.
- **Not a fully automatic chart maker.** You place shapes yourself, with help from relative positions like `right-of=`. Tools that lay out diagrams from data are better at that.
- **No lock-in and no cloud.** No paid file formats, no accounts, and everything works offline.

## Suggesting a feature

Ideas are welcome, including ideas you love in other tools. A feature fits ZyxDraw when it:

1. still exports to plain SVG;
2. keeps the text short and readable;
3. keeps simple drawings simple.

Open an issue on [GitHub](https://github.com/kapilsharma/ZyxDraw/issues) and say what it would make easier for you.
