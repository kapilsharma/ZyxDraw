# Drawing and editing paths

A path is any line or shape you draw yourself: a wave, an arrow, a speech bubble, a cloud. In the text, it is one line with a `d` attribute that lists its steps:

```zyxd
path1 is path(d="M 20,100 C 20,100 70,40 100,40 S 180,100 180,100", fill=none, stroke=black)
```

You don't have to write `d` yourself. Draw in the drawing area and ZyxDraw writes it for you. Every change you make by dragging changes only the numbers it must in the text, and you can undo it in one step.

This page covers drawing paths, changing them, and reading `d`. The rest of the drawing area is in [Using ZyxDraw in Obsidian](editing.md).

## Which tool to use

| You want | Use | Key |
| -------- | --- | --- |
| A smooth line or blob, without fiddling with handles | **Curve** tool | `C` |
| Corners, curves and arcs, exactly where you want them | **Pen** tool | `B` |
| One straight line | **Line** tool | `L` |
| A shape with straight sides | **Polygon** tool | `P` |

While a tool is in use, a hint line at the bottom of the drawing area shows its keys. The **Help** tab in the right panel explains it in more detail.

## Drawing with the curve tool

The easiest way to get a smooth line. Click where the line should go, and the curve bends smoothly through every point.

1. Press `C`.
2. Click a few points. The curve shows through them as you move the mouse.
3. Press `Enter` (or double-click) to finish. Or click the first point again (with 3 points or more) to close it into a smooth shape, like a cloud.

There are no handles to pull. ZyxDraw works out the curve and writes an ordinary path in whole numbers. You can change it afterwards like any other path (see [Changing a path](#changing-a-path)).

## Drawing with the pen

The pen gives you corners, curves and arcs. Press `B`, then:

| Do this | You get |
| ------- | ------- |
| Click | A corner |
| Press, keep the button down, and drag | A smooth point: the curve bends through it. The further you drag, the rounder the curve |
| `Shift` + click | An arc: half a circle to the new point |
| `Shift` + press and drag | An arc that bends through the mouse (see [Arcs](#arcs)) |
| Click the first point | Close the shape |
| `Enter` or double-click | Finish, leaving the path open |
| `Backspace` or `Ctrl+Z` | Take back the last point, and go on drawing |
| `Esc` | Stop. With 2 or more points, the path is kept as it is |
| Hold `Alt` | Place a point off the grid (when the grid is shown) |

On Mac, use `Cmd` for `Ctrl`.

### A curve, step by step

To draw a hill:

1. Press `B`.
2. Click at the bottom left: the start.
3. Press at the top, keep the button down, and drag to the right. Let go: the curve bends over the top.
4. Click at the bottom right, then press `Enter`.

ZyxDraw adds this line to the text:

```zyxd
path1 is path(d="M 20,100 C 20,100 70,40 100,40 S 180,100 180,100", fill=none, stroke=black)
```

An open path gets `fill=none, stroke=black`, so it shows as a line. A closed one is filled.

### Arcs

An arc is part of a circle: a rounded end, a pie slice, a bridge. Hold `Shift` with the pen.

- **`Shift` + click** joins the new point with half a circle. It always bulges to the **right** of the way you are drawing: drawing to the right, it bulges down; drawing to the left, it bulges up. While `Shift` is held, the next side shows as that half circle before you click.
- **`Shift` + press and drag** lets you choose. Press where the arc should end, keep the button down, and move the mouse: the arc bends through the mouse, shown by a small dot. Drag to the **other side** of the line for the other direction. Drag close to the line for a flat arc, far out for more than half a circle.
- **Already drawn?** Select the path and drag the arc itself across to the other side. It stays part of a circle and turns the other way.

`Shift` also works on the closing side: `Shift` + click on the first point closes the shape with an arc.

### Going on from an end

Finished too early, for example by an accidental double-click? Select the path: a **+** appears beside each of its ends. Click it (or, with the pen, click the end itself, or right-click the end and choose **Continue path**) and draw on as usual. Clicking the other end closes the path. Only the new part is added to the text.

This works for open paths and polylines. Not for closed shapes, paths with several parts, or turned and scaled shapes.

## Changing a path

Select a path. Its points appear:

- **squares**: points on the line;
- **circles**: curve handles, with dashed lines to the point they belong to.

| Do this | What happens |
| ------- | ------------ |
| Drag a square | The point moves, and its handles come along |
| Drag a circle | The curve changes shape. At a smooth point, the other handle turns to match, so the point stays smooth. Hold `Alt` to move one handle alone and make a corner |
| Drag a side (the line itself) | A straight side bends into a curve through the spot you hold; a curve changes shape the same way. An arc stays part of a circle (drag it across to turn it the other way) |
| `Ctrl` + drag | Moves the whole path instead (or use the arrow keys) |
| Double-click a point | Switches it between corner and smooth. Also in its right-click menu: **Make smooth** / **Make corner** |
| Click the dot in the middle of a side | Adds a point there. On a curve or arc, the shape stays the same |
| Click a point, press `Delete` | Removes it; the sides on either side join |
| Click a point | With the text open beside the drawing, its numbers are selected in the text |

Some handles have no numbers of their own, because SVG works them out:

- After a smooth point, the next curve is often written `S`. Its first handle is the one before the point, mirrored. It is still shown, and dragging it turns the other handle, so the point stays smooth. To make a corner there, use **Make corner**.
- A `T` curve's handle mirrors the one before it. Dragging it changes the `Q` curve it comes from, so every `T` after that `Q` changes too.

## Reading `d`

`d` is short but hard to read. ZyxDraw explains it without changing it:

- **In the text:** hover over `d`. A numbered list explains each step, for example "1. Start at 100, 100", "2. Straight line to 150, 50", "3. Close the shape".
- **In the Attributes:** a selected path shows **Steps of d**, with a small field for each number. Changing one changes only that number.
- **In the drawing:** hovering a step in either list highlights that part of the path.

### The letters in `d`

Each step starts with a letter, followed by its numbers. A capital letter means "go to this point"; a small letter means "go this far from where you are" (`l 50,0` is "50 to the right"). Pairs are `x,y`: `x` grows to the right, `y` grows **down**.

| Letter | Means | Numbers |
| ------ | ----- | ------- |
| `M` | Start (or jump) here | the point |
| `L` | Straight line to | the point |
| `H` / `V` | Straight line across / up or down to | one number: `x` / `y` |
| `C` | Curve to | first handle, second handle, the point |
| `S` | Smooth curve to: its first handle mirrors the one before | second handle, the point |
| `Q` | Curve with one handle to | the handle, the point |
| `T` | Smooth curve with one handle: it mirrors the one before | the point |
| `A` | Arc (part of a circle or an ellipse) to | 7 numbers, below |
| `Z` | Close the shape: a straight line back to the start | none |

### The 7 numbers of an arc

```
A  50 50   0   0   1   120,100
   rx ry  turn large  sweep  end point
```

| Number | Means |
| ------ | ----- |
| `rx`, `ry` | The radius across and up-down. The same number twice is a circle; different numbers, an ellipse. If they are too small to reach the end point, SVG makes them just big enough |
| turn | Turns an ellipse, in degrees. No effect on a circle |
| large | `0`: the short way round. `1`: the long way, more than half the circle |
| sweep | The direction. `1`: clockwise on screen. `0`: anticlockwise |
| end point | Where the arc ends |

A circle through two points can be drawn four ways: short or long, clockwise or anticlockwise. `large` and `sweep` pick one. To flip an arc to the other side of its line, change `sweep` (`0` ↔ `1`), or drag the arc across in the drawing.

## Good to know

- **Paths from elsewhere:** you can paste the `d` of any SVG file. Everything above works with every letter, capital or small, and a path written with small letters stays that way when you edit it.
- **Arcs of an ellipse** (`rx` ≠ `ry`) cannot be bent by dragging. Drag their end points, or change the numbers.
- **Calculations:** a `d` with calculations in `( )` is drawn, but its points cannot be dragged and its steps are not listed.
- **Custom shapes:** when `d` comes from a parameter of a custom shape, its points cannot be dragged.
- **Plain SVG:** whatever you draw, the text is a standard SVG path, so the drawing exports to SVG and opens anywhere.
