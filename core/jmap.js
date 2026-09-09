'use strict';

/* JMAP client for Fastmail.

   Auth is Bearer-token only. Fastmail's API rejects cookies outright -- both
   api.fastmail.com/jmap/session and the app's own regional endpoint answer
   "401 No Authorization header" to a cookie-bearing request -- so there is no
   cookie-riding path of the kind Gmail notifiers use.

   Errors carry a .code so callers can tell "your token is dead" (auth) from
   "the network blipped" (network). Only `auth` should change the UI to a
   logged-out state; the rest are transient. */

const jmap = {
  SESSION_URL: 'https://api.fastmail.com/jmap/session',
  USING: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
  TIMEOUT: 15000,
  LIMIT: 50,

  err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  },

  async request(url, opts, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), jmap.TIMEOUT);
    let r;
    try {
      r = await fetch(url, Object.assign({}, opts, {
        signal: controller.signal,
        cache: 'no-store',
        headers: Object.assign({}, opts.headers, {Authorization: 'Bearer ' + token})
      }));
    }
    catch (e) {
      throw jmap.err('network', controller.signal.aborted ? 'Request timed out' : 'Network error');
    }
    finally {
      clearTimeout(timer);
    }

    if (r.status === 401 || r.status === 403) {
      throw jmap.err('auth', 'Fastmail rejected the API token (' + r.status + ')');
    }
    if (r.status === 429) {
      throw jmap.err('rate', 'Rate limited by Fastmail');
    }
    if (!r.ok) {
      throw jmap.err('http', 'Fastmail returned HTTP ' + r.status);
    }
    return r;
  },

  /* One-time per session: resolve the region-specific apiUrl and the mail accountId.
     Never hardcode the API host -- this account resolves to phl.api.fastmail.com,
     others differ. */
  async bootstrap(token) {
    const r = await jmap.request(jmap.SESSION_URL, {method: 'GET'}, token);
    const j = await r.json();

    const accountId = j.primaryAccounts && j.primaryAccounts['urn:ietf:params:jmap:mail'];
    if (!accountId) {
      throw jmap.err('scope', 'This token has no access to mail. Create one with the Mail scope.');
    }
    return {
      apiUrl: new URL(j.apiUrl, jmap.SESSION_URL).href,
      downloadUrl: j.downloadUrl || '',
      eventSourceUrl: j.eventSourceUrl || '',
      accountId,
      username: j.username || ''
    };
  },

  async call(token, session, methodCalls) {
    const r = await jmap.request(session.apiUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({using: jmap.USING, methodCalls})
    }, token);

    const j = await r.json();
    const responses = j.methodResponses || [];
    // A method-level failure still arrives as HTTP 200 with an "error" response.
    for (const [name, args] of responses) {
      if (name === 'error') {
        throw jmap.err('jmap', 'JMAP error: ' + ((args && args.type) || 'unknown'));
      }
    }
    return responses;
  },

  byTag(responses) {
    const out = {};
    for (const [, args, tag] of responses) {
      out[tag] = args;
    }
    return out;
  },

  /* Mailbox ids are stable, so we resolve them once and cache for the session.
     Look them up by `role`, never by name: names are localised, and this account
     has custom folders (Important, Receipts, Family...) that must not
     be mistaken for Inbox.

     `parentId` comes back too so every mailbox can carry its full path. Fastmail
     folders nest, and two subfolders under different parents may share a leaf name
     -- the path is what makes a user's choice unambiguous. */
  async mailboxes(token, session) {
    const res = await jmap.call(token, session, [
      ['Mailbox/get', {
        accountId: session.accountId,
        ids: null,
        properties: ['id', 'name', 'role', 'parentId', 'sortOrder']
      }, '0']
    ]);
    const list = jmap.byTag(res)['0'].list || [];
    const byRole = {};
    for (const m of list) {
      if (m.role) {
        byRole[m.role] = m.id;
      }
    }
    if (!byRole.inbox) {
      throw jmap.err('nobox', 'No mailbox with role "inbox" found on this account');
    }
    const path = jmap.paths(list);
    return {
      inbox: byRole.inbox,
      trash: byRole.trash || null,
      all: list.map(m => ({id: m.id, name: m.name, path: path.get(m.id), role: m.role || null}))
    };
  },

  /* "Receipts/Family" from the parentId chain. The depth cap is a cycle guard:
     the data comes from the server, and a parent loop would otherwise recurse
     until the stack gave out. */
  paths(list) {
    const by = new Map(list.map(m => [m.id, m]));
    const out = new Map();
    const walk = (m, depth) => {
      if (out.has(m.id)) {
        return out.get(m.id);
      }
      const parent = m.parentId ? by.get(m.parentId) : null;
      const p = parent && depth < 20 ? walk(parent, depth + 1) + '/' + m.name : m.name;
      out.set(m.id, p);
      return p;
    };
    for (const m of list) {
      walk(m, 0);
    }
    return out;
  },

  /* The filter for one poll: unread mail in any of `ids`.

     "Unread" has to mean what Mailbox.unreadEmails means, or the badge and the
     list describe different sets. RFC 8621 defines that counter as emails
     carrying *neither* $seen nor $draft, so both are excluded here. Filtering on
     $seen alone let an unsent draft into the preview and into notifications
     while contributing nothing to the count it was supposedly part of -- easy to
     hit, since the picker offers Drafts like any other mailbox.

     A FilterCondition carries one `notKeyword`, so two exclusions mean an AND
     even for a single mailbox; the plain condition this used to send for the
     common case is no longer expressive enough. Several mailboxes additionally
     need an OR, because `inMailbox` takes one id. */
  unreadIn(ids) {
    // No mailbox means no valid filter -- an OR with no conditions is not one.
    if (!ids.length) {
      return null;
    }
    const scope = ids.length === 1
      ? {inMailbox: ids[0]}
      : {operator: 'OR', conditions: ids.map(id => ({inMailbox: id}))};
    return {
      operator: 'AND',
      conditions: [scope, {notKeyword: '$seen'}, {notKeyword: '$draft'}]
    };
  },

  /* The whole poll in one HTTP round trip.

     `watchIds` is every mailbox the user is watching -- the inbox has no special
     status here, which is why this no longer takes the `mailboxes` object at all.
     The counts come from Mailbox/get, which is authoritative past our LIMIT, and
     the messages from a single Email/query spanning the same set, so the badge,
     the preview and the notifications all describe the same folders.

     Note the back-reference is on `#ids`, a whole argument. It cannot be used for a
     key nested inside `filter`, which is why the mailbox ids have to be resolved
     first and cached rather than chained from a Mailbox/query in the same request. */
  async poll(token, session, watchIds) {
    const ids = [...new Set((watchIds || []).filter(Boolean))];

    /* Nothing watched. Return early rather than sending a request: there is
       nothing to ask for, and an OR with no conditions is not a valid filter. */
    if (!ids.length) {
      return {count: 0, messages: [], perBox: []};
    }

    const accountId = session.accountId;
    const res = await jmap.call(token, session, [
      ['Mailbox/get', {
        accountId,
        ids,
        properties: ['unreadEmails', 'totalEmails']
      }, 'box'],
      ['Email/query', {
        accountId,
        filter: jmap.unreadIn(ids),
        sort: [{property: 'receivedAt', isAscending: false}],
        limit: jmap.LIMIT,
        calculateTotal: true
      }, 'q'],
      ['Email/get', {
        accountId,
        '#ids': {resultOf: 'q', name: 'Email/query', path: '/ids'},
        properties: ['id', 'threadId', 'mailboxIds', 'from', 'subject',
                     'receivedAt', 'preview', 'hasAttachment']
      }, 'get']
    ]);

    const tagged = jmap.byTag(res);
    const boxes = new Map((tagged.box.list || []).map(b => [b.id, b]));
    const order = tagged.q.ids || [];
    // Email/get gives no ordering guarantee, so re-impose the query's order.
    const found = new Map((tagged.get.list || []).map(e => [e.id, e]));

    /* A requested id that came back with no entry is a folder deleted or renamed
       since the mailbox list was cached. Omit it rather than counting it as zero,
       so the caller can tell the two apart. */
    const perBox = [];
    for (const id of ids) {
      const b = boxes.get(id);
      if (b && typeof b.unreadEmails === 'number') {
        perBox.push({id, unread: b.unreadEmails});
      }
    }

    /* The badge counts *messages*, not memberships. Summing each mailbox's
       unreadEmails counts a message filed in two watched folders twice, while
       the preview shows it once. Email/query's total is the distinct size of the
       filtered union and is authoritative past LIMIT -- and calculateTotal was
       already being requested and thrown away, so this costs nothing. The sum
       remains as a fallback for a server that omits it.

       Per-mailbox values stay in perBox for the tooltip breakdown, where they
       are the right number; they simply do not have to add up to the total. */
    const total = typeof tagged.q.total === 'number'
      ? tagged.q.total
      : perBox.reduce((n, b) => n + b.unread, 0);

    return {
      perBox,
      count: total,
      messages: order.map(id => found.get(id)).filter(Boolean).map(jmap.summarise)
    };
  },

  WEBMAIL: 'https://app.fastmail.com/mail/Inbox/',

  /* Deep link to one message in the Fastmail web app.

     Verified against the live app: /mail/Inbox/<emailId> opens the message, and
     Fastmail canonicalises the URL to <threadId>.<emailId> on its own -- so the
     email id alone is enough. An id it does not recognise degrades to the folder
     view rather than erroring, which makes this safe to attempt unconditionally.

     Re-verified once the preview began spanning folders: the /Inbox/ segment is
     only the view to open, not a constraint on the lookup, so a message living
     solely in another folder still opens from this URL. That is why no folder
     path is threaded through here -- it would buy nothing.

     The ?u= key is the JMAP accountId minus its leading "u"
     (accountId "u1a2b3c4d" <-> "?u=1a2b3c4d"). Appended only when the accountId
     actually has that shape, so an unexpected id format cannot produce a bad param. */
  webUrl(session, emailId) {
    if (!emailId) {
      return jmap.WEBMAIL;
    }
    const url = jmap.WEBMAIL + encodeURIComponent(emailId);
    const m = /^u([0-9a-f]+)$/i.exec((session && session.accountId) || '');
    return m ? url + '?u=' + m[1] : url;
  },

  summarise(e) {
    const from = (e.from && e.from[0]) || {};
    return {
      id: e.id,
      threadId: e.threadId,
      mailboxIds: e.mailboxIds || {},
      fromName: from.name || from.email || 'Unknown sender',
      fromEmail: (from.email || '').toLowerCase(),
      subject: e.subject || '(no subject)',
      receivedAt: e.receivedAt,
      preview: e.preview || '',
      hasAttachment: Boolean(e.hasAttachment)
    };
  },

  /* Full body, fetched only when the popup actually shows a message. */
  async body(token, session, id) {
    const res = await jmap.call(token, session, [
      ['Email/get', {
        accountId: session.accountId,
        ids: [id],
        properties: ['id', 'blobId', 'bodyValues', 'htmlBody', 'textBody',
                     'attachments', 'from', 'to', 'subject', 'receivedAt'],
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
        maxBodyValueBytes: 512 * 1024
      }, '0']
    ]);
    return (jmap.byTag(res)['0'].list || [])[0] || null;
  },

  assertUpdated(responses, ids) {
    const args = jmap.byTag(responses)['0'];
    const failed = Object.keys(args.notUpdated || {});
    if (failed.length) {
      const why = args.notUpdated[failed[0]];
      throw jmap.err('setfail', 'Fastmail refused the change: ' + ((why && why.type) || 'unknown'));
    }
    return ids;
  },

  async markRead(token, session, ids) {
    const update = {};
    for (const id of ids) {
      update[id] = {'keywords/$seen': true};
    }
    const res = await jmap.call(token, session, [
      ['Email/set', {accountId: session.accountId, update}, '0']
    ]);
    return jmap.assertUpdated(res, ids);
  },

  /* Per RFC 8621: to trash, replace mailboxIds with the trash mailbox rather than
     destroying the message. That keeps it recoverable from the Trash folder. */
  async trash(token, session, mailboxes, ids) {
    if (!mailboxes.trash) {
      throw jmap.err('nobox', 'No mailbox with role "trash" found on this account');
    }
    const update = {};
    for (const id of ids) {
      update[id] = {mailboxIds: {[mailboxes.trash]: true}};
    }
    const res = await jmap.call(token, session, [
      ['Email/set', {accountId: session.accountId, update}, '0']
    ]);
    return jmap.assertUpdated(res, ids);
  }
};

self.jmap = jmap;
