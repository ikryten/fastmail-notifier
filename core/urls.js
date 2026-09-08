'use strict';

/* URL handling for message bodies.

   A message body is rendered in a srcdoc iframe, whose base URL is inherited from
   the parent -- a chrome-extension:// page. So anything that is not already an
   absolute URL resolves against the extension and fails: protocol-relative
   sources (//cdn.example.com/logo.png, still common in email) turn into
   chrome-extension://cdn.example.com/... and die with a broken-image icon.

   Normalising here rather than setting a <base href> is deliberate: there is no
   single correct base for an email, so guessing one would silently point relative
   URLs at some arbitrary host. */

const urls = {
  /* Returns a URL safe to place in an img src, or null if it cannot be resolved
     or should not be trusted. `cid:` is passed through untouched as a marker for
     the inline-attachment resolver. */
  safeSrc(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) {
      return null;
    }
    if (/^https?:\/\//i.test(v)) {
      return v;
    }
    // Protocol-relative: the email meant https, not the extension origin.
    if (/^\/\/[^/]/.test(v)) {
      return 'https:' + v;
    }
    if (/^cid:/i.test(v)) {
      return v;
    }
    if (/^data:image\//i.test(v)) {
      return v;
    }
    // Relative paths, or anything with a scheme we do not vouch for
    // (javascript:, vbscript:, data:text/html, file:, ...).
    return null;
  }
};

self.urls = urls;
