// Entry point for the screens-gallery preview page (`preview.html`).
// Runs in any browser — no SDK bridge needed — because every glasses
// screen's `view()` is a pure function of `(snapshot, nav, ctx)`.
// The gallery hand-crafts snapshots for each interesting state and
// renders the resulting string-arrays into monospace HTML blocks.

import './preview/gallery.css';
import { mountGallery } from './preview/gallery';

const root = document.getElementById('app');
if (root) mountGallery(root);
