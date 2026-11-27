# Zyxd guide for AI assistants

You are helping someone make a drawing in **Zyxd**, the text language of ZyxDraw (an Obsidian plugin). Read this whole page before you answer. Zyxd is new and not in your training data, so do not guess from SVG, Python or other diagram languages. Follow the rules and copy the patterns below.

**How to answer:**

- Reply with the complete drawing in one ```` ```zyxd ```` code block, ready to paste into a `.zyxd` file.
- Use only the shapes and attributes on this page.
- The user may paste back problems, each with a code (like `ZYX012`) and a line number. Fix exactly those lines and send the whole drawing again.
- Keep it simple. Prefer `right-of=` / `below=` and `line(from=, to=)` over computing coordinates by hand.

## 1. The one rule of syntax

```text
name is type(attribute=value, attribute=value)
```

- Read it as "`api` is a `rect` with these attributes": `api is rect(width=120, height=60)`.
- The name is optional when nothing refers to the shape: `rect(width=120, height=60)`.
- Attributes go inside `( )`, separated by commas. On several lines, commas are optional.
- Children go in an **indented block after `:`**, two spaces per level.
- Comments start with `#`.
- Text values use double quotes: `"Hello"`. Numbers are pixels, `40%` is a percent of the parent.
- Colors: names (`red`, `steelblue`), hex (`#4a90d9`), `rgb(0, 128, 0)`, or `none`.
- Every attribute has a default, so write only what you need.

```zyxd
canvas(width=400, height=160, background=white)

# A box, a circle and a label joined by an arrow
box is rect(x=20, y=40, width=120, height=70, radius=8, fill=lightblue, stroke=navy, stroke-width=2)
dot is circle(right-of=box 120, y=45, r=30, fill=gold)
line(from=box, to=dot, arrow=end, label="next")
```

## 2. The canvas

Optional, written first, at most once.

| Form | Meaning |
| ---- | ------- |
| `canvas(width=800, height=400)` | A frame of that size. `%` is measured from it |
| `canvas(width=800, height=400, background=white)` | With a background color (or a gradient name) |
| no `canvas` line | A 1000 × 600 frame |
| `canvas(infinite)` | No frame: the image grows to fit everything. Top-level shapes use pixels only (no `%`, no `right` / `bottom`); negative positions are fine |

## 3. Built-in shapes

| Shape | Main attributes | Example |
| ----- | --------------- | ------- |
| `rect` | `x`, `y`, `width`, `height`, `radius` (round corners) | `rect(x=10, y=10, width=100, height=50, radius=6)` |
| `circle` | `r`, plus `x` / `y` (top-left of its box) or `cx` / `cy` (center) | `circle(cx=60, cy=60, r=25)` |
| `ellipse` | `rx`, `ry`, plus `x` / `y` or `cx` / `cy` | `ellipse(cx=80, cy=40, rx=60, ry=25)` |
| `line` | `x1`, `y1`, `x2`, `y2`, or `from` / `to` shapes; `arrow` = `none`, `start`, `end`, `both`; `label` | `line(from=a, to=b, arrow=end, label="SQL")` |
| `polyline` | `points="x,y x,y ..."` (open), `radius` | `polyline(points="0,0 50,40 100,0", fill=none, stroke=black)` |
| `polygon` | `points="x,y x,y ..."` (closed), `radius` | `polygon(points="50,0 100,80 0,80", fill=orange)` |
| `path` | `d` = SVG path commands: `M L H V C S Q T A Z`; lower case means relative to the previous point | `path(d="M 0 40 C 30 0 70 0 100 40", fill=none, stroke=red)` |
| `text` | the words first, in quotes; `x`, `y` (top-left), `font-size`, `font-weight`, `align` = `start`, `middle`, `end` | `text("Hello", x=50%, y=20, font-size=18, align=middle)` |
| `group` | `x`, `y`, and `width` / `height` if children use `%`; children indented | see section 5 |
| `layer` | a top-level group for one part of the drawing | see section 5 |

`points` and `d` of `polyline`, `polygon` and `path` are measured from the shape's own `x` / `y`, which default to 0.

**Attributes that work on every shape:**

| Attribute | Values |
| --------- | ------ |
| `fill`, `stroke` | a color, a gradient name, or `none` |
| `stroke-width` | pixels |
| `stroke-dasharray` | `"6 4"` for a dashed line |
| `opacity`, `fill-opacity`, `stroke-opacity` | 0 to 1 |
| `rotate` | degrees, clockwise, around the shape's center |
| `scale` | `2`, or `-1 1` to mirror |
| `display` | `none` hides the shape, `inline` shows it |
| `style` | one or more style names: `style=card bold` |
| `clip-path` | a clip name |

## 4. Placing shapes

| Attribute | Meaning |
| --------- | ------- |
| `x` or `left` | distance from the parent's left edge |
| `y` or `top` | distance from the parent's top edge |
| `right`, `bottom` | distance from the parent's right / bottom edge |
| `right-of=a 40` | 40 px to the right of shape `a` |
| `left-of=a 40`, `above=a 20`, `below=a 20` | the same, in other directions |

Rules:

- **One way per axis.** Horizontal: one of `x`, `left`, `right`, `right-of`, `left-of`. Vertical: one of `y`, `top`, `bottom`, `above`, `below`. Two on the same axis is an error.
- `left` + `right` together stretch the shape, so then leave out `width`. The same for `top` + `bottom` and `height`.
- `%` is of the parent's size on that axis: the canvas, or the group or custom shape the shape is in.
- Anchors cannot loop (`a` right of `b` and `b` right of `a`).
- Shapes drawn later are on top.
- A `text` is placed by its own numbers, not inside a box. To put a label in the middle of a box, give it `x` = the box's left + half its width, with `align=middle`. When many boxes need labels, a custom shape (section 7) centers them for you with `x=50%`.

```zyxd
canvas(width=520, height=260, background=white)

start is rect(x=20, y=100, width=110, height=50, radius=25, fill=#d6f5d6, stroke=#3c8c3a)
check is rect(right-of=start 60, y=100, width=120, height=50, fill=#fff4d6, stroke=#b8860b)
done is rect(right-of=check 60, y=100, width=110, height=50, radius=25, fill=#dbe8fb, stroke=#3b6db3)
retry is rect(below=check 40, x=210, width=120, height=40, fill=#fde2e2, stroke=#b33b3b)

text("Start", x=75, y=118, align=middle)
text("Valid?", x=250, y=118, align=middle)
text("Done", x=425, y=118, align=middle)
text("Fix input", x=270, y=203, align=middle)

line(from=start, to=check, arrow=end)
line(from=check, to=done, arrow=end, label="yes")
line(from=check, to=retry, arrow=end, label="no")
```

## 5. Groups and layers

A group moves its children together. Children are placed from the group's top-left. Refer to a child from outside as `group.child`.

```zyxd
canvas(width=460, height=200, background=white)

server is group(x=20, y=40, width=180, height=110):
  box is rect(width=100%, height=100%, radius=8, fill=#eeeeee, stroke=#555555)
  title is text("API server", x=50%, y=12, font-size=16, align=middle)
  dot is circle(cx=20, cy=80, r=8, fill=green)

db is rect(right-of=server 80, y=60, width=120, height=70, fill=#e3f4e1, stroke=#3c8c3a)
text("Database", x=340, y=88, align=middle)

line(from=server.box, to=db, arrow=both)
```

- A group whose children use `%` needs `width` and `height`.
- Names must be unique only among siblings.

A layer is a group for one part of the drawing (background, shapes, labels). Write layers only at the top level. Without `width` / `height` a layer covers the canvas. Later layers are on top.

```zyxd
canvas(width=300, height=160)

back is layer():
  sky is rect(width=100%, height=100%, fill=lightblue)
  ground is rect(y=70%, width=100%, height=30%, fill=#7cb35b)
front is layer():
  sun is circle(x=80%, y=10%, r=20, fill=gold)
  house is rect(x=60, y=80, width=70, height=50, fill=#c25a24)
```

## 6. Styles

A style is a named set of attributes, reused with `style=`. Several styles apply left to right. A shape's own attributes win. Styles cannot set positions.

```zyxd
canvas(width=360, height=120)

card is style(fill=white, stroke=gray, stroke-width=2, radius=8)
warm is style(fill=#ffe7c2)

a is rect(x=20, y=20, width=140, height=80, style=card)
b is rect(right-of=a 20, y=20, width=140, height=80, style=card warm, stroke=orange)
```

## 7. Custom shapes (reuse with parameters)

`name is shape(parameters):` defines a shape once, with its parts indented below. A parameter without a default is required. Use it like a built-in shape, with its parameters and any position or style attribute.

```zyxd
canvas(width=560, height=200, background=white)

service is shape(label, width=140, height=60, color=#dbe8fb):
  body is rect(width=100%, height=100%, radius=8, fill=color, stroke=#3b6db3, stroke-width=2)
  name is text(label, x=50%, y=20, font-size=15, align=middle)

database is shape(label, width=120, height=80, color=#e3f4e1):
  body is rect(width=100%, height=100%, rx=width / 2, ry=10, fill=color, stroke=#3c8c3a, stroke-width=2)
  lid is ellipse(x=0, y=0, rx=width / 2, ry=10, fill=color, stroke=#3c8c3a, stroke-width=2)
  name is text(label, x=50%, y=(height - 20) / 2, font-size=15, align=middle)

web is service(label="Web app", x=20, y=60)
api is service(label="API", right-of=web 60, y=60)
orders is database(label="Orders", right-of=api 60, y=50)

line(from=web, to=api, arrow=end, label="HTTPS")
line(from=api, to=orders, arrow=end, label="SQL")
```

- Inside a custom shape, `%` and positions are of the shape's own box (`width` × `height`).
- Numbers can be calculations with parameters: `rx=width / 2`, `y=(height - 20) / 2`.
- **Put spaces around `-`** in calculations. `width-2` is read as one name; write `width - 2`.
- Inside `points` or `d`, put a calculation in `( )`: `points="0,0 (width),0 (width / 2),(height)"`.
- Parts of a shape defined in the same file can be referred to: `web.body`.

## 8. Gradients and clips

```zyxd
canvas(width=400, height=220, background=sky)

sky is gradient(from=#7a2a5a, to=#f6c3a8, angle=90)
sun is gradient(type=radial, from=#fff6c8, to=#ff9a5a)
glow is gradient(type=radial):
  stop(offset=0%, color=#ffd36e, opacity=0.9)
  stop(offset=100%, color=#ffd36e, opacity=0)

halo is circle(cx=300, cy=80, r=70, fill=glow)
ball is circle(cx=300, cy=80, r=35, fill=sun)

top-half is clip():
  rect(width=100%, height=50%)
hill is ellipse(cx=120, cy=220, rx=150, ry=90, fill=#3a5f3a, clip-path=top-half)
```

- A gradient name works wherever a color does. `angle`: 0 is left to right, 90 is top to bottom. `type=radial` blends from the center.
- A clip keeps only what is inside its shapes. Its `%` is of the clipped shape's box.

## 9. Libraries

A library is a `.zyxdl` file of custom shapes, styles, gradients and clips to share between drawings. A drawing imports from it by library name: the path with dots, so `shapes/speech.zyxdl` is `shapes.speech`.

```zyxd
canvas(width=460, height=200, background=white)

import say, think from shapes.speech

hello is say(label="Hello!", x=40, y=20, tip-x=-40, tip-y=70)
idea is think(label="What if...", x=260, y=20)
```

- `import a, b from lib`, `import * from lib`, `import a as b from lib`.
- In a library, `export a, b` lists what drawings can import.
- Only use a library the user says they have. Otherwise define custom shapes in the drawing itself (section 7).

## 10. More patterns

**Mind map:**

```zyxd
canvas(width=560, height=300, background=white)

topic is style(fill=#fff4d6, stroke=#b8860b, stroke-width=2, radius=20)
idea is style(fill=#eef5ff, stroke=#3b6db3, radius=12)

center is rect(x=210, y=120, width=140, height=60, style=topic)
text("Project", x=280, y=140, font-size=18, font-weight=bold, align=middle)

goals is rect(x=20, y=30, width=120, height=44, style=idea)
team is rect(x=420, y=30, width=120, height=44, style=idea)
risks is rect(x=20, y=226, width=120, height=44, style=idea)
dates is rect(x=420, y=226, width=120, height=44, style=idea)
text("Goals", x=80, y=42, align=middle)
text("Team", x=480, y=42, align=middle)
text("Risks", x=80, y=238, align=middle)
text("Dates", x=480, y=238, align=middle)

line(from=center, to=goals)
line(from=center, to=team)
line(from=center, to=risks)
line(from=center, to=dates)
```

**Timeline:**

```zyxd
canvas(width=600, height=160, background=white)

line(x1=30, y1=80, x2=570, y2=80, stroke=#555555, stroke-width=3, arrow=end)

step is shape(year, note):
  circle(cx=0, cy=0, r=8, fill=#3b6db3)
  text(year, x=0, y=-40, font-weight=bold, align=middle)
  text(note, x=0, y=20, font-size=13, align=middle)

step(year="2024", note="Idea", x=80, y=80)
step(year="2025", note="First version", x=230, y=80)
step(year="2026", note="Libraries", x=380, y=80)
step(year="2027", note="1.0", x=520, y=80)
```

**Simple wireframe:**

```zyxd
canvas(width=320, height=420, background=white)

phone is group(x=20, y=10, width=280, height=400):
  frame is rect(width=100%, height=100%, radius=24, fill=#fafafa, stroke=#333333, stroke-width=2)
  header is rect(x=0, y=0, width=100%, height=60, radius=24, fill=#3b6db3)
  title is text("Sign in", x=50%, y=20, font-size=20, fill=white, align=middle)
  email is rect(left=10%, right=10%, y=110, height=40, radius=6, fill=white, stroke=#999999)
  password is rect(left=10%, right=10%, below=email 20, height=40, radius=6, fill=white, stroke=#999999)
  button is rect(left=10%, right=10%, below=password 30, height=44, radius=22, fill=#3b6db3)
  label is text("Continue", x=50%, y=252, fill=white, align=middle)
```

## 11. Mistakes to avoid

| Wrong | Right | Why |
| ----- | ----- | --- |
| `<rect x="10" ... />` | `rect(x=10)` | Zyxd is not SVG XML |
| `rect api(width=10)` | `api is rect(width=10)` | the name comes first, then `is` |
| `api = rect(...)` or `api: rect(...)` | `api is rect(...)` | only `is` names a shape |
| `rect(width: 10)` | `rect(width=10)` | attributes use `=` |
| `x=10, right-of=a 20` | one of them | one way per axis |
| `left=10, right=10, width=100` | leave out `width` | `left` + `right` already set the width |
| `rx=width-2` | `rx=width - 2` | spaces around `-` |
| `%` on a top-level shape with `canvas(infinite)` | pixels, or put it in a group with a size | an infinite canvas has no size to measure from |
| children of a group without `:` or not indented | `name is group(...):` then two-space indented lines | indentation makes children |
| a layer inside a group | layers only at the top level | |
| `style`, `shape`, `rect`, `canvas`, `layer` ... as a name | `box`, `card`, `main` ... | keywords and shape types are reserved |
| `line(from=a.right, ...)` | `line(from=a, ...)` | lines attach to a shape, not to a side |
| `text("Hi", width=100)` | `text("Hi", x=50, align=middle)` | text has no `width`; center it with `align=middle` at its middle `x` |
| two shapes with the same name side by side | unique names | names must be unique among siblings |
| using a library the user does not have | a custom shape in the drawing | an import of a missing library is an error |

## 12. Checklist before you answer

1. One ```` ```zyxd ```` block with the whole drawing, `canvas(...)` first.
2. Every line is `name is type(...)`, `type(...)`, a comment, or an indented child.
3. Every name used in `from=`, `to=`, `right-of=`, `style=`, `fill=` ... is defined in the drawing.
4. At most one horizontal and one vertical position per shape.
5. Each label sits inside its box: check `x` = left + width / 2 for centered text, or use a custom shape.
6. The whole drawing fits inside the canvas.
