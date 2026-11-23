# ZyxDraw in a note

An embedded drawing file:

![[02_system_design.zyxd]]

A drawing written directly in the note:

```zyxd
canvas(width=300, height=120)
a is rect(x=20, y=30, width=100, height=60, radius=8, fill=lightblue)
b is circle(right-of=a 60, y=30, r=30, fill=gold)
line(from=a, to=b, arrow=end)
```

A drawing with a mistake, to see how errors look:

```zyxd
a is rect(x=20, y=20, width=abc, height=40)
```
