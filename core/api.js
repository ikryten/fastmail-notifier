'use strict';

/* One extension-API namespace for both browsers.

   Firefox exposes promise-based APIs on `browser`; its `chrome` alias is
   callback-based, so awaiting it silently yields undefined. Chrome's `chrome`
   namespace is promise-based under MV3, and recent Chrome also exposes `browser`.

   Preferring `browser` and falling back to `chrome` therefore lands on a
   promise-based namespace everywhere, with no polyfill and no build step:

     Firefox           -> browser  (promises)
     Chrome (recent)   -> browser  (promises)
     Chrome (older)    -> chrome   (promises, MV3)

   Everything else in the extension calls `api.*` and never touches either global
   directly, so this file is the single place a compatibility shim ever needs to go. */

self.api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
