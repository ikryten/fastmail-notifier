/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';

/* Choosing which body parts to display.

   RFC 8621 defines `htmlBody` and `textBody` as *ordered lists* of parts to be
   displayed in sequence -- not as a single part each. Taking only the first
   silently drops content, because messages routinely split header, body, footer
   or inline media across separate parts.

   Deliberately pure -- data in, data out, no DOM -- so the selection rules are
   testable without a browser, and the caller keeps responsibility for sanitising
   each part in isolation. */

const bodyparts = {
  select(email) {
    if (!email) {
      return [];
    }
    const values = email.bodyValues || {};
    const usable = list => (list || []).filter(p => p && values[p.partId]);

    // Prefer the HTML view when any of its parts actually carries a value;
    // otherwise fall back to the text view.
    const html = usable(email.htmlBody);
    const chosen = html.length ? html : usable(email.textBody);

    // Either list may contain both text/plain and text/html parts, so carry each
    // part's own type rather than inferring it from the list it came from.
    return chosen.map(p => ({
      mime: String(p.type || 'text/plain').toLowerCase(),
      value: values[p.partId].value,
      truncated: Boolean(values[p.partId].isTruncated)
    }));
  }
};

self.bodyparts = bodyparts;
