/**
 * KP UI Selectors — Single Source of Truth
 *
 * Rules:
 * 1. NEVER select by visible text (i18n — text changes per locale via ngx-translate)
 *    Exception: ticket titles are user-authored, not i18n'd — :has-text() is safe for those.
 * 2. Prefer component tag names: kanban-board, kanban-column, kanban-card
 * 3. Use CSS classes: .priority-card, .glass-input, .glass-container
 * 4. Use data-testid attributes (9 available — see inventory below)
 * 5. Use CDK drag attributes for drag-drop: [cdkDrag], [cdkDropList]
 *
 * data-testid inventory (added to KP codebase):
 *   landing-open-folder     — button on landing page
 *   column-{columnId}       — column root div (dynamic UUID)
 *   column-add-ticket       — add-ticket input per column
 *   ticket-card-{ticketId}  — card div[cdkDrag] (dynamic ID)
 *   view-switch-{viewId}    — view switcher buttons
 *   search-input            — search bar input
 *   ticket-title            — title input in ticket detail
 *   ticket-editor           — editor wrapper div in ticket detail
 *   comment-submit          — comment submit button
 */
export const selectors = {
  // ─── Landing Page ──────────────────────────────────────
  landing: {
    title: 'h1',
    openFolderButton: '[data-testid="landing-open-folder"]',
  },

  // ─── Board View ────────────────────────────────────────
  board: {
    container: 'kanban-board',
    column: 'kanban-column',
    // Each column has [data-testid="column-{uuid}"]
    columnById: (id: string) => `[data-testid="column-${id}"]`,
    columnHeader: 'kanban-column .glass-container',
    card: '.priority-card',
    // Each card has [data-testid="ticket-card-{id}"] on the cdkDrag div
    cardById: (id: string) => `[data-testid="ticket-card-${id}"]`,
    addTicketInput: '[data-testid="column-add-ticket"]',
    // CDK drop list — each column has [cdkDropList][id="{columnId}"]
    dropList: '[cdkDropList]',
    dropListById: (id: string) => `div[cdkDropList][id="${id}"]`,
  },

  // ─── Ticket Detail (centered modal, not side sheet) ────
  ticketDetail: {
    panel: 'ticket-detail',
    titleInput: '[data-testid="ticket-title"]',
    editorShell: '[data-testid="ticket-editor"]',
    // Tiptap ProseMirror contenteditable — the actual editable element.
    // page.fill() does NOT work here. Use click() + keyboard.type() or clipboard paste.
    editor: '[data-testid="ticket-editor"] .ProseMirror',
    editorToolbar: 'editor-toolbar',
    // Scroll containers inside the modal
    scrollBody: 'ticket-detail .overflow-y-auto',
    commentSubmit: '[data-testid="comment-submit"]',
    tagInput: 'tag-input',
    // Close: Escape key, backdrop click, or close button (X SVG in header)
    backdrop: '.glass-backdrop',
    closeButton: 'ticket-detail button:first-child', // X button in header
  },

  // ─── View Switcher ────────────────────────────────────
  viewSwitcher: {
    button: '.view-switcher-btn',
    activeButton: '.view-switcher-btn-active',
    // Each view button has [data-testid="view-switch-{viewId}"]
    byView: (view: string) => `[data-testid="view-switch-${view}"]`,
  },

  // ─── Search ───────────────────────────────────────────
  search: {
    bar: 'search-bar',
    input: '[data-testid="search-input"]',
    resultsModal: 'search-results-modal',
    resultItem: 'search-results-modal button',
    backdrop: 'search-results-modal .glass-backdrop',
  },

  // ─── Toolbar ──────────────────────────────────────────
  toolbar: {
    button: '.toolbar-btn',
    filterButton: '.toolbar-btn[data-tooltip]',
    themeToggle: '.theme-toggle',
  },

  // ─── Modals / Dialogs ────────────────────────────────
  modal: {
    backdrop: '.glass-backdrop',
    card: '.glass-card',
  },

  // ─── CDK Drag States ─────────────────────────────────
  drag: {
    placeholder: '.cdk-drag-placeholder',
    animating: '.cdk-drag-animating',
    dragging: '.cdk-drop-list-dragging',
    receiving: '.cdk-drop-list-receiving',
  },

  // ─── CDK Overlays (rendered in <body> cdk-overlay-container) ──
  overlay: {
    container: '.cdk-overlay-container',
    pane: '.cdk-overlay-container .cdk-overlay-pane',
  },
};
