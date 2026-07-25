# ATLAS Design System v1.0

## Product identity

**Product:** ATLAS  
**Descriptor:** Warehouse SKU Finder  
**Purpose statement:** Find any SKU in seconds.  
**Guiding principle:** Every feature must make a picker faster, more accurate, or more confident.

## Brand character

ATLAS should feel:

- Premium without clutter
- Industrial and precise
- Confident, simple, and professional
- Easy to understand at a glance
- Consistent with Chubby Gorilla branding

## Core colors

| Token | Value | Use |
|---|---:|---|
| Navy | `#07182A` | Primary brand surfaces and menu |
| Deep Navy | `#06182B` | Darkest branded surfaces |
| Action Blue | `#0759D6` | Active states and primary actions |
| Dark Blue | `#0B45A8` | Pressed and emphasized states |
| Ink | `#0C1830` | Primary text |
| Muted | `#68758A` | Supporting text and timestamps |
| Border | `#DDE4EC` | Dividers and control borders |
| Soft Surface | `#F4F7FB` | Secondary backgrounds |
| White | `#FFFFFF` | Main application surface |

## Typography

Use the native system font stack for speed and reliability:

`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

Hierarchy:

- Product name: bold, wide letter spacing
- Screen title: clear and compact
- SKU: prominent and highly readable
- Labels: concise uppercase text
- Secondary details: smaller muted text

## Components

### Search field

- Largest functional control on the home screen
- Rounded corners, light border, restrained shadow
- Clear focus ring
- Autocomplete appears directly below

### Recent-search card

- Entire card is tappable
- SKU shown first
- Relative timestamp directly beneath it
- No unnecessary metadata

### Aisle button

- Large tap target
- Three-column grid on mobile
- Active aisle uses Action Blue

### Location card

- Large aisle/section badge
- Aisle, section, and level presented in one glance
- Navigation description beneath
- Verification state remains secondary

### Navigation

Only two primary bottom-navigation items:

1. Home
2. Browse Aisles

Supervisor tools remain inside the menu.

## Interaction rules

- Motion is subtle and functional
- No bouncing, spinning, or decorative animation
- Respect reduced-motion settings
- Buttons may shift or scale only slightly when pressed
- Focus states remain visible for accessibility

## Warehouse terminology

Sections:

- A — South of Main Forklift Driveway
- B — After Main Forklift Driveway
- C — After Forklift Driveway 2
- D — Back Section

Driveways:

1. Main Forklift Driveway
2. Forklift Driveway 2
3. Forklift Driveway 3
4. Forklift Driveway 4

Special zone:

- Back Wall Storage
