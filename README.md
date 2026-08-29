# ATLAS — COC Office Delivery Update

This package adds the warehouse Certificate of Compliance workflow, hard pallet box ceiling, exact blue-region scanner, IndexedDB completed history, private official-workbook generation, secure send/receipt lifecycle, and dedicated `/coc-receiver/` office inbox.

The uploaded source identified employees by initials but did not establish Supabase Auth sessions. Secure delivery deliberately requires a real Supabase Auth user/access token. Follow `docs/COC_OFFICE_DELIVERY_DEPLOYMENT.md` before production acceptance, and see `evidence/TEST_RESULTS.md` for verified and production-only checks.

The historical Sprint 3 notes below are retained for repository context.

# ATLAS — Sprint 3 Design Foundation

This build begins **ATLAS Design System 1.0** while preserving the validated warehouse search application and Supabase connection.

## Structure

- `index.html` — semantic application shell
- `css/theme.css` — official colors, typography foundation, global tokens
- `css/layout.css` — responsive structure and spacing
- `css/components.css` — reusable interface components
- `css/animations.css` — motion language and reduced-motion support
- `js/app.js` — validated search, recents, aisle browsing, and Supabase logic
- `assets/` — reserved for approved logos, icons, and product imagery

## GitHub update

Replace the current repository contents with this folder's contents, keeping the folder structure intact. Open `index.html` locally before committing, then verify the live GitHub Pages site.

## Sprint 3 checkpoint

This is **3.1 — Design Foundation**. No warehouse features were added or removed. The next checkpoint is **3.2 — Brand Experience**, where the header, floating search experience, typography hierarchy, and spacing will be rebuilt against these shared files.
