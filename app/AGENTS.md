# Code Style Guide
Always use ; at the end of JS code lines, this is not optional, do not
trust the JS runtime to insert it for you.

In Vue templates, add a blank line between sibling HTML/component elements at
the same nesting level. Keep nested parent/child elements directly adjacent.

# Frontend UI Guidance
Before adding or changing durable UI patterns, read `../docs/design-system.md`.

Use design tokens from `src/styles/tokens.scss` instead of hard-coded colors,
spacing, shadows, fonts, or radii. Reuse `Button`, `Badge`, `Panel`, `Toolbar`,
and `EmptyState` before creating new local controls.

Keep domain-specific UI in feature components. Only add components under
`src/components/ui/` when the surface is generic and reusable across unrelated
features.

Custom interactive elements must have visible `:focus-visible` treatment and
accessible labels. Prefer real `button`, `input`, and `textarea` elements.
