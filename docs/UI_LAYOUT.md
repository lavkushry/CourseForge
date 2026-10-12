# Responsive layout contract

The card grids use one column below 768 px, three from 768 px, four from 1200 px, and six from 1600 px. The required 320 / 390 / 768 / 1366 / 1920 px screenshots therefore show 1 / 1 / 3 / 4 / 6 columns. One readable card at phone widths keeps full course titles and actions visible. The content maximum is 1600 px; gutters are 16 px below 1200 and 24 px above it. Page padding is 16 / 24 / 32 px.

Cards stretch to their grid cell and use a flexible body so progress and actions align. Category labels stay with their cards. Empty results span the entire grid. Single-course carousel sections use horizontal cards in a two-column section grid from 768 px. Multi-course rows remain explicitly scrollable carousels.

The header height is measured when its navigation wraps. The academy header scrolls with the document; the workspace header and sidebar stick to the viewport top. Its measured height bounds popover content; search and appearance popovers anchor below the workspace header. Phone controls and course actions wrap, studio breadcrumbs wrap, and the focus form uses one column. Native player stage geometry and player security behavior are preserved.

Tables and code previews may scroll within their own labelled container. The page and dialogs must fit the viewport; hidden page overflow does not count as evidence that their children fit.

Stage 2 navigation evidence covers all five required widths. The complete stage-2 capture and final before/after evidence use the same 83 named views as the audit.
