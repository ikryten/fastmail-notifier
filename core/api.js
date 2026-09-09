/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

/* Gecko detection by capability rather than user agent: runtime.getBrowserInfo()
   is a Firefox API that Chrome does not implement. Needed where the browsers
   differ in behavior rather than in API surface -- Chrome adds its own "Options"
   entry to the toolbar button's context menu, Firefox does not. */
self.IS_GECKO = typeof self.api.runtime.getBrowserInfo === 'function';
