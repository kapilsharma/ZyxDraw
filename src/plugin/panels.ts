/**
 * Views shown in the panels of a drawing (issues #8 and #11): the Attributes in the bottom panel,
 * the Layers in the right panel. Today each view has a fixed panel; they share this shape so a
 * view can be moved to another panel later without changing the view itself.
 */
export interface PanelView {
  /** The view's own element, inside its panel. */
  readonly el: HTMLElement;
  /** The panel is showing this view (it is not rebuilt while hidden). */
  setShown(shown: boolean): void;
  /** The text was recompiled: read the drawing again. */
  refresh(): void;
}
