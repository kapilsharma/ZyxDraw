/**
 * Help for each tool of the drawing area (issue #42): one table, read by the toolbar tooltips,
 * the Help tab in the right panel, and the hint line shown while drawing (issue #33).
 * Plain data with no Obsidian imports, so a test can check that every tool has its help.
 * Write `Ctrl` for the command key: the Help tab shows `Cmd` on Mac.
 */

/** The tools of the drawing area, in toolbar order. */
export const TOOLS = ["select", "hand", "line", "polygon", "pen"] as const;
export type Tool = (typeof TOOLS)[number];

/** One action of a tool: what to do, and what it does. */
export interface HelpStep {
  how: string;
  does: string;
}

export interface ToolHelp {
  /** Short name, shown with the key: "Pen (B)". */
  name: string;
  /** The key that picks the tool. */
  key: string;
  /** The toolbar button's tooltip. */
  tooltip: string;
  /** Drawing tools: the short line shown in the drawing area while the tool is in use (issue #33). */
  hint?: string;
  /** One or two sentences on what the tool is for. */
  about: string;
  /** Mouse actions and keys, most used first. */
  steps: HelpStep[];
}

/** Where the full help is: the editing guide, section "Editing in the drawing area". */
export const DOCS_URL = "https://github.com/kapilsharma/ZyxDraw/blob/main/docs/editing.md#editing-in-the-drawing-area";

export const TOOL_HELP: Record<Tool, ToolHelp> = {
  select: {
    name: "Select",
    key: "V",
    tooltip: "Select and move (V)",
    about: "Select shapes to move, resize, color or delete them. Every change is written back to the text.",
    steps: [
      { how: "Click", does: "Select a shape. Click again to go one level deeper; double-click for the innermost shape" },
      { how: "Shift + click", does: "Add or remove a shape from the selection" },
      { how: "Drag on empty space", does: "Select the shapes inside the box" },
      { how: "Drag a shape", does: "Move it. Arrow keys nudge it (with Shift: 10 px)" },
      { how: "Drag a handle", does: "Resize. On a path, polygon or line: move a point" },
      { how: "Delete or Backspace", does: "Delete the selected shapes" },
      { how: "Ctrl+D", does: "Duplicate" },
      { how: "Ctrl+G", does: "Group (Ctrl+Shift+G: ungroup)" },
      { how: "Right-click", does: "More: copy, layer order, show in text" },
    ],
  },
  hand: {
    name: "Hand",
    key: "H",
    tooltip: "Hand: drag to scroll (H, or hold Space)",
    about: "Move around the drawing without changing it.",
    steps: [
      { how: "Drag", does: "Scroll the drawing area" },
      { how: "Hold Space", does: "Use the hand with any tool, then go back to it" },
      { how: "Ctrl + mouse wheel", does: "Zoom in and out" },
      { how: "V", does: "Back to Select" },
    ],
  },
  line: {
    name: "Line",
    key: "L",
    tooltip: "Draw a line (L): drag, or click both ends. Shift: 45° steps",
    hint: "Drag, or click both ends · Shift: 45° steps · Esc: stop",
    about: "Draw a straight line.",
    steps: [
      { how: "Drag", does: "Draw a line from where you press to where you let go" },
      { how: "Click, then click", does: "Place the first end, then the second" },
      { how: "Shift", does: "Keep the line at 45° steps" },
      { how: "Alt", does: "Place freely, off the grid (when the grid is shown)" },
      { how: "Esc", does: "Drop the first end. Press again to leave the tool" },
    ],
  },
  polygon: {
    name: "Polygon",
    key: "P",
    tooltip: "Draw a polygon (P): click to place points, click the first point or press Enter to finish. Backspace removes the last point",
    hint: "Click: place a point · Click the first point or Enter: finish · Backspace: remove last point · Esc: drop points",
    about: "Draw a closed shape with straight sides, one point at a time.",
    steps: [
      { how: "Click", does: "Place a point" },
      { how: "Click the first point", does: "Finish the shape" },
      { how: "Enter or double-click", does: "Finish the shape" },
      { how: "Backspace or Ctrl+Z", does: "Remove the last point" },
      { how: "Alt", does: "Place freely, off the grid (when the grid is shown)" },
      { how: "Esc", does: "Drop all points. Press again to leave the tool" },
    ],
  },
  pen: {
    name: "Pen",
    key: "B",
    tooltip: "Draw a path (B): click for a corner, press and drag for a curve. Backspace removes the last point. Click the first point to close, or press Enter / double-click to leave it open",
    hint: "Click: corner · Press and drag: curve · Backspace: remove last point · Enter: finish · Esc: stop",
    about: "Draw a path with corners and smooth curves. To make a curve, keep the mouse button pressed and drag.",
    steps: [
      { how: "Click", does: "Place a corner" },
      { how: "Press and drag", does: "Place a smooth point: dragging pulls out its curve" },
      { how: "Click the first point", does: "Close the shape" },
      { how: "Enter or double-click", does: "Finish, leaving the path open" },
      { how: "Click an end of the selected path", does: "Go on drawing from it (an open path or polyline). Also the + beside each end, or right-click the end: Continue path" },
      { how: "Backspace or Ctrl+Z", does: "Remove the last point" },
      { how: "Alt", does: "Place freely, off the grid (when the grid is shown)" },
      { how: "Esc", does: "Stop: with 2 or more points, the path is kept, open. With fewer, the tool is left" },
    ],
  },
};

/** Help text with the Mac command key where needed. */
export function forPlatform(text: string, mac: boolean): string {
  return mac ? text.replace(/\bCtrl\b/g, "Cmd") : text;
}
